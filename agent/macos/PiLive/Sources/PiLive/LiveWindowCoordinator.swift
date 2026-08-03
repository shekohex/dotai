import AppKit
import SwiftUI

struct LiveDisplayGeometry: Equatable {
    let id: UInt32
    let frame: CGRect
    let visibleFrame: CGRect
}

@MainActor
enum LiveWindowPresentation {
    // Resizable windows can become key without requiring a title bar.
    static let styleMask: NSWindow.StyleMask = [.resizable]

    static func apply(to window: NSWindow) {
        if window.styleMask != styleMask {
            window.styleMask = styleMask
        }
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
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
    }
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
    let desktopPetMotion = DesktopPetMotionController()

    private weak var window: NSWindow?
    private var currentDisplay: LiveDisplayGeometry?
    private var pointerMonitor: Timer?
    private var motionTimer: Timer?
    private var lastMotionTick: TimeInterval?
    private var interactionMonitor: Any?
    private var screenParametersObserver: NSObjectProtocol?
    private var activeSpaceObserver: NSObjectProtocol?

    func attach(_ window: NSWindow) {
        guard self.window !== window else {
            maintainWindowPresentation(window)
            return
        }
        self.window = window
        desktopPetMotion.reset()
        maintainWindowPresentation(window)
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
        desktopPetMotion.reset()
        maintainWindowPresentation(window)
        moveToPointerDisplayIfNeeded(window)
        if let display = currentDisplay ?? window.screen.map(displayGeometry) {
            currentDisplay = display
            desktopPetMotion.rebase(
                windowFrame: window.frame,
                visibleFrame: display.visibleFrame,
                now: ProcessInfo.processInfo.systemUptime
            )
        }
        window.orderFrontRegardless()
    }

    func hide() {
        desktopPetMotion.reset(direction: desktopPetMotion.direction)
        window?.orderOut(nil)
    }

    func repositionAboveDock() {
        guard let window else { return }
        guard let display = currentDisplay ?? pointerDisplay() else { return }
        currentDisplay = display
        positionAboveDock(window, on: display)
    }

    private func maintainWindowPresentation(_ window: NSWindow) {
        LiveWindowPresentation.apply(to: window)
    }

    private func positionAboveDock(_ window: NSWindow, on display: LiveDisplayGeometry) {
        window.setFrameOrigin(LiveWindowPlacement.originAboveDock(
            windowSize: window.frame.size,
            visibleFrame: display.visibleFrame
        ))
        desktopPetMotion.rebase(
            windowFrame: window.frame,
            visibleFrame: display.visibleFrame,
            now: ProcessInfo.processInfo.systemUptime
        )
    }

    private func startDisplayMonitoring() {
        guard pointerMonitor == nil else { return }
        pointerMonitor = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) {
            [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let window = self.window, window.isVisible else { return }
                self.maintainWindowPresentation(window)
                self.moveToPointerDisplayIfNeeded(window)
            }
        }
        scheduleMotionTick(after: 0.05)
        interactionMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp, .rightMouseDown, .rightMouseUp]
        ) { [weak self] event in
            MainActor.assumeIsolated {
                self?.handleInteractionEvent(event)
            }
            return event
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
        activeSpaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleActiveSpaceChanged()
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
        rebaseMotion(window: window, display: target)
    }

    private func advanceDesktopPetMotion() {
        guard let window, window.isVisible else {
            lastMotionTick = nil
            return
        }
        let display = currentDisplay ?? window.screen.map(displayGeometry)
        guard let display else { return }
        currentDisplay = display
        let now = ProcessInfo.processInfo.systemUptime
        let elapsed = lastMotionTick.map { min(0.1, max(0, now - $0)) } ?? 0
        lastMotionTick = now
        guard let origin = desktopPetMotion.step(
            windowFrame: window.frame,
            visibleFrame: display.visibleFrame,
            elapsed: elapsed,
            now: now
        ), origin != window.frame.origin
        else { return }
        window.setFrameOrigin(origin)
    }

    private func scheduleMotionTick(after interval: TimeInterval) {
        motionTimer?.invalidate()
        motionTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) {
            [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.advanceDesktopPetMotion()
                self.scheduleMotionTick(after: self.desktopPetMotion.recommendedTickInterval(
                    now: ProcessInfo.processInfo.systemUptime
                ))
            }
        }
    }

    private func handleInteractionEvent(_ event: NSEvent) {
        guard event.window === window else { return }
        switch event.type {
        case .leftMouseDown, .leftMouseDragged, .rightMouseDown:
            desktopPetMotion.beginUserInteraction()
        case .leftMouseUp, .rightMouseUp:
            if let screen = window?.screen { currentDisplay = displayGeometry(screen) }
            if let window, let display = currentDisplay {
                desktopPetMotion.endUserInteraction(
                    windowFrame: window.frame,
                    visibleFrame: display.visibleFrame,
                    now: ProcessInfo.processInfo.systemUptime
                )
            }
            lastMotionTick = nil
        default:
            break
        }
    }

    private func handleScreenParametersChanged() {
        guard let window else { return }
        maintainWindowPresentation(window)
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
        rebaseMotion(window: window, display: target)
    }

    private func handleActiveSpaceChanged() {
        guard let window else { return }
        maintainWindowPresentation(window)
        moveToPointerDisplayIfNeeded(window)
        guard let display = currentDisplay ?? window.screen.map(displayGeometry) else { return }
        currentDisplay = display
        rebaseMotion(window: window, display: display)
    }

    private func rebaseMotion(window: NSWindow, display: LiveDisplayGeometry) {
        desktopPetMotion.rebase(
            windowFrame: window.frame,
            visibleFrame: display.visibleFrame,
            now: ProcessInfo.processInfo.systemUptime
        )
        lastMotionTick = nil
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
