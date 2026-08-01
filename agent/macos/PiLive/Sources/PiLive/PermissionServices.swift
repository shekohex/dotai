import AppKit
import AVFoundation
import CoreGraphics
import Observation

enum LivePermissionKind: Equatable, Sendable {
    case microphone
    case screenRecording
}

enum LivePermissionStatus: Equatable, Sendable {
    case allowed
    case notRequested
    case denied
    case restricted
    case unknown

    var title: String {
        switch self {
        case .allowed: "Allowed"
        case .notRequested: "Not requested"
        case .denied: "Denied"
        case .restricted: "Restricted"
        case .unknown: "Unknown"
        }
    }

    var systemImage: String {
        switch self {
        case .allowed: "checkmark.circle.fill"
        case .notRequested: "questionmark.circle"
        case .denied, .restricted: "exclamationmark.triangle.fill"
        case .unknown: "questionmark.diamond"
        }
    }

    var requiresSystemSettings: Bool {
        switch self {
        case .denied, .restricted, .unknown: true
        case .allowed, .notRequested: false
        }
    }
}

@MainActor
protocol LivePermissionServicing {
    func status() -> LivePermissionStatus
    func requestPermission() async -> LivePermissionStatus
    func openSystemSettings()
}

@MainActor
protocol PermissionSystemSettingsOpening {
    func openSystemSettings(for permission: LivePermissionKind)
}

@MainActor
struct MacOSPermissionSystemSettingsOpener: PermissionSystemSettingsOpening {
    func openSystemSettings(for permission: LivePermissionKind) {
        let pane = switch permission {
        case .microphone: "Privacy_Microphone"
        case .screenRecording: "Privacy_ScreenCapture"
        }
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?\(pane)"
        ) else { return }
        NSWorkspace.shared.open(url)
    }
}

@MainActor
final class MicrophonePermissionService: LivePermissionServicing {
    private let authorizationStatus: () -> AVAuthorizationStatus
    private let requestAccess: () async -> Bool
    private let settingsOpener: any PermissionSystemSettingsOpening

    init(
        authorizationStatus: @escaping () -> AVAuthorizationStatus = {
            AVCaptureDevice.authorizationStatus(for: .audio)
        },
        requestAccess: @escaping () async -> Bool = {
            await AVCaptureDevice.requestAccess(for: .audio)
        },
        settingsOpener: any PermissionSystemSettingsOpening = MacOSPermissionSystemSettingsOpener()
    ) {
        self.authorizationStatus = authorizationStatus
        self.requestAccess = requestAccess
        self.settingsOpener = settingsOpener
    }

    func status() -> LivePermissionStatus {
        Self.map(authorizationStatus())
    }

    func requestPermission() async -> LivePermissionStatus {
        guard status() == .notRequested else { return status() }
        _ = await requestAccess()
        return status()
    }

    func openSystemSettings() {
        settingsOpener.openSystemSettings(for: .microphone)
    }

    static func map(_ status: AVAuthorizationStatus) -> LivePermissionStatus {
        switch status {
        case .authorized: .allowed
        case .notDetermined: .notRequested
        case .denied: .denied
        case .restricted: .restricted
        @unknown default: .unknown
        }
    }
}

@MainActor
protocol ScreenRecordingPermissionRequestTracking {
    var hasRequestedScreenRecordingPermission: Bool { get }
    func markScreenRecordingPermissionRequested()
}

@MainActor
final class UserDefaultsScreenRecordingPermissionRequestHistory:
    ScreenRecordingPermissionRequestTracking
{
    private let defaults: UserDefaults
    private let key = "screenRecordingPermissionRequested"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var hasRequestedScreenRecordingPermission: Bool {
        defaults.bool(forKey: key)
    }

    func markScreenRecordingPermissionRequested() {
        defaults.set(true, forKey: key)
    }
}

@MainActor
final class ScreenRecordingPermissionService: LivePermissionServicing {
    private let preflightAccess: () -> Bool
    private let requestAccess: () -> Bool
    private let requestHistory: any ScreenRecordingPermissionRequestTracking
    private let settingsOpener: any PermissionSystemSettingsOpening

    init(
        preflightAccess: @escaping () -> Bool = CGPreflightScreenCaptureAccess,
        requestAccess: @escaping () -> Bool = CGRequestScreenCaptureAccess,
        requestHistory: any ScreenRecordingPermissionRequestTracking =
            UserDefaultsScreenRecordingPermissionRequestHistory(),
        settingsOpener: any PermissionSystemSettingsOpening = MacOSPermissionSystemSettingsOpener()
    ) {
        self.preflightAccess = preflightAccess
        self.requestAccess = requestAccess
        self.requestHistory = requestHistory
        self.settingsOpener = settingsOpener
    }

    func status() -> LivePermissionStatus {
        if preflightAccess() {
            requestHistory.markScreenRecordingPermissionRequested()
            return .allowed
        }
        return requestHistory.hasRequestedScreenRecordingPermission ? .denied : .notRequested
    }

    func requestPermission() async -> LivePermissionStatus {
        guard status() == .notRequested else { return status() }
        requestHistory.markScreenRecordingPermissionRequested()
        _ = requestAccess()
        return status()
    }

    func openSystemSettings() {
        settingsOpener.openSystemSettings(for: .screenRecording)
    }
}

@MainActor
@Observable
final class PermissionsViewModel {
    private(set) var microphoneStatus: LivePermissionStatus = .unknown
    private(set) var screenRecordingStatus: LivePermissionStatus = .unknown
    private(set) var requestingMicrophone = false
    private(set) var requestingScreenRecording = false

    @ObservationIgnored private let microphonePermission: any LivePermissionServicing
    @ObservationIgnored private let screenRecordingPermission: any LivePermissionServicing

    init(
        microphonePermission: any LivePermissionServicing = MicrophonePermissionService(),
        screenRecordingPermission: any LivePermissionServicing =
            ScreenRecordingPermissionService()
    ) {
        self.microphonePermission = microphonePermission
        self.screenRecordingPermission = screenRecordingPermission
    }

    func refresh() {
        microphoneStatus = microphonePermission.status()
        screenRecordingStatus = screenRecordingPermission.status()
    }

    func requestMicrophonePermission() async {
        guard !requestingMicrophone else { return }
        requestingMicrophone = true
        microphoneStatus = await microphonePermission.requestPermission()
        requestingMicrophone = false
        refresh()
    }

    func requestScreenRecordingPermission() async {
        guard !requestingScreenRecording else { return }
        requestingScreenRecording = true
        screenRecordingStatus = await screenRecordingPermission.requestPermission()
        requestingScreenRecording = false
        refresh()
    }

    func openMicrophoneSystemSettings() {
        microphonePermission.openSystemSettings()
    }

    func openScreenRecordingSystemSettings() {
        screenRecordingPermission.openSystemSettings()
    }
}
