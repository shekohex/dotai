import Foundation
import Observation

enum DesktopPetDirection: Equatable, Sendable {
    case left
    case right

    var mirrorsHorizontally: Bool { self == .left }
    var multiplier: CGFloat { self == .left ? -1 : 1 }
    var reversed: DesktopPetDirection { self == .left ? .right : .left }
}

enum DesktopPetMotionPhase: Equatable, Sendable {
    case resting
    case outbound
    case returning
}

struct DesktopPetMotionContext: Equatable, Sendable {
    let semanticState: OrbVisualState
    let livePhase: LivePhase
    let isCompactSurface: Bool
    let reduceMotion: Bool

    var permitsRoaming: Bool {
        guard isCompactSurface, !reduceMotion else { return false }
        guard semanticState == .idle else { return false }
        return ![.pairing, .connecting, .reconnecting, .ending, .error].contains(livePhase)
    }
}

enum DesktopPetVisualResolver {
    static func state(
        semanticState: OrbVisualState,
        isWalking: Bool
    ) -> OrbVisualState {
        isWalking && semanticState == .idle ? .working : semanticState
    }
}

struct DesktopPetPresentation: Equatable, Sendable {
    let visualState: OrbVisualState
    let isMoving: Bool
    let mirroredHorizontally: Bool
    let walkingFramePhase: Int
}

@MainActor
@Observable
final class DesktopPetMotionController {
    static let speed: CGFloat = 42
    static let restDuration: TimeInterval = 2.5
    static let movementTickInterval: TimeInterval = 1.0 / 20.0
    static let walkingFrameDistance = speed * 0.125

    private(set) var direction: DesktopPetDirection
    private(set) var phase: DesktopPetMotionPhase = .resting
    private(set) var origin = CGPoint.zero
    private(set) var isWalking = false
    private(set) var presentation = DesktopPetPresentation(
        visualState: .idle,
        isMoving: false,
        mirroredHorizontally: false,
        walkingFramePhase: 0
    )
    private var hasOrigin = false
    private var outboundDirection: DesktopPetDirection
    private var restUntil = Double.infinity
    private var userInteracting = false
    private var distanceTraveled: CGFloat = 0
    private var walkingFramePhase = 0
    private var context = DesktopPetMotionContext(
        semanticState: .idle,
        livePhase: .idle,
        isCompactSurface: false,
        reduceMotion: false
    )

    init(direction: DesktopPetDirection = .right) {
        self.direction = direction
        outboundDirection = direction
    }

    var ownsWindowPosition: Bool { context.permitsRoaming && hasOrigin }

    func recommendedTickInterval(now: TimeInterval) -> TimeInterval {
        guard ownsWindowPosition, !userInteracting else { return 0.5 }
        switch phase {
        case .outbound, .returning:
            return Self.movementTickInterval
        case .resting:
            return max(0.05, restUntil - now)
        }
    }

    func update(context: DesktopPetMotionContext) {
        self.context = context
        if !context.permitsRoaming { setWalking(false) }
        updatePresentation()
    }

    func beginUserInteraction() {
        userInteracting = true
        setWalking(false)
    }

    func endUserInteraction(
        windowFrame: CGRect,
        visibleFrame: CGRect,
        now: TimeInterval
    ) {
        userInteracting = false
        rebase(windowFrame: windowFrame, visibleFrame: visibleFrame, now: now)
    }

    func reset(direction: DesktopPetDirection = .right) {
        self.direction = direction
        outboundDirection = direction
        phase = .resting
        hasOrigin = false
        restUntil = .infinity
        distanceTraveled = 0
        walkingFramePhase = 0
        setWalking(false)
    }

    func rebase(
        windowFrame: CGRect,
        visibleFrame: CGRect,
        now: TimeInterval
    ) {
        let minimumX = visibleFrame.minX
        let maximumX = max(minimumX, visibleFrame.maxX - windowFrame.width)
        let minimumY = visibleFrame.minY
        let maximumY = max(minimumY, visibleFrame.maxY - windowFrame.height)
        origin = CGPoint(
            x: min(maximumX, max(minimumX, windowFrame.minX)),
            y: min(maximumY, max(minimumY, windowFrame.minY))
        )
        hasOrigin = true
        phase = .resting
        restUntil = now + Self.restDuration
        distanceTraveled = 0
        walkingFramePhase = 0
        if origin.x >= maximumX { direction = .left }
        if origin.x <= minimumX { direction = .right }
        outboundDirection = direction
        setWalking(false)
        updatePresentation()
    }

    func step(
        windowFrame: CGRect,
        visibleFrame: CGRect,
        elapsed: TimeInterval,
        now: TimeInterval
    ) -> CGPoint? {
        defer { updatePresentation() }
        guard context.permitsRoaming, !userInteracting else {
            setWalking(false)
            return nil
        }
        guard hasOrigin else {
            rebase(windowFrame: windowFrame, visibleFrame: visibleFrame, now: now)
            return windowFrame.origin == origin ? nil : origin
        }
        if phase == .resting {
            guard now >= restUntil else {
                setWalking(false)
                return nil
            }
            phase = .outbound
            outboundDirection = direction
        }

        let minimumX = visibleFrame.minX
        let maximumX = max(minimumX, visibleFrame.maxX - windowFrame.width)
        let distance = Self.speed * max(0, elapsed)

        switch phase {
        case .resting:
            return nil
        case .outbound:
            let targetX = outboundDirection == .right ? maximumX : minimumX
            let nextX = windowFrame.minX + outboundDirection.multiplier * distance
            if (outboundDirection == .right && nextX >= targetX)
                || (outboundDirection == .left && nextX <= targetX)
            {
                phase = .returning
                return recordMovement(
                    to: CGPoint(x: targetX, y: origin.y),
                    from: windowFrame.origin
                )
            }
            return recordMovement(
                to: CGPoint(x: nextX, y: origin.y),
                from: windowFrame.origin
            )
        case .returning:
            let returnDirection = outboundDirection.reversed
            let nextX = windowFrame.minX + returnDirection.multiplier * distance
            if (returnDirection == .left && nextX <= origin.x)
                || (returnDirection == .right && nextX >= origin.x)
            {
                phase = .resting
                _ = recordMovement(to: origin, from: windowFrame.origin)
                outboundDirection = direction
                restUntil = now + Self.restDuration
                setWalking(false)
                return origin
            }
            return recordMovement(
                to: CGPoint(x: nextX, y: origin.y),
                from: windowFrame.origin
            )
        }
    }

    private func recordMovement(to target: CGPoint, from current: CGPoint) -> CGPoint {
        let deltaX = target.x - current.x
        guard deltaX != 0 else {
            setWalking(false)
            return target
        }
        direction = deltaX < 0 ? .left : .right
        distanceTraveled += abs(deltaX)
        walkingFramePhase = Int(floor(distanceTraveled / Self.walkingFrameDistance))
        setWalking(true)
        return target
    }

    private func setWalking(_ walking: Bool) {
        guard isWalking != walking else { return }
        isWalking = walking
        updatePresentation()
    }

    private func updatePresentation() {
        let next = DesktopPetPresentation(
            visualState: DesktopPetVisualResolver.state(
                semanticState: context.semanticState,
                isWalking: isWalking
            ),
            isMoving: isWalking,
            mirroredHorizontally: direction.mirrorsHorizontally,
            walkingFramePhase: walkingFramePhase
        )
        if presentation != next { presentation = next }
    }
}
