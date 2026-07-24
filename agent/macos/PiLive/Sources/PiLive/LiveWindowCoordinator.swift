import AppKit
import SwiftUI

@MainActor
final class LiveWindowCoordinator {
    private weak var window: NSWindow?

    func attach(_ window: NSWindow) {
        guard self.window !== window else { return }
        self.window = window
        configure(window)
        positionAboveDock(window)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func show() {
        guard let window else { return }
        configure(window)
        positionAboveDock(window)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func hide() {
        window?.orderOut(nil)
    }

    func repositionAboveDock() {
        guard let window else { return }
        positionAboveDock(window)
    }

    private func configure(_ window: NSWindow) {
        // A truly borderless NSWindow does not become key by default, so it
        // never receives Space/Escape. Keep an invisible full-size title bar
        // to preserve key-window behavior while rendering no window chrome.
        window.styleMask = [.titled, .fullSizeContentView]
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isMovable = true
        window.isMovableByWindowBackground = true
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.isOpaque = false
        window.backgroundColor = .clear
        // AppKit otherwise shadows the rectangular transparent window rather
        // than the rounded Liquid Glass surface.
        window.hasShadow = false
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
    }

    private func positionAboveDock(_ window: NSWindow) {
        guard let screen = window.screen ?? NSScreen.main ?? NSScreen.screens.first else { return }
        let visibleFrame = screen.visibleFrame
        window.setFrameOrigin(NSPoint(
            x: visibleFrame.midX - window.frame.width / 2,
            y: visibleFrame.minY + 18
        ))
    }
}

struct LiveWindowAccessor: NSViewRepresentable {
    let onResolve: (NSWindow) -> Void

    func makeNSView(context: Context) -> WindowProbeView {
        let view = WindowProbeView()
        view.onWindowChange = { window in
            guard let window else { return }
            onResolve(window)
        }
        return view
    }

    func updateNSView(_ nsView: WindowProbeView, context: Context) {
        if let window = nsView.window { onResolve(window) }
    }
}
