import AppKit
import SwiftUI

enum OrbRenderFrameResolver {
    static func frameIndex(
        pack: OrbPackManifest,
        state: OrbVisualState,
        framePhase: Int
    ) -> Int? {
        guard let frames = pack.resolvedSequence(for: state)?.frames, !frames.isEmpty else {
            return nil
        }
        return frames[framePhase % frames.count]
    }
}

struct OrbRenderer: View {
    let pack: OrbPackManifest
    let state: OrbVisualState
    var animated = true
    var mirroredHorizontally = false
    var framePhase: Int?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var playback = OrbPlaybackController()

    var body: some View {
        OrbFrameLayerRepresentable(
            image: renderedImage,
            mirroredHorizontally: mirroredHorizontally
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Pi Live orb")
        .accessibilityValue(state.rawValue)
        .task(id: OrbPlaybackIdentity(
            packID: pack.id,
            state: state,
            animated: playsAnimation,
            reducedMotion: reduceMotion
        )) {
            await playback.play(
                pack: pack,
                state: state,
                animated: playsAnimation,
                reducedMotion: reduceMotion
            )
        }
    }

    private var playsAnimation: Bool { animated && framePhase == nil }

    private var renderedImage: NSImage? {
        guard let framePhase,
              let frameIndex = OrbRenderFrameResolver.frameIndex(
                  pack: pack,
                  state: state,
                  framePhase: framePhase
              )
        else { return playback.image }
        return OrbFrameStore.shared.frame(pack: pack, frameIndex: frameIndex)
    }
}

final class OrbFrameStore: @unchecked Sendable {
    static let shared = OrbFrameStore()
    static let cacheCostLimitBytes = 64 * 1_024 * 1_024

    private struct CachedFrame {
        let image: NSImage
        let cost: Int
    }

    private final class CachedPack {
        let sheet: CGImage
        let sheetCost: Int
        var frames: [Int: CachedFrame] = [:]
        var frameOrder: [Int] = []

        init(sheet: CGImage) {
            self.sheet = sheet
            sheetCost = sheet.bytesPerRow * sheet.height
        }
    }

    private let lock = NSLock()
    private var packs: [String: CachedPack] = [:]
    private var packOrder: [String] = []
    private var totalCost = 0

    private init() {}

    static func decodedCost(width: Int, height: Int) -> Int {
        width * height * 4
    }

    func frame(pack: OrbPackManifest, frameIndex: Int) -> NSImage? {
        lock.lock()
        defer { lock.unlock() }
        guard let cachedPack = loadPack(pack: pack) else { return nil }
        touchPack(pack.id)
        if let cached = cachedPack.frames[frameIndex] {
            touchFrame(frameIndex, in: cachedPack)
            return cached.image
        }
        let frameWidth = cachedPack.sheet.width / pack.columns
        let frameHeight = cachedPack.sheet.height / pack.rows
        let column = frameIndex % pack.columns
        let row = frameIndex / pack.columns
        let rect = CGRect(
            x: column * frameWidth,
            y: row * frameHeight,
            width: frameWidth,
            height: frameHeight
        )
        guard let cropped = cachedPack.sheet.cropping(to: rect) else { return nil }
        let image = NSImage(cgImage: cropped, size: NSSize(width: frameWidth, height: frameHeight))
        let frameCost = cropped.bytesPerRow * cropped.height
        cachedPack.frames[frameIndex] = CachedFrame(image: image, cost: frameCost)
        cachedPack.frameOrder.append(frameIndex)
        totalCost += frameCost
        evictIfNeeded(protecting: pack.id)
        return image
    }

    private func loadPack(pack: OrbPackManifest) -> CachedPack? {
        if let cached = packs[pack.id] { return cached }
        guard let url = try? OrbCatalog.shared.sheetURL(for: pack),
              let image = NSImage(contentsOf: url),
              let representation = image.bestRepresentation(
                  for: NSRect(origin: .zero, size: image.size),
                  context: nil,
                  hints: nil
              ),
              let cgImage = representation.cgImage(
                  forProposedRect: nil,
                  context: nil,
                  hints: nil
              )
        else { return nil }
        let cachedPack = CachedPack(sheet: cgImage)
        packs[pack.id] = cachedPack
        packOrder.append(pack.id)
        totalCost += cachedPack.sheetCost
        evictIfNeeded(protecting: pack.id)
        return cachedPack
    }

    private func touchPack(_ packID: String) {
        packOrder.removeAll { $0 == packID }
        packOrder.append(packID)
    }

    private func touchFrame(_ frameIndex: Int, in pack: CachedPack) {
        pack.frameOrder.removeAll { $0 == frameIndex }
        pack.frameOrder.append(frameIndex)
    }

    private func evictIfNeeded(protecting protectedPackID: String) {
        while totalCost > Self.cacheCostLimitBytes {
            if let packID = packOrder.first(where: { $0 != protectedPackID }) {
                removePack(packID)
                continue
            }
            guard let protectedPack = packs[protectedPackID],
                  let frameIndex = protectedPack.frameOrder.first,
                  let frame = protectedPack.frames.removeValue(forKey: frameIndex)
            else { return }
            protectedPack.frameOrder.removeFirst()
            totalCost -= frame.cost
        }
    }

    private func removePack(_ packID: String) {
        guard let pack = packs.removeValue(forKey: packID) else { return }
        totalCost -= pack.sheetCost + pack.frames.values.reduce(0) { $0 + $1.cost }
        packOrder.removeAll { $0 == packID }
    }
}
