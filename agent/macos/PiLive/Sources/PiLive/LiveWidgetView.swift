import SwiftUI

struct LiveWidgetView: View {
    @ObservedObject var model: LiveViewModel

    var body: some View {
        VStack(spacing: 14) {
            HStack {
                Image(systemName: "waveform.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, phaseColor)
                Text("Pi Live")
                    .font(.headline)
                Spacer()
                Text(model.phase.rawValue.replacingOccurrences(of: "-", with: " "))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(phaseColor)
            }

            if model.connected || [.listening, .working, .speaking, .muted].contains(model.phase) {
                liveBody
            } else {
                pairingBody
            }

            if !model.errorMessage.isEmpty {
                Text(model.errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
        }
        .padding(18)
        .frame(width: 430)
        .background(.ultraThinMaterial)
    }

    private var pairingBody: some View {
        VStack(spacing: 10) {
            HStack {
                TextField("Paste pi-live:// pairing URL", text: $model.pairingURL)
                    .textFieldStyle(.roundedBorder)
                Button("Paste") { model.pastePairingURL() }
            }
            Picker("Transport", selection: $model.preferredTransport) {
                ForEach(PreferredTransport.allCases) { transport in
                    Text(transport.rawValue.capitalized).tag(transport)
                }
            }
            .pickerStyle(.segmented)
            if model.preferredTransport == .ssh || model.preferredTransport == .automatic {
                TextField("SSH target, for example pi.coder", text: $model.sshTarget)
                    .textFieldStyle(.roundedBorder)
            }
            if model.preferredTransport == .coder || model.preferredTransport == .automatic {
                SecureField("Coder session token, stored in Keychain", text: $model.coderToken)
                    .textFieldStyle(.roundedBorder)
            }
            Button {
                model.connect()
            } label: {
                HStack {
                    if model.phase == .pairing || model.phase == .connecting { ProgressView().controlSize(.small) }
                    Text("Connect")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.pairingURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var liveBody: some View {
        VStack(spacing: 16) {
            Waveform(phase: model.phase)
                .frame(height: 54)
            Text(model.transcript.isEmpty ? statusPrompt : model.transcript)
                .font(.title3)
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .frame(maxWidth: .infinity, minHeight: 50)
            HStack {
                Button {
                    model.toggleMute()
                } label: {
                    Label(model.muted ? "Unmute" : "Mute", systemImage: model.muted ? "mic.slash.fill" : "mic.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(model.muted ? .orange : .accentColor)
                Button(role: .destructive) { model.disconnect() } label: {
                    Label("End", systemImage: "phone.down.fill")
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var statusPrompt: String {
        switch model.phase {
        case .working: "Working in your Pi workspace…"
        case .muted: "Microphone muted"
        case .speaking: "Pi is speaking"
        default: "Listening…"
        }
    }

    private var phaseColor: Color {
        switch model.phase {
        case .listening: .green
        case .working: .orange
        case .speaking: .blue
        case .muted: .secondary
        case .error: .red
        default: .accentColor
        }
    }
}

private struct Waveform: View {
    let phase: LivePhase

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.08)) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0..<32, id: \.self) { index in
                    let active = phase != .muted
                    let wave = abs(sin(time * 3.5 + Double(index) * 0.53))
                    Capsule()
                        .fill(active ? Color.accentColor.gradient : Color.secondary.gradient)
                        .frame(width: 5, height: active ? 8 + wave * 38 : 6)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
