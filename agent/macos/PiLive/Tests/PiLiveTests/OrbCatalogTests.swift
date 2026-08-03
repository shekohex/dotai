import AppKit
import Foundation
import XCTest
@testable import PiLive

final class OrbCatalogTests: XCTestCase {
    func testBundledCatalogValidatesAndResolvesSpriteSheets() throws {
        let catalog = try OrbCatalog.load()

        XCTAssertEqual(catalog.packs.map(\.id), ["miss-minutes"])
        for pack in catalog.packs {
            let url = try catalog.sheetURL(for: pack)
            XCTAssertEqual(url.pathExtension, "png")
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
            for state in OrbVisualState.allCases {
                XCTAssertNotNil(pack.resolvedSequence(for: state))
            }
        }
    }

    func testCatalogRejectsOutOfBoundsFrames() throws {
        let sequence = OrbSequenceManifest(
            frames: [4],
            frameDurationMilliseconds: 100,
            looping: true,
            reducedMotionFrame: 4,
            fallbackState: nil
        )
        let firstPack = OrbPackManifest(
            id: "invalid",
            name: "Invalid",
            sheet: "invalid.png",
            columns: 2,
            rows: 2,
            accent: "FFFFFF",
            alphaMode: .hard,
            previewState: .idle,
            fallbackState: .idle,
            states: Dictionary(uniqueKeysWithValues: OrbVisualState.allCases.map { ($0.rawValue, sequence) })
        )
        let secondPack = OrbPackManifest(
            id: "invalid-two",
            name: firstPack.name,
            sheet: firstPack.sheet,
            columns: firstPack.columns,
            rows: firstPack.rows,
            accent: firstPack.accent,
            alphaMode: firstPack.alphaMode,
            previewState: firstPack.previewState,
            fallbackState: firstPack.fallbackState,
            states: firstPack.states
        )

        XCTAssertThrowsError(try OrbCatalogManifest(version: 1, packs: [firstPack, secondPack]).validated()) { error in
            XCTAssertEqual(error as? OrbCatalogError, .invalidState("invalid", .idle))
        }
    }

    func testCatalogSupportsSingleEightByTwelvePack() throws {
        let sequence = OrbSequenceManifest(
            frames: Array(0 ..< 96),
            frameDurationMilliseconds: 80,
            looping: true,
            reducedMotionFrame: 0,
            fallbackState: nil
        )
        let pack = OrbPackManifest(
            id: "ninety-six",
            name: "Ninety Six",
            sheet: "ninety-six.png",
            columns: 8,
            rows: 12,
            accent: "FF8000",
            alphaMode: .hard,
            previewState: .talking,
            fallbackState: .idle,
            states: Dictionary(uniqueKeysWithValues: OrbVisualState.allCases.map { ($0.rawValue, sequence) })
        )

        XCTAssertNoThrow(try OrbCatalogManifest(version: 1, packs: [pack]).validated())
    }

    func testEightByTwelvePackFitsCombinedDecodedCacheBudget() {
        let sheetCost = OrbFrameStore.decodedCost(width: 2_048, height: 3_072)
        let frameCost = OrbFrameStore.decodedCost(width: 256, height: 256)

        XCTAssertLessThanOrEqual(sheetCost + frameCost * 96, OrbFrameStore.cacheCostLimitBytes)
    }

    func testRenderedTalkingFramesDoNotContainAdjacentFrameFragments() throws {
        let pack = try XCTUnwrap(OrbCatalog.load().packs.first)
        let talking = try XCTUnwrap(pack.resolvedSequence(for: .talking))

        for frameIndex in try XCTUnwrap(talking.frames) {
            let image = try XCTUnwrap(OrbFrameStore.shared.frame(
                pack: pack,
                frameIndex: frameIndex
            ))
            let representation = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
            XCTAssertEqual(
                visibleComponentCount(in: representation),
                1,
                "Talking frame \(frameIndex) contains clipped adjacent-frame artwork"
            )
        }
    }

    private func visibleComponentCount(in representation: NSBitmapImageRep) -> Int {
        let width = representation.pixelsWide
        let height = representation.pixelsHigh
        var visited = Array(repeating: false, count: width * height)
        var components = 0
        for y in 0 ..< height {
            for x in 0 ..< width {
                let index = y * width + x
                guard !visited[index], (representation.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0 else {
                    continue
                }
                components += 1
                var queue = [index]
                visited[index] = true
                while let current = queue.popLast() {
                    let currentX = current % width
                    let currentY = current / width
                    for (nextX, nextY) in [
                        (currentX - 1, currentY),
                        (currentX + 1, currentY),
                        (currentX, currentY - 1),
                        (currentX, currentY + 1),
                    ] where nextX >= 0 && nextX < width && nextY >= 0 && nextY < height {
                        let next = nextY * width + nextX
                        guard !visited[next],
                              (representation.colorAt(x: nextX, y: nextY)?.alphaComponent ?? 0) > 0
                        else { continue }
                        visited[next] = true
                        queue.append(next)
                    }
                }
            }
        }
        return components
    }
}
