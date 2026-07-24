import Foundation

let livePairingProtocolVersion = 1

struct PairingEnvelope: Equatable {
    let payload: PairingPayload
    let secret: String

    init(uri: String) throws {
        guard let components = URLComponents(string: uri),
              components.scheme == "pi-live",
              components.host == "pair",
              let fragment = components.fragment,
              let fragmentComponents = URLComponents(string: "pi-live://fragment?\(fragment)")
        else {
            throw PiLiveError.invalidPairingURL
        }
        let values = Dictionary(
            uniqueKeysWithValues: (fragmentComponents.queryItems ?? []).compactMap { item in
                item.value.map { (item.name, $0) }
            }
        )
        guard let encodedPayload = values["payload"],
              let secret = values["secret"],
              let data = Data(base64URLEncoded: encodedPayload)
        else {
            throw PiLiveError.invalidPairingURL
        }
        let payload = try JSONDecoder().decode(PairingPayload.self, from: data)
        guard payload.protocolVersion == livePairingProtocolVersion,
              payload.expiresAt > Int(Date().timeIntervalSince1970 * 1_000)
        else {
            throw PiLiveError.expiredPairingURL
        }
        self.payload = payload
        self.secret = secret
    }
}

struct PairingPayload: Codable, Equatable {
    let protocolVersion: Int
    let sessionId: String
    let serverNonce: String
    let expiresAt: Int
    let endpoints: [PairingEndpoint]
}

enum PairingEndpoint: Codable, Equatable {
    case local(url: URL)
    case coder(url: URL)
    case direct(url: URL)
    case ssh(remoteHost: String, remotePort: Int, targetHint: String?)

    private enum CodingKeys: String, CodingKey {
        case type, url, remoteHost, remotePort, targetHint
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "local":
            self = .local(url: try container.decode(URL.self, forKey: .url))
        case "coder":
            self = .coder(url: try container.decode(URL.self, forKey: .url))
        case "direct":
            self = .direct(url: try container.decode(URL.self, forKey: .url))
        case "ssh":
            self = .ssh(
                remoteHost: try container.decode(String.self, forKey: .remoteHost),
                remotePort: try container.decode(Int.self, forKey: .remotePort),
                targetHint: try container.decodeIfPresent(String.self, forKey: .targetHint)
            )
        default:
            throw PiLiveError.unsupportedTransport
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .local(url):
            try container.encode("local", forKey: .type)
            try container.encode(url, forKey: .url)
        case let .coder(url):
            try container.encode("coder", forKey: .type)
            try container.encode(url, forKey: .url)
        case let .direct(url):
            try container.encode("direct", forKey: .type)
            try container.encode(url, forKey: .url)
        case let .ssh(remoteHost, remotePort, targetHint):
            try container.encode("ssh", forKey: .type)
            try container.encode(remoteHost, forKey: .remoteHost)
            try container.encode(remotePort, forKey: .remotePort)
            try container.encodeIfPresent(targetHint, forKey: .targetHint)
        }
    }
}

enum PreferredTransport: String, CaseIterable, Identifiable {
    case automatic
    case coder
    case ssh
    case local
    case direct

    var id: String { rawValue }
}

enum LivePhase: String {
    case idle
    case pairing
    case connecting
    case listening
    case speaking
    case working
    case muted
    case ending
    case reconnecting
    case error
}

enum PiLiveError: LocalizedError {
    case invalidPairingURL
    case expiredPairingURL
    case unsupportedTransport
    case missingCoderToken
    case missingSSHTarget
    case microphoneDenied
    case pairingRejected(String)
    case protocolError(String)

    var errorDescription: String? {
        switch self {
        case .invalidPairingURL: "Invalid Pi Live pairing URL."
        case .expiredPairingURL: "The Pi Live pairing URL has expired."
        case .unsupportedTransport: "No supported connection adapter is available."
        case .missingCoderToken: "Save a Coder session token before using the Coder adapter."
        case .missingSSHTarget: "Enter the same SSH target used to access the workspace."
        case .microphoneDenied: "Microphone access is required for Pi Live."
        case let .pairingRejected(message): "Pairing rejected: \(message)"
        case let .protocolError(message): "Pi Live protocol error: \(message)"
        }
    }
}

extension Data {
    init?(base64URLEncoded value: String) {
        var normalized = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        self.init(base64Encoded: normalized)
    }
}
