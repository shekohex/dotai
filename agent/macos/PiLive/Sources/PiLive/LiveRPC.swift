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
struct MutedParams: Codable, Sendable { let muted: Bool }
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

extension Optional where Wrapped == JSONValue {
    func decode<Value: Decodable>(_ type: Value.Type, default defaultValue: Value? = nil) throws -> Value {
        if let self { return try self.decode(type) }
        if let defaultValue { return defaultValue }
        throw PiLiveError.protocolError("JSON-RPC request is missing parameters")
    }
}
