@preconcurrency import DeviceCheck
import Foundation

@MainActor
enum CodexDeviceCheck {
    private static let appSessionId = UUID().uuidString

    static func generate() async -> [String: Any] {
        let device = DCDevice.current
        let startedAt = Date()
        var result: [String: Any] = [
            "supported": device.isSupported,
            "locale": String(Locale.current.identifier.prefix(64)),
            "timezone": String(TimeZone.current.identifier.prefix(64)),
            "appSessionId": String(appSessionId.prefix(128)),
        ]
        guard device.isSupported else {
            result["latencyMs"] = Date().timeIntervalSince(startedAt) * 1_000
            return result
        }
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
            result["tokenBase64"] = token.base64EncodedString()
        } catch {}
        result["latencyMs"] = Date().timeIntervalSince(startedAt) * 1_000
        return result
    }
}
