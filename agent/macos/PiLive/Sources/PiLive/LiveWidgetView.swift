import SwiftUI

struct LiveWidgetView: View {
    @Bindable var model: LiveViewModel
    let desktopPetMotion: DesktopPetMotionController
    @Namespace private var orbNamespace
    @State private var escapeArmed = false
    @State private var escapeResetTask: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isLive: Bool {
        model.connected || [.listening, .working, .speaking, .muted, .ending].contains(model.phase)
    }

    var body: some View {
        Group {
            if isLive {
                CompactLiveSurface(
                    model: model,
                    desktopPetMotion: desktopPetMotion,
                    orbNamespace: orbNamespace,
                    escapeArmed: escapeArmed
                )
                .transition(.scale(scale: 0.72).combined(with: .opacity))
            } else {
                PairingSurface(model: model, orbNamespace: orbNamespace)
                    .transition(.opacity)
            }
        }
        .animation(.spring(response: 0.52, dampingFraction: 0.84), value: isLive)
        .background {
            FocusedCallShortcuts(
                enabled: isLive && model.phase != .ending,
                onSpace: model.toggleMute,
                onEscape: handleEscape
            )
        }
        .onGeometryChange(for: CGSize.self) { proxy in
            proxy.size
        } action: { _, _ in
            model.contentSizeDidChange()
        }
        .onChange(of: model.phase) { _, phase in
            if phase == .ending || phase == .idle { disarmEscape() }
            updateDesktopPetMotion()
        }
        .onAppear { updateDesktopPetMotion() }
        .onChange(of: model.orbState) { _, _ in updateDesktopPetMotion() }
        .onChange(of: isLive) { _, _ in updateDesktopPetMotion() }
        .onChange(of: reduceMotion) { _, _ in updateDesktopPetMotion() }
        .onDisappear {
            escapeResetTask?.cancel()
            desktopPetMotion.update(context: DesktopPetMotionContext(
                semanticState: model.orbState,
                livePhase: model.phase,
                isCompactSurface: false,
                reduceMotion: reduceMotion
            ))
        }
    }

    private func handleEscape() {
        if escapeArmed {
            disarmEscape()
            model.disconnect()
            return
        }
        withAnimation(.snappy(duration: 0.22)) {
            escapeArmed = true
        }
        escapeResetTask?.cancel()
        escapeResetTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            withAnimation(.smooth(duration: 0.2)) {
                escapeArmed = false
            }
        }
    }

    private func disarmEscape() {
        escapeResetTask?.cancel()
        escapeResetTask = nil
        withAnimation(.smooth(duration: 0.18)) {
            escapeArmed = false
        }
    }

    private func updateDesktopPetMotion() {
        desktopPetMotion.update(context: DesktopPetMotionContext(
            semanticState: model.orbState,
            livePhase: model.phase,
            isCompactSurface: isLive,
            reduceMotion: reduceMotion
        ))
    }
}
