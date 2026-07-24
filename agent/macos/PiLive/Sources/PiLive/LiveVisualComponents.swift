import SwiftUI

struct VoiceMark: View {
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
        .accessibilityHidden(true)
    }
}

struct LiveBackdrop: View {
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
        .accessibilityHidden(true)
    }
}

extension View {
    func liveGlass<S: Shape>(tint: Color? = nil, in shape: S) -> some View {
        glassEffect(.regular.tint(tint), in: shape)
    }
}
