import SwiftUI

/// A Siri-inspired voice sphere: a dark luminous upper field with layered,
/// continuously moving speech ribbons in the lower half.
struct VoiceOrb: View {
    let voice: LiveVoice
    let phase: LivePhase
    let muted: Bool
    let inputLevel: Double
    let outputLevel: Double
    let speechActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var displayedEnergy = 0.07

    private var targetEnergy: Double {
        if phase == .ending { return 0.01 }
        if phase == .working && !muted { return 0.14 }
        let media = muted ? outputLevel : (phase == .speaking ? outputLevel : max(inputLevel, outputLevel))
        let compressed = 1 - exp(-max(0, media) * 12)
        return min(0.95, max(0.06, compressed + (!muted && speechActive ? 0.035 : 0)))
    }

    var body: some View {
        TimelineView(.animation) { timeline in
            let time = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
            orb(at: time)
        }
        .onChange(of: targetEnergy, initial: true) { oldValue, newValue in
            withAnimation(.smooth(duration: newValue > oldValue ? 0.14 : 0.38)) {
                displayedEnergy = newValue
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Pi Live voice activity")
        .accessibilityValue(accessibilityValue)
    }

    @ViewBuilder
    private func orb(at time: TimeInterval) -> some View {
        let breath = reduceMotion ? 0 : sin(time * 1.8) * (0.008 + displayedEnergy * 0.011)
        let speechPulse = reduceMotion
            ? 0
            : sin(time * (3.0 + displayedEnergy * 2.4)) * displayedEnergy * 0.025
        let motion = reduceMotion ? 0 : time * (0.72 + displayedEnergy * 0.5)
        let waveGain = 1 + displayedEnergy * 0.7
        let saturation = phase == .ending ? 0.12 : (muted && outputLevel < 0.012 ? 0.72 : 1.08)
        let localSpeaking = !muted && (speechActive || inputLevel >= 0.012)
        let remoteSpeaking = outputLevel >= 0.012
        let active = localSpeaking || remoteSpeaking
        let wobble = reduceMotion || !active
            ? 0
            : sin(time * (7.5 + displayedEnergy * 3.5)) * (0.012 + displayedEnergy * 0.035)
        let tilt = reduceMotion || !active
            ? 0
            : sin(time * 5.2 + 0.8) * (0.35 + displayedEnergy * 1.1)
        let activityColor: Color = localSpeaking ? .green : voice.accent

        ZStack {
            Circle()
                .stroke(activityColor.opacity(0.13 + displayedEnergy * 0.28), lineWidth: localSpeaking ? 1.2 : 0.8)
                .scaleEffect(1.11 + displayedEnergy * 0.06 + breath + speechPulse)
            Circle()
                .stroke(Color.cyan.opacity(0.07 + displayedEnergy * 0.16), lineWidth: 0.7)
                .scaleEffect(1.2 + displayedEnergy * 0.08 - breath * 0.6)

            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(red: 0.045, green: 0.015, blue: 0.20),
                                Color(red: 0.035, green: 0.12, blue: 0.27),
                                Color(red: 0.04, green: 0.32, blue: 0.46),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )

                Circle()
                    .fill(
                        RadialGradient(
                            colors: [Color.cyan.opacity(0.36 + displayedEnergy * 0.18), .clear],
                            center: UnitPoint(x: 0.63, y: 0.58),
                            startRadius: 1,
                            endRadius: 55
                        )
                    )

                OrbWaveShape(
                    baseline: 0.56,
                    amplitude: (0.055 + displayedEnergy * 0.035) * waveGain,
                    frequency: 0.92,
                    phase: motion + 1.8,
                    detail: 0.018
                )
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.96, green: 0.12, blue: 0.72),
                            voice.colors[1].opacity(0.92),
                            Color.cyan.opacity(0.8),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .blur(radius: 1.8)

                OrbWaveShape(
                    baseline: 0.61,
                    amplitude: (0.075 + displayedEnergy * 0.045) * waveGain,
                    frequency: 1.03,
                    phase: -motion * 0.82 + 0.4,
                    detail: 0.025
                )
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.18, green: 0.68, blue: 0.98).opacity(0.82),
                            Color(red: 0.12, green: 0.91, blue: 0.88),
                            Color(red: 0.27, green: 0.75, blue: 0.97),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .opacity(0.88)

                OrbWaveShape(
                    baseline: 0.69,
                    amplitude: (0.09 + displayedEnergy * 0.05) * waveGain,
                    frequency: 1.08,
                    phase: motion * 0.66 + 2.7,
                    detail: 0.03
                )
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.10, green: 0.86, blue: 0.83),
                            Color(red: 0.48, green: 0.93, blue: 0.96),
                            Color(red: 0.18, green: 0.68, blue: 0.96),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .opacity(0.88)

                OrbWaveShape(
                    baseline: 0.76,
                    amplitude: (0.10 + displayedEnergy * 0.055) * waveGain,
                    frequency: 1.0,
                    phase: -motion * 0.9 + 4.2,
                    detail: 0.022
                )
                .fill(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.94),
                            Color(red: 0.72, green: 0.96, blue: 0.98).opacity(0.94),
                            Color(red: 0.34, green: 0.77, blue: 0.98).opacity(0.9),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .opacity(0.9)

                OrbWaveShape(
                    baseline: 0.89,
                    amplitude: (0.07 + displayedEnergy * 0.04) * waveGain,
                    frequency: 0.88,
                    phase: motion * 0.74 + 0.9,
                    detail: 0.02
                )
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.05, green: 0.67, blue: 0.81),
                            Color(red: 0.04, green: 0.43, blue: 0.82),
                            Color(red: 0.08, green: 0.24, blue: 0.62),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
            }
            .clipShape(Circle())
            .overlay(Circle().stroke(.white.opacity(0.2), lineWidth: 0.65))
            .shadow(
                color: voice.accent.opacity(0.24 + displayedEnergy * 0.34),
                radius: 12 + displayedEnergy * 15
            )
            .scaleEffect(1 + displayedEnergy * 0.055 + breath + speechPulse * 0.75)
            .saturation(saturation)
        }
        .scaleEffect(x: 1 + wobble, y: 1 - wobble * 0.72)
        .rotationEffect(.degrees(tilt))
    }

    private var accessibilityValue: String {
        if muted && outputLevel >= 0.012 { return "Pi is speaking; microphone muted" }
        return muted ? "Microphone muted" : phase.rawValue
    }
}

private struct OrbWaveShape: Shape {
    let baseline: Double
    let amplitude: Double
    let frequency: Double
    let phase: Double
    let detail: Double

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard rect.width > 0, rect.height > 0 else { return path }

        path.move(to: CGPoint(x: 0, y: rect.height))
        path.addLine(to: point(at: 0, in: rect))
        let step = max(1, rect.width / 100)
        for x in stride(from: step, through: rect.width, by: step) {
            path.addLine(to: point(at: x, in: rect))
        }
        path.addLine(to: CGPoint(x: rect.width, y: rect.height))
        path.closeSubpath()
        return path
    }

    private func point(at x: CGFloat, in rect: CGRect) -> CGPoint {
        let progress = Double(x / rect.width)
        let primary = sin(progress * 2 * .pi * frequency + phase) * amplitude
        let secondary = sin(progress * 4 * .pi * (frequency * 0.72) - phase * 0.6) * detail
        return CGPoint(x: x, y: rect.height * CGFloat(baseline + primary + secondary))
    }
}
