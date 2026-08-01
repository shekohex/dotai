import AVFoundation
import XCTest
@testable import PiLive

@MainActor
private final class TestPermissionService: LivePermissionServicing {
    var currentStatus: LivePermissionStatus
    var requestedStatus: LivePermissionStatus
    private(set) var requestCount = 0
    private(set) var openSettingsCount = 0

    init(
        status: LivePermissionStatus,
        requestedStatus: LivePermissionStatus? = nil
    ) {
        currentStatus = status
        self.requestedStatus = requestedStatus ?? status
    }

    func status() -> LivePermissionStatus { currentStatus }

    func requestPermission() async -> LivePermissionStatus {
        requestCount += 1
        currentStatus = requestedStatus
        return currentStatus
    }

    func openSystemSettings() {
        openSettingsCount += 1
    }
}

@MainActor
private final class TestScreenRecordingRequestHistory: ScreenRecordingPermissionRequestTracking {
    var hasRequestedScreenRecordingPermission: Bool

    init(hasRequested: Bool) {
        hasRequestedScreenRecordingPermission = hasRequested
    }

    func markScreenRecordingPermissionRequested() {
        hasRequestedScreenRecordingPermission = true
    }
}

@MainActor
private final class TestPermissionSettingsOpener: PermissionSystemSettingsOpening {
    private(set) var openedPermissions: [LivePermissionKind] = []

    func openSystemSettings(for permission: LivePermissionKind) {
        openedPermissions.append(permission)
    }
}

@MainActor
final class PermissionServicesTests: XCTestCase {
    func testMicrophoneAuthorizationStatusMapping() {
        XCTAssertEqual(MicrophonePermissionService.map(.authorized), .allowed)
        XCTAssertEqual(MicrophonePermissionService.map(.notDetermined), .notRequested)
        XCTAssertEqual(MicrophonePermissionService.map(.denied), .denied)
        XCTAssertEqual(MicrophonePermissionService.map(.restricted), .restricted)
    }

    func testScreenRecordingStatusDistinguishesUnrequestedAndDenied() {
        let settingsOpener = TestPermissionSettingsOpener()
        let unrequested = ScreenRecordingPermissionService(
            preflightAccess: { false },
            requestAccess: { false },
            requestHistory: TestScreenRecordingRequestHistory(hasRequested: false),
            settingsOpener: settingsOpener
        )
        let denied = ScreenRecordingPermissionService(
            preflightAccess: { false },
            requestAccess: { false },
            requestHistory: TestScreenRecordingRequestHistory(hasRequested: true),
            settingsOpener: settingsOpener
        )

        XCTAssertEqual(unrequested.status(), .notRequested)
        XCTAssertEqual(denied.status(), .denied)
    }

    func testPermissionRequestsRefreshStatusesAfterCompletion() async {
        let microphone = TestPermissionService(status: .notRequested, requestedStatus: .allowed)
        let screenRecording = TestPermissionService(status: .notRequested, requestedStatus: .denied)
        let model = PermissionsViewModel(
            microphonePermission: microphone,
            screenRecordingPermission: screenRecording
        )

        await model.requestMicrophonePermission()
        await model.requestScreenRecordingPermission()

        XCTAssertEqual(model.microphoneStatus, .allowed)
        XCTAssertEqual(model.screenRecordingStatus, .denied)
        XCTAssertEqual(microphone.requestCount, 1)
        XCTAssertEqual(screenRecording.requestCount, 1)
    }

    func testRefreshReadsBothServicesAndDeniedStateOpensSettings() {
        let microphone = TestPermissionService(status: .denied)
        let screenRecording = TestPermissionService(status: .allowed)
        let model = PermissionsViewModel(
            microphonePermission: microphone,
            screenRecordingPermission: screenRecording
        )

        model.refresh()
        model.openMicrophoneSystemSettings()

        XCTAssertEqual(model.microphoneStatus, .denied)
        XCTAssertEqual(model.screenRecordingStatus, .allowed)
        XCTAssertTrue(model.microphoneStatus.requiresSystemSettings)
        XCTAssertEqual(microphone.openSettingsCount, 1)
    }

    func testPermissionServicesOpenRelevantPrivacyPanes() {
        let settingsOpener = TestPermissionSettingsOpener()
        let microphone = MicrophonePermissionService(
            authorizationStatus: { .denied },
            requestAccess: { false },
            settingsOpener: settingsOpener
        )
        let screenRecording = ScreenRecordingPermissionService(
            preflightAccess: { false },
            requestAccess: { false },
            requestHistory: TestScreenRecordingRequestHistory(hasRequested: true),
            settingsOpener: settingsOpener
        )

        microphone.openSystemSettings()
        screenRecording.openSystemSettings()

        XCTAssertEqual(settingsOpener.openedPermissions, [.microphone, .screenRecording])
    }
}
