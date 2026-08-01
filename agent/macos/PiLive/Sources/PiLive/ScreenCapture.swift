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
protocol ScreenCaptureEncoding {
    func encode(
        image: CGImage,
        displayID: String,
        timestamp: Double,
        requestID: RPCID,
        pointer: CGPoint?
    ) throws -> ScreenCaptureResult
}

@MainActor
protocol ScreenCaptureConfirmationSoundPlaying {
    func playCaptureConfirmation()
}

@MainActor
protocol ScreenCaptureProviding: AnyObject {
    func availableDisplays() async throws -> [ScreenCaptureDisplay]
    func capture(display: ScreenCaptureDisplay) async throws -> CGImage
}

@MainActor
protocol ScreenCaptureRPCHandling: AnyObject {
    func capture(requestID: RPCID) async throws -> ScreenCaptureResult
    func confirmCaptureDelivered()
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

@MainActor
struct SystemScreenCaptureAuthorizer: ScreenCaptureAuthorizing {
    private let permissionService: any LivePermissionServicing

    init(permissionService: any LivePermissionServicing = ScreenRecordingPermissionService()) {
        self.permissionService = permissionService
    }

    func requestAccess() async -> Bool {
        await permissionService.requestPermission() == .allowed
    }
}

@MainActor
struct SystemScreenCaptureConfirmationSoundPlayer: ScreenCaptureConfirmationSoundPlaying {
    func playCaptureConfirmation() {
        NSSound(named: NSSound.Name("Tink"))?.play()
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
        let appKitFrames: [UInt32: CGRect] = Dictionary(
            uniqueKeysWithValues: NSScreen.screens.compactMap { screen in
                guard let number = screen.deviceDescription[
                    NSDeviceDescriptionKey("NSScreenNumber")
                ] as? NSNumber else { return nil }
                return (number.uint32Value, screen.frame)
            }
        )
        let mainDisplayID = CGMainDisplayID()
        return content.displays.map { display in
            ScreenCaptureDisplay(
                id: display.displayID,
                frame: appKitFrames[display.displayID] ?? display.frame,
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

enum ScreenCapturePointerMapper {
    static func mapToImagePixels(
        globalPoint: CGPoint,
        displayFrame: CGRect,
        imageWidth: Int,
        imageHeight: Int
    ) -> CGPoint? {
        guard displayFrame.width > 0,
              displayFrame.height > 0,
              imageWidth > 0,
              imageHeight > 0,
              displayFrame.contains(globalPoint)
        else { return nil }

        let localX = globalPoint.x - displayFrame.minX
        let localYFromTop = displayFrame.maxY - globalPoint.y
        let pixelX = localX * CGFloat(imageWidth) / displayFrame.width
        let pixelY = localYFromTop * CGFloat(imageHeight) / displayFrame.height
        return CGPoint(
            x: min(max(pixelX, 0), CGFloat(imageWidth - 1)),
            y: min(max(pixelY, 0), CGFloat(imageHeight - 1))
        )
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
        pointer: CGPoint? = nil,
        encode: (
            _ width: Int,
            _ height: Int,
            _ quality: Double,
            _ pointer: CGPoint?
        ) throws -> Data
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
            let scaledPointer = scaledPointer(
                pointer,
                originalWidth: originalWidth,
                originalHeight: originalHeight,
                outputWidth: dimensions.width,
                outputHeight: dimensions.height
            )
            for quality in qualities {
                let data = try encode(
                    dimensions.width,
                    dimensions.height,
                    quality,
                    scaledPointer
                )
                guard data.count <= maxScreenCaptureImageBytes else { continue }
                let result = ScreenCaptureResult(
                    mimeType: "image/jpeg",
                    data: data.base64EncodedString(),
                    width: dimensions.width,
                    height: dimensions.height,
                    displayId: displayID,
                    timestamp: timestamp,
                    byteSize: data.count,
                    sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
                    pointerX: scaledPointer.map { Int($0.x.rounded()) },
                    pointerY: scaledPointer.map { Int($0.y.rounded()) }
                )
                let frame = try JSONEncoder().encode(RPCSuccess(id: requestID, result: result))
                if frame.count <= targetScreenCaptureEncodedFrameBytes { return result }
            }
        }
        throw PiLiveError.protocolError("Screen capture cannot fit within JSON-RPC size limits")
    }

    private static func scaledPointer(
        _ pointer: CGPoint?,
        originalWidth: Int,
        originalHeight: Int,
        outputWidth: Int,
        outputHeight: Int
    ) -> CGPoint? {
        guard let pointer,
              pointer.x >= 0,
              pointer.y >= 0,
              pointer.x < CGFloat(originalWidth),
              pointer.y < CGFloat(originalHeight)
        else { return nil }
        return CGPoint(
            x: min(
                CGFloat(outputWidth - 1),
                pointer.x * CGFloat(outputWidth) / CGFloat(originalWidth)
            ),
            y: min(
                CGFloat(outputHeight - 1),
                pointer.y * CGFloat(outputHeight) / CGFloat(originalHeight)
            )
        )
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
struct AdaptiveScreenCaptureEncoding: ScreenCaptureEncoding {
    func encode(
        image: CGImage,
        displayID: String,
        timestamp: Double,
        requestID: RPCID,
        pointer: CGPoint?
    ) throws -> ScreenCaptureResult {
        try AdaptiveScreenCaptureEncoder.fit(
            originalWidth: image.width,
            originalHeight: image.height,
            displayID: displayID,
            timestamp: timestamp,
            requestID: requestID,
            pointer: pointer
        ) { width, height, quality, scaledPointer in
            try ScreenCaptureImageEncoder.encodeJPEG(
                image,
                width: width,
                height: height,
                quality: quality,
                pointer: scaledPointer
            )
        }
    }
}

private enum ScreenCaptureImageEncoder {
    static func encodeJPEG(
        _ image: CGImage,
        width: Int,
        height: Int,
        quality: Double,
        pointer: CGPoint?
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
        if let pointer {
            drawPointerHalo(pointer, width: width, height: height, in: context)
        }
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

    private static func drawPointerHalo(
        _ pointer: CGPoint,
        width: Int,
        height: Int,
        in context: CGContext
    ) {
        let center = CGPoint(x: pointer.x, y: CGFloat(height) - pointer.y)
        let radius = min(28, max(14, CGFloat(max(width, height)) / 180))
        let ring = CGRect(
            x: center.x - radius,
            y: center.y - radius,
            width: radius * 2,
            height: radius * 2
        )
        context.saveGState()
        context.setStrokeColor(CGColor(gray: 0, alpha: 0.86))
        context.setLineWidth(6)
        context.strokeEllipse(in: ring)
        context.setStrokeColor(CGColor(gray: 1, alpha: 0.96))
        context.setLineWidth(2.5)
        context.strokeEllipse(in: ring)
        context.restoreGState()
    }
}

@MainActor
final class ScreenCaptureRPCHandler: ScreenCaptureRPCHandling {
    private let authorizer: any ScreenCaptureAuthorizing
    private let provider: any ScreenCaptureProviding
    private let pointerLocation: () -> CGPoint
    private let now: () -> Date
    private let encoder: any ScreenCaptureEncoding
    private let soundPlayer: any ScreenCaptureConfirmationSoundPlaying
    private var captureInProgress = false
    private var confirmationPending = false

    init(
        authorizer: any ScreenCaptureAuthorizing = SystemScreenCaptureAuthorizer(),
        provider: any ScreenCaptureProviding = ScreenCaptureKitProvider(),
        pointerLocation: @escaping () -> CGPoint = {
            NSEvent.mouseLocation
        },
        now: @escaping () -> Date = Date.init,
        encoder: any ScreenCaptureEncoding = AdaptiveScreenCaptureEncoding(),
        soundPlayer: any ScreenCaptureConfirmationSoundPlaying =
            SystemScreenCaptureConfirmationSoundPlayer()
    ) {
        self.authorizer = authorizer
        self.provider = provider
        self.pointerLocation = pointerLocation
        self.now = now
        self.encoder = encoder
        self.soundPlayer = soundPlayer
    }

    func capture(requestID: RPCID) async throws -> ScreenCaptureResult {
        guard !captureInProgress else {
            throw PiLiveError.protocolError("Screen capture is already in progress")
        }
        confirmationPending = false
        captureInProgress = true
        defer { captureInProgress = false }
        guard await authorizer.requestAccess() else { throw PiLiveError.screenRecordingDenied }
        try Task.checkCancellation()
        let displays = try await provider.availableDisplays()
        let sampledPointerLocation = pointerLocation()
        guard let display = ScreenCaptureDisplaySelector.select(
            from: displays,
            pointerLocation: sampledPointerLocation
        ) else {
            throw PiLiveError.protocolError("No display is available for screen capture")
        }
        let image = try await provider.capture(display: display)
        try Task.checkCancellation()
        let pointer = ScreenCapturePointerMapper.mapToImagePixels(
            globalPoint: sampledPointerLocation,
            displayFrame: display.frame,
            imageWidth: image.width,
            imageHeight: image.height
        )
        let result = try encoder.encode(
            image: image,
            displayID: String(display.id),
            timestamp: now().timeIntervalSince1970 * 1_000,
            requestID: requestID,
            pointer: pointer
        )
        try Task.checkCancellation()
        confirmationPending = true
        return result
    }

    func confirmCaptureDelivered() {
        guard confirmationPending else { return }
        confirmationPending = false
        soundPlayer.playCaptureConfirmation()
    }
}
