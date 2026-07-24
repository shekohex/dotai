import SwiftUI

/// A modern, audio-reactive Siri-style waveform. Its envelope and layered sine
/// composition are adapted from the MIT-licensed SwiftUI Siri waveform projects
/// by Noah Chalifour and Michele Volpato; rendering is rebuilt for macOS 26.
struct SiriVoiceWaveform: View {
    let colors: [Color]
    let phase: LivePhase
    let inputLevel: Double
    let outputLevel: Double
    let speechActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var energy: Double {
        if phase == .muted || phase == .ending { return 0.015 }
        if phase == .working { return 0.18 }
        let media = phase == .speaking ? outputLevel : max(inputLevel, outputLevel)
        return min(1, media * 7.5 + (speechActive ? 0.2 : 0.075))
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { timeline in
            let time = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
            let motion = CGFloat(time * (1.6 + energy * 2.8))

            ZStack {
                Capsule()
                    .fill(.primary.opacity(0.08))
                    .frame(height: 1)

                ForEach(Array(colors.enumerated()), id: \.offset) { index, color in
                    let progress = CGFloat(index) / CGFloat(max(1, colors.count - 1))
                    let amplitude = CGFloat(0.16 + energy * (0.72 - Double(progress) * 0.12))
                    let offset = CGFloat(index) * 1.7

                    SiriWaveShape(
                        amplitude: amplitude,
                        phase: motion * (1 + progress * 0.12) + offset,
                        frequency: 1.35 + progress * 0.65,
                        harmonic: 2.2 + progress * 0.8
                    )
                    .stroke(
                        color.opacity(0.72 + energy * 0.25),
                        style: StrokeStyle(
                            lineWidth: 2.0 - progress * 0.45,
                            lineCap: .round,
                            lineJoin: .round
                        )
                    )
                    .shadow(color: color.opacity(0.35 + energy * 0.35), radius: 3 + energy * 5)
                }

                SiriWaveShape(
                    amplitude: CGFloat(0.1 + energy * 0.48),
                    phase: -motion * 0.8,
                    frequency: 2.4,
                    harmonic: 3.7
                )
                .stroke(.white.opacity(0.35 + energy * 0.35), lineWidth: 0.9)
                .blendMode(.plusLighter)
            }
            .drawingGroup()
            .saturation(phase == .muted || phase == .ending ? 0.1 : 1.2)
            .animation(.smooth(duration: 0.16), value: energy)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Live voice waveform")
        .accessibilityValue(phase.rawValue)
    }
}

private struct SiriWaveShape: Shape {
    var amplitude: CGFloat
    var phase: CGFloat
    var frequency: CGFloat
    var harmonic: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(amplitude, phase) }
        set {
            amplitude = newValue.first
            phase = newValue.second
        }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard rect.width > 0, rect.height > 0 else { return path }

        let midY = rect.midY
        let maxAmplitude = rect.height * 0.46
        let step = max(1, rect.width / 220)

        for x in stride(from: CGFloat.zero, through: rect.width, by: step) {
            let progress = x / rect.width
            let envelope = pow(max(0, sin(.pi * progress)), 1.45)
            let carrier = sin(progress * 2 * .pi * frequency + phase)
            let detail = sin(progress * 2 * .pi * harmonic - phase * 0.72) * 0.28
            let shimmer = sin(progress * 2 * .pi * (harmonic + 1.3) + phase * 1.2) * 0.08
            let y = midY + (carrier + detail + shimmer) * maxAmplitude * amplitude * envelope
            let point = CGPoint(x: x, y: y)
            if x == 0 { path.move(to: point) }
            else { path.addLine(to: point) }
        }
        return path
    }
}
