import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}

@main
struct PiLiveApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model: LiveViewModel
    private let windowCoordinator: LiveWindowCoordinator

    init() {
        let model = LiveViewModel()
        let windowCoordinator = LiveWindowCoordinator()
        _model = State(initialValue: model)
        self.windowCoordinator = windowCoordinator
        model.showWindow = { [weak windowCoordinator] in windowCoordinator?.show() }
        model.hideWindow = { [weak windowCoordinator] in windowCoordinator?.hide() }
        model.contentSizeDidChange = { [weak windowCoordinator] in
            windowCoordinator?.repositionAboveDock()
        }
    }

    var body: some Scene {
        Window("Pi Live", id: "main") {
            LiveWidgetView(model: model)
                .background {
                    LiveWindowAccessor { window in
                        windowCoordinator.attach(window)
                    }
                }
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
        .defaultSize(width: 460, height: 500)

        Settings {
            LiveSettingsView(model: model)
        }

        MenuBarExtra("Pi Live", systemImage: "waveform.circle.fill") {
            PiLiveMenu(model: model)
        }
    }
}

private struct PiLiveMenu: View {
    @Bindable var model: LiveViewModel
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Button("Show Pi Live") {
            model.activateFromGlobalShortcut()
        }
        Button("Settings…") {
            showSettings()
        }
        .keyboardShortcut(",", modifiers: .command)
        Divider()
        Button("Quit") {
            Task {
                await model.prepareForTermination()
                NSApp.terminate(nil)
            }
        }
    }

    private func showSettings() {
        // Menu-bar apps use the accessory activation policy. Explicitly activate
        // before opening Settings so SwiftUI can create or raise its window.
        NSApp.activate(ignoringOtherApps: true)
        openSettings()
        Task { @MainActor in
            await Task.yield()
            NSApp.activate(ignoringOtherApps: true)
        }
    }
}
