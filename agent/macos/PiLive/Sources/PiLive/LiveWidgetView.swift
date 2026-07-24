import SwiftUI

struct LiveWidgetView: View {
    @ObservedObject var model: LiveViewModel
    @Environment(\.openSettings) private var openSettings

    private var isLive: Bool {
        model.connected || [.listening, .working, .speaking, .muted, .ending].contains(model.phase)
    }

    var body: some View {
        Group {
            if isLive {
                compactLiveSurface
            } else {
                pairingSurface
            }
        }
        .animation(.snappy(duration: 0.32), value: isLive)
        .onDisappear {
            if isLive { model.disconnect() }
        }
    }

    private var pairingSurface: some View {
        ZStack {
            LiveBackdrop(voice: model.selectedVoice)

            VStack(spacing: 0) {
                pairingHeader
                pairingBody
            }
            .padding(22)
        }
        .frame(width: 460, height: 500)
    }

    private var pairingHeader: some View {
        HStack(spacing: 11) {
            VoiceMark(voice: model.selectedVoice)

            VStack(alignment: .leading, spacing: 1) {
                Text("Pi Live")
                    .font(.headline)
                Text(phaseLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button { openSettings() } label: {
                Image(systemName: "gearshape.fill")
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.glass(.regular.tint(model.selectedVoice.accent.opacity(0.18))))
            .buttonBorderShape(.circle)
            .help("Pi Live Settings")
        }
    }

    private var pairingBody: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 8)

            VoiceOrb(
                voice: model.selectedVoice,
                phase: model.phase,
                inputLevel: 0.03,
                outputLevel: 0,
                speechActive: false
            )
            .frame(width: 132, height: 132)

            VStack(spacing: 6) {
                Text("Ready when you are")
                    .font(.title2.weight(.semibold))
                Text("Start /live in Pi, then connect this Mac to your workspace.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 340)
            }

            VStack(spacing: 12) {
                HStack(spacing: 10) {
                    Image(systemName: pairingLinkReady ? "link.circle.fill" : "link.circle")
                        .font(.title3)
                        .foregroundStyle(pairingLinkReady ? model.selectedVoice.accent : .secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(pairingLinkReady ? "Pairing link detected" : "Pairing link needed")
                            .font(.subheadline.weight(.semibold))
                        Text(pairingLinkReady ? "Secure, single-use link" : "Copied automatically by /live")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Paste") { model.pastePairingURL() }
                        .buttonStyle(.borderless)
                }

                Divider()

                HStack {
                    Label(model.selectedVoice.displayName, systemImage: "waveform.badge.mic")
                    Spacer()
                    Text(model.preferredTransport.rawValue.capitalized)
                        .foregroundStyle(.secondary)
                }
                .font(.subheadline)
            }
            .padding(15)
            .liveGlass(tint: model.selectedVoice.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))

            if !model.errorMessage.isEmpty {
                Label(model.errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }

            Button { model.connect() } label: {
                HStack(spacing: 8) {
                    if model.phase == .pairing || model.phase == .connecting {
                        ProgressView().controlSize(.small)
                    }
                    Text(model.phase == .pairing || model.phase == .connecting ? "Connecting…" : "Connect")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 30)
            }
            .buttonStyle(.borderedProminent)
            .tint(model.selectedVoice.accent)
            .disabled(!pairingLinkReady || model.phase == .pairing || model.phase == .connecting)
        }
    }

    private var compactLiveSurface: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 14) {
                VoiceOrb(
                    voice: model.selectedVoice,
                    phase: model.phase,
                    inputLevel: model.inputLevel,
                    outputLevel: model.outputLevel,
                    speechActive: model.speechActive
                )
                .frame(width: 72, height: 72)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 6, height: 6)
                            .shadow(color: statusColor.opacity(0.7), radius: 4)
                        Text(statusPrompt)
                            .font(.subheadline.weight(.semibold))
                        Spacer(minLength: 4)
                        Text(model.selectedVoice.displayName)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                    }

                    SiriVoiceWaveform(
                        colors: model.selectedVoice.colors,
                        phase: model.phase,
                        inputLevel: model.inputLevel,
                        outputLevel: model.outputLevel,
                        speechActive: model.speechActive
                    )
                    .frame(height: 54)

                    Text(model.transcript.isEmpty ? supportingStatus : model.transcript)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .contentTransition(.opacity)
                }
                .frame(maxWidth: .infinity)

                VStack(spacing: 8) {
                    CompactControlButton(
                        systemImage: "gearshape.fill",
                        tint: model.selectedVoice.accent,
                        help: "Settings",
                        action: { openSettings() }
                    )

                    CompactControlButton(
                        systemImage: model.muted ? "mic.slash.fill" : "mic.fill",
                        tint: model.muted ? .orange : model.selectedVoice.accent,
                        help: model.muted ? "Unmute" : "Mute",
                        action: model.toggleMute
                    )
                    .disabled(model.phase == .ending)

                    CompactControlButton(
                        systemImage: "phone.down.fill",
                        tint: .red,
                        help: "End",
                        action: model.disconnect
                    )
                    .disabled(model.phase == .ending)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .liveGlass(
                tint: model.selectedVoice.accent.opacity(0.1),
                in: RoundedRectangle(cornerRadius: 30, style: .continuous)
            )
        }
        .padding(8)
        .frame(width: 450, height: 154)
    }

    private var pairingLinkReady: Bool {
        model.pairingURL.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("pi-live://pair#")
    }

    private var statusColor: Color {
        switch model.phase {
        case .working: .orange
        case .speaking: model.selectedVoice.colors[0]
        case .muted: .orange
        case .error: .red
        case .ending: .secondary
        default: model.speechActive ? .green : model.selectedVoice.accent
        }
    }

    private var phaseLabel: String {
        switch model.phase {
        case .idle: "Not connected"
        case .pairing: "Pairing securely"
        case .connecting: "Connecting"
        case .listening: model.speechActive ? "Hearing you" : "Listening"
        case .speaking: "Speaking"
        case .working: "Working"
        case .muted: "Microphone muted"
        case .ending: "Ending call"
        case .reconnecting: "Reconnecting"
        case .error: "Needs attention"
        }
    }

    private var statusPrompt: String {
        switch model.phase {
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
        switch model.phase {
        case .working: "Pi is handling the workspace request."
        case .muted: "Microphone is off."
        case .speaking: "Interrupt at any time."
        case .ending: "Closing cleanly…"
        default: "Listening for your voice."
        }
    }
}

private struct VoiceMark: View {
    let voice: LiveVoice

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: voice.colors,
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Image(systemName: "waveform")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.white)
        }
        .frame(width: 30, height: 30)
        .shadow(color: voice.accent.opacity(0.45), radius: 10)
    }
}

private struct CompactControlButton: View {
    let systemImage: String
    let tint: Color
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .semibold))
                .frame(width: 28, height: 28)
        }
        .buttonStyle(.glass(.regular.tint(tint.opacity(0.22))))
        .buttonBorderShape(.circle)
        .help(help)
    }
}

/// Audio-reactive aurora sphere adapted for Pi Live from the MIT-licensed
/// Cursor Voice orb composition, then rebuilt around Pi phases and voice palettes.
private struct VoiceOrb: View {
    let voice: LiveVoice
    let phase: LivePhase
    let inputLevel: Double
    let outputLevel: Double
    let speechActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var energy: Double {
        if phase == .muted || phase == .ending { return 0.01 }
        if phase == .working { return 0.17 }
        return min(1, max(inputLevel, outputLevel) * 5.2 + (speechActive ? 0.16 : 0.055))
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { timeline in
            let time = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
            let breath = reduceMotion ? 0 : sin(time * 2.25) * (0.012 + energy * 0.016)

            ZStack {
                Circle()
                    .stroke(voice.accent.opacity(0.16 + energy * 0.22), lineWidth: 1)
                    .scaleEffect(1.1 + energy * 0.08 + breath)
                Circle()
                    .stroke(voice.colors[0].opacity(0.08 + energy * 0.16), lineWidth: 0.8)
                    .scaleEffect(1.22 + energy * 0.11 - breath * 0.7)

                ZStack {
                    Circle()
                        .fill(
                            AngularGradient(
                                colors: orbColors,
                                center: .center,
                                angle: .degrees(time * 34)
                            )
                        )

                    Circle()
                        .fill(voice.colors[0].opacity(0.85))
                        .scaleEffect(0.72 + energy * 0.18)
                        .offset(
                            x: sin(time * 1.3) * 17,
                            y: cos(time * 1.1) * 15
                        )
                        .blur(radius: 12)
                        .blendMode(.plusLighter)

                    Circle()
                        .fill(voice.colors[2].opacity(0.78))
                        .scaleEffect(0.64 + energy * 0.2)
                        .offset(
                            x: cos(time * 0.9) * 18,
                            y: sin(time * 1.4) * 16
                        )
                        .blur(radius: 13)
                        .blendMode(.screen)

                    Circle()
                        .fill(
                            RadialGradient(
                                colors: [.white.opacity(0.82), .white.opacity(0.08), .clear],
                                center: UnitPoint(
                                    x: 0.32 + sin(time * 0.7) * 0.1,
                                    y: 0.26 + cos(time * 0.8) * 0.08
                                ),
                                startRadius: 1,
                                endRadius: 58
                            )
                        )
                        .blendMode(.screen)
                }
                .clipShape(Circle())
                .overlay(Circle().stroke(.white.opacity(0.3), lineWidth: 0.7))
                .rotationEffect(.degrees(reduceMotion ? 0 : sin(time * 0.35) * 10))
                .shadow(color: voice.accent.opacity(0.36 + energy * 0.35), radius: 16 + energy * 18)
                .scaleEffect(1 + energy * 0.075 + breath)
                .saturation(phase == .muted || phase == .ending ? 0.15 : 1.2)

                Ellipse()
                    .fill(.white.opacity(0.68))
                    .frame(width: 31, height: 12)
                    .offset(x: -17, y: -27)
                    .blur(radius: 4)
                    .blendMode(.screen)
            }
            .animation(.smooth(duration: 0.18), value: energy)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Pi Live voice activity")
        .accessibilityValue(phase.rawValue)
    }

    private var orbColors: [Color] {
        if phase == .error { return [.red, .orange, .red, .purple, .red] }
        if phase == .muted || phase == .ending {
            return [.gray.opacity(0.8), .secondary, .gray, .secondary, .gray.opacity(0.8)]
        }
        return voice.colors + Array(voice.colors.reversed()) + [voice.colors[0]]
    }
}

private struct LiveBackdrop: View {
    let voice: LiveVoice

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor).opacity(0.82)
            RadialGradient(
                colors: [voice.colors[0].opacity(0.08), .clear],
                center: .topLeading,
                startRadius: 20,
                endRadius: 390
            )
            RadialGradient(
                colors: [voice.colors[1].opacity(0.06), .clear],
                center: .bottomTrailing,
                startRadius: 10,
                endRadius: 350
            )
        }
        .ignoresSafeArea()
    }
}

extension View {
    func liveGlass<S: Shape>(tint: Color? = nil, in shape: S) -> some View {
        glassEffect(.regular.tint(tint), in: shape)
    }
}
