import AVFoundation
import Foundation

@MainActor
final class LivePairingClient {
    var onPhase: ((LivePhase) -> Void)?
    var onTranscript: ((String) -> Void)?
    var onError: ((Error) -> Void)?
    var onStopped: (() -> Void)?
    var onLevels: ((Double, Double, Bool) -> Void)?
    var onVoiceSetting: ((LiveVoice, String) -> Void)?
    var onInstructionsSetting: ((String) -> Void)?

    private let peer = LiveWebRTCPeer()
    private let tunnel = SSHTunnel()
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
        peer.onOpened = { [weak self] in
            Task { try? await self?.notify("webrtc.opened", params: [:]) }
        }
        peer.onFailure = { [weak self] error in self?.fail(error) }
        peer.onLevels = { [weak self] input, output, speechActive in
            guard let self else { return }
            self.onLevels?(input, output, speechActive)
            Task {
                try? await self.notify("audio.levels", params: [
                    "input": input,
                    "output": output,
                    "speechActive": speechActive,
                ])
            }
        }
    }

    func connect(
        pairingURL: String,
        preferredTransport: PreferredTransport,
        coderToken: String,
        sshTarget: String,
        voice: LiveVoice,
        customInstructions: String
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
        onPhase?(.pairing)
        try await send([
            "jsonrpc": "2.0",
            "id": "pair",
            "method": "pair",
            "params": [
                "protocolVersion": livePairingProtocolVersion,
                "secret": envelope.secret,
                "client": [
                    "name": Host.current().localizedName ?? "Mac",
                    "platform": "macOS",
                    "appVersion": "0.1.0",
                ],
                "capabilities": [
                    "webrtc": true,
                    "inputLevel": true,
                    "outputLevel": true,
                    "deviceSelection": false,
                ],
                "preferences": [
                    "voice": voice.rawValue,
                    "instructions": customInstructions,
                ],
            ],
        ])
        let pairResponse = try await receiveObject()
        if let error = pairResponse["error"] as? [String: Any] {
            throw PiLiveError.pairingRejected(error["message"] as? String ?? "unknown error")
        }
        guard pairResponse["result"] != nil else {
            throw PiLiveError.protocolError("Pair response is missing result")
        }
        onPhase?(.connecting)
        receiveTask = Task { [weak self] in await self?.receiveLoop() }
    }

    func toggleMute() async {
        muted.toggle()
        peer.setMuted(muted)
        try? await notify("audio.muted", params: ["muted": muted])
        onPhase?(muted ? .muted : .listening)
    }

    func setPreferredVoice(_ voice: LiveVoice) {
        preferredVoice = voice
        guard socket != nil else { return }
        Task {
            try? await notify("settings.setVoice", params: ["voice": voice.rawValue])
        }
    }

    func setCustomInstructions(_ instructions: String) {
        guard socket != nil else { return }
        Task {
            try? await notify("settings.setInstructions", params: ["instructions": instructions])
        }
    }

    func endSession() async {
        guard !stopFinished else { return }
        await withCheckedContinuation { continuation in
            stopWaiters.append(continuation)
            guard !ending else { return }
            ending = true
            onPhase?(.ending)
            guard socket != nil else {
                finishStop()
                return
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    try await self.notify("session.stop", params: ["reason": "user"])
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
                let object = try await receiveObject()
                try await handle(object)
            }
        } catch is CancellationError {
        } catch {
            if ending { finishStop() }
            else { fail(error) }
        }
    }

    private func handle(_ object: [String: Any]) async throws {
        guard let method = object["method"] as? String else { return }
        let params = object["params"] as? [String: Any] ?? [:]
        if let id = object["id"] {
            do {
                let result = try await handleRequest(method, params: params)
                try await send(["jsonrpc": "2.0", "id": id, "result": result])
            } catch {
                try await send([
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": ["code": -32000, "message": error.localizedDescription],
                ])
            }
            return
        }
        switch method {
        case "session.phase":
            if let value = params["phase"] as? String { onPhase?(LivePhase(rawValue: value) ?? .connecting) }
        case "transcript.updated":
            if let text = params["text"] as? String { onTranscript?(text) }
        case "audio.setMuted":
            muted = params["muted"] as? Bool ?? false
            peer.setMuted(muted)
        case "session.stop":
            ending = true
            finishStop()
        case "settings.voice":
            let saved = params["saved"] as? Bool ?? false
            if saved,
               let rawVoice = params["voice"] as? String,
               let voice = LiveVoice(rawValue: rawVoice)
            {
                preferredVoice = voice
                let appliesTo = params["appliesTo"] as? String ?? "next-session"
                onVoiceSetting?(voice, appliesTo)
            } else if let message = params["message"] as? String {
                onError?(PiLiveError.protocolError(message))
            }
        case "settings.instructions":
            let saved = params["saved"] as? Bool ?? false
            if saved {
                let appliesTo = params["appliesTo"] as? String ?? "next-session"
                onInstructionsSetting?(appliesTo)
            } else if let message = params["message"] as? String {
                onError?(PiLiveError.protocolError(message))
            }
        case "ping":
            try await notify("pong", params: ["timestamp": Date().timeIntervalSince1970 * 1_000])
        default:
            break
        }
    }

    private func handleRequest(_ method: String, params: [String: Any]) async throws -> [String: Any] {
        switch method {
        case "codex.createAttestation":
            return await CodexDeviceCheck.generate()
        case "webrtc.createOffer":
            return ["sdp": try await peer.createOffer()]
        case "webrtc.acceptAnswer":
            guard let sdp = params["sdp"] as? String else {
                throw PiLiveError.protocolError("acceptAnswer is missing SDP")
            }
            try await peer.acceptAnswer(sdp)
            return ["accepted": true]
        default:
            throw PiLiveError.protocolError("Unsupported request: \(method)")
        }
    }

    private func notify(_ method: String, params: [String: Any]) async throws {
        try await send(["jsonrpc": "2.0", "method": method, "params": params])
    }

    private func send(_ object: [String: Any]) async throws {
        guard let socket else { throw PiLiveError.protocolError("Pairing socket is closed") }
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let string = String(data: data, encoding: .utf8) else {
            throw PiLiveError.protocolError("Unable to encode JSON-RPC message")
        }
        try await socket.send(.string(string))
    }

    private func receiveObject() async throws -> [String: Any] {
        guard let socket else { throw PiLiveError.protocolError("Pairing socket is closed") }
        let message = try await socket.receive()
        let data: Data
        switch message {
        case let .string(value): data = Data(value.utf8)
        case let .data(value): data = value
        @unknown default: throw PiLiveError.protocolError("Unsupported WebSocket frame")
        }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PiLiveError.protocolError("Invalid JSON-RPC frame")
        }
        return object
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
                    return (try await tunnel.open(target: target, remoteHost: remoteHost, remotePort: remotePort), false)
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
        onPhase?(.error)
        onError?(error)
        Task { try? await notify("client.error", params: ["message": error.localizedDescription]) }
    }

    private func finishStop() {
        guard !stopFinished else { return }
        stopFinished = true
        endingTask?.cancel()
        endingTask = nil
        close()
        onStopped?()
        let waiters = stopWaiters
        stopWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }
}
