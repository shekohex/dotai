import Foundation
import XCTest
@testable import PiLive

final class OrbStateResolverTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 2_000)

    func testTransportAudioAndRemoteActivityPrecedence() {
        XCTAssertEqual(resolve(phase: .connecting, remote: .working), .syncing)
        XCTAssertEqual(resolve(phase: .working, outputActive: true, remote: .checkingSubagents), .talking)
        XCTAssertEqual(resolve(phase: .working, muted: true, remote: .working), .working)
        XCTAssertEqual(resolve(phase: .working, remote: .checkingSubagents), .checkingSubagents)
        XCTAssertEqual(resolve(phase: .listening, speechActive: true), .listening)
        XCTAssertEqual(resolve(phase: .listening, mediaSessionActive: true), .idle)
        XCTAssertEqual(resolve(phase: .ending, outputActive: true, remote: .failure), .ending)
    }

    func testMuteDoesNotChangeClipOrPlaybackEpoch() {
        let unmutedState = resolve(phase: .working, muted: false, remote: .thinking)
        let mutedState = resolve(phase: .working, muted: true, remote: .thinking)

        XCTAssertEqual(mutedState, unmutedState)
        XCTAssertEqual(mutedState, .thinking)
        XCTAssertEqual(
            OrbPlaybackIdentity(
                packID: "miss-minutes",
                state: mutedState,
                animated: true,
                reducedMotion: false
            ),
            OrbPlaybackIdentity(
                packID: "miss-minutes",
                state: unmutedState,
                animated: true,
                reducedMotion: false
            )
        )
    }

    @MainActor
    func testToggleMutePublishesBadgeStateWithoutSemanticPhase() async {
        let client = LivePairingClient()
        var events = client.events.makeAsyncIterator()

        await client.toggleMute()

        while let event = await events.next() {
            switch event {
            case .muted(true): return
            case .phase:
                return XCTFail("Mute toggle changed semantic phase")
            default:
                continue
            }
        }
        XCTFail("Mute toggle did not publish badge state")
    }

    func testSuccessAndFailureDecayToWaiting() {
        let recentSuccess = ActivitySnapshotParams(
            revision: 4,
            state: .success,
            updatedAt: now.timeIntervalSince1970 * 1_000
        )
        let staleFailure = ActivitySnapshotParams(
            revision: 5,
            state: .failure,
            updatedAt: (now.timeIntervalSince1970 - 2) * 1_000
        )

        XCTAssertEqual(resolve(phase: .working, snapshot: recentSuccess), .success)
        XCTAssertEqual(resolve(phase: .working, snapshot: staleFailure), .waiting)
    }

    func testDwellDefersNonUrgentStateChanges() {
        let result = OrbStateResolver.resolve(
            inputs: OrbStateInputs(
                phase: .working,
                muted: false,
                outputActive: false,
                speechActive: false,
                mediaSessionActive: false,
                remoteActivity: snapshot(.thinking)
            ),
            currentState: .working,
            stateEnteredAt: now.addingTimeInterval(-0.05),
            now: now
        )

        XCTAssertEqual(result.state, .working)
        XCTAssertNotNil(result.reevaluateAt)
    }

    func testSnapshotRevisionDecodesWithoutProtocolVersionChange() throws {
        XCTAssertEqual(livePairingProtocolVersion, 2)
        let frame = try JSONDecoder().decode(
            RPCIncomingFrame.self,
            from: Data(#"{"jsonrpc":"2.0","method":"activity.snapshot","params":{"revision":7,"state":"checkingSubagents","updatedAt":1234}}"#.utf8)
        )
        XCTAssertEqual(try frame.params.decode(ActivitySnapshotParams.self), ActivitySnapshotParams(
            revision: 7,
            state: .checkingSubagents,
            updatedAt: 1_234
        ))
    }

    private func resolve(
        phase: LivePhase,
        muted: Bool = false,
        outputActive: Bool = false,
        speechActive: Bool = false,
        mediaSessionActive: Bool = false,
        remote: RemoteActivityState? = nil,
        snapshot: ActivitySnapshotParams? = nil
    ) -> OrbVisualState {
        OrbStateResolver.resolve(
            inputs: OrbStateInputs(
                phase: phase,
                muted: muted,
                outputActive: outputActive,
                speechActive: speechActive,
                mediaSessionActive: mediaSessionActive,
                remoteActivity: snapshot ?? remote.map(self.snapshot)
            ),
            currentState: .idle,
            stateEnteredAt: now.addingTimeInterval(-1),
            now: now
        ).state
    }

    private func snapshot(_ state: RemoteActivityState) -> ActivitySnapshotParams {
        ActivitySnapshotParams(
            revision: 1,
            state: state,
            updatedAt: now.timeIntervalSince1970 * 1_000
        )
    }
}
