package com.coder.pi

sealed interface TerminalOscEvent {
    data class Clipboard(val kind: String, val data: String) : TerminalOscEvent
    data class Notification(val title: String, val body: String) : TerminalOscEvent
    data class Progress(val stateText: String, val valueText: String) : TerminalOscEvent
    data class Pi(val eventName: String, val payload: String) : TerminalOscEvent
    data object Ignored : TerminalOscEvent
}

fun parseTerminalOscEvent(raw: String): TerminalOscEvent {
    val parts = raw.split("\t", limit = 3)
    return when (parts.getOrNull(0)) {
        "clipboard" -> TerminalOscEvent.Clipboard(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
        "notification" -> TerminalOscEvent.Notification(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
        "progress" -> TerminalOscEvent.Progress(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
        "pi" -> TerminalOscEvent.Pi(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
        else -> TerminalOscEvent.Ignored
    }
}

fun Array<String>.toTerminalOscEvents(): List<TerminalOscEvent> = map(::parseTerminalOscEvent).filterNot { it is TerminalOscEvent.Ignored }
