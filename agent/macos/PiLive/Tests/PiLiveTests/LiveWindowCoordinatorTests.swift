import AppKit
import XCTest
@testable import PiLive

final class LiveWindowCoordinatorTests: XCTestCase {
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
}
