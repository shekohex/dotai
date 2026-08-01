import CoreGraphics
import Foundation
import XCTest
@testable import PiLive

private struct TestScreenCaptureAuthorizer: ScreenCaptureAuthorizing {
    let allowed: Bool
    func requestAccess() async -> Bool { allowed }
}

@MainActor
private final class TestScreenCaptureProvider: ScreenCaptureProviding {
    let displays: [ScreenCaptureDisplay]
    let image: CGImage
    private(set) var capturedDisplay: ScreenCaptureDisplay?

    init(displays: [ScreenCaptureDisplay], image: CGImage) {
        self.displays = displays
        self.image = image
    }

    func availableDisplays() async throws -> [ScreenCaptureDisplay] { displays }

    func capture(display: ScreenCaptureDisplay) async throws -> CGImage {
        capturedDisplay = display
        return image
    }
}

@MainActor
private final class TestScreenCaptureRPCHandler: ScreenCaptureRPCHandling {
    let result: ScreenCaptureResult
    private(set) var requestIDs: [RPCID] = []

    init(result: ScreenCaptureResult) { self.result = result }

    func capture(requestID: RPCID) async throws -> ScreenCaptureResult {
        requestIDs.append(requestID)
        return result
    }
}

@MainActor
final class ScreenCaptureTests: XCTestCase {
    func testPermissionDenialStopsBeforeCapture() async throws {
        let provider = TestScreenCaptureProvider(
            displays: [display(id: 1, frame: CGRect(x: 0, y: 0, width: 100, height: 100))],
            image: try makeImage(width: 100, height: 100)
        )
        let handler = ScreenCaptureRPCHandler(
            authorizer: TestScreenCaptureAuthorizer(allowed: false),
            provider: provider
        )

        do {
            _ = try await handler.capture(requestID: .string("capture"))
            XCTFail("Expected screen recording denial")
        } catch let error as PiLiveError {
            XCTAssertEqual(
                error.localizedDescription,
                PiLiveError.screenRecordingDenied.localizedDescription
            )
        }
        XCTAssertNil(provider.capturedDisplay)
    }

    func testSelectsPointerDisplayThenMainDisplayFallback() {
        let first = display(id: 1, frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        let main = display(
            id: 2,
            frame: CGRect(x: 100, y: 0, width: 100, height: 100),
            isMain: true
        )

        XCTAssertEqual(
            ScreenCaptureDisplaySelector.select(
                from: [first, main],
                pointerLocation: CGPoint(x: 150, y: 50)
            )?.id,
            2
        )
        XCTAssertEqual(
            ScreenCaptureDisplaySelector.select(
                from: [first, main],
                pointerLocation: CGPoint(x: 500, y: 500)
            )?.id,
            2
        )
    }

    func testRetainsNativeHighResolutionWhenItFits() throws {
        var attempts: [(width: Int, height: Int, quality: Double)] = []
        let result = try AdaptiveScreenCaptureEncoder.fit(
            originalWidth: 5_120,
            originalHeight: 2_880,
            displayID: "7",
            timestamp: 123,
            requestID: .string("capture")
        ) { width, height, quality in
            attempts.append((width, height, quality))
            return Data(repeating: 1, count: 4 * 1024 * 1024)
        }

        XCTAssertEqual(result.width, 5_120)
        XCTAssertEqual(result.height, 2_880)
        XCTAssertEqual(attempts.count, 1)
        XCTAssertEqual(attempts.first?.quality, 0.85)
        XCTAssertGreaterThan(result.byteSize, maxLiveRPCFrameBytes)
        XCTAssertLessThanOrEqual(
            try JSONEncoder().encode(RPCSuccess(id: RPCID.string("capture"), result: result)).count,
            targetScreenCaptureEncodedFrameBytes
        )
    }

    func testReducesQualityBeforeDimensions() throws {
        var attempts: [(width: Int, height: Int, quality: Double)] = []
        let result = try AdaptiveScreenCaptureEncoder.fit(
            originalWidth: 5_120,
            originalHeight: 2_880,
            displayID: "7",
            timestamp: 123,
            requestID: .string("capture")
        ) { width, height, quality in
            attempts.append((width, height, quality))
            if width > 4_096 { return Data(repeating: 1, count: maxScreenCaptureImageBytes + 1) }
            return Data(repeating: 2, count: 1_024)
        }

        XCTAssertEqual(result.width, 4_096)
        XCTAssertEqual(result.height, 2_304)
        XCTAssertEqual(attempts.prefix(7).map(\.width), Array(repeating: 5_120, count: 7))
        XCTAssertEqual(attempts.last?.width, 4_096)
        XCTAssertEqual(attempts.last?.quality, 0.85)
    }

    func testReportsMetadataAndRoutesScreenCaptureRPCExactlyOnce() async throws {
        let expected = ScreenCaptureResult(
            mimeType: "image/jpeg",
            data: "/9j/2Q==",
            width: 100,
            height: 50,
            displayId: "9",
            timestamp: 456,
            byteSize: 4,
            sha256: String(repeating: "a", count: 64)
        )
        let handler = TestScreenCaptureRPCHandler(result: expected)

        let result = try await routeScreenCaptureRequest(
            method: "screen.capture",
            requestID: .number(9),
            handler: handler
        )
        let ignored = try await routeScreenCaptureRequest(
            method: "webrtc.createOffer",
            requestID: .number(10),
            handler: handler
        )

        XCTAssertEqual(result, expected)
        XCTAssertNil(ignored)
        XCTAssertEqual(handler.requestIDs, [.number(9)])
    }

    func testCaptureMetadataUsesSelectedDisplayAndEncodedImage() async throws {
        let pointerDisplay = display(
            id: 2,
            frame: CGRect(x: 100, y: 0, width: 100, height: 50)
        )
        let provider = TestScreenCaptureProvider(
            displays: [
                display(id: 1, frame: CGRect(x: 0, y: 0, width: 100, height: 50), isMain: true),
                pointerDisplay,
            ],
            image: try makeImage(width: 100, height: 50)
        )
        let handler = ScreenCaptureRPCHandler(
            authorizer: TestScreenCaptureAuthorizer(allowed: true),
            provider: provider,
            pointerLocation: { CGPoint(x: 150, y: 25) },
            now: { Date(timeIntervalSince1970: 10) }
        )

        let result = try await handler.capture(requestID: .string("capture"))

        XCTAssertEqual(provider.capturedDisplay, pointerDisplay)
        XCTAssertEqual(result.mimeType, "image/jpeg")
        XCTAssertEqual(result.width, 100)
        XCTAssertEqual(result.height, 50)
        XCTAssertEqual(result.displayId, "2")
        XCTAssertEqual(result.timestamp, 10_000)
        XCTAssertEqual(Data(base64Encoded: result.data)?.count, result.byteSize)
        XCTAssertEqual(result.sha256.count, 64)
    }

    func testFailsWhenNoEncodingFitsSizeLimits() {
        XCTAssertThrowsError(
            try AdaptiveScreenCaptureEncoder.fit(
                originalWidth: 5_120,
                originalHeight: 2_880,
                displayID: "7",
                timestamp: 123,
                requestID: .string("capture")
            ) { _, _, _ in Data(repeating: 1, count: maxScreenCaptureImageBytes + 1) }
        ) { error in
            XCTAssertTrue(error.localizedDescription.contains("cannot fit"))
        }
    }

    func testFrameGuardsKeepOrdinaryRPCSmallAndAllowBoundedCaptureRPC() throws {
        let oneMiBResult = ScreenCaptureResult(
            mimeType: "image/jpeg",
            data: String(repeating: "A", count: 1024 * 1024),
            width: 1,
            height: 1,
            displayId: "1",
            timestamp: 1,
            byteSize: 1,
            sha256: String(repeating: "0", count: 64)
        )
        let response = RPCSuccess(id: RPCID.string("capture"), result: oneMiBResult)

        XCTAssertThrowsError(try encodeLiveRPCFrame(response))
        XCTAssertNoThrow(try encodeLiveRPCFrame(
            response,
            maximumBytes: maxScreenCaptureEncodedFrameBytes
        ))

        let oversizedResult = ScreenCaptureResult(
            mimeType: "image/jpeg",
            data: String(repeating: "A", count: maxScreenCaptureEncodedFrameBytes),
            width: 1,
            height: 1,
            displayId: "1",
            timestamp: 1,
            byteSize: 1,
            sha256: String(repeating: "0", count: 64)
        )
        XCTAssertThrowsError(try encodeLiveRPCFrame(
            RPCSuccess(id: RPCID.string("capture"), result: oversizedResult),
            maximumBytes: maxScreenCaptureEncodedFrameBytes
        ))
    }

    private func display(
        id: UInt32,
        frame: CGRect,
        isMain: Bool = false
    ) -> ScreenCaptureDisplay {
        ScreenCaptureDisplay(
            id: id,
            frame: frame,
            width: Int(frame.width),
            height: Int(frame.height),
            isMain: isMain
        )
    }

    private func makeImage(width: Int, height: Int) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try XCTUnwrap(context.makeImage())
    }
}
