import AppKit
import XCTest
@testable import PiLive

final class LiveWindowCoordinatorTests: XCTestCase {
    @MainActor
    func testWalkingPresentationMovesAttachedWindow() {
        let coordinator = LiveWindowCoordinator()
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 122, height: 122),
            styleMask: [.resizable],
            backing: .buffered,
            defer: false
        )
        defer { window.close() }

        coordinator.attach(window)
        coordinator.updateDesktopPetMotion(context: DesktopPetMotionContext(
            semanticState: .idle,
            livePhase: .listening,
            isCompactSurface: true,
            reduceMotion: false,
            desktopRoamingEnabled: true
        ))
        let initialOrigin = window.frame.origin
        let now = ProcessInfo.processInfo.systemUptime

        coordinator.advanceDesktopPetMotion(elapsed: 1, now: now + 3)

        XCTAssertTrue(coordinator.desktopPetMotion.presentation.isMoving)
        XCTAssertGreaterThan(window.frame.origin.x, initialOrigin.x)
        XCTAssertEqual(window.frame.origin.y, initialOrigin.y)
    }

    @MainActor
    func testRepeatedSameSizeUpdatesDoNotRecenterMovingWindow() {
        let coordinator = LiveWindowCoordinator()
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 122, height: 122),
            styleMask: [.resizable],
            backing: .buffered,
            defer: false
        )
        defer { window.close() }
        coordinator.attach(window)
        let movedOrigin = CGPoint(x: window.frame.minX + 80, y: window.frame.minY + 35)
        window.setFrameOrigin(movedOrigin)

        coordinator.contentSizeDidChange()

        XCTAssertEqual(window.frame.origin, movedOrigin)
    }

    @MainActor
    func testContentResizePreservesPlacedOriginInsteadOfSnappingAboveDock() {
        let coordinator = LiveWindowCoordinator()
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 460, height: 500),
            styleMask: [.resizable],
            backing: .buffered,
            defer: false
        )
        coordinator.attach(window)
        let placedOrigin = CGPoint(x: window.frame.minX + 90, y: window.frame.minY + 65)
        window.setFrameOrigin(placedOrigin)
        coordinator.captureCurrentWindowOrigin(now: 0)
        window.setContentSize(CGSize(width: 122, height: 122))

        coordinator.contentSizeDidChange()

        XCTAssertEqual(window.frame.origin, placedOrigin)
    }

    @MainActor
    func testDisablingMidRouteRestoresExactOriginAndStopsMotionTimer() throws {
        let coordinator = LiveWindowCoordinator()
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 122, height: 122),
            styleMask: [.resizable],
            backing: .buffered,
            defer: false
        )
        defer { window.close() }
        coordinator.attach(window)
        let enabledContext = context(desktopRoamingEnabled: true)
        coordinator.updateDesktopPetMotion(context: enabledContext)
        let routeOrigin = coordinator.desktopPetMotion.origin
        let now = ProcessInfo.processInfo.systemUptime

        coordinator.advanceDesktopPetMotion(elapsed: 1, now: now + 3)
        XCTAssertGreaterThan(window.frame.minX, routeOrigin.x)

        coordinator.updateDesktopPetMotion(context: context(desktopRoamingEnabled: false))

        XCTAssertEqual(window.frame.origin, routeOrigin)
        XCTAssertFalse(coordinator.desktopPetMotion.presentation.isMoving)
        XCTAssertFalse(coordinator.hasScheduledMotionTick)
    }

    @MainActor
    func testReenablingCapturesCurrentOriginAndWaitsForIdleDwell() {
        let coordinator = LiveWindowCoordinator()
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 122, height: 122),
            styleMask: [.resizable],
            backing: .buffered,
            defer: false
        )
        defer { window.close() }
        coordinator.attach(window)
        coordinator.updateDesktopPetMotion(context: context(desktopRoamingEnabled: false))
        let userPlacedOrigin = CGPoint(x: window.frame.minX + 70, y: window.frame.minY + 45)
        window.setFrameOrigin(userPlacedOrigin)
        let now = ProcessInfo.processInfo.systemUptime

        coordinator.updateDesktopPetMotion(context: context(desktopRoamingEnabled: true))

        XCTAssertEqual(coordinator.desktopPetMotion.origin, userPlacedOrigin)
        coordinator.advanceDesktopPetMotion(elapsed: 1, now: now + 2.49)
        XCTAssertEqual(window.frame.origin, userPlacedOrigin)
        coordinator.advanceDesktopPetMotion(elapsed: 1, now: now + 2.6)
        XCTAssertGreaterThan(window.frame.minX, userPlacedOrigin.x)
        XCTAssertEqual(window.frame.minY, userPlacedOrigin.y)
    }

    @MainActor
    func testReduceMotionRestoresOriginAndOverridesEnabledRoaming() {
        let coordinator = LiveWindowCoordinator()
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 122, height: 122),
            styleMask: [.resizable],
            backing: .buffered,
            defer: false
        )
        defer { window.close() }
        coordinator.attach(window)
        coordinator.updateDesktopPetMotion(context: context(desktopRoamingEnabled: true))
        let routeOrigin = coordinator.desktopPetMotion.origin
        let now = ProcessInfo.processInfo.systemUptime
        coordinator.advanceDesktopPetMotion(elapsed: 1, now: now + 3)

        coordinator.updateDesktopPetMotion(context: context(
            desktopRoamingEnabled: true,
            reduceMotion: true
        ))

        XCTAssertEqual(window.frame.origin, routeOrigin)
        XCTAssertFalse(coordinator.desktopPetMotion.presentation.isMoving)
        XCTAssertFalse(coordinator.hasScheduledMotionTick)
    }

    @MainActor
    func testRepeatedWorkspaceReconfigurationKeepsOrbStructurallyBorderlessAndKeyCapable() {
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 122, height: 122),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        for _ in 0 ..< 25 {
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable]

            LiveWindowPresentation.apply(to: window)

            XCTAssertEqual(window.styleMask, LiveWindowPresentation.styleMask)
            XCTAssertFalse(window.styleMask.contains(.titled))
            XCTAssertNil(window.standardWindowButton(.closeButton))
            XCTAssertNil(window.standardWindowButton(.miniaturizeButton))
            XCTAssertNil(window.standardWindowButton(.zoomButton))
            XCTAssertTrue(window.canBecomeKey)
        }
    }

    func testSelectsDisplayForPointerAcrossNegativeOrigins() {
        let displays = [
            LiveDisplayGeometry(
                id: 1,
                frame: CGRect(x: 0, y: 0, width: 1_440, height: 900),
                visibleFrame: CGRect(x: 0, y: 24, width: 1_440, height: 840)
            ),
            LiveDisplayGeometry(
                id: 2,
                frame: CGRect(x: -1_920, y: -120, width: 1_920, height: 1_080),
                visibleFrame: CGRect(x: -1_920, y: -80, width: 1_920, height: 1_000)
            ),
        ]

        XCTAssertEqual(
            LiveWindowPlacement.display(containing: CGPoint(x: -500, y: 400), in: displays)?.id,
            2
        )
        XCTAssertEqual(
            LiveWindowPlacement.display(containing: CGPoint(x: 500, y: 400), in: displays)?.id,
            1
        )
    }

    func testPreservesRelativeEdgePlacementWhenMovingDisplays() {
        let windowFrame = CGRect(x: 780, y: 20, width: 200, height: 100)
        let source = CGRect(x: 0, y: 0, width: 1_000, height: 800)
        let destination = CGRect(x: -1_920, y: -80, width: 1_920, height: 1_000)

        let origin = LiveWindowPlacement.repositionedOrigin(
            windowFrame: windowFrame,
            from: source,
            to: destination
        )

        XCTAssertEqual(origin.x, -243.0, accuracy: 1)
        XCTAssertEqual(origin.y, -54.0, accuracy: 1)
    }

    func testDisplayChangeRequiresDifferentDisplayIdentity() {
        XCTAssertFalse(LiveWindowPlacement.shouldMove(fromDisplayID: 4, toDisplayID: 4))
        XCTAssertTrue(LiveWindowPlacement.shouldMove(fromDisplayID: 4, toDisplayID: 5))
        XCTAssertTrue(LiveWindowPlacement.shouldMove(fromDisplayID: nil, toDisplayID: 5))
    }

    @MainActor
    func testPresentationRemainsVisibleAcrossSpacesAndFullscreen() {
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 122, height: 122),
            styleMask: [.resizable],
            backing: .buffered,
            defer: false
        )

        LiveWindowPresentation.apply(to: window)

        XCTAssertTrue(window.collectionBehavior.contains(.canJoinAllSpaces))
        XCTAssertTrue(window.collectionBehavior.contains(.fullScreenAuxiliary))
        XCTAssertTrue(window.collectionBehavior.contains(.stationary))
    }

    private func context(
        desktopRoamingEnabled: Bool,
        reduceMotion: Bool = false
    ) -> DesktopPetMotionContext {
        DesktopPetMotionContext(
            semanticState: .idle,
            livePhase: .listening,
            isCompactSurface: true,
            reduceMotion: reduceMotion,
            desktopRoamingEnabled: desktopRoamingEnabled
        )
    }
}
