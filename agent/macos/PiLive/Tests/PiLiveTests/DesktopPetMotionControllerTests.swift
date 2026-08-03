import Foundation
import XCTest
@testable import PiLive

@MainActor
final class DesktopPetMotionControllerTests: XCTestCase {
    private let visibleFrame = CGRect(x: 0, y: 40, width: 200, height: 120)
    private let originFrame = CGRect(x: 80, y: 90, width: 40, height: 40)

    func testCompletesOutboundAndReturnRouteAtExactOrigin() throws {
        let controller = DesktopPetMotionController(direction: .right)
        var movementDirections: [DesktopPetDirection] = []
        controller.update(context: context(state: .idle))
        controller.rebase(windowFrame: originFrame, visibleFrame: visibleFrame, now: 0)

        XCTAssertNil(controller.step(
            windowFrame: originFrame,
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 2.49
        ))
        XCTAssertEqual(controller.phase, .resting)

        let outbound = try applyStep(
            controller: controller,
            windowFrame: originFrame,
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 2.5
        )
        XCTAssertEqual(outbound.x, 122)
        XCTAssertEqual(outbound.y, originFrame.minY)
        XCTAssertEqual(controller.phase, .outbound)
        movementDirections.append(controller.direction)
        XCTAssertFalse(controller.presentation.mirroredHorizontally)

        let edge = try applyStep(
            controller: controller,
            windowFrame: CGRect(origin: outbound, size: originFrame.size),
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 3.5
        )
        XCTAssertEqual(edge.x, 160)
        XCTAssertGreaterThan(edge.x, outbound.x)
        XCTAssertEqual(controller.phase, .returning)
        movementDirections.append(controller.direction)
        XCTAssertEqual(controller.direction, .right)
        XCTAssertFalse(controller.presentation.mirroredHorizontally)

        let returning = try applyStep(
            controller: controller,
            windowFrame: CGRect(origin: edge, size: originFrame.size),
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 4.5
        )
        movementDirections.append(controller.direction)
        XCTAssertLessThan(returning.x, edge.x)
        XCTAssertEqual(controller.direction, .left)
        XCTAssertTrue(controller.presentation.mirroredHorizontally)
        let home = try applyStep(
            controller: controller,
            windowFrame: CGRect(origin: returning, size: originFrame.size),
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 5.5
        )
        XCTAssertEqual(home.x, originFrame.minX)
        XCTAssertEqual(home.y, originFrame.minY)
        XCTAssertEqual(home, originFrame.origin)
        XCTAssertLessThan(home.x, returning.x)
        XCTAssertEqual(controller.phase, .resting)
        XCTAssertFalse(controller.isWalking)
        movementDirections.append(controller.direction)
        XCTAssertEqual(movementDirections.adjacentChangeCount, 1)
        XCTAssertTrue(controller.presentation.mirroredHorizontally)
    }

    func testThinkingPausesRequestedRouteAndKeepsExactlyThinkingVisualState() {
        let controller = DesktopPetMotionController()
        controller.update(context: context(state: .thinking, phase: .working))
        controller.rebase(windowFrame: originFrame, visibleFrame: visibleFrame, now: 0)

        XCTAssertNil(controller.step(
            windowFrame: originFrame,
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 2.5
        ))

        XCTAssertFalse(controller.isWalking)
        XCTAssertEqual(controller.presentation.visualState, .thinking)
        XCTAssertFalse(controller.presentation.isMoving)
        XCTAssertEqual(controller.phase, .resting)
    }

    func testActiveStatePausesAndIdleResumesFromCurrentRoutePosition() throws {
        let controller = DesktopPetMotionController()
        controller.update(context: context(state: .idle))
        controller.rebase(windowFrame: originFrame, visibleFrame: visibleFrame, now: 0)
        let movingOrigin = try applyStep(
            controller: controller,
            windowFrame: originFrame,
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 2.5
        )

        controller.update(context: context(state: .talking, phase: .speaking))
        XCTAssertNil(controller.step(
            windowFrame: CGRect(origin: movingOrigin, size: originFrame.size),
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 3.5
        ))
        XCTAssertEqual(controller.phase, .outbound)
        XCTAssertEqual(controller.presentation.visualState, .talking)
        XCTAssertFalse(controller.presentation.isMoving)

        controller.update(context: context(state: .idle, phase: .listening))
        let resumed = try XCTUnwrap(controller.step(
            windowFrame: CGRect(origin: movingOrigin, size: originFrame.size),
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 4.5
        ))
        XCTAssertGreaterThan(resumed.x, movingOrigin.x)
        XCTAssertEqual(resumed.y, movingOrigin.y)

        controller.update(context: context(state: .idle, phase: .listening, reduceMotion: true))
        XCTAssertNil(controller.step(
            windowFrame: CGRect(origin: resumed, size: originFrame.size),
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 5.5
        ))
    }

    func testEveryActiveSemanticStatePausesAndRendersOnlyItsOwnClip() {
        let activeStates: [OrbVisualState] = [
            .listening,
            .talking,
            .syncing,
            .thinking,
            .working,
            .checkingSubagents,
            .waiting,
            .success,
            .failure,
            .ending,
        ]

        for state in activeStates {
            let controller = DesktopPetMotionController()
            controller.update(context: context(state: state))
            controller.rebase(windowFrame: originFrame, visibleFrame: visibleFrame, now: 0)

            XCTAssertNil(controller.step(
                windowFrame: originFrame,
                visibleFrame: visibleFrame,
                elapsed: 1,
                now: 2.5
            ), "\(state) moved the route")
            XCTAssertEqual(controller.presentation.visualState, state)
            XCTAssertFalse(controller.presentation.isMoving)
        }
    }

    func testUserInteractionRebasesOriginAndRestartsDwell() throws {
        let controller = DesktopPetMotionController()
        controller.update(context: context(state: .idle, phase: .listening))
        controller.rebase(windowFrame: originFrame, visibleFrame: visibleFrame, now: 0)
        controller.beginUserInteraction()
        let draggedFrame = CGRect(x: 20, y: 100, width: 40, height: 40)
        controller.endUserInteraction(
            windowFrame: draggedFrame,
            visibleFrame: visibleFrame,
            now: 10
        )

        XCTAssertNil(controller.step(
            windowFrame: draggedFrame,
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 12.49
        ))
        let resumed = try XCTUnwrap(controller.step(
            windowFrame: draggedFrame,
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 12.5
        ))
        XCTAssertEqual(resumed.x, 62)
        XCTAssertEqual(resumed.y, draggedFrame.minY)
        XCTAssertEqual(controller.origin, draggedFrame.origin)
    }

    func testScreenChangeClampsAndRebasesWithinVisibleFrame() {
        let controller = DesktopPetMotionController(direction: .right)
        controller.update(context: context(state: .thinking, phase: .working))
        let changedVisibleFrame = CGRect(x: -120, y: 80, width: 100, height: 90)
        let outsideFrame = CGRect(x: 50, y: 10, width: 40, height: 40)

        controller.rebase(
            windowFrame: outsideFrame,
            visibleFrame: changedVisibleFrame,
            now: 10
        )

        XCTAssertEqual(controller.origin, CGPoint(x: -60, y: 80))
        XCTAssertEqual(controller.phase, .resting)
        XCTAssertFalse(controller.isWalking)
    }

    func testCoordinatorDisplayMigrationRebasesAtActualPlacedOrigin() throws {
        let controller = DesktopPetMotionController(direction: .right)
        controller.update(context: context(state: .idle))
        let source = CGRect(x: 0, y: 0, width: 1_000, height: 800)
        let destination = CGRect(x: -1_920, y: -80, width: 1_920, height: 1_000)
        let sourceWindow = CGRect(x: 780, y: 430, width: 200, height: 100)
        let migratedOrigin = LiveWindowPlacement.repositionedOrigin(
            windowFrame: sourceWindow,
            from: source,
            to: destination
        )
        let migratedWindow = CGRect(origin: migratedOrigin, size: sourceWindow.size)

        controller.rebase(windowFrame: migratedWindow, visibleFrame: destination, now: 20)

        XCTAssertEqual(controller.origin, migratedOrigin)
        let outbound = try applyStep(
            controller: controller,
            windowFrame: migratedWindow,
            visibleFrame: destination,
            elapsed: 1,
            now: 22.5
        )
        XCTAssertEqual(outbound.y, migratedOrigin.y)
        XCTAssertGreaterThan(outbound.x, migratedOrigin.x)
        let edge = try applyStep(
            controller: controller,
            windowFrame: CGRect(origin: outbound, size: migratedWindow.size),
            visibleFrame: destination,
            elapsed: 100,
            now: 122.5
        )
        let returned = try applyStep(
            controller: controller,
            windowFrame: CGRect(origin: edge, size: migratedWindow.size),
            visibleFrame: destination,
            elapsed: 100,
            now: 222.5
        )
        XCTAssertEqual(returned, migratedOrigin)
    }

    func testLeavingCompactSurfaceStopsRouteImmediately() throws {
        let controller = DesktopPetMotionController()
        controller.update(context: context(state: .idle))
        controller.rebase(windowFrame: originFrame, visibleFrame: visibleFrame, now: 0)
        let moving = try applyStep(
            controller: controller,
            windowFrame: originFrame,
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 2.5
        )

        controller.update(context: DesktopPetMotionContext(
            semanticState: .syncing,
            livePhase: .pairing,
            isCompactSurface: false,
            reduceMotion: false
        ))

        XCTAssertFalse(controller.ownsWindowPosition)
        XCTAssertFalse(controller.isWalking)
        XCTAssertNil(controller.step(
            windowFrame: CGRect(origin: moving, size: originFrame.size),
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 3.5
        ))
    }

    func testUsesDeadlineSchedulingAtRestAndHighCadenceOnlyWhileMoving() throws {
        let controller = DesktopPetMotionController()
        controller.update(context: context(state: .idle))
        controller.rebase(windowFrame: originFrame, visibleFrame: visibleFrame, now: 10)

        XCTAssertEqual(controller.recommendedTickInterval(now: 10), 2.5)
        _ = try XCTUnwrap(controller.step(
            windowFrame: originFrame,
            visibleFrame: visibleFrame,
            elapsed: 0,
            now: 12.5
        ))
        XCTAssertEqual(
            controller.recommendedTickInterval(now: 12.5),
            DesktopPetMotionController.movementTickInterval
        )

        controller.beginUserInteraction()
        XCTAssertEqual(controller.recommendedTickInterval(now: 12.5), 0.5)
    }

    func testMovementPublishesWalkingPresentationThenReturnsToIdle() throws {
        let controller = DesktopPetMotionController(direction: .right)
        controller.update(context: context(state: .idle))
        controller.rebase(windowFrame: originFrame, visibleFrame: visibleFrame, now: 0)
        XCTAssertEqual(controller.presentation.visualState, .idle)
        XCTAssertFalse(controller.presentation.isMoving)

        let outbound = try applyStep(
            controller: controller,
            windowFrame: originFrame,
            visibleFrame: visibleFrame,
            elapsed: 1,
            now: 2.5
        )
        XCTAssertEqual(controller.presentation.visualState, .working)
        XCTAssertTrue(controller.presentation.isMoving)

        let edge = try applyStep(
            controller: controller,
            windowFrame: CGRect(origin: outbound, size: originFrame.size),
            visibleFrame: visibleFrame,
            elapsed: 100,
            now: 102.5
        )
        _ = try applyStep(
            controller: controller,
            windowFrame: CGRect(origin: edge, size: originFrame.size),
            visibleFrame: visibleFrame,
            elapsed: 100,
            now: 202.5
        )
        XCTAssertEqual(controller.presentation.visualState, .idle)
        XCTAssertFalse(controller.presentation.isMoving)
    }

    func testIdleMovementAdvancesWalkingFramePhaseWithDistance() throws {
        let controller = DesktopPetMotionController(direction: .right)
        controller.update(context: context(state: .idle))
        controller.rebase(windowFrame: originFrame, visibleFrame: visibleFrame, now: 0)

        let moved = try applyStep(
            controller: controller,
            windowFrame: originFrame,
            visibleFrame: visibleFrame,
            elapsed: 0.125,
            now: 2.5
        )

        XCTAssertGreaterThan(moved.x, originFrame.minX)
        XCTAssertEqual(controller.presentation.visualState, .working)
        XCTAssertEqual(controller.presentation.walkingFramePhase, 1)
    }

    func testRequestedMovementDoesNotChangePresentationUntilWindowActuallyMoves() throws {
        let controller = DesktopPetMotionController(direction: .right)
        controller.update(context: context(state: .idle))
        controller.rebase(windowFrame: originFrame, visibleFrame: visibleFrame, now: 0)
        let initialPresentation = controller.presentation

        let requestedOrigin = try XCTUnwrap(controller.step(
            windowFrame: originFrame,
            visibleFrame: visibleFrame,
            elapsed: 0.125,
            now: 2.5
        ))

        XCTAssertGreaterThan(requestedOrigin.x, originFrame.minX)
        XCTAssertEqual(controller.presentation, initialPresentation)

        controller.confirmMovement(
            from: originFrame.origin,
            to: originFrame.origin,
            now: 2.5
        )

        XCTAssertFalse(controller.presentation.isMoving)
        XCTAssertFalse(controller.presentation.mirroredHorizontally)
        XCTAssertEqual(controller.presentation.walkingFramePhase, 0)
        XCTAssertEqual(controller.direction, .right)
    }

    private func context(
        state: OrbVisualState,
        phase: LivePhase = .working,
        reduceMotion: Bool = false
    ) -> DesktopPetMotionContext {
        DesktopPetMotionContext(
            semanticState: state,
            livePhase: phase,
            isCompactSurface: true,
            reduceMotion: reduceMotion,
            desktopRoamingEnabled: true
        )
    }

    private func applyStep(
        controller: DesktopPetMotionController,
        windowFrame: CGRect,
        visibleFrame: CGRect,
        elapsed: TimeInterval,
        now: TimeInterval
    ) throws -> CGPoint {
        let target = try XCTUnwrap(controller.step(
            windowFrame: windowFrame,
            visibleFrame: visibleFrame,
            elapsed: elapsed,
            now: now
        ))
        controller.confirmMovement(from: windowFrame.origin, to: target, now: now)
        return target
    }
}

private extension Array where Element: Equatable {
    var adjacentChangeCount: Int {
        zip(self, dropFirst()).count { pair in pair.0 != pair.1 }
    }
}
