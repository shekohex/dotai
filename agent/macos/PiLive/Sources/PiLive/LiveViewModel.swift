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
    var selectedOrbID: String
    var desktopRoamingEnabled: Bool
    var orbState: OrbVisualState = .idle
    var phase: LivePhase = .idle
    var transcript = ""
    var agentProgress = ""
    var errorMessage = ""
    var muted = false
    var inputLevel = 0.0
    var outputLevel = 0.0
    var speechActive = false
    var mediaSessionActive = false
    var settingsMessage = ""
    var customInstructions: String
    var diagnosticsEnabled: Bool
    let permissions: PermissionsViewModel

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
    @ObservationIgnored private var agentProgressDelegationId = ""
    @ObservationIgnored private var remoteActivity: ActivitySnapshotParams?
    @ObservationIgnored private var orbStateEnteredAt = Date()
    @ObservationIgnored private var orbResolutionTask: Task<Void, Never>?

    var selectedOrb: OrbPackManifest { OrbCatalog.shared.pack(id: selectedOrbID) }

    init(
        credentials: CredentialStore = CredentialStore(),
        preferences: LivePreferences = LivePreferences(),
        client: LivePairingClient = LivePairingClient(),
        permissions: PermissionsViewModel = PermissionsViewModel()
    ) {
        self.credentials = credentials
        self.preferences = preferences
        self.client = client
        self.permissions = permissions
        coderToken = credentials.readCoderToken()
        sshTarget = preferences.sshTarget
        preferredTransport = preferences.transport
        selectedVoice = preferences.voice
        selectedOrbID = OrbCatalog.shared.pack(id: preferences.selectedOrbID).id
        desktopRoamingEnabled = preferences.desktopRoamingEnabled
        customInstructions = preferences.instructions
        diagnosticsEnabled = preferences.diagnosticsEnabled

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
        remoteActivity = nil
        mediaSessionActive = false
        inputLevel = 0
        outputLevel = 0
        speechActive = false
        updateOrbState()
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
                    customInstructions: normalizedInstructions,
                    diagnosticsEnabled: diagnosticsEnabled
                )
            } catch {
                phase = .error
                updateOrbState()
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

    func selectOrb(_ orb: OrbPackManifest) {
        guard selectedOrbID != orb.id else { return }
        selectedOrbID = orb.id
        preferences.saveOrbID(orb.id)
    }

    func setDesktopRoamingEnabled(_ enabled: Bool) {
        desktopRoamingEnabled = enabled
        preferences.saveDesktopRoamingEnabled(enabled)
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

    func setDiagnosticsEnabled(_ enabled: Bool) {
        diagnosticsEnabled = enabled
        preferences.saveDiagnosticsEnabled(enabled)
        client.setDiagnosticsEnabled(enabled)
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
            updateOrbState()
        case let .muted(isMuted):
            muted = isMuted
        case let .transcript(text):
            transcript = text
        case let .agentProgress(delegationId, text, _):
            if delegationId != agentProgressDelegationId {
                agentProgressDelegationId = delegationId
                agentProgress = ""
            }
            agentProgress = String((agentProgress + text).suffix(2_000))
        case .threadsSnapshot, .threadEvent:
            break
        case let .activitySnapshot(snapshot):
            guard snapshot.revision > (remoteActivity?.revision ?? -1) else { break }
            remoteActivity = snapshot
            updateOrbState()
        case let .failure(message):
            errorMessage = message
        case .stopped:
            reset()
        case let .levels(input, output, active):
            inputLevel = input
            outputLevel = output
            speechActive = active
            updateOrbState()
        case let .mediaSessionActive(active):
            mediaSessionActive = active
            updateOrbState()
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
        case let .diagnosticsSetting(enabled, appliesTo):
            diagnosticsEnabled = enabled
            preferences.saveDiagnosticsEnabled(enabled)
            settingsMessage = enabled
                ? "Diagnostic logging enabled for \(appliesTo == "current" ? "this call" : "the next call")"
                : "Diagnostic logging disabled"
        }
    }

    private func reset() {
        muted = false
        phase = .idle
        transcript = ""
        agentProgress = ""
        agentProgressDelegationId = ""
        inputLevel = 0
        outputLevel = 0
        speechActive = false
        mediaSessionActive = false
        remoteActivity = nil
        setOrbState(.idle)
        errorMessage = ""
        hideWindow()
    }

    private func persistSettings() {
        preferences.save(
            sshTarget: sshTarget,
            transport: preferredTransport,
            voice: selectedVoice,
            selectedOrbID: selectedOrbID,
            desktopRoamingEnabled: desktopRoamingEnabled,
            instructions: normalizedInstructions,
            diagnosticsEnabled: diagnosticsEnabled
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

    private func updateOrbState(now: Date = Date()) {
        orbResolutionTask?.cancel()
        let resolution = OrbStateResolver.resolve(
            inputs: OrbStateInputs(
                phase: phase,
                muted: muted,
                outputActive: outputLevel >= 0.012,
                speechActive: speechActive,
                mediaSessionActive: mediaSessionActive,
                remoteActivity: remoteActivity
            ),
            currentState: orbState,
            stateEnteredAt: orbStateEnteredAt,
            now: now
        )
        setOrbState(resolution.state, now: now)
        guard let reevaluateAt = resolution.reevaluateAt else { return }
        orbResolutionTask = Task { @MainActor [weak self] in
            let delay = max(0, reevaluateAt.timeIntervalSinceNow)
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.updateOrbState()
        }
    }

    private func setOrbState(_ state: OrbVisualState, now: Date = Date()) {
        guard orbState != state else { return }
        orbState = state
        orbStateEnteredAt = now
    }
}
