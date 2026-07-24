import Foundation

struct LivePreferences {
    private enum Key {
        static let sshTarget = "sshTarget"
        static let transport = "preferredTransport"
        static let voice = "liveVoice"
        static let instructions = "liveInstructions"
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
    var instructions: String { defaults.string(forKey: Key.instructions) ?? "" }

    func save(
        sshTarget: String,
        transport: PreferredTransport,
        voice: LiveVoice,
        instructions: String
    ) {
        defaults.set(sshTarget, forKey: Key.sshTarget)
        defaults.set(transport.rawValue, forKey: Key.transport)
        defaults.set(voice.rawValue, forKey: Key.voice)
        defaults.set(instructions, forKey: Key.instructions)
    }

    func saveVoice(_ voice: LiveVoice) {
        defaults.set(voice.rawValue, forKey: Key.voice)
    }
}
