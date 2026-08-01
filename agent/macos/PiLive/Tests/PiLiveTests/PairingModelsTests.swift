import XCTest
@testable import PiLive

final class PairingModelsTests: XCTestCase {
    func testLiveVoicesUseLowercaseWireValues() {
        XCTAssertEqual(
            LiveVoice.allCases.map(\.rawValue),
            ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"]
        )
    }

    func testDecodesFragmentOnlyPairingURL() throws {
        let payload = PairingPayload(
            protocolVersion: livePairingProtocolVersion,
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

    func testDecodesTypedRPCNotificationParameters() throws {
        let data = Data(#"{"jsonrpc":"2.0","method":"audio.setMuted","params":{"muted":true}}"#.utf8)
        let frame = try JSONDecoder().decode(RPCIncomingFrame.self, from: data)
        XCTAssertEqual(frame.method, "audio.setMuted")
        XCTAssertTrue(try frame.params.decode(MutedParams.self).muted)
    }

    func testEncodesTypedRPCRequest() throws {
        let request = RPCRequest(
            id: RPCID.string("offer"),
            method: "webrtc.createOffer",
            params: EmptyParams()
        )
        let data = try JSONEncoder().encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(object["id"] as? String, "offer")
        XCTAssertEqual(object["method"] as? String, "webrtc.createOffer")
        XCTAssertNotNil(object["params"] as? [String: Any])
    }

    func testEncodesDiagnosticsPairingPreference() throws {
        let preferences = PairRequestParams.Preferences(
            voice: "sol",
            instructions: "",
            diagnosticsEnabled: false
        )
        let data = try JSONEncoder().encode(preferences)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["diagnosticsEnabled"] as? Bool, false)
    }

    func testEncodesSessionResumeCapability() throws {
        let capabilities = PairRequestParams.Capabilities(
            webrtc: true,
            inputLevel: true,
            outputLevel: true,
            deviceSelection: false,
            sessionResume: true,
            threadCoordination: true
        )
        let data = try JSONEncoder().encode(capabilities)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["sessionResume"] as? Bool, true)
        XCTAssertEqual(object["threadCoordination"] as? Bool, true)
    }

    func testDecodesAgentProgressNotification() throws {
        let data = Data(
            #"{"jsonrpc":"2.0","method":"agent.progress","params":{"delegationId":"d1","channel":"commentary","text":"Checking tests"}}"#.utf8
        )
        let frame = try JSONDecoder().decode(RPCIncomingFrame.self, from: data)
        let progress = try frame.params.decode(AgentProgressParams.self)
        XCTAssertEqual(progress.delegationId, "d1")
        XCTAssertEqual(progress.channel, "commentary")
        XCTAssertEqual(progress.text, "Checking tests")
    }

    func testDecodesThreadSnapshotNotification() throws {
        let data = Data(
            #"{"jsonrpc":"2.0","method":"threads.snapshot","params":{"coordinatorId":"c1","sequence":2,"threads":[{"id":"child-1","parentId":"root","path":"/root/tests","name":"tests","task":"Run tests","status":"running","activity":{"kind":"tool","label":"npm test","toolName":"bash","startedAt":1,"updatedAt":2},"updatedAt":2}]}}"#.utf8
        )
        let frame = try JSONDecoder().decode(RPCIncomingFrame.self, from: data)
        let snapshot = try frame.params.decode(ThreadsSnapshotParams.self)
        XCTAssertEqual(snapshot.sequence, 2)
        XCTAssertEqual(snapshot.threads.first?.path, "/root/tests")
        XCTAssertEqual(snapshot.threads.first?.activity?.label, "npm test")
    }
}
