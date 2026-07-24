@preconcurrency import DeviceCheck
import Foundation

@MainActor
enum CodexDeviceCheck {
    private static let appSessionId = UUID().uuidString

    static func generate() async -> CodexDeviceCheckResult {
        let device = DCDevice.current
        let startedAt = Date()
        let locale = String(Locale.current.identifier.prefix(64))
        let timezone = String(TimeZone.current.identifier.prefix(64))
        let sessionID = String(appSessionId.prefix(128))
        guard device.isSupported else {
            return CodexDeviceCheckResult(
                supported: false,
                locale: locale,
                timezone: timezone,
                appSessionId: sessionID,
                tokenBase64: nil,
                latencyMs: Date().timeIntervalSince(startedAt) * 1_000
            )
        }
        var tokenBase64: String?
        do {
            let token = try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<Data, Error>) in
                device.generateToken { data, error in
                    if let data {
                        continuation.resume(returning: data)
                    } else if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(throwing: PiLiveError.protocolError(
                            "DeviceCheck returned no token"
                        ))
                    }
                }
            }
            tokenBase64 = token.base64EncodedString()
        } catch {}
        return CodexDeviceCheckResult(
            supported: true,
            locale: locale,
            timezone: timezone,
            appSessionId: sessionID,
            tokenBase64: tokenBase64,
            latencyMs: Date().timeIntervalSince(startedAt) * 1_000
        )
    }
}

struct CodexDeviceCheckResult: Codable, Sendable {
    let supported: Bool
    let locale: String
    let timezone: String
    let appSessionId: String
    let tokenBase64: String?
    let latencyMs: Double
}
