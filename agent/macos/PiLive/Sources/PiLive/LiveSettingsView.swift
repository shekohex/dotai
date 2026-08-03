import AppKit
import Combine
import KeyboardShortcuts
import SwiftUI

struct LiveSettingsView: View {
    @Bindable var model: LiveViewModel
    @State private var selectedSection: LiveSettingsSection = .general

    var body: some View {
        NavigationSplitView {
            List(LiveSettingsSection.allCases, selection: $selectedSection) { section in
                Label(section.title, systemImage: section.systemImage)
                    .tag(section)
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 155, ideal: 175, max: 195)
        } detail: {
            VStack(spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(selectedSection.title)
                            .font(.title2.weight(.semibold))
                        Text(selectedSection.detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(.horizontal, 24)
                .padding(.top, 20)
                .padding(.bottom, 14)

                Divider()

                selectedSettings
            }
            .background(Color(nsColor: .windowBackgroundColor).opacity(0.5))
        }
        .frame(width: 760, height: 540)
        .onDisappear { model.saveSettings() }
    }

    @ViewBuilder
    private var selectedSettings: some View {
        switch selectedSection {
        case .general: generalSettings
        case .orbs: orbSettings
        case .voice: voiceSettings
        case .assistant: assistantSettings
        case .connection: connectionSettings
        case .audio: audioSettings
        case .permissions: permissionsSettings
        }
    }

    private var generalSettings: some View {
        Form {
            Section("Global shortcut") {
                KeyboardShortcuts.Recorder("Show Pi Live", name: .showPiLive)
                Text("The shortcut works from any app. It imports a valid pi-live pairing link from the clipboard, then opens Pi Live above the Dock.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Section("Call window") {
                LabeledContent("While connected", value: "Floating animated orb")
                LabeledContent("After hangup", value: "Hide automatically")
                LabeledContent("Mute shortcut", value: "Space while focused")
                LabeledContent("Mouse", value: "Click to mute · Double-click to end")
                LabeledContent("Escape", value: "Press twice to end")
                Text("Pi Live remains available in the menu bar after the call window closes. Right-click the orb for explicit call controls.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Diagnostics") {
                Toggle(
                    "Enable diagnostic logging",
                    isOn: Binding(
                        get: { model.diagnosticsEnabled },
                        set: { model.setDiagnosticsEnabled($0) }
                    )
                )
                Text("Disabled by default. When enabled, Pi writes redacted live-session events to ~/.pi/agent/logs/live.jsonl in the workspace. Existing log files are not deleted when logging is turned off.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    private var assistantSettings: some View {
        Form {
            Section("Conversation") {
                LabeledContent("Spoken replies", value: "Follow your spoken language")
                LabeledContent("Workspace delegations", value: "Always synthesized in English")
                Text("Pi Live answers greetings and ordinary conversation itself. It delegates only requests that require repository context, coding, commands, tools, or workspace inspection.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Section("Custom instructions") {
                TextEditor(text: $model.customInstructions)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 170)
                    .padding(8)
                    .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color(nsColor: .separatorColor).opacity(0.35), lineWidth: 1)
                    )
                    .accessibilityLabel("Custom assistant instructions")

                HStack {
                    Text("Use this for tone, brevity, terminology, and conversational preferences. Core routing and language rules remain enforced.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(min(model.customInstructions.count, 8_000))/8,000")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(model.customInstructions.count > 8_000 ? Color.red : Color.secondary)
                }

                HStack {
                    Button("Reset", role: .destructive) { model.resetInstructions() }
                        .disabled(model.customInstructions.isEmpty)
                    Spacer()
                    if model.connected {
                        Text("Changes apply to the next call")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !model.settingsMessage.isEmpty {
                Section {
                    Label(model.settingsMessage, systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    private var voiceSettings: some View {
        Form {
            Section {
                HStack(spacing: 18) {
                    Image(systemName: "waveform.badge.mic")
                        .font(.system(size: 34, weight: .medium))
                        .foregroundStyle(model.selectedOrb.accentColor)
                        .frame(width: 82, height: 82)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.selectedVoice.displayName)
                            .font(.title2.weight(.semibold))
                        Text("Used for new calls. Changes made during a call are saved in Pi for the next session.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 8)
            }

            Section("Voice") {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    ForEach(LiveVoice.allCases) { voice in
                        VoiceSelectionButton(
                            voice: voice,
                            selected: model.selectedVoice == voice
                        ) {
                            model.selectVoice(voice)
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            if !model.settingsMessage.isEmpty {
                Section {
                    Label(model.settingsMessage, systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    private var orbSettings: some View {
        Form {
            Section {
                HStack(spacing: 18) {
                    OrbRenderer(pack: model.selectedOrb, state: model.selectedOrb.previewState)
                        .frame(width: 96, height: 96)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.selectedOrb.name)
                            .font(.title2.weight(.semibold))
                        Text("Stored on this Mac and independent from voice selection.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 8)
            }

            Section("Orb") {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    ForEach(OrbCatalog.shared.packs) { orb in
                        OrbSelectionButton(
                            orb: orb,
                            selected: model.selectedOrbID == orb.id
                        ) {
                            model.selectOrb(orb)
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Movement") {
                Toggle(
                    "Move orb around desktop",
                    isOn: Binding(
                        get: { model.desktopRoamingEnabled },
                        set: { model.setDesktopRoamingEnabled($0) }
                    )
                )
                Text("When enabled, the idle call orb walks right and returns to its starting position. Reduce Motion always keeps it stationary.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    private var connectionSettings: some View {
        Form {
            Section("Default connection") {
                Picker("Transport", selection: $model.preferredTransport) {
                    ForEach(PreferredTransport.allCases) { transport in
                        Text(transport.rawValue.capitalized).tag(transport)
                    }
                }

                if model.preferredTransport == .ssh || model.preferredTransport == .automatic {
                    TextField("SSH target", text: $model.sshTarget, prompt: Text("workspace.coder"))
                        .textContentType(.URL)
                }
            }

            Section("Coder") {
                SecureField(
                    "Session token",
                    text: $model.coderToken,
                    prompt: Text("Stored securely in Keychain")
                )
                .onSubmit { model.saveSettings() }
                Text("The token is stored in your macOS Keychain and is only sent to the selected Coder app endpoint.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                LabeledContent("Pairing", value: "Single-use, encrypted transport")
                LabeledContent("ChatGPT authentication", value: "Remains in the Pi workspace")
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    private var audioSettings: some View {
        Form {
            Section("Voice processing") {
                AudioFeatureRow(title: "Echo cancellation", detail: "WebRTC acoustic echo cancellation")
                AudioFeatureRow(title: "Noise suppression", detail: "WebRTC adaptive noise suppression")
                AudioFeatureRow(title: "Automatic gain", detail: "Keeps speech at a consistent level")
                AudioFeatureRow(title: "Media VAD", detail: "WebRTC voice activity detection")
                AudioFeatureRow(title: "High-pass filter", detail: "Reduces low-frequency rumble")
            }

            Section("Conversation activity") {
                LabeledContent("Turn detection", value: "Codex Live")
                LabeledContent("Orb state", value: "Local media + Pi activity")
                Text("Audio telemetry selects listening and talking states. Bundled sprite manifests define every animation and reduced-motion frame.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Section {
                Text("Pi Live uses WebRTC's real-time audio processing on the Mac. Presentation-level metering never clips or gates microphone audio; conversational turn detection remains with the live model.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    private var permissionsSettings: some View {
        PermissionsSettingsView(model: model.permissions)
    }
}

private enum LiveSettingsSection: String, CaseIterable, Identifiable {
    case general
    case orbs
    case voice
    case assistant
    case connection
    case audio
    case permissions

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: "General"
        case .orbs: "Orbs"
        case .voice: "Voice"
        case .assistant: "Assistant"
        case .connection: "Connection"
        case .audio: "Audio"
        case .permissions: "Permissions"
        }
    }

    var systemImage: String {
        switch self {
        case .general: "gearshape"
        case .orbs: "circle.hexagongrid.fill"
        case .voice: "waveform"
        case .assistant: "sparkles"
        case .connection: "network"
        case .audio: "waveform.badge.mic"
        case .permissions: "hand.raised.fill"
        }
    }

    var detail: String {
        switch self {
        case .general: "Shortcuts and call-window behavior"
        case .orbs: "Choose Pi Live's local visual identity"
        case .voice: "Choose Pi Live's spoken voice"
        case .assistant: "Conversation and workspace preferences"
        case .connection: "Transport, SSH, and Coder credentials"
        case .audio: "Microphone processing and speech activity"
        case .permissions: "Review microphone and Screen Recording access"
        }
    }
}

private struct PermissionsSettingsView: View {
    @Bindable var model: PermissionsViewModel

    var body: some View {
        Form {
            Section("Privacy & Security") {
                PermissionSettingsRow(
                    title: "Microphone",
                    detail: "Required for realtime voice conversations.",
                    status: model.microphoneStatus,
                    requesting: model.requestingMicrophone,
                    requestAction: {
                        Task { await model.requestMicrophonePermission() }
                    },
                    openSettingsAction: model.openMicrophoneSystemSettings
                )

                PermissionSettingsRow(
                    title: "Screen Recording",
                    detail: "Used only after you explicitly ask Pi to inspect the current display.",
                    status: model.screenRecordingStatus,
                    requesting: model.requestingScreenRecording,
                    requestAction: {
                        Task { await model.requestScreenRecordingPermission() }
                    },
                    openSettingsAction: model.openScreenRecordingSystemSettings
                )
            }

            Section("Screen Recording changes") {
                Text("macOS may require Pi Live to be quit and reopened after Screen Recording access changes before capture succeeds.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .onAppear { model.refresh() }
        .onReceive(NotificationCenter.default.publisher(
            for: NSApplication.didBecomeActiveNotification
        )) { _ in
            model.refresh()
        }
    }
}

private struct PermissionSettingsRow: View {
    let title: String
    let detail: String
    let status: LivePermissionStatus
    let requesting: Bool
    let requestAction: () -> Void
    let openSettingsAction: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: status.systemImage)
                    .font(.title3)
                    .foregroundStyle(status == .allowed ? Color.accentColor : Color.secondary)
                    .frame(width: 24)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.headline)
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                Text(status.title)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(status == .allowed ? Color.accentColor : Color.secondary)
                    .accessibilityLabel("\(title) status: \(status.title)")
            }

            HStack {
                Spacer()
                if status == .notRequested {
                    Button(requesting ? "Requesting…" : "Request Access", action: requestAction)
                        .disabled(requesting)
                        .accessibilityLabel("Request \(title) access")
                } else if status.requiresSystemSettings {
                    Button("Open System Settings", action: openSettingsAction)
                        .accessibilityLabel("Open \(title) settings")
                }
            }
        }
        .padding(.vertical, 5)
    }
}

private struct VoiceSelectionButton: View {
    let voice: LiveVoice
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: voice.colors,
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 22, height: 22)
                Text(voice.displayName)
                    .fontWeight(selected ? .semibold : .regular)
                Spacer(minLength: 2)
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(voice.accent)
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .contentShape(RoundedRectangle(cornerRadius: 11))
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 11)
                .fill(selected ? voice.accent.opacity(0.13) : Color.secondary.opacity(0.055))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 11)
                .stroke(selected ? voice.accent.opacity(0.5) : Color.secondary.opacity(0.12), lineWidth: 1)
        )
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct OrbSelectionButton: View {
    let orb: OrbPackManifest
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                OrbRenderer(pack: orb, state: orb.previewState)
                    .frame(width: 82, height: 82)
                HStack {
                    Text(orb.name)
                        .fontWeight(selected ? .semibold : .regular)
                    Spacer()
                    if selected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(orb.accentColor)
                    }
                }
            }
            .padding(12)
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(selected ? orb.accentColor.opacity(0.12) : Color.secondary.opacity(0.055))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(selected ? orb.accentColor.opacity(0.5) : Color.secondary.opacity(0.12))
        )
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct AudioFeatureRow: View {
    let title: String
    let detail: String

    var body: some View {
        LabeledContent {
            Text(detail)
                .foregroundStyle(.secondary)
        } label: {
            Label(title, systemImage: "checkmark.circle.fill")
                .foregroundStyle(.primary, .green)
        }
    }
}
