import AppKit
import Foundation

@MainActor
final class LiveViewModel: ObservableObject {
    @Published var pairingURL = ""
    @Published var coderToken = ""
    @Published var sshTarget = UserDefaults.standard.string(forKey: "sshTarget") ?? "" {
        didSet { UserDefaults.standard.set(sshTarget, forKey: "sshTarget") }
    }
    @Published var preferredTransport = PreferredTransport(
        rawValue: UserDefaults.standard.string(forKey: "preferredTransport") ?? "automatic"
    ) ?? .automatic {
        didSet { UserDefaults.standard.set(preferredTransport.rawValue, forKey: "preferredTransport") }
    }
    @Published var selectedVoice = LiveVoice(
        rawValue: UserDefaults.standard.string(forKey: "liveVoice") ?? "sol"
    ) ?? .sol {
        didSet {
            UserDefaults.standard.set(selectedVoice.rawValue, forKey: "liveVoice")
            client.setPreferredVoice(selectedVoice)
        }
    }
    @Published var phase: LivePhase = .idle
    @Published var transcript = ""
    @Published var errorMessage = ""
    @Published var connected = false
    @Published var muted = false
    @Published var inputLevel = 0.0
    @Published var outputLevel = 0.0
    @Published var speechActive = false
    @Published var settingsMessage = ""
    @Published var customInstructions = UserDefaults.standard.string(forKey: "liveInstructions") ?? ""

    private let credentials = CredentialStore()
    private let client = LivePairingClient()

    init() {
        coderToken = credentials.readCoderToken()
        client.onPhase = { [weak self] phase in
            self?.phase = phase
            self?.connected = ![.idle, .pairing, .connecting, .error].contains(phase)
            self?.muted = phase == .muted
        }
        client.onTranscript = { [weak self] text in self?.transcript = text }
        client.onError = { [weak self] error in self?.errorMessage = error.localizedDescription }
        client.onStopped = { [weak self] in self?.reset() }
        client.onLevels = { [weak self] input, output, speechActive in
            self?.inputLevel = input
            self?.outputLevel = output
            self?.speechActive = speechActive
        }
        client.onVoiceSetting = { [weak self] voice, appliesTo in
            guard let self else { return }
            if self.selectedVoice != voice { self.selectedVoice = voice }
            self.settingsMessage = appliesTo == "current"
                ? "Using \(voice.displayName) for this call"
                : "\(voice.displayName) saved for the next call"
        }
        client.onInstructionsSetting = { [weak self] appliesTo in
            self?.settingsMessage = appliesTo == "current"
                ? "Assistant preferences are active for this call"
                : "Assistant preferences saved for the next call"
        }
        importPairingURLFromPasteboard()
    }

    func pastePairingURL() {
        pairingURL = NSPasteboard.general.string(forType: .string) ?? pairingURL
    }

    func connect() {
        errorMessage = ""
        do { try credentials.saveCoderToken(coderToken) }
        catch { errorMessage = error.localizedDescription; return }
        Task {
            do {
                try await client.connect(
                    pairingURL: pairingURL,
                    preferredTransport: preferredTransport,
                    coderToken: coderToken,
                    sshTarget: sshTarget,
                    voice: selectedVoice,
                    customInstructions: normalizedInstructions
                )
            } catch {
                phase = .error
                errorMessage = error.localizedDescription
            }
        }
    }

    func toggleMute() {
        Task { await client.toggleMute() }
    }

    func disconnect() {
        Task { await client.endSession() }
    }

    func saveSettings() {
        customInstructions = normalizedInstructions
        UserDefaults.standard.set(customInstructions, forKey: "liveInstructions")
        client.setCustomInstructions(customInstructions)
        do {
            try credentials.saveCoderToken(coderToken)
            errorMessage = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func resetInstructions() {
        customInstructions = ""
        saveSettings()
    }

    func prepareForTermination() async {
        if connected || ![.idle, .error].contains(phase) {
            await client.endSession()
        }
    }

    private func reset() {
        connected = false
        muted = false
        phase = .idle
        transcript = ""
        inputLevel = 0
        outputLevel = 0
        speechActive = false
    }

    private func importPairingURLFromPasteboard() {
        guard let value = NSPasteboard.general.string(forType: .string),
              value.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("pi-live://pair#")
        else { return }
        pairingURL = value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var normalizedInstructions: String {
        String(customInstructions.prefix(8_000)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
