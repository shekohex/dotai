import SwiftUI

struct CompactLiveSurface: View {
    @Bindable var model: LiveViewModel
    @Environment(\.openSettings) private var openSettings
    @State private var hovering = false

    private var agentSpeaking: Bool {
        model.outputLevel >= 0.012
    }

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            ZStack {
                VStack(spacing: 3) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 6, height: 6)
                            .shadow(color: statusColor.opacity(0.7), radius: 4)
                        Text(statusPrompt)
                            .font(.headline.weight(.medium))
                    }

                    ZStack {
                        SiriVoiceWaveform(
                            colors: model.selectedVoice.colors,
                            phase: model.phase,
                            inputLevel: model.inputLevel,
                            outputLevel: model.outputLevel,
                            speechActive: model.speechActive
                        )
                        .opacity(model.muted ? 0 : 1)
                        .accessibilityHidden(model.muted)

                        if model.muted {
                            Text(agentSpeaking ? "Pi is speaking" : "Microphone muted")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                                .transition(.opacity)
                        }
                    }
                    .frame(width: 272, height: 47)
                    .animation(.smooth(duration: 0.2), value: model.muted)

                    Text(model.transcript.isEmpty ? supportingStatus : model.transcript)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .contentTransition(.opacity)
                        .frame(maxWidth: 300)
                }

                VoiceOrb(
                    voice: model.selectedVoice,
                    phase: model.phase,
                    muted: model.muted,
                    inputLevel: model.inputLevel,
                    outputLevel: model.outputLevel,
                    speechActive: model.speechActive
                )
                .frame(width: 48, height: 48)
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 6) {
                    CompactControlButton(
                        systemImage: "gearshape.fill",
                        tint: model.selectedVoice.accent,
                        label: "Settings",
                        action: { openSettings() }
                    )

                    CompactControlButton(
                        systemImage: model.muted ? "mic.slash.fill" : "mic.fill",
                        tint: model.muted ? .orange : model.selectedVoice.accent,
                        label: model.muted ? "Unmute" : "Mute",
                        action: model.toggleMute
                    )
                    .disabled(model.phase == .ending)

                    CompactControlButton(
                        systemImage: "phone.down.fill",
                        tint: .red,
                        label: "End call",
                        action: model.disconnect
                    )
                    .disabled(model.phase == .ending)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .opacity(hovering || model.muted ? 1 : 0.58)
                .animation(.smooth(duration: 0.18), value: hovering)
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 12)
            .background(.black.opacity(0.16), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .liveGlass(
                tint: model.selectedVoice.accent.opacity(0.1),
                in: RoundedRectangle(cornerRadius: 24, style: .continuous)
            )
            .overlay {
                AppleIntelligenceGlow(
                    voice: model.selectedVoice,
                    phase: model.phase,
                    muted: model.muted,
                    inputLevel: model.inputLevel,
                    outputLevel: model.outputLevel
                )
            }
        }
        .padding(8)
        .frame(width: 420, height: 138)
        .onHover { hovering = $0 }
        .accessibilityHint("Press Space to mute or unmute while this window is focused.")
    }

    private var statusColor: Color {
        if model.muted && agentSpeaking { return model.selectedVoice.colors[0] }
        return switch model.phase {
        case .working: .orange
        case .speaking: model.selectedVoice.colors[0]
        case .muted: .orange
        case .error: .red
        case .ending: .secondary
        default: model.speechActive ? .green : model.selectedVoice.accent
        }
    }

    private var statusPrompt: String {
        if model.muted && agentSpeaking { return "Speaking · Muted" }
        return switch model.phase {
        case .working: "Working on it"
        case .muted: "Muted"
        case .speaking: "Speaking"
        case .ending: "Ending call…"
        case .reconnecting: "Reconnecting…"
        case .error: "Needs attention"
        default: model.speechActive ? "Listening" : "Ask Pi"
        }
    }

    private var supportingStatus: String {
        if model.muted && agentSpeaking { return "Pi is speaking; your microphone remains off." }
        return switch model.phase {
        case .working: "Pi is handling the workspace request."
        case .muted: "Microphone is off. Press Space to unmute."
        case .speaking: "Interrupt at any time."
        case .ending: "Closing cleanly…"
        default: "Listening for your voice."
        }
    }
}
