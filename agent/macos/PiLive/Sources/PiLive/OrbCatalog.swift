import AppKit
import Foundation
import ImageIO
import SwiftUI

enum OrbVisualState: String, CaseIterable, Codable, Sendable {
    case idle
    case syncing
    case listening
    case talking
    case thinking
    case working
    case checkingSubagents
    case waiting
    case success
    case failure
    case muted
    case ending
}

enum OrbAlphaMode: String, Codable, Sendable {
    case hard
    case soft
}

struct OrbSequenceManifest: Codable, Equatable, Sendable {
    let frames: [Int]?
    let frameDurationMilliseconds: Int?
    let looping: Bool?
    let reducedMotionFrame: Int?
    let fallbackState: OrbVisualState?
}

struct OrbPackManifest: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let sheet: String
    let columns: Int
    let rows: Int
    let accent: String
    let alphaMode: OrbAlphaMode?
    let previewState: OrbVisualState
    let fallbackState: OrbVisualState
    let states: [String: OrbSequenceManifest]

    var accentColor: Color { Color(hex: accent) ?? .accentColor }

    func resolvedSequence(for state: OrbVisualState) -> OrbSequenceManifest? {
        var candidate = state
        var visited = Set<OrbVisualState>()
        while visited.insert(candidate).inserted {
            guard let sequence = states[candidate.rawValue] else {
                candidate = fallbackState
                continue
            }
            if sequence.frames?.isEmpty == false { return sequence }
            candidate = sequence.fallbackState ?? fallbackState
        }
        return nil
    }
}

struct OrbCatalogManifest: Codable, Equatable, Sendable {
    let version: Int
    let packs: [OrbPackManifest]

    func validated() throws -> Self {
        guard version == 1 else { throw OrbCatalogError.unsupportedVersion(version) }
        guard !packs.isEmpty else { throw OrbCatalogError.emptyCatalog }
        guard Set(packs.map(\.id)).count == packs.count else { throw OrbCatalogError.duplicatePackID }
        for pack in packs {
            guard !pack.id.isEmpty, !pack.name.isEmpty, pack.columns > 0, pack.rows > 0 else {
                throw OrbCatalogError.invalidPack(pack.id)
            }
            guard pack.columns <= 32, pack.rows <= 32, pack.columns * pack.rows <= 1_024 else {
                throw OrbCatalogError.unsafeGrid(pack.id)
            }
            let frameCount = pack.columns * pack.rows
            for state in OrbVisualState.allCases {
                guard let sequence = pack.resolvedSequence(for: state),
                      let frames = sequence.frames,
                      !frames.isEmpty,
                      frames.allSatisfy({ $0 >= 0 && $0 < frameCount }),
                      let duration = sequence.frameDurationMilliseconds,
                      duration > 0,
                      let reducedFrame = sequence.reducedMotionFrame,
                      frames.contains(reducedFrame)
                else { throw OrbCatalogError.invalidState(pack.id, state) }
            }
        }
        return self
    }
}

enum OrbCatalogError: Error, Equatable {
    case missingCatalog
    case unsupportedVersion(Int)
    case emptyCatalog
    case duplicatePackID
    case invalidPack(String)
    case unsafeGrid(String)
    case invalidState(String, OrbVisualState)
    case missingSheet(String)
    case unreadableSheet(String)
    case invalidSheetDimensions(String)
}

struct OrbCatalog {
    static let shared: OrbCatalog = {
        do { return try load() }
        catch { fatalError("Invalid bundled orb catalog: \(error)") }
    }()

    let packs: [OrbPackManifest]
    let bundle: Bundle

    var defaultPack: OrbPackManifest { packs[0] }

    func pack(id: String) -> OrbPackManifest {
        packs.first(where: { $0.id == id }) ?? defaultPack
    }

    func sheetURL(for pack: OrbPackManifest) throws -> URL {
        let name = (pack.sheet as NSString).deletingPathExtension
        let extensionName = (pack.sheet as NSString).pathExtension
        guard let url = bundle.url(forResource: name, withExtension: extensionName) else {
            throw OrbCatalogError.missingSheet(pack.sheet)
        }
        return url
    }

    static func load(bundle: Bundle = .module) throws -> OrbCatalog {
        guard let url = bundle.url(forResource: "catalog", withExtension: "json") else {
            throw OrbCatalogError.missingCatalog
        }
        let manifest = try JSONDecoder().decode(OrbCatalogManifest.self, from: Data(contentsOf: url)).validated()
        let catalog = OrbCatalog(packs: manifest.packs, bundle: bundle)
        for pack in catalog.packs {
            let sheetURL = try catalog.sheetURL(for: pack)
            guard NSImage(contentsOf: sheetURL) != nil else {
                throw OrbCatalogError.unreadableSheet(pack.sheet)
            }
            try validateSheetDimensions(pack: pack, url: sheetURL)
        }
        return catalog
    }

    private static func validateSheetDimensions(pack: OrbPackManifest, url: URL) throws {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0,
              height > 0,
              width <= 4_096,
              height <= 4_096,
              width * height <= 16 * 1_024 * 1_024,
              width.isMultiple(of: pack.columns),
              height.isMultiple(of: pack.rows),
              (32 ... 2_048).contains(width / pack.columns),
              (32 ... 2_048).contains(height / pack.rows)
        else { throw OrbCatalogError.invalidSheetDimensions(pack.sheet) }
    }
}

private extension Color {
    init?(hex: String) {
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xff) / 255,
            green: Double((value >> 8) & 0xff) / 255,
            blue: Double(value & 0xff) / 255
        )
    }
}
