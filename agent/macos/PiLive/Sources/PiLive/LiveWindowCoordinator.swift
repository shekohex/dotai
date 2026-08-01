import AppKit
import SwiftUI

struct LiveDisplayGeometry: Equatable {
    let id: UInt32
    let frame: CGRect
    let visibleFrame: CGRect
}

enum LiveWindowPlacement {
    static func display(
        containing pointer: CGPoint,
        in displays: [LiveDisplayGeometry]
    ) -> LiveDisplayGeometry? {
        displays.first(where: { $0.frame.contains(pointer) })
    }

    static func shouldMove(fromDisplayID: UInt32?, toDisplayID: UInt32) -> Bool {
        fromDisplayID != toDisplayID
    }

    static func originAboveDock(windowSize: CGSize, visibleFrame: CGRect) -> CGPoint {
        CGPoint(
            x: visibleFrame.midX - windowSize.width / 2,
            y: visibleFrame.minY + 18
        )
    }

    static func repositionedOrigin(
        windowFrame: CGRect,
        from sourceVisibleFrame: CGRect,
        to destinationVisibleFrame: CGRect
    ) -> CGPoint {
        let sourceWidth = max(1, sourceVisibleFrame.width - windowFrame.width)
        let sourceHeight = max(1, sourceVisibleFrame.height - windowFrame.height)
        let relativeX = min(
            1,
            max(0, (windowFrame.minX - sourceVisibleFrame.minX) / sourceWidth)
        )
        let relativeY = min(
            1,
            max(0, (windowFrame.minY - sourceVisibleFrame.minY) / sourceHeight)
        )
        let destinationWidth = max(0, destinationVisibleFrame.width - windowFrame.width)
        let destinationHeight = max(0, destinationVisibleFrame.height - windowFrame.height)
        return CGPoint(
            x: destinationVisibleFrame.minX + relativeX * destinationWidth,
            y: destinationVisibleFrame.minY + relativeY * destinationHeight
        )
    }
}

@MainActor
final class LiveWindowCoordinator {
    private weak var window: NSWindow?
    private var currentDisplay: LiveDisplayGeometry?
    private var pointerMonitor: Timer?
    private var screenParametersObserver: NSObjectProtocol?

    func attach(_ window: NSWindow) {
        guard self.window !== window else { return }
        self.window = window
        configure(window)
        let display = pointerDisplay() ?? window.screen.map(displayGeometry)
        if let display {
            currentDisplay = display
            positionAboveDock(window, on: display)
        }
        startDisplayMonitoring()
        window.orderFrontRegardless()
    }

    func show() {
        guard let window else { return }
        configure(window)
        moveToPointerDisplayIfNeeded(window)
        window.orderFrontRegardless()
    }

    func hide() {
        window?.orderOut(nil)
    }

    func repositionAboveDock() {
        guard let window else { return }
        guard let display = currentDisplay ?? pointerDisplay() else { return }
        currentDisplay = display
        positionAboveDock(window, on: display)
    }

    private func configure(_ window: NSWindow) {
        // A truly borderless NSWindow does not become key by default, so it
        // never receives Space/Escape. Keep an invisible full-size title bar
        // to preserve key-window behavior while rendering no window chrome.
        window.styleMask = [.titled, .fullSizeContentView]
        window.level = .floating
        window.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .stationary,
            .ignoresCycle,
        ]
        window.hidesOnDeactivate = false
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

    private func positionAboveDock(_ window: NSWindow, on display: LiveDisplayGeometry) {
        window.setFrameOrigin(LiveWindowPlacement.originAboveDock(
            windowSize: window.frame.size,
            visibleFrame: display.visibleFrame
        ))
    }

    private func startDisplayMonitoring() {
        guard pointerMonitor == nil else { return }
        pointerMonitor = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) {
            [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let window = self.window, window.isVisible else { return }
                self.moveToPointerDisplayIfNeeded(window)
            }
        }
        screenParametersObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleScreenParametersChanged()
            }
        }
    }

    private func moveToPointerDisplayIfNeeded(_ window: NSWindow) {
        guard let target = pointerDisplay(),
              LiveWindowPlacement.shouldMove(
                  fromDisplayID: currentDisplay?.id,
                  toDisplayID: target.id
              )
        else { return }
        let sourceFrame = currentDisplay?.visibleFrame
            ?? window.screen?.visibleFrame
            ?? target.visibleFrame
        window.setFrameOrigin(LiveWindowPlacement.repositionedOrigin(
            windowFrame: window.frame,
            from: sourceFrame,
            to: target.visibleFrame
        ))
        currentDisplay = target
    }

    private func handleScreenParametersChanged() {
        guard let window else { return }
        let displays = displayGeometries()
        let current = currentDisplay.flatMap { current in
            displays.first(where: { $0.id == current.id })
        }
        let target = current
            ?? LiveWindowPlacement.display(containing: NSEvent.mouseLocation, in: displays)
            ?? displays.first
        guard let target else { return }
        let sourceFrame = currentDisplay?.visibleFrame ?? target.visibleFrame
        if currentDisplay != target {
            window.setFrameOrigin(LiveWindowPlacement.repositionedOrigin(
                windowFrame: window.frame,
                from: sourceFrame,
                to: target.visibleFrame
            ))
        }
        currentDisplay = target
    }

    private func pointerDisplay() -> LiveDisplayGeometry? {
        LiveWindowPlacement.display(
            containing: NSEvent.mouseLocation,
            in: displayGeometries()
        )
    }

    private func displayGeometries() -> [LiveDisplayGeometry] {
        NSScreen.screens.map(displayGeometry)
    }

    private func displayGeometry(_ screen: NSScreen) -> LiveDisplayGeometry {
        let number = screen.deviceDescription[
            NSDeviceDescriptionKey("NSScreenNumber")
        ] as? NSNumber
        return LiveDisplayGeometry(
            id: number?.uint32Value ?? 0,
            frame: screen.frame,
            visibleFrame: screen.visibleFrame
        )
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
