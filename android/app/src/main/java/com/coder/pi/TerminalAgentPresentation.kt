package com.coder.pi

data class TerminalAgentStatusPresentation(val title: String, val subtitle: String)
data class TerminalAgentNotificationPresentation(val title: String, val body: String)
data class TerminalAgentProgressPresentation(val stateText: String, val valueText: String)

fun TerminalAgentStateSnapshot.statusPresentation(): TerminalAgentStatusPresentation? {
    val tool = tools.lastOrNull { it.state == "running" }
    if (tool != null) return TerminalAgentStatusPresentation("Pi agent", "${tool.toolName} running")
    if (compaction?.state == "preparing") return TerminalAgentStatusPresentation("Pi agent", "Compacting context")
    if (progress?.state == "active") return TerminalAgentStatusPresentation("Pi agent", "Working")
    if (turn?.state == "running") return TerminalAgentStatusPresentation("Pi agent", "Turn ${turn.turnIndex} running")
    if (run?.state == "running") return TerminalAgentStatusPresentation("Pi agent", "Running")
    return null
}

fun AgentAlertState.notificationPresentation(): TerminalAgentNotificationPresentation = TerminalAgentNotificationPresentation(
    title = title.agentDisplayText().ifBlank { "Pi agent" }.take(128),
    body = body.agentDisplayText().ifBlank { kind.agentDisplayText() }.take(512),
)

fun AgentProgressState.progressPresentation(): TerminalAgentProgressPresentation = when (state) {
    "active" -> TerminalAgentProgressPresentation("3", "")
    else -> TerminalAgentProgressPresentation("0", "0")
}

fun AgentRunState.progressPresentation(): TerminalAgentProgressPresentation? = when (state) {
    "idle" -> TerminalAgentProgressPresentation("0", "0")
    else -> null
}

private fun String.agentDisplayText(): String = TerminalNotificationFormat.cleanText(this).replace(Regex("\\s+"), " ").trim()
