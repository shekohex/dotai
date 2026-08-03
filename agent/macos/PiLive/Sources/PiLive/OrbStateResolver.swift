import Foundation

enum RemoteActivityState: String, Codable, Sendable {
    case thinking
    case working
    case checkingSubagents
    case waiting
    case success
    case failure
}

struct ActivitySnapshotParams: Codable, Sendable, Equatable {
    let revision: Int
    let state: RemoteActivityState
    let updatedAt: Double
}

struct OrbStateInputs: Equatable, Sendable {
    var phase: LivePhase
    var muted: Bool
    var outputActive: Bool
    var speechActive: Bool
    var mediaSessionActive: Bool
    var remoteActivity: ActivitySnapshotParams?
}

struct OrbStateResolution: Equatable, Sendable {
    let state: OrbVisualState
    let reevaluateAt: Date?
}

enum OrbStateResolver {
    static let minimumDwell: TimeInterval = 0.18
    static let transientDuration: TimeInterval = 1.2

    static func resolve(
        inputs: OrbStateInputs,
        currentState: OrbVisualState,
        stateEnteredAt: Date,
        now: Date
    ) -> OrbStateResolution {
        let candidate = candidate(inputs: inputs, now: now)
        guard candidate != currentState else { return OrbStateResolution(state: candidate, reevaluateAt: nil) }
        if isUrgent(candidate) {
            return OrbStateResolution(state: candidate, reevaluateAt: transientExpiry(inputs: inputs, now: now))
        }
        let dwellEnd = stateEnteredAt.addingTimeInterval(minimumDwell)
        if now < dwellEnd {
            return OrbStateResolution(state: currentState, reevaluateAt: dwellEnd)
        }
        return OrbStateResolution(state: candidate, reevaluateAt: transientExpiry(inputs: inputs, now: now))
    }

    private static func candidate(inputs: OrbStateInputs, now: Date) -> OrbVisualState {
        if inputs.phase == .ending { return .ending }
        if inputs.phase == .error { return .failure }
        if [.pairing, .connecting, .reconnecting].contains(inputs.phase) { return .syncing }
        if inputs.outputActive { return .talking }
        if let remote = inputs.remoteActivity {
            let age = now.timeIntervalSince1970 - remote.updatedAt / 1_000
            switch remote.state {
            case .success where age <= transientDuration: return .success
            case .failure where age <= transientDuration: return .failure
            case .success, .failure: return .waiting
            case .thinking: return .thinking
            case .working: return .working
            case .checkingSubagents: return .checkingSubagents
            case .waiting: return .waiting
            }
        }
        if inputs.speechActive { return .listening }
        return .idle
    }

    private static func isUrgent(_ state: OrbVisualState) -> Bool {
        [.syncing, .talking, .success, .failure, .ending].contains(state)
    }

    private static func transientExpiry(inputs: OrbStateInputs, now: Date) -> Date? {
        guard let activity = inputs.remoteActivity,
              activity.state == .success || activity.state == .failure
        else { return nil }
        let expiry = Date(timeIntervalSince1970: activity.updatedAt / 1_000 + transientDuration)
        return expiry > now ? expiry : nil
    }
}
