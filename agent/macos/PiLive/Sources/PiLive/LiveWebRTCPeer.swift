import Foundation
@preconcurrency import WebRTC

@MainActor
final class LiveWebRTCPeer: NSObject {
    var onOpened: (() -> Void)?
    var onFailure: ((Error) -> Void)?

    private let factory: RTCPeerConnectionFactory
    private var peerConnection: RTCPeerConnection?
    private var audioTrack: RTCAudioTrack?
    private var dataChannel: RTCDataChannel?
    private var gatheringContinuation: CheckedContinuation<String, Error>?
    private var muted = false

    override init() {
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory()
        super.init()
    }

    func createOffer() async throws -> String {
        close()
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
    }

    func setMuted(_ muted: Bool) {
        self.muted = muted
        audioTrack?.isEnabled = !muted
    }

    func close() {
        gatheringContinuation?.resume(throwing: CancellationError())
        gatheringContinuation = nil
        dataChannel?.close()
        dataChannel = nil
        peerConnection?.close()
        peerConnection = nil
        audioTrack = nil
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
                self?.onFailure?(PiLiveError.protocolError("WebRTC connection failed"))
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
