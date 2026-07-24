import Foundation
@preconcurrency import WebRTC

@MainActor
final class LiveWebRTCPeer: NSObject {
    var onOpened: (() -> Void)?
    var onFailure: ((Error) -> Void)?
    var onLevels: ((Double, Double, Bool) -> Void)?

    private let factory: RTCPeerConnectionFactory
    private var peerConnection: RTCPeerConnection?
    private var audioTrack: RTCAudioTrack?
    private var dataChannel: RTCDataChannel?
    private var gatheringContinuation: CheckedContinuation<String, Error>?
    private var levelTask: Task<Void, Never>?
    private var statsPending = false
    private var inputLevel = 0.0
    private var outputLevel = 0.0
    private var muted = false
    private var closing = false
    private var speechHangoverFrames = 0

    override init() {
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory()
        super.init()
    }

    func createOffer() async throws -> String {
        close()
        closing = false
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
        )
        guard let peer = factory.peerConnection(
            with: configuration,
            constraints: constraints,
            delegate: self
        ) else {
            throw PiLiveError.protocolError("Unable to create WebRTC peer")
        }
        peerConnection = peer

        let audioSource = factory.audioSource(with: RTCMediaConstraints(
            mandatoryConstraints: [
                "googEchoCancellation": "true",
                "googAutoGainControl": "true",
                "googNoiseSuppression": "true",
                "googHighpassFilter": "true",
            ],
            optionalConstraints: nil
        ))
        let audioTrack = factory.audioTrack(with: audioSource, trackId: "pi-live-audio")
        audioTrack.isEnabled = !muted
        self.audioTrack = audioTrack
        peer.add(audioTrack, streamIds: ["pi-live"])

        let channelConfiguration = RTCDataChannelConfiguration()
        channelConfiguration.isOrdered = true
        guard let channel = peer.dataChannel(forLabel: "oai-events", configuration: channelConfiguration)
        else { throw PiLiveError.protocolError("Unable to create oai-events data channel") }
        channel.delegate = self
        dataChannel = channel

        let offer = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<RTCSessionDescription, Error>) in
            peer.offer(for: RTCMediaConstraints(
                mandatoryConstraints: [
                    "OfferToReceiveAudio": "true",
                    "OfferToReceiveVideo": "false",
                    "VoiceActivityDetection": "true",
                ],
                optionalConstraints: nil
            )) { description, error in
                if let error { continuation.resume(throwing: error) }
                else if let description { continuation.resume(returning: description) }
                else { continuation.resume(throwing: PiLiveError.protocolError("WebRTC returned no offer")) }
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(offer) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
        if peer.iceGatheringState == .complete, let sdp = peer.localDescription?.sdp {
            return sdp
        }
        return try await withCheckedThrowingContinuation { continuation in
            gatheringContinuation = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(8))
                guard let self, let pending = self.gatheringContinuation else { return }
                self.gatheringContinuation = nil
                if let sdp = self.peerConnection?.localDescription?.sdp {
                    pending.resume(returning: sdp)
                } else {
                    pending.resume(throwing: PiLiveError.protocolError("ICE gathering produced no SDP"))
                }
            }
        }
    }

    func acceptAnswer(_ sdp: String) async throws {
        guard let peerConnection else { throw PiLiveError.protocolError("WebRTC peer is not started") }
        let answer = RTCSessionDescription(type: .answer, sdp: sdp)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peerConnection.setRemoteDescription(answer) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
        startLevelMonitoring()
    }

    func setMuted(_ muted: Bool) {
        self.muted = muted
        audioTrack?.isEnabled = !muted
        if muted {
            inputLevel = 0
            onLevels?(0, outputLevel, false)
        }
    }

    func close() {
        closing = true
        levelTask?.cancel()
        levelTask = nil
        statsPending = false
        gatheringContinuation?.resume(throwing: CancellationError())
        gatheringContinuation = nil
        let channel = dataChannel
        dataChannel = nil
        let peer = peerConnection
        peerConnection = nil
        channel?.delegate = nil
        channel?.close()
        peer?.close()
        audioTrack = nil
        inputLevel = 0
        outputLevel = 0
        speechHangoverFrames = 0
    }

    private func startLevelMonitoring() {
        levelTask?.cancel()
        levelTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.pollAudioLevels()
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    private func pollAudioLevels() {
        guard !statsPending, let peerConnection else { return }
        statsPending = true
        peerConnection.statistics { [weak self] report in
            let levels = Self.extractAudioLevels(from: report)
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.statsPending = false
                self.consumeAudioLevels(input: levels.input, output: levels.output)
            }
        }
    }

    nonisolated private static func extractAudioLevels(
        from report: RTCStatisticsReport
    ) -> (input: Double, output: Double) {
        var input = 0.0
        var output = 0.0
        for statistic in report.statistics.values {
            let kind = (statistic.values["kind"] as? NSString) as String?
                ?? (statistic.values["mediaType"] as? NSString) as String?
            guard kind == "audio", let value = statistic.values["audioLevel"] as? NSNumber else {
                continue
            }
            let level = min(1, max(0, value.doubleValue))
            if statistic.type == "media-source" || statistic.type == "outbound-rtp" {
                input = max(input, level)
            } else if statistic.type == "inbound-rtp" {
                output = max(output, level)
            }
        }
        return (input, output)
    }

    private func consumeAudioLevels(input rawInput: Double, output rawOutput: Double) {
        let inputSample = muted ? 0 : max(0, rawInput - 0.004)
        let outputSample = max(0, rawOutput - 0.002)
        inputLevel = smoothLevel(current: inputLevel, sample: inputSample)
        outputLevel = smoothLevel(current: outputLevel, sample: outputSample)
        // This is presentation-only audio activity. WebRTC M150 owns media VAD/APM,
        // and Codex Live owns conversational end-of-turn detection.
        if !muted && inputLevel >= 0.022 {
            speechHangoverFrames = 6
        } else if speechHangoverFrames > 0 {
            speechHangoverFrames -= 1
        }
        let inputActive = !muted && speechHangoverFrames > 0
        onLevels?(inputLevel, outputLevel, inputActive)
    }

    private func smoothLevel(current: Double, sample: Double) -> Double {
        let coefficient = sample > current ? 0.26 : 0.075
        let smoothed = current + (sample - current) * coefficient
        return smoothed < 0.001 ? 0 : smoothed
    }

    deinit { RTCCleanupSSL() }
}

extension LiveWebRTCPeer: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        if newState == .failed || newState == .closed {
            Task { @MainActor [weak self] in
                guard let self,
                      self.peerConnection === peerConnection,
                      !self.closing
                else { return }
                self.onFailure?(PiLiveError.protocolError("WebRTC connection failed"))
            }
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        guard newState == .complete else { return }
        Task { @MainActor [weak self] in
            guard let self, let continuation = self.gatheringContinuation else { return }
            self.gatheringContinuation = nil
            if let sdp = self.peerConnection?.localDescription?.sdp {
                continuation.resume(returning: sdp)
            } else {
                continuation.resume(throwing: PiLiveError.protocolError("ICE gathering produced no SDP"))
            }
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        Task { @MainActor [weak self] in
            dataChannel.delegate = self
            self?.dataChannel = dataChannel
        }
    }
}

extension LiveWebRTCPeer: RTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        guard dataChannel.readyState == .open else { return }
        Task { @MainActor [weak self] in self?.onOpened?() }
    }

    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        // The workspace sideband owns control events. This channel remains open
        // because the OpenAI live peer requires it for call readiness.
    }
}
