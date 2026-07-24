import AppKit
import Foundation
import KeyboardShortcuts
import Observation

@MainActor
@Observable
final class LiveViewModel {
    var pairingURL = ""
    var coderToken: String
    var sshTarget: String
    var preferredTransport: PreferredTransport
    var selectedVoice: LiveVoice
    var phase: LivePhase = .idle
    var transcript = ""
    var errorMessage = ""
    var muted = false
    var inputLevel = 0.0
    var outputLevel = 0.0
    var speechActive = false
    var settingsMessage = ""
    var customInstructions: String

    var connected: Bool {
        ![.idle, .pairing, .connecting, .error].contains(phase)
    }

    @ObservationIgnored var showWindow: () -> Void = {}
    @ObservationIgnored var hideWindow: () -> Void = {}
    @ObservationIgnored var contentSizeDidChange: () -> Void = {}

    @ObservationIgnored private let credentials: CredentialStore
    @ObservationIgnored private let preferences: LivePreferences
    @ObservationIgnored private let client: LivePairingClient
    @ObservationIgnored private var eventTask: Task<Void, Never>?

    init(
        credentials: CredentialStore = CredentialStore(),
        preferences: LivePreferences = LivePreferences(),
        client: LivePairingClient = LivePairingClient()
    ) {
        self.credentials = credentials
        self.preferences = preferences
        self.client = client
        coderToken = credentials.readCoderToken()
        sshTarget = preferences.sshTarget
        preferredTransport = preferences.transport
        selectedVoice = preferences.voice
        customInstructions = preferences.instructions

        eventTask = Task { [weak self, events = client.events] in
            for await event in events {
                guard let self else { return }
                self.consume(event)
            }
        }
        importPairingURLFromPasteboard()
        KeyboardShortcuts.onKeyUp(for: .showPiLive) { [weak self] in
            self?.activateFromGlobalShortcut()
        }
    }

    func pastePairingURL() {
        pairingURL = NSPasteboard.general.string(forType: .string) ?? pairingURL
    }

    func activateFromGlobalShortcut() {
        importPairingURLFromPasteboard()
        showWindow()
    }

    func connect() {
        errorMessage = ""
        persistSettings()
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
        guard connected, phase != .ending else { return }
        Task { await client.toggleMute() }
    }

    func disconnect() {
        errorMessage = ""
        Task { await client.endSession() }
    }

    func selectVoice(_ voice: LiveVoice) {
        guard selectedVoice != voice else { return }
        selectedVoice = voice
        preferences.saveVoice(voice)
        client.setPreferredVoice(voice)
    }

    func saveSettings() {
        customInstructions = normalizedInstructions
        persistSettings()
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

    private func consume(_ event: LiveClientEvent) {
        switch event {
        case let .phase(newPhase):
            phase = newPhase
            muted = newPhase == .muted
        case let .transcript(text):
            transcript = text
        case let .failure(message):
            errorMessage = message
        case .stopped:
            reset()
        case let .levels(input, output, active):
            inputLevel = input
            outputLevel = output
            speechActive = active
        case let .voiceSetting(voice, appliesTo):
            selectedVoice = voice
            preferences.saveVoice(voice)
            settingsMessage = appliesTo == "current"
                ? "Using \(voice.displayName) for this call"
                : "\(voice.displayName) saved for the next call"
        case let .instructionsSetting(appliesTo):
            settingsMessage = appliesTo == "current"
                ? "Assistant preferences are active for this call"
                : "Assistant preferences saved for the next call"
        }
    }

    private func reset() {
        muted = false
        phase = .idle
        transcript = ""
        inputLevel = 0
        outputLevel = 0
        speechActive = false
        errorMessage = ""
        hideWindow()
    }

    private func persistSettings() {
        preferences.save(
            sshTarget: sshTarget,
            transport: preferredTransport,
            voice: selectedVoice,
            instructions: normalizedInstructions
        )
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
