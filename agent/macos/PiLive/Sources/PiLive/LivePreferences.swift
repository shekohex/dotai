import Foundation

struct LivePreferences {
    private enum Key {
        static let sshTarget = "sshTarget"
        static let transport = "preferredTransport"
        static let voice = "liveVoice"
        static let orb = "selectedOrbID"
        static let instructions = "liveInstructions"
        static let diagnosticsEnabled = "liveDiagnosticsEnabled"
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var sshTarget: String { defaults.string(forKey: Key.sshTarget) ?? "" }
    var transport: PreferredTransport {
        PreferredTransport(rawValue: defaults.string(forKey: Key.transport) ?? "automatic") ?? .automatic
    }
    var voice: LiveVoice {
        LiveVoice(rawValue: defaults.string(forKey: Key.voice) ?? "sol") ?? .sol
    }
    var selectedOrbID: String { defaults.string(forKey: Key.orb) ?? OrbCatalog.shared.defaultPack.id }
    var instructions: String { defaults.string(forKey: Key.instructions) ?? "" }
    var diagnosticsEnabled: Bool { defaults.bool(forKey: Key.diagnosticsEnabled) }

    func save(
        sshTarget: String,
        transport: PreferredTransport,
        voice: LiveVoice,
        selectedOrbID: String,
        instructions: String,
        diagnosticsEnabled: Bool
    ) {
        defaults.set(sshTarget, forKey: Key.sshTarget)
        defaults.set(transport.rawValue, forKey: Key.transport)
        defaults.set(voice.rawValue, forKey: Key.voice)
        defaults.set(selectedOrbID, forKey: Key.orb)
        defaults.set(instructions, forKey: Key.instructions)
        defaults.set(diagnosticsEnabled, forKey: Key.diagnosticsEnabled)
    }

    func saveVoice(_ voice: LiveVoice) {
        defaults.set(voice.rawValue, forKey: Key.voice)
    }

    func saveOrbID(_ selectedOrbID: String) {
        defaults.set(selectedOrbID, forKey: Key.orb)
    }

    func saveDiagnosticsEnabled(_ enabled: Bool) {
        defaults.set(enabled, forKey: Key.diagnosticsEnabled)
    }
}
