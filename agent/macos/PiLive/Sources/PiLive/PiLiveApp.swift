import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            NSApp.windows.forEach { window in
                window.level = .floating
                window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
                window.isMovableByWindowBackground = true
                window.titleVisibility = .hidden
                window.titlebarAppearsTransparent = true
                window.isOpaque = false
                window.backgroundColor = .clear
                window.hasShadow = true
                window.makeKeyAndOrderFront(nil)
            }
            self.positionMainWindowAboveDock()
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func showMainWindow() {
        guard let window = mainWindow else { return }
        positionMainWindowAboveDock()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private var mainWindow: NSWindow? {
        NSApp.windows.first(where: { $0.title == "Pi Live" }) ?? NSApp.windows.first
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
