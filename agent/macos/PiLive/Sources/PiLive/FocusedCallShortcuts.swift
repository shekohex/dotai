@preconcurrency import AppKit
import SwiftUI

/// Handles call-scoped keyboard controls only while the Pi Live window is key.
/// Other applications and text editors never see intercepted Space/Escape keys.
struct FocusedCallShortcuts: NSViewRepresentable {
    let enabled: Bool
    let onSpace: () -> Void
    let onEscape: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(enabled: enabled, onSpace: onSpace, onEscape: onEscape)
    }

    func makeNSView(context: Context) -> WindowProbeView {
        let view = WindowProbeView()
        view.onWindowChange = { [weak coordinator = context.coordinator] window in
            coordinator?.window = window
        }
        context.coordinator.installMonitor()
        return view
    }

    func updateNSView(_ nsView: WindowProbeView, context: Context) {
        context.coordinator.enabled = enabled
        context.coordinator.onSpace = onSpace
        context.coordinator.onEscape = onEscape
        context.coordinator.window = nsView.window
    }

    static func dismantleNSView(_ nsView: WindowProbeView, coordinator: Coordinator) {
        coordinator.removeMonitor()
    }

    @MainActor
    final class Coordinator {
        weak var window: NSWindow?
        var enabled: Bool
        var onSpace: () -> Void
        var onEscape: () -> Void
        private var monitor: Any?

        init(enabled: Bool, onSpace: @escaping () -> Void, onEscape: @escaping () -> Void) {
            self.enabled = enabled
            self.onSpace = onSpace
            self.onEscape = onEscape
        }

        func installMonitor() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self,
                      self.enabled,
                      !event.isARepeat,
                      NSApp.isActive,
                      event.window === self.window,
                      self.window?.isKeyWindow == true,
                      !(self.window?.firstResponder is NSTextView)
                else { return event }
                let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                    .subtracting([.capsLock, .function, .numericPad])
                guard modifiers.isEmpty else { return event }
                switch event.keyCode {
                case 49:
                    self.onSpace()
                    return nil
                case 53:
                    self.onEscape()
                    return nil
                default:
                    return event
                }
            }
        }

        func removeMonitor() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }
}

final class WindowProbeView: NSView {
    var onWindowChange: ((NSWindow?) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        onWindowChange?(window)
    }
}
