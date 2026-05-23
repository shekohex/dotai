package com.coder.pi

enum class TerminalConnectionStatus(
    val wireName: String,
) {
    Connecting("connecting"),
    Connected("connected"),
    Reconnecting("reconnecting"),
    Disconnected("disconnected"),
    Failed("failed"),
}

fun terminalStatusFromWireName(value: String): TerminalConnectionStatus = TerminalConnectionStatus.entries.firstOrNull { it.wireName == value } ?: TerminalConnectionStatus.Disconnected

fun terminalStatusIsRecoverable(value: String): Boolean = terminalStatusFromWireName(value) in setOf(TerminalConnectionStatus.Disconnected, TerminalConnectionStatus.Failed)

fun terminalStatusPreviewLabel(value: String): String = if (terminalStatusFromWireName(value) == TerminalConnectionStatus.Connected) "just now" else value
