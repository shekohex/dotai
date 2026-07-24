import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private weak var mainWindowReference: NSWindow?
    private var observers: [NSObjectProtocol] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        observers.append(
            NotificationCenter.default.addObserver(
                forName: .piLiveShowRequested,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.showMainWindow() }
            }
        )
        observers.append(
            NotificationCenter.default.addObserver(
                forName: .piLiveSessionEnded,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.hideMainWindow() }
            }
        )
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            guard let window = self.mainWindow else { return }
            self.configureMainWindow(window)
            window.makeKeyAndOrderFront(nil)
            self.positionMainWindowAboveDock()
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
    }

    func showMainWindow() {
        guard let window = mainWindow else { return }
        configureMainWindow(window)
        positionMainWindowAboveDock()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func hideMainWindow() {
        mainWindow?.orderOut(nil)
    }

    private var mainWindow: NSWindow? {
        mainWindowReference ?? NSApp.windows.first(where: { $0.title == "Pi Live" })
    }

    private func configureMainWindow(_ window: NSWindow) {
        mainWindowReference = window
        window.styleMask = [.borderless]
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isMovable = true
        window.isMovableByWindowBackground = true
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isOpaque = false
        window.backgroundColor = .clear
        // AppKit shadows the rectangular transparent NSWindow rather than the rounded
        // Liquid Glass surface, which produces a dark box around the compact strip.
        window.hasShadow = false
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
    }

    private func positionMainWindowAboveDock() {
        guard let window = mainWindow,
              let screen = window.screen ?? NSScreen.main ?? NSScreen.screens.first
        else { return }
        let visibleFrame = screen.visibleFrame
        let origin = NSPoint(
            x: visibleFrame.midX - window.frame.width / 2,
            y: visibleFrame.minY + 18
        )
        window.setFrameOrigin(origin)
    }
}

@main
struct PiLiveApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = LiveViewModel()

    var body: some Scene {
        WindowGroup("Pi Live") {
            LiveWidgetView(model: model)
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
        .defaultSize(width: 460, height: 500)

        Settings {
            LiveSettingsView(model: model)
        }

        MenuBarExtra("Pi Live", systemImage: "waveform.circle.fill") {
            Button("Show Pi Live") {
                appDelegate.showMainWindow()
            }
            SettingsLink {
                Text("Settings…")
            }
            Divider()
            Button("Quit") {
                Task {
                    await model.prepareForTermination()
                    NSApp.terminate(nil)
                }
            }
        }
    }
}
