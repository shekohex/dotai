import XCTest
@testable import PiLive

final class PairingModelsTests: XCTestCase {
    func testDecodesFragmentOnlyPairingURL() throws {
        let payload = PairingPayload(
            protocolVersion: 1,
            sessionId: "session",
            serverNonce: "nonce",
            expiresAt: Int(Date().addingTimeInterval(60).timeIntervalSince1970 * 1_000),
            endpoints: [.ssh(remoteHost: "127.0.0.1", remotePort: 39999, targetHint: "pi.coder")]
        )
        let data = try JSONEncoder().encode(payload)
        let encoded = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let envelope = try PairingEnvelope(uri: "pi-live://pair#payload=\(encoded)&secret=abc")
        XCTAssertEqual(envelope.payload.sessionId, "session")
        XCTAssertEqual(envelope.secret, "abc")
    }
}
