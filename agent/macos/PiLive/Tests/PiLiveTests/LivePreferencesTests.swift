import Foundation
import XCTest
@testable import PiLive

final class LivePreferencesTests: XCTestCase {
    func testOrbPersistenceIsSeparateFromVoice() throws {
        let suiteName = "PiLiveTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let preferences = LivePreferences(defaults: defaults)

        preferences.saveVoice(.maple)
        preferences.saveOrbID("miss-minutes")

        XCTAssertEqual(preferences.voice, .maple)
        XCTAssertEqual(preferences.selectedOrbID, "miss-minutes")
        preferences.saveOrbID("future-pack")
        XCTAssertEqual(preferences.voice, .maple)
        XCTAssertEqual(preferences.selectedOrbID, "future-pack")
    }

    func testUnknownOrbFallsBackThroughCatalogWithoutChangingVoice() throws {
        let suiteName = "PiLiveTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("spruce", forKey: "liveVoice")
        defaults.set("removed-pack", forKey: "selectedOrbID")
        let preferences = LivePreferences(defaults: defaults)

        XCTAssertEqual(preferences.voice, .spruce)
        XCTAssertEqual(
            OrbCatalog.shared.pack(id: preferences.selectedOrbID).id,
            OrbCatalog.shared.defaultPack.id
        )
    }
}
