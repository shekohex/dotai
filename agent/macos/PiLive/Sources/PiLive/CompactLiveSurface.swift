import AppKit
import SwiftUI

struct CompactLiveSurface: View {
    @Bindable var model: LiveViewModel
    let orbNamespace: Namespace.ID
    let escapeArmed: Bool
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(spacing: 7) {
            if escapeArmed {
                Label("Press Esc again to end", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 7)
                    .liveGlass(
                        tint: Color.red.opacity(0.17),
                        in: Capsule(style: .continuous)
                    )
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            ZStack {
                AppleIntelligenceGlow(
                    voice: model.selectedVoice,
                    phase: model.phase,
                    muted: model.muted,
                    inputLevel: model.inputLevel,
                    outputLevel: model.outputLevel
                )
                .frame(width: 94, height: 94)
                .opacity(escapeArmed ? 0.45 : 1)

                VoiceOrb(
                    voice: model.selectedVoice,
                    phase: model.phase,
                    muted: model.muted,
                    inputLevel: model.inputLevel,
                    outputLevel: model.outputLevel,
                    speechActive: model.speechActive
                )
                .matchedGeometryEffect(id: "live-orb", in: orbNamespace, isSource: false)
                .frame(width: 82, height: 82)

                if escapeArmed {
                    Circle()
                        .stroke(Color.red.opacity(0.8), lineWidth: 2)
                        .frame(width: 88, height: 88)
                        .transition(.opacity)
                }

                if model.muted {
                    Image(systemName: "mic.slash.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 24, height: 24)
                        .background(.orange.gradient, in: Circle())
                        .overlay(Circle().stroke(.white.opacity(0.38), lineWidth: 0.7))
                        .shadow(color: .black.opacity(0.3), radius: 4, y: 2)
                        .offset(x: 31, y: 31)
                        .transition(.scale.combined(with: .opacity))
                }

                OrbClickSurface(
                    onSingleClick: model.toggleMute,
                    onDoubleClick: model.disconnect
                )
                .clipShape(Circle())
                .frame(width: 92, height: 92)
                .accessibilityHidden(true)
            }
            .frame(width: 102, height: 102)
            .contentShape(Circle())
            .contextMenu {
                Button(model.muted ? "Unmute" : "Mute") {
                    model.toggleMute()
                }
                Button("Settings…") {
                    showSettings()
                }
                Divider()
                Button("End Call", role: .destructive) {
                    model.disconnect()
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityHint("Click once to mute or unmute. Double-click to end the call.")
            .accessibilityAction(named: model.muted ? "Unmute" : "Mute") {
                model.toggleMute()
            }
            .accessibilityAction(named: "End call") {
                model.disconnect()
            }
        }
        .padding(8)
        .frame(
            width: escapeArmed ? 210 : 118,
            height: escapeArmed ? 154 : 118,
            alignment: .bottom
        )
        .animation(.snappy(duration: 0.26), value: escapeArmed)
        .animation(.smooth(duration: 0.2), value: model.muted)
    }

    private var accessibilityLabel: String {
        if escapeArmed { return "Pi Live. Press Escape again to end the call." }
        if model.muted && model.outputLevel >= 0.012 {
            return "Pi is speaking. Microphone muted."
        }
        if model.muted { return "Pi Live. Microphone muted." }
        if model.speechActive { return "Pi Live is hearing you." }
        return "Pi Live. \(model.phase.rawValue)."
    }

    private func showSettings() {
        NSApp.activate(ignoringOtherApps: true)
        openSettings()
    }
}
