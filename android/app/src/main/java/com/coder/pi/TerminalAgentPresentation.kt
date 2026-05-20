package com.coder.pi

data class TerminalAgentStatusPresentation(val title: String, val subtitle: String)
data class TerminalAgentNotificationPresentation(val title: String, val body: String)
data class TerminalAgentProgressPresentation(val stateText: String, val valueText: String, val body: String = "")

fun TerminalAgentStateSnapshot.statusPresentation(): TerminalAgentStatusPresentation? {
    val tool = tools.lastOrNull { it.state == "running" }
    if (tool != null) return TerminalAgentStatusPresentation("Pi agent", tool.activityText())
    if (compaction?.state == "preparing") return TerminalAgentStatusPresentation("Pi agent", "Compacting context")
    if (progress?.state == "active") return TerminalAgentStatusPresentation("Pi agent", whimsicalAgentStatus())
    if (turn?.state == "running") return TerminalAgentStatusPresentation("Pi agent", whimsicalAgentStatus())
    if (run?.state == "running") return TerminalAgentStatusPresentation("Pi agent", whimsicalAgentStatus())
    return null
}

fun TerminalAgentStateSnapshot.progressPresentation(): TerminalAgentProgressPresentation? {
    val progressState = progress?.progressPresentation() ?: run?.progressPresentation() ?: return null
    if (progressState.stateText == "0") return progressState
    return progressState.copy(body = progressBody())
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

private fun TerminalAgentStateSnapshot.progressBody(): String {
    val tool = tools.lastOrNull { it.state == "running" }
    if (tool != null) return tool.activityText()
    if (compaction?.state == "preparing") return "Compacting context"
    return ""
}

private fun TerminalAgentStateSnapshot.whimsicalAgentStatus(): String {
    val messages = WhimsicalStatusMessages.working
    val seed = progress?.event?.seq ?: turn?.event?.seq ?: run?.event?.seq ?: 0L
    return messages[seed.mod(messages.size)]
}

private fun AgentToolState.activityText(): String = when (toolName.lowercase()) {
    "bash", "shell", "sh", "zsh", "fish" -> "Bashing"
    "read", "open" -> "Reading code"
    "grep", "rg", "find", "glob", "ls" -> "Exploring code"
    "edit", "write", "apply_patch", "patch" -> "Editing files"
    "review" -> "Reviewing"
    "websearch", "web_search", "firecrawl" -> "Researching"
    "todo", "planner", "plan" -> "Planning"
    else -> toolName.agentDisplayText().ifBlank { "Vibing" }
}
