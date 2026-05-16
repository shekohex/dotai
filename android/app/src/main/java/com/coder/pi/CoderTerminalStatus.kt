package com.coder.pi

enum class TerminalConnectionStatus(val wireName: String) {
    Connecting("connecting"),
    Connected("connected"),
    Reconnecting("reconnecting"),
    Disconnected("disconnected"),
    Failed("failed"),
}

fun terminalStatusFromWireName(value: String): TerminalConnectionStatus {
    return TerminalConnectionStatus.entries.firstOrNull { it.wireName == value } ?: TerminalConnectionStatus.Disconnected
}

fun terminalStatusIsRecoverable(value: String): Boolean {
    return terminalStatusFromWireName(value) in setOf(TerminalConnectionStatus.Disconnected, TerminalConnectionStatus.Failed)
}

fun terminalStatusPreviewLabel(value: String): String {
    return if (terminalStatusFromWireName(value) == TerminalConnectionStatus.Connected) "just now" else value
}
