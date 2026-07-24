import SwiftUI

struct PairingSurface: View {
    @Bindable var model: LiveViewModel
    let orbNamespace: Namespace.ID
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        ZStack {
            LiveBackdrop(voice: model.selectedVoice)

            VStack(spacing: 0) {
                header
                bodyContent
            }
            .padding(22)
        }
        .frame(width: 460, height: 500)
    }

    private var header: some View {
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
            .accessibilityLabel("Pi Live Settings")
        }
    }

    private var bodyContent: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 8)

            VoiceOrb(
                voice: model.selectedVoice,
                phase: model.phase,
                muted: false,
                inputLevel: 0.03,
                outputLevel: 0,
                speechActive: false
            )
            .matchedGeometryEffect(id: "live-orb", in: orbNamespace)
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

    private var pairingLinkReady: Bool {
        model.pairingURL.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("pi-live://pair#")
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
}
