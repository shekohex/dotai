import SwiftUI

enum LiveVoice: String, CaseIterable, Identifiable, Codable, Sendable {
    case juniper
    case maple
    case spruce
    case ember
    case vale
    case breeze
    case arbor
    case sol
    case cove

    var id: String { rawValue }
    var displayName: String { rawValue.capitalized }

    var colors: [Color] {
        switch self {
        case .juniper: [.mint, .teal, .green]
        case .maple: [.orange, .pink, .red]
        case .spruce: [.indigo, .teal, .green]
        case .ember: [.red, .orange, .yellow]
        case .vale: [.purple, .indigo, .blue]
        case .breeze: [.cyan, .blue, .mint]
        case .arbor: [.green, .mint, .yellow]
        case .sol: [.yellow, .orange, .pink]
        case .cove: [.blue, .cyan, .teal]
        }
    }

    var accent: Color { colors[1] }
}
