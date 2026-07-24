import SwiftUI

struct LiveWidgetView: View {
    @Bindable var model: LiveViewModel

    private var isLive: Bool {
        model.connected || [.listening, .working, .speaking, .muted, .ending].contains(model.phase)
    }

    var body: some View {
        Group {
            if isLive {
                CompactLiveSurface(model: model)
            } else {
                PairingSurface(model: model)
            }
        }
        .animation(.snappy(duration: 0.32), value: isLive)
        .background {
            FocusedSpacebarShortcut(enabled: isLive && model.phase != .ending) {
                model.toggleMute()
            }
        }
    }
}
