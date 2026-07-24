@preconcurrency import AppKit
import SwiftUI

/// Resolves a single click only after the double-click recognizer fails, so a
/// double click never briefly toggles mute before ending the call.
struct OrbClickSurface: NSViewRepresentable {
    let onSingleClick: () -> Void
    let onDoubleClick: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSingleClick: onSingleClick, onDoubleClick: onDoubleClick)
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let singleClick = NSClickGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleSingleClick)
        )
        singleClick.numberOfClicksRequired = 1
        singleClick.delegate = context.coordinator
        let doubleClick = NSClickGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDoubleClick)
        )
        doubleClick.numberOfClicksRequired = 2
        view.addGestureRecognizer(singleClick)
        view.addGestureRecognizer(doubleClick)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.onSingleClick = onSingleClick
        context.coordinator.onDoubleClick = onDoubleClick
    }

    @MainActor
    final class Coordinator: NSObject, NSGestureRecognizerDelegate {
        var onSingleClick: () -> Void
        var onDoubleClick: () -> Void

        init(onSingleClick: @escaping () -> Void, onDoubleClick: @escaping () -> Void) {
            self.onSingleClick = onSingleClick
            self.onDoubleClick = onDoubleClick
        }

        @objc func handleSingleClick() {
            onSingleClick()
        }

        @objc func handleDoubleClick() {
            onDoubleClick()
        }

        func gestureRecognizer(
            _ gestureRecognizer: NSGestureRecognizer,
            shouldRequireFailureOf otherGestureRecognizer: NSGestureRecognizer
        ) -> Bool {
            guard let click = gestureRecognizer as? NSClickGestureRecognizer,
                  let otherClick = otherGestureRecognizer as? NSClickGestureRecognizer
            else { return false }
            return click.numberOfClicksRequired == 1 && otherClick.numberOfClicksRequired == 2
        }
    }
}
