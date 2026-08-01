import AppKit
import CoreGraphics
import CryptoKit
import Foundation
import ScreenCaptureKit

struct ScreenCaptureDisplay: Equatable, Sendable {
    let id: UInt32
    let frame: CGRect
    let width: Int
    let height: Int
    let isMain: Bool
}

@MainActor
protocol ScreenCaptureAuthorizing {
    func requestAccess() async -> Bool
}

@MainActor
protocol ScreenCaptureProviding: AnyObject {
    func availableDisplays() async throws -> [ScreenCaptureDisplay]
    func capture(display: ScreenCaptureDisplay) async throws -> CGImage
}

@MainActor
protocol ScreenCaptureRPCHandling: AnyObject {
    func capture(requestID: RPCID) async throws -> ScreenCaptureResult
}

@MainActor
func routeScreenCaptureRequest(
    method: String,
    requestID: RPCID,
    handler: any ScreenCaptureRPCHandling
) async throws -> ScreenCaptureResult? {
    guard method == "screen.capture" else { return nil }
    try Task.checkCancellation()
    let result = try await handler.capture(requestID: requestID)
    try Task.checkCancellation()
    return result
}

struct SystemScreenCaptureAuthorizer: ScreenCaptureAuthorizing {
    func requestAccess() async -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        return CGRequestScreenCaptureAccess()
    }
}

@MainActor
final class ScreenCaptureKitProvider: ScreenCaptureProviding {
    private var displaysByID: [UInt32: SCDisplay] = [:]

    func availableDisplays() async throws -> [ScreenCaptureDisplay] {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        displaysByID = Dictionary(uniqueKeysWithValues: content.displays.map { ($0.displayID, $0) })
        let mainDisplayID = CGMainDisplayID()
        return content.displays.map { display in
            ScreenCaptureDisplay(
                id: display.displayID,
                frame: display.frame,
                width: display.width,
                height: display.height,
                isMain: display.displayID == mainDisplayID
            )
        }
    }

    func capture(display: ScreenCaptureDisplay) async throws -> CGImage {
        guard let source = displaysByID[display.id] else {
            throw PiLiveError.protocolError("Selected display is no longer available")
        }
        let filter = SCContentFilter(display: source, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = display.width
        configuration.height = display.height
        configuration.showsCursor = true
        configuration.capturesAudio = false
        return try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
    }
}

enum ScreenCaptureDisplaySelector {
    static func select(
        from displays: [ScreenCaptureDisplay],
        pointerLocation: CGPoint
    ) -> ScreenCaptureDisplay? {
        displays.first(where: { $0.frame.contains(pointerLocation) })
            ?? displays.first(where: \.isMain)
            ?? displays.first
    }
}

enum AdaptiveScreenCaptureEncoder {
    private static let reducedMaximumEdges = [4_096, 3_584, 3_072, 2_560, 2_048, 1_600, 1_280]
    private static let qualities = [0.85, 0.78, 0.70, 0.62, 0.54, 0.45, 0.36]

    static func fit(
        originalWidth: Int,
        originalHeight: Int,
        displayID: String,
        timestamp: Double,
        requestID: RPCID,
        encode: (_ width: Int, _ height: Int, _ quality: Double) throws -> Data
    ) throws -> ScreenCaptureResult {
        var attemptedSizes = Set<String>()
        let nativeMaximumEdge = max(originalWidth, originalHeight)
        for maximumEdge in [nativeMaximumEdge] + reducedMaximumEdges {
            let dimensions = scaledDimensions(
                width: originalWidth,
                height: originalHeight,
                maximumEdge: maximumEdge
            )
            let sizeKey = "\(dimensions.width)x\(dimensions.height)"
            guard attemptedSizes.insert(sizeKey).inserted else { continue }
            for quality in qualities {
                let data = try encode(dimensions.width, dimensions.height, quality)
                guard data.count <= maxScreenCaptureImageBytes else { continue }
                let result = ScreenCaptureResult(
                    mimeType: "image/jpeg",
                    data: data.base64EncodedString(),
                    width: dimensions.width,
                    height: dimensions.height,
                    displayId: displayID,
                    timestamp: timestamp,
                    byteSize: data.count,
                    sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                )
                let frame = try JSONEncoder().encode(RPCSuccess(id: requestID, result: result))
                if frame.count <= targetScreenCaptureEncodedFrameBytes { return result }
            }
        }
        throw PiLiveError.protocolError("Screen capture cannot fit within JSON-RPC size limits")
    }

    static func scaledDimensions(
        width: Int,
        height: Int,
        maximumEdge: Int
    ) -> (width: Int, height: Int) {
        let sourceMaximumEdge = max(width, height)
        guard sourceMaximumEdge > maximumEdge else { return (width, height) }
        let scale = Double(maximumEdge) / Double(sourceMaximumEdge)
        return (
            max(1, Int((Double(width) * scale).rounded())),
            max(1, Int((Double(height) * scale).rounded()))
        )
    }
}

@MainActor
final class ScreenCaptureRPCHandler: ScreenCaptureRPCHandling {
    private let authorizer: any ScreenCaptureAuthorizing
    private let provider: any ScreenCaptureProviding
    private let pointerLocation: () -> CGPoint
    private let now: () -> Date
    private var captureInProgress = false

    init(
        authorizer: any ScreenCaptureAuthorizing = SystemScreenCaptureAuthorizer(),
        provider: any ScreenCaptureProviding = ScreenCaptureKitProvider(),
        pointerLocation: @escaping () -> CGPoint = {
            CGEvent(source: nil)?.location ?? CGPoint.zero
        },
        now: @escaping () -> Date = Date.init
    ) {
        self.authorizer = authorizer
        self.provider = provider
        self.pointerLocation = pointerLocation
        self.now = now
    }

    func capture(requestID: RPCID) async throws -> ScreenCaptureResult {
        guard !captureInProgress else {
            throw PiLiveError.protocolError("Screen capture is already in progress")
        }
        captureInProgress = true
        defer { captureInProgress = false }
        guard await authorizer.requestAccess() else { throw PiLiveError.screenRecordingDenied }
        try Task.checkCancellation()
        let displays = try await provider.availableDisplays()
        guard let display = ScreenCaptureDisplaySelector.select(
            from: displays,
            pointerLocation: pointerLocation()
        ) else {
            throw PiLiveError.protocolError("No display is available for screen capture")
        }
        let image = try await provider.capture(display: display)
        try Task.checkCancellation()
        return try AdaptiveScreenCaptureEncoder.fit(
            originalWidth: image.width,
            originalHeight: image.height,
            displayID: String(display.id),
            timestamp: now().timeIntervalSince1970 * 1_000,
            requestID: requestID
        ) { width, height, quality in
            try Self.encodeJPEG(image, width: width, height: height, quality: quality)
        }
    }

    private static func encodeJPEG(
        _ image: CGImage,
        width: Int,
        height: Int,
        quality: Double
    ) throws -> Data {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else {
            throw PiLiveError.protocolError("Unable to allocate resized screen capture")
        }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let resized = context.makeImage(),
              let data = NSBitmapImageRep(cgImage: resized).representation(
                  using: .jpeg,
                  properties: [.compressionFactor: quality]
              )
        else {
            throw PiLiveError.protocolError("Unable to encode screen capture as JPEG")
        }
        return data
    }
}
