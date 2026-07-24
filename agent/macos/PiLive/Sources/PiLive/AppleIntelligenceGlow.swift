import SwiftUI

/// A macOS adaptation of Jacob Mobin's MIT-licensed pure-SwiftUI Apple
/// Intelligence glow. Pi Live keeps the layered angular-gradient border while
/// replacing random timers with the system animation timeline and live audio.
struct AppleIntelligenceGlow: View {
    let voice: LiveVoice
    let phase: LivePhase
    let muted: Bool
    let inputLevel: Double
    let outputLevel: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var energy: Double {
        let media = muted ? outputLevel : max(inputLevel, outputLevel)
        let compressed = 1 - exp(-max(0, media) * 11)
        let phaseFloor = switch phase {
        case .working: 0.22
        case .speaking: 0.18
        case .listening: 0.09
        case .muted: 0.07
        case .ending: 0.02
        default: 0.06
        }
        return min(1, max(phaseFloor, compressed))
    }

    var body: some View {
        TimelineView(.animation) { timeline in
            let time = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
            let pulse = reduceMotion ? 0 : sin(time * (1.7 + energy)) * 0.08
            let primaryAngle = Angle.degrees(time * (10 + energy * 8))
            let secondaryAngle = Angle.degrees(-time * (7 + energy * 5) + 80)
            let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled

            ZStack {
                if !lowPower {
                    glowStroke(angle: secondaryAngle, width: 8 + energy * 3)
                        .blur(radius: 7 + energy * 4)
                        .opacity(0.25 + energy * 0.34 + pulse)
                }

                glowStroke(angle: primaryAngle, width: 4.5 + energy * 1.8)
                    .blur(radius: lowPower ? 3 : 4.5)
                    .opacity(0.38 + energy * 0.4 + pulse)

                glowStroke(angle: primaryAngle, width: 1.15 + energy * 0.55)
                    .opacity(0.72 + energy * 0.22)
            }
            .blendMode(.plusLighter)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func glowStroke(angle: Angle, width: CGFloat) -> some View {
        Circle()
            .strokeBorder(
                AngularGradient(
                    colors: glowColors,
                    center: .center,
                    startAngle: angle,
                    endAngle: angle + .degrees(360)
                ),
                lineWidth: width
            )
    }

    private var glowColors: [Color] {
        [
            Color(red: 0.74, green: 0.51, blue: 0.95),
            voice.colors[0],
            Color(red: 0.96, green: 0.73, blue: 0.92),
            Color(red: 0.55, green: 0.62, blue: 1.0),
            voice.accent,
            Color(red: 1.0, green: 0.40, blue: 0.47),
            Color(red: 1.0, green: 0.73, blue: 0.44),
            voice.colors[2],
            Color(red: 0.74, green: 0.51, blue: 0.95),
        ]
    }
}
