import Foundation

enum JSONValue: Codable, Sendable, Equatable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .object(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    func decode<Value: Decodable>(_ type: Value.Type) throws -> Value {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
    }
}

enum RPCID: Codable, Sendable, Equatable {
    case string(String)
    case number(Int)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .string(value)
        } else {
            self = .number(try container.decode(Int.self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        }
    }

    var key: String {
        switch self {
        case let .string(value): value
        case let .number(value): String(value)
        }
    }
}

struct RPCIncomingFrame: Decodable, Sendable {
    let id: RPCID?
    let method: String?
    let params: JSONValue?
    let result: JSONValue?
    let error: RPCErrorPayload?
}

struct RPCErrorPayload: Codable, Sendable {
    let code: Int
    let message: String
}

struct RPCRequest<Params: Encodable>: Encodable {
    let jsonrpc = "2.0"
    let id: RPCID
    let method: String
    let params: Params
}

struct RPCNotification<Params: Encodable>: Encodable {
    let jsonrpc = "2.0"
    let method: String
    let params: Params
}

struct RPCSuccess<Result: Encodable>: Encodable {
    let jsonrpc = "2.0"
    let id: RPCID
    let result: Result
}

struct RPCFailure: Encodable {
    let jsonrpc = "2.0"
    let id: RPCID
    let error: RPCErrorPayload
}

struct EmptyParams: Codable, Sendable {}

struct PairRequestParams: Encodable {
    struct Client: Encodable {
        let name: String
        let platform: String
        let appVersion: String
    }

    struct Capabilities: Encodable {
        let webrtc: Bool
        let inputLevel: Bool
        let outputLevel: Bool
        let deviceSelection: Bool
        let sessionResume: Bool
        let threadCoordination: Bool
        let screenCapture: Bool
    }

    struct Preferences: Encodable {
        let voice: String
        let instructions: String
        let diagnosticsEnabled: Bool
    }

    let protocolVersion: Int
    let secret: String
    let client: Client
    let capabilities: Capabilities
    let preferences: Preferences
}

struct PhaseParams: Codable, Sendable { let phase: String }
struct TranscriptParams: Codable, Sendable { let text: String }
struct AgentProgressParams: Codable, Sendable {
    let delegationId: String
    let channel: String
    let text: String
}
struct LiveThreadActivity: Codable, Sendable, Equatable {
    let kind: String
    let label: String
    let detail: String?
    let toolName: String?
    let startedAt: Double
    let updatedAt: Double
}
struct LiveThreadSnapshot: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let parentId: String?
    let path: String
    let name: String
    let task: String
    let status: String
    let activity: LiveThreadActivity?
    let latestCommentary: String?
    let finalSummary: String?
    let updatedAt: Double
}
struct ThreadsSnapshotParams: Codable, Sendable {
    let coordinatorId: String
    let sequence: Int
    let threads: [LiveThreadSnapshot]
}
struct ThreadEventParams: Codable, Sendable {
    let coordinatorId: String
    let sequence: Int
    let type: String
    let threadId: String
    let timestamp: Double
    let thread: LiveThreadSnapshot?
}
struct ThreadInspectionResult: Codable, Sendable {
    let thread: LiveThreadSnapshot
    let events: [ThreadEventParams]
}
struct ThreadIDParams: Codable, Sendable { let threadId: String }
struct ThreadMessageParams: Codable, Sendable {
    let threadId: String
    let message: String
    let delivery: String
}
struct MutedParams: Codable, Sendable { let muted: Bool }
struct WebRTCStateParams: Codable, Sendable { let state: String }
struct AudioLevelsParams: Codable, Sendable {
    let input: Double
    let output: Double
    let speechActive: Bool
}
struct VoiceSettingParams: Codable, Sendable {
    let saved: Bool?
    let voice: String?
    let appliesTo: String?
    let message: String?
}
struct InstructionsSettingParams: Codable, Sendable {
    let saved: Bool?
    let appliesTo: String?
    let message: String?
}
struct DiagnosticsSettingParams: Codable, Sendable {
    let saved: Bool?
    let enabled: Bool?
    let appliesTo: String?
    let message: String?
}
struct VoicePreferenceParams: Codable, Sendable { let voice: String }
struct InstructionsPreferenceParams: Codable, Sendable { let instructions: String }
struct DiagnosticsPreferenceParams: Codable, Sendable { let enabled: Bool }
struct StopParams: Codable, Sendable { let reason: String }
struct ErrorMessageParams: Codable, Sendable { let message: String }
struct PongParams: Codable, Sendable { let timestamp: Double }
struct AcceptAnswerParams: Codable, Sendable { let sdp: String }
struct OfferResult: Codable, Sendable { let sdp: String }
struct AcceptAnswerResult: Codable, Sendable { let accepted: Bool }
struct PairResult: Codable, Sendable {
    let protocolVersion: Int
    let sessionId: String
    let serverNonce: String
    let resumeToken: String
}
struct ResumeRequestParams: Codable, Sendable {
    let protocolVersion: Int
    let sessionId: String
    let serverNonce: String
    let resumeToken: String
}
struct ResumeResult: Codable, Sendable {
    let protocolVersion: Int
    let sessionId: String
    let serverNonce: String
    let resumed: Bool
}

struct ScreenCaptureResult: Codable, Sendable, Equatable {
    let mimeType: String
    let data: String
    let width: Int
    let height: Int
    let displayId: String
    let timestamp: Double
    let byteSize: Int
    let sha256: String
}

let maxLiveRPCFrameBytes = 512 * 1024
let maxLiveSDPBytes = 256 * 1024
let maxScreenCaptureImageBytes = 6 * 1024 * 1024
let maxScreenCaptureEncodedFrameBytes = 8 * 1024 * 1024
let targetScreenCaptureEncodedFrameBytes = maxScreenCaptureEncodedFrameBytes - 16 * 1024

func encodeLiveRPCFrame<Message: Encodable>(
    _ message: Message,
    encoder: JSONEncoder = JSONEncoder(),
    maximumBytes: Int = maxLiveRPCFrameBytes
) throws -> String {
    let data = try encoder.encode(message)
    guard data.count <= maximumBytes else {
        throw PiLiveError.protocolError("JSON-RPC frame is oversized")
    }
    guard let string = String(data: data, encoding: .utf8) else {
        throw PiLiveError.protocolError("Unable to encode JSON-RPC message")
    }
    return string
}

extension Optional where Wrapped == JSONValue {
    func decode<Value: Decodable>(_ type: Value.Type, default defaultValue: Value? = nil) throws -> Value {
        if let self { return try self.decode(type) }
        if let defaultValue { return defaultValue }
        throw PiLiveError.protocolError("JSON-RPC request is missing parameters")
    }
}
