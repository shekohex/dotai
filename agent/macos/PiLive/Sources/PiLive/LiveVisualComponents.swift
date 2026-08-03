import SwiftUI

struct LiveBackdrop: View {
    let accent: Color

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor).opacity(0.82)
            RadialGradient(
                colors: [accent.opacity(0.08), .clear],
                center: .topLeading,
                startRadius: 20,
                endRadius: 390
            )
            RadialGradient(
                colors: [accent.opacity(0.06), .clear],
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
