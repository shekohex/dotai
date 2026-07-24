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
    @State private var displayedEnergy = 0.08

    private var targetEnergy: Double {
        if phase == .muted || phase == .ending { return 0.015 }
        if phase == .working { return 0.14 }
        let media = phase == .speaking ? outputLevel : max(inputLevel, outputLevel)
        let compressed = 1 - exp(-max(0, media) * 13)
        return min(0.92, max(0.065, compressed + (speechActive ? 0.035 : 0)))
    }

    var body: some View {
        TimelineView(.animation) { timeline in
            let time = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
            let motion = CGFloat(time * 2.05)

            ZStack {
                Capsule()
                    .fill(.primary.opacity(0.08))
                    .frame(height: 1)

                ForEach(Array(colors.enumerated()), id: \.offset) { index, color in
                    let progress = CGFloat(index) / CGFloat(max(1, colors.count - 1))
                    let amplitude = CGFloat(0.08 + displayedEnergy * (0.72 - Double(progress) * 0.1))
                    let offset = CGFloat(index) * 1.45

                    SiriWaveShape(
                        amplitude: amplitude,
                        phase: motion * (1 + progress * 0.06) + offset,
                        frequency: 1.4 + progress * 0.34,
                        harmonic: 2.55 + progress * 0.28
                    )
                    .stroke(
                        color.opacity(0.68 + displayedEnergy * 0.28),
                        style: StrokeStyle(
                            lineWidth: 1.85 - progress * 0.35,
                            lineCap: .round,
                            lineJoin: .round
                        )
                    )
                    .shadow(
                        color: color.opacity(0.28 + displayedEnergy * 0.32),
                        radius: 2.5 + displayedEnergy * 3.5
                    )
                }

                SiriWaveShape(
                    amplitude: CGFloat(0.055 + displayedEnergy * 0.38),
                    phase: -motion * 0.72,
                    frequency: 1.85,
                    harmonic: 3.1
                )
                .stroke(.white.opacity(0.25 + displayedEnergy * 0.32), lineWidth: 0.8)
                .blendMode(.plusLighter)
            }
            .saturation(phase == .muted || phase == .ending ? 0.1 : 1.2)
        }
        .onChange(of: targetEnergy, initial: true) { oldValue, newValue in
            let duration = newValue > oldValue ? 0.16 : 0.42
            withAnimation(.smooth(duration: duration)) {
                displayedEnergy = newValue
            }
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
            let envelope = pow(max(0, sin(.pi * progress)), 1.8)
            let carrier = sin(progress * 2 * .pi * frequency + phase)
            let detail = sin(progress * 2 * .pi * harmonic - phase * 0.58) * 0.16
            let y = midY + (carrier + detail) * maxAmplitude * amplitude * envelope
            let point = CGPoint(x: x, y: y)
            if x == 0 { path.move(to: point) }
            else { path.addLine(to: point) }
        }
        return path
    }
}
