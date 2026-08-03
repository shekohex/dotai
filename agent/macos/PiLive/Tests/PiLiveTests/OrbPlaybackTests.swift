import AppKit
import XCTest
@testable import PiLive

final class OrbPlaybackTests: XCTestCase {
    private struct FakePlaybackClock {
        var elapsedMilliseconds = 0

        mutating func advance(
            timeline: inout OrbPlaybackTimeline,
            to targetMilliseconds: Int,
            deliveringEachDeadline: Bool
        ) -> [Int] {
            var publications: [Int] = []
            if deliveringEachDeadline {
                while let deadline = timeline.nextDeadlineMilliseconds,
                      deadline <= targetMilliseconds
                {
                    elapsedMilliseconds = deadline
                    if let frame = timeline.advance(to: deadline) { publications.append(frame) }
                }
            }
            elapsedMilliseconds = targetMilliseconds
            if let frame = timeline.advance(to: targetMilliseconds) { publications.append(frame) }
            return publications
        }
    }

    func testDoesNotPublishBeforeFrameDeadline() throws {
        var timeline = try XCTUnwrap(OrbPlaybackTimeline(
            sequence: sequence(frames: [1, 2], duration: 100),
            reducedMotion: false
        ))

        XCTAssertEqual(timeline.currentFrame, 1)
        XCTAssertEqual(timeline.nextDeadlineMilliseconds, 100)
        XCTAssertNil(timeline.advance(to: 99))
        XCTAssertEqual(timeline.currentFrame, 1)
        XCTAssertEqual(timeline.advance(to: 100), 2)
    }

    func testRepeatedPhysicalFrameDoesNotPublishInvalidation() throws {
        var timeline = try XCTUnwrap(OrbPlaybackTimeline(
            sequence: sequence(frames: [1, 1, 2], duration: 100),
            reducedMotion: false
        ))

        XCTAssertNil(timeline.advance(to: 100))
        XCTAssertEqual(timeline.nextDeadlineMilliseconds, 200)
        XCTAssertEqual(timeline.advance(to: 200), 2)
    }

    func testReducedMotionUsesStaticFrameAndSchedulesNoDeadline() throws {
        var timeline = try XCTUnwrap(OrbPlaybackTimeline(
            sequence: OrbSequenceManifest(
                frames: [3, 4, 5],
                frameDurationMilliseconds: 100,
                looping: true,
                reducedMotionFrame: 4,
                fallbackState: nil
            ),
            reducedMotion: true
        ))

        XCTAssertEqual(timeline.currentFrame, 4)
        XCTAssertNil(timeline.nextDeadlineMilliseconds)
        XCTAssertNil(timeline.advance(to: 10_000))
    }

    func testFiniteSequenceStopsAtFinalFrame() throws {
        var timeline = try XCTUnwrap(OrbPlaybackTimeline(
            sequence: OrbSequenceManifest(
                frames: [5, 6],
                frameDurationMilliseconds: 100,
                looping: false,
                reducedMotionFrame: 5,
                fallbackState: nil
            ),
            reducedMotion: false
        ))

        XCTAssertEqual(timeline.advance(to: 900), 6)
        XCTAssertNil(timeline.nextDeadlineMilliseconds)
        XCTAssertNil(timeline.advance(to: 10_000))
    }

    func testMovingIdleSelectsAndAdvancesInstalledWalkingFrames() throws {
        let pack = try XCTUnwrap(OrbCatalog.load().packs.first)
        XCTAssertEqual(
            DesktopPetVisualResolver.state(semanticState: .idle, isWalking: false),
            .idle
        )
        let movingState = DesktopPetVisualResolver.state(
            semanticState: .idle,
            isWalking: true
        )
        XCTAssertEqual(movingState, .working)
        let working = try XCTUnwrap(pack.resolvedSequence(for: movingState))
        let frames = try XCTUnwrap(working.frames)
        XCTAssertEqual(frames, Array(40 ... 47))
        var timeline = try XCTUnwrap(OrbPlaybackTimeline(
            sequence: working,
            reducedMotion: false
        ))

        XCTAssertEqual(timeline.currentFrame, 40)
        XCTAssertEqual(
            timeline.advance(to: try XCTUnwrap(working.frameDurationMilliseconds)),
            41
        )
        XCTAssertEqual(
            OrbRenderFrameResolver.frameIndex(pack: pack, state: movingState, framePhase: 0),
            40
        )
        XCTAssertEqual(
            OrbRenderFrameResolver.frameIndex(pack: pack, state: movingState, framePhase: 1),
            41
        )
        XCTAssertEqual(
            OrbRenderFrameResolver.frameIndex(pack: pack, state: movingState, framePhase: 8),
            40
        )
    }

    func testInstalledListeningAndTalkingCadenceDoesNotAccelerate() throws {
        let pack = try XCTUnwrap(OrbCatalog.load().packs.first)
        let listening = try XCTUnwrap(pack.resolvedSequence(for: .listening))
        let talking = try XCTUnwrap(pack.resolvedSequence(for: .talking))

        XCTAssertEqual(listening.frameDurationMilliseconds, 220)
        XCTAssertEqual(talking.frameDurationMilliseconds, 160)
        XCTAssertEqual(try publicationCount(sequence: listening, through: 1_000), 5)
        XCTAssertEqual(try publicationCount(sequence: listening, through: 10_000), 37)
        XCTAssertEqual(try publicationCount(sequence: talking, through: 1_000), 7)
        XCTAssertEqual(try publicationCount(sequence: talking, through: 10_000), 63)
    }

    func testSameStateUpdatesDoNotResetPlaybackIdentity() {
        let firstAudioSample = OrbPlaybackIdentity(
            packID: "miss-minutes",
            state: .talking,
            animated: true,
            reducedMotion: false
        )
        let laterAudioSample = OrbPlaybackIdentity(
            packID: "miss-minutes",
            state: .talking,
            animated: true,
            reducedMotion: false
        )

        XCTAssertEqual(firstAudioSample, laterAudioSample)
    }

    func testGenuineStateTransitionStartsNewStateLocalEpoch() throws {
        let pack = try XCTUnwrap(OrbCatalog.load().packs.first)
        var listening = try XCTUnwrap(OrbPlaybackTimeline(
            sequence: try XCTUnwrap(pack.resolvedSequence(for: .listening)),
            reducedMotion: false
        ))
        var clock = FakePlaybackClock()
        _ = clock.advance(timeline: &listening, to: 4_000, deliveringEachDeadline: true)
        let talking = try XCTUnwrap(OrbPlaybackTimeline(
            sequence: try XCTUnwrap(pack.resolvedSequence(for: .talking)),
            reducedMotion: false
        ))

        XCTAssertNotEqual(listening.currentFrame, 16)
        XCTAssertEqual(talking.currentFrame, 24)
        XCTAssertEqual(talking.nextDeadlineMilliseconds, 160)
    }

    func testDelayedCallbackSkipsMissedFramesAndSchedulesFutureDeadline() throws {
        let pack = try XCTUnwrap(OrbCatalog.load().packs.first)
        var timeline = try XCTUnwrap(OrbPlaybackTimeline(
            sequence: try XCTUnwrap(pack.resolvedSequence(for: .talking)),
            reducedMotion: false
        ))
        var clock = FakePlaybackClock()

        XCTAssertEqual(
            clock.advance(timeline: &timeline, to: 950, deliveringEachDeadline: false),
            [29]
        )
        XCTAssertEqual(timeline.nextDeadlineMilliseconds, 960)
    }

    func testLongElapsedDurationSchedulesOneFutureDeadlineWithoutCatchUp() throws {
        let pack = try XCTUnwrap(OrbCatalog.load().packs.first)
        var timeline = try XCTUnwrap(OrbPlaybackTimeline(
            sequence: try XCTUnwrap(pack.resolvedSequence(for: .talking)),
            reducedMotion: false
        ))
        var clock = FakePlaybackClock()

        XCTAssertEqual(
            clock.advance(timeline: &timeline, to: 36_000_500, deliveringEachDeadline: false),
            [27]
        )
        XCTAssertEqual(timeline.nextDeadlineMilliseconds, 36_000_640)
    }

    @MainActor
    func testRapidStateReplacementKeepsExactlyOneImageLayer() throws {
        let pack = try XCTUnwrap(OrbCatalog.load().packs.first)
        let idle = try XCTUnwrap(pack.resolvedSequence(for: .idle)?.frames?.first)
        let talking = try XCTUnwrap(pack.resolvedSequence(for: .talking)?.frames?.first)
        let idleImage = try XCTUnwrap(OrbFrameStore.shared.frame(pack: pack, frameIndex: idle))
        let talkingImage = try XCTUnwrap(OrbFrameStore.shared.frame(pack: pack, frameIndex: talking))
        let view = OrbFrameLayerView(frame: NSRect(x: 0, y: 0, width: 100, height: 100))

        view.update(image: idleImage, mirroredHorizontally: false)
        view.update(image: talkingImage, mirroredHorizontally: false)
        view.update(image: idleImage, mirroredHorizontally: true)

        XCTAssertEqual(view.imageLayerCount, 1)
        XCTAssertTrue(view.renderedImage === idleImage)
    }

    private func sequence(frames: [Int], duration: Int) -> OrbSequenceManifest {
        OrbSequenceManifest(
            frames: frames,
            frameDurationMilliseconds: duration,
            looping: true,
            reducedMotionFrame: frames[0],
            fallbackState: nil
        )
    }

    private func publicationCount(
        sequence: OrbSequenceManifest,
        through elapsedMilliseconds: Int
    ) throws -> Int {
        var timeline = try XCTUnwrap(OrbPlaybackTimeline(
            sequence: sequence,
            reducedMotion: false
        ))
        var clock = FakePlaybackClock()
        return 1 + clock.advance(
            timeline: &timeline,
            to: elapsedMilliseconds,
            deliveringEachDeadline: true
        ).count
    }
}
