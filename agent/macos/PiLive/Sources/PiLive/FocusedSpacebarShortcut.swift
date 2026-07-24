@preconcurrency import AppKit
import SwiftUI

/// Handles Space only while the Pi Live call window is key. A local monitor is
/// used instead of global event capture so typing in other apps is never affected.
struct FocusedSpacebarShortcut: NSViewRepresentable {
    let enabled: Bool
    let action: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(enabled: enabled, action: action)
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
        context.coordinator.action = action
        context.coordinator.window = nsView.window
    }

    static func dismantleNSView(_ nsView: WindowProbeView, coordinator: Coordinator) {
        coordinator.removeMonitor()
    }

    @MainActor
    final class Coordinator {
        weak var window: NSWindow?
        var enabled: Bool
        var action: () -> Void
        private var monitor: Any?

        init(enabled: Bool, action: @escaping () -> Void) {
            self.enabled = enabled
            self.action = action
        }

        func installMonitor() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self,
                      self.enabled,
                      !event.isARepeat,
                      event.keyCode == 49,
                      NSApp.isActive,
                      event.window === self.window,
                      self.window?.isKeyWindow == true,
                      !(self.window?.firstResponder is NSTextView)
                else { return event }
                let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                    .subtracting([.capsLock, .function, .numericPad])
                guard modifiers.isEmpty else { return event }
                self.action()
                return nil
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
