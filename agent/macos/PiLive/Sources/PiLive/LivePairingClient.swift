import AVFoundation
import Foundation

enum LiveClientEvent: Sendable {
    case phase(LivePhase)
    case transcript(String)
    case failure(String)
    case stopped
    case levels(input: Double, output: Double, speechActive: Bool)
    case voiceSetting(voice: LiveVoice, appliesTo: String)
    case instructionsSetting(appliesTo: String)
    case diagnosticsSetting(enabled: Bool, appliesTo: String)
}

@MainActor
final class LivePairingClient {
    let events: AsyncStream<LiveClientEvent>

    private let eventContinuation: AsyncStream<LiveClientEvent>.Continuation
    private let peer = LiveWebRTCPeer()
    private let tunnel = SSHTunnel()
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var receiveTask: Task<Void, Never>?
    private var endingTask: Task<Void, Never>?
    private var stopWaiters: [CheckedContinuation<Void, Never>] = []
    private var ending = false
    private var stopFinished = true
    private var preferredVoice: LiveVoice = .sol
    private var muted = false

    init() {
        let pair = AsyncStream.makeStream(of: LiveClientEvent.self)
        events = pair.stream
        eventContinuation = pair.continuation

        peer.onOpened = { [weak self] in
            Task { try? await self?.notify("webrtc.opened", params: EmptyParams()) }
        }
        peer.onFailure = { [weak self] error in self?.fail(error) }
        peer.onLevels = { [weak self] input, output, speechActive in
            guard let self else { return }
            self.emit(.levels(input: input, output: output, speechActive: speechActive))
            Task {
                try? await self.notify(
                    "audio.levels",
                    params: AudioLevelsParams(input: input, output: output, speechActive: speechActive)
                )
            }
        }
    }

    func connect(
        pairingURL: String,
        preferredTransport: PreferredTransport,
        coderToken: String,
        sshTarget: String,
        voice: LiveVoice,
        customInstructions: String,
        diagnosticsEnabled: Bool
    ) async throws {
        close()
        ending = false
        stopFinished = false
        preferredVoice = voice
        guard await requestMicrophonePermission() else { throw PiLiveError.microphoneDenied }
        let envelope = try PairingEnvelope(uri: pairingURL.trimmingCharacters(in: .whitespacesAndNewlines))
        let resolved = try await resolveEndpoint(
            envelope.payload.endpoints,
            preferredTransport: preferredTransport,
            coderToken: coderToken,
            sshTarget: sshTarget
        )
        var request = URLRequest(url: resolved.url)
        request.timeoutInterval = 15
        if resolved.needsCoderToken {
            guard !coderToken.isEmpty else { throw PiLiveError.missingCoderToken }
            request.setValue(coderToken, forHTTPHeaderField: "Coder-Session-Token")
        }
        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: request)
        self.session = session
        self.socket = socket
        socket.resume()
        emit(.phase(.pairing))

        try await send(RPCRequest(
            id: .string("pair"),
            method: "pair",
            params: PairRequestParams(
                protocolVersion: livePairingProtocolVersion,
                secret: envelope.secret,
                client: .init(
                    name: Host.current().localizedName ?? "Mac",
                    platform: "macOS",
                    appVersion: "0.1.0"
                ),
                capabilities: .init(
                    webrtc: true,
                    inputLevel: true,
                    outputLevel: true,
                    deviceSelection: false
                ),
                preferences: .init(
                    voice: voice.rawValue,
                    instructions: customInstructions,
                    diagnosticsEnabled: diagnosticsEnabled
                )
            )
        ))
        let pairResponse = try await receiveFrame()
        if let error = pairResponse.error {
            throw PiLiveError.pairingRejected(error.message)
        }
        guard pairResponse.result != nil else {
            throw PiLiveError.protocolError("Pair response is missing result")
        }
        emit(.phase(.connecting))
        receiveTask = Task { [weak self] in await self?.receiveLoop() }
    }

    func toggleMute() async {
        muted.toggle()
        peer.setMuted(muted)
        try? await notify("audio.muted", params: MutedParams(muted: muted))
        emit(.phase(muted ? .muted : .listening))
    }

    func setPreferredVoice(_ voice: LiveVoice) {
        preferredVoice = voice
        guard socket != nil else { return }
        Task {
            try? await notify("settings.setVoice", params: VoicePreferenceParams(voice: voice.rawValue))
        }
    }

    func setCustomInstructions(_ instructions: String) {
        guard socket != nil else { return }
        Task {
            try? await notify(
                "settings.setInstructions",
                params: InstructionsPreferenceParams(instructions: instructions)
            )
        }
    }

    func setDiagnosticsEnabled(_ enabled: Bool) {
        guard socket != nil else { return }
        Task {
            try? await notify(
                "settings.setDiagnostics",
                params: DiagnosticsPreferenceParams(enabled: enabled)
            )
        }
    }

    func endSession() async {
        guard !stopFinished else { return }
        await withCheckedContinuation { continuation in
            stopWaiters.append(continuation)
            guard !ending else { return }
            ending = true
            emit(.phase(.ending))
            guard socket != nil else {
                finishStop()
                return
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    try await self.notify("session.stop", params: StopParams(reason: "user"))
                    self.endingTask?.cancel()
                    self.endingTask = Task { @MainActor [weak self] in
                        try? await Task.sleep(for: .milliseconds(1_500))
                        guard !Task.isCancelled else { return }
                        self?.finishStop()
                    }
                } catch {
                    self.finishStop()
                }
            }
        }
    }

    func close() {
        endingTask?.cancel()
        endingTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        if let socket {
            socket.cancel(with: .normalClosure, reason: nil)
        }
        socket = nil
        session?.invalidateAndCancel()
        session = nil
        peer.close()
        tunnel.close()
    }

    private func receiveLoop() async {
        do {
            while !Task.isCancelled {
                try await handle(receiveFrame())
            }
        } catch is CancellationError {
        } catch {
            if ending { finishStop() }
            else { fail(error) }
        }
    }

    private func handle(_ frame: RPCIncomingFrame) async throws {
        guard let method = frame.method else { return }
        if let id = frame.id {
            do {
                try await handleRequest(method, id: id, params: frame.params)
            } catch {
                try await send(RPCFailure(
                    id: id,
                    error: RPCErrorPayload(code: -32000, message: error.localizedDescription)
                ))
            }
            return
        }

        switch method {
        case "session.phase":
            let params = try frame.params.decode(PhaseParams.self)
            emit(.phase(LivePhase(rawValue: params.phase) ?? .connecting))
        case "transcript.updated":
            emit(.transcript(try frame.params.decode(TranscriptParams.self).text))
        case "audio.setMuted":
            let params = try frame.params.decode(MutedParams.self)
            muted = params.muted
            peer.setMuted(muted)
        case "session.stop":
            ending = true
            finishStop()
        case "settings.voice":
            let params = try frame.params.decode(VoiceSettingParams.self)
            if params.saved == true,
               let rawVoice = params.voice,
               let voice = LiveVoice(rawValue: rawVoice)
            {
                preferredVoice = voice
                emit(.voiceSetting(voice: voice, appliesTo: params.appliesTo ?? "next-session"))
            } else if let message = params.message {
                emit(.failure(PiLiveError.protocolError(message).localizedDescription))
            }
        case "settings.instructions":
            let params = try frame.params.decode(InstructionsSettingParams.self)
            if params.saved == true {
                emit(.instructionsSetting(appliesTo: params.appliesTo ?? "next-session"))
            } else if let message = params.message {
                emit(.failure(PiLiveError.protocolError(message).localizedDescription))
            }
        case "settings.diagnostics":
            let params = try frame.params.decode(DiagnosticsSettingParams.self)
            if params.saved == true, let enabled = params.enabled {
                emit(.diagnosticsSetting(
                    enabled: enabled,
                    appliesTo: params.appliesTo ?? "current"
                ))
            } else if let message = params.message {
                emit(.failure(PiLiveError.protocolError(message).localizedDescription))
            }
        case "ping":
            try await notify(
                "pong",
                params: PongParams(timestamp: Date().timeIntervalSince1970 * 1_000)
            )
        default:
            break
        }
    }

    private func handleRequest(_ method: String, id: RPCID, params: JSONValue?) async throws {
        switch method {
        case "codex.createAttestation":
            try await send(RPCSuccess(id: id, result: await CodexDeviceCheck.generate()))
        case "webrtc.createOffer":
            try await send(RPCSuccess(id: id, result: OfferResult(sdp: try await peer.createOffer())))
        case "webrtc.acceptAnswer":
            let answer = try params.decode(AcceptAnswerParams.self)
            try await peer.acceptAnswer(answer.sdp)
            try await send(RPCSuccess(id: id, result: AcceptAnswerResult(accepted: true)))
        default:
            throw PiLiveError.protocolError("Unsupported request: \(method)")
        }
    }

    private func notify<Params: Encodable>(_ method: String, params: Params) async throws {
        try await send(RPCNotification(method: method, params: params))
    }

    private func send<Message: Encodable>(_ message: Message) async throws {
        guard let socket else { throw PiLiveError.protocolError("Pairing socket is closed") }
        let data = try encoder.encode(message)
        guard let string = String(data: data, encoding: .utf8) else {
            throw PiLiveError.protocolError("Unable to encode JSON-RPC message")
        }
        try await socket.send(.string(string))
    }

    private func receiveFrame() async throws -> RPCIncomingFrame {
        guard let socket else { throw PiLiveError.protocolError("Pairing socket is closed") }
        let message = try await socket.receive()
        let data: Data
        switch message {
        case let .string(value): data = Data(value.utf8)
        case let .data(value): data = value
        @unknown default: throw PiLiveError.protocolError("Unsupported WebSocket frame")
        }
        return try decoder.decode(RPCIncomingFrame.self, from: data)
    }

    private func resolveEndpoint(
        _ endpoints: [PairingEndpoint],
        preferredTransport: PreferredTransport,
        coderToken: String,
        sshTarget: String
    ) async throws -> (url: URL, needsCoderToken: Bool) {
        let ordered: [PreferredTransport] = preferredTransport == .automatic
            ? [.coder, .ssh, .local, .direct]
            : [preferredTransport]
        for preference in ordered {
            for endpoint in endpoints {
                switch (preference, endpoint) {
                case let (.coder, .coder(url)) where !coderToken.isEmpty:
                    return (url, true)
                case let (.ssh, .ssh(remoteHost, remotePort, targetHint)):
                    let target = sshTarget.isEmpty ? (targetHint ?? "") : sshTarget
                    guard !target.isEmpty else { continue }
                    return (
                        try await tunnel.open(
                            target: target,
                            remoteHost: remoteHost,
                            remotePort: remotePort
                        ),
                        false
                    )
                case let (.local, .local(url)):
                    return (url, false)
                case let (.direct, .direct(url)):
                    return (url, false)
                default:
                    continue
                }
            }
        }
        if preferredTransport == .coder { throw PiLiveError.missingCoderToken }
        if preferredTransport == .ssh { throw PiLiveError.missingSSHTarget }
        throw PiLiveError.unsupportedTransport
    }

    private func requestMicrophonePermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: true
        case .denied, .restricted: false
        case .notDetermined: await AVCaptureDevice.requestAccess(for: .audio)
        @unknown default: false
        }
    }

    private func fail(_ error: Error) {
        guard !ending, !stopFinished else { return }
        emit(.phase(.error))
        emit(.failure(error.localizedDescription))
        Task {
            try? await notify("client.error", params: ErrorMessageParams(message: error.localizedDescription))
        }
    }

    private func finishStop() {
        guard !stopFinished else { return }
        stopFinished = true
        endingTask?.cancel()
        endingTask = nil
        close()
        emit(.stopped)
        let waiters = stopWaiters
        stopWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    private func emit(_ event: LiveClientEvent) {
        eventContinuation.yield(event)
    }
}
