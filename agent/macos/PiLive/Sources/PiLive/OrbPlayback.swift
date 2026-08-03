import AppKit
import Foundation
import Observation

struct OrbPlaybackIdentity: Hashable {
    let packID: String
    let state: OrbVisualState
    let animated: Bool
    let reducedMotion: Bool
}

struct OrbPlaybackTimeline {
    private let frames: [Int]
    private let frameDurationMilliseconds: Int
    private let looping: Bool
    private(set) var currentFrame: Int
    private(set) var nextDeadlineMilliseconds: Int?

    init?(sequence: OrbSequenceManifest, reducedMotion: Bool) {
        guard let frames = sequence.frames, let firstFrame = frames.first else { return nil }
        if reducedMotion {
            let staticFrame = sequence.reducedMotionFrame ?? firstFrame
            self.frames = [staticFrame]
            frameDurationMilliseconds = 1
            looping = false
            currentFrame = staticFrame
            nextDeadlineMilliseconds = nil
            return
        }
        self.frames = frames
        frameDurationMilliseconds = max(1, sequence.frameDurationMilliseconds ?? 1)
        looping = sequence.looping == true
        currentFrame = firstFrame
        nextDeadlineMilliseconds = frames.count > 1 ? frameDurationMilliseconds : nil
    }

    mutating func advance(to elapsedMilliseconds: Int) -> Int? {
        guard let deadline = nextDeadlineMilliseconds,
              elapsedMilliseconds >= deadline
        else { return nil }

        let elapsedFrame = max(0, elapsedMilliseconds / frameDurationMilliseconds)
        let frameOffset = looping
            ? elapsedFrame % frames.count
            : min(elapsedFrame, frames.count - 1)
        let nextFrame = frames[frameOffset]
        if !looping, frameOffset == frames.count - 1 {
            nextDeadlineMilliseconds = nil
        } else {
            nextDeadlineMilliseconds = (elapsedFrame + 1) * frameDurationMilliseconds
        }
        guard nextFrame != currentFrame else { return nil }
        currentFrame = nextFrame
        return nextFrame
    }
}

@MainActor
@Observable
final class OrbPlaybackController {
    private(set) var image: NSImage?
    private(set) var frameIndex: Int?
    private(set) var publicationCount = 0

    func play(
        pack: OrbPackManifest,
        state: OrbVisualState,
        animated: Bool,
        reducedMotion: Bool
    ) async {
        guard let sequence = pack.resolvedSequence(for: state),
              var timeline = OrbPlaybackTimeline(
                  sequence: sequence,
                  reducedMotion: reducedMotion || !animated
              )
        else {
            replaceFrame(nil, pack: pack, force: true)
            return
        }

        replaceFrame(timeline.currentFrame, pack: pack, force: true)
        let startedAt = ProcessInfo.processInfo.systemUptime
        while let deadline = timeline.nextDeadlineMilliseconds {
            let elapsed = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1_000)
            let delay = max(0, deadline - elapsed)
            do {
                try await Task.sleep(for: .milliseconds(delay), tolerance: .milliseconds(4))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            let currentElapsed = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1_000)
            if let nextFrame = timeline.advance(to: currentElapsed) {
                replaceFrame(nextFrame, pack: pack)
            }
        }
    }

    private func replaceFrame(
        _ frameIndex: Int?,
        pack: OrbPackManifest,
        force: Bool = false
    ) {
        guard force || self.frameIndex != frameIndex else { return }
        self.frameIndex = frameIndex
        image = frameIndex.flatMap { OrbFrameStore.shared.frame(pack: pack, frameIndex: $0) }
        publicationCount += 1
    }
}
