import Foundation
import KeyboardShortcuts

extension KeyboardShortcuts.Name {
    static let showPiLive = Self("showPiLive")
}

extension Notification.Name {
    static let piLiveShowRequested = Self("dev.herdr.pilive.show-requested")
    static let piLiveSessionEnded = Self("dev.herdr.pilive.session-ended")
}
