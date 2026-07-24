import SwiftUI
import KeyboardShortcuts

struct LiveSettingsView: View {
    @ObservedObject var model: LiveViewModel

    var body: some View {
        TabView {
            generalSettings
                .tabItem { Label("General", systemImage: "gearshape") }
            voiceSettings
                .tabItem { Label("Voice", systemImage: "waveform") }
            assistantSettings
                .tabItem { Label("Assistant", systemImage: "sparkles") }
            connectionSettings
                .tabItem { Label("Connection", systemImage: "network") }
            audioSettings
                .tabItem { Label("Audio", systemImage: "waveform.badge.mic") }
        }
        .padding(20)
        .frame(width: 600, height: 500)
        .onDisappear { model.saveSettings() }
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
                LabeledContent("While connected", value: "Compact floating strip")
                LabeledContent("After hangup", value: "Hide automatically")
                Text("Pi Live remains available in the menu bar after the call window closes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
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
    }

    private var voiceSettings: some View {
        Form {
            Section {
                HStack(spacing: 18) {
                    SettingsOrb(voice: model.selectedVoice)
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
                            model.selectedVoice = voice
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
    }

    private var audioSettings: some View {
        Form {
            Section("Voice processing") {
                AudioFeatureRow(title: "Echo cancellation", detail: "WebRTC acoustic echo cancellation")
                AudioFeatureRow(title: "Noise suppression", detail: "WebRTC adaptive noise suppression")
                AudioFeatureRow(title: "Automatic gain", detail: "Keeps speech at a consistent level")
                AudioFeatureRow(title: "Voice activity", detail: "Adaptive local VAD plus server turn detection")
                AudioFeatureRow(title: "High-pass filter", detail: "Reduces low-frequency rumble")
            }

            Section {
                Text("Pi Live uses WebRTC's real-time audio processing on the Mac. The local detector drives the interface and telemetry without clipping or gating microphone audio; conversational turn detection remains with the live model.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
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

private struct SettingsOrb: View {
    let voice: LiveVoice

    var body: some View {
        Circle()
            .fill(
                AngularGradient(
                    colors: voice.colors + Array(voice.colors.reversed()) + [voice.colors[0]],
                    center: .center
                )
            )
            .overlay(
                Circle().fill(
                    RadialGradient(
                        colors: [.white.opacity(0.7), .clear],
                        center: .topLeading,
                        startRadius: 1,
                        endRadius: 58
                    )
                )
                .blendMode(.screen)
            )
            .overlay(Circle().stroke(.white.opacity(0.3), lineWidth: 0.8))
            .shadow(color: voice.accent.opacity(0.35), radius: 16)
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
