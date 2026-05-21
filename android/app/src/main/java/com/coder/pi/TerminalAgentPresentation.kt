package com.coder.pi

data class TerminalAgentStatusPresentation(val title: String, val subtitle: String)
data class TerminalAgentNotificationPresentation(val title: String, val body: String, val url: String? = null)
data class TerminalAgentProgressPresentation(val active: Boolean, val body: String = "", val elapsedSeconds: Long? = null)

fun TerminalAgentStateSnapshot.statusPresentation(): TerminalAgentStatusPresentation? {
    val tool = tools.lastOrNull { it.state == "running" }
    if (tool != null) return TerminalAgentStatusPresentation("Pi agent", tool.activityText())
    if (compaction?.state == "preparing") return TerminalAgentStatusPresentation("Pi agent", "Compacting context")
    progress?.goalActivityText()?.let { return TerminalAgentStatusPresentation("Pi agent", it) }
    if (progress?.state == "active") return TerminalAgentStatusPresentation("Pi agent", whimsicalAgentStatus())
    if (turn?.state == "running") return TerminalAgentStatusPresentation("Pi agent", whimsicalAgentStatus())
    if (run?.state == "running") return TerminalAgentStatusPresentation("Pi agent", whimsicalAgentStatus())
    return null
}

fun TerminalAgentStateSnapshot.progressPresentation(): TerminalAgentProgressPresentation? {
    val progressState = when {
        progress?.state == "active" -> progress.progressPresentation()
        progress?.state == "clear" && run?.state != "running" -> progress.progressPresentation()
        run?.state == "running" || turn?.state == "running" -> TerminalAgentProgressPresentation(true)
        else -> run?.progressPresentation() ?: return null
    }
    if (!progressState.active) return progressState
    return progressState.copy(body = progressBody())
}

fun AgentAlertState.notificationPresentation(): TerminalAgentNotificationPresentation = TerminalAgentNotificationPresentation(
    title = title.agentDisplayText().ifBlank { "Pi agent" }.take(128),
    body = body.agentDisplayText().ifBlank { kind.agentDisplayText() }.take(512),
    url = url?.takeIf { it.startsWith("http://") || it.startsWith("https://") }?.take(2048),
)

fun AgentProgressState.progressPresentation(): TerminalAgentProgressPresentation = when (state) {
    "active" -> TerminalAgentProgressPresentation(true, elapsedSeconds = elapsedSeconds)
    else -> TerminalAgentProgressPresentation(false)
}

fun AgentRunState.progressPresentation(): TerminalAgentProgressPresentation? = when (state) {
    "idle" -> TerminalAgentProgressPresentation(false)
    else -> null
}

private fun String.agentDisplayText(): String = TerminalNotificationFormat.cleanText(this).replace(Regex("\\s+"), " ").trim()

private fun TerminalAgentStateSnapshot.progressBody(): String {
    val tool = tools.lastOrNull { it.state == "running" }
    if (tool != null) return tool.activityText()
    if (compaction?.state == "preparing") return "Compacting context"
    progress?.goalActivityText()?.let { return it }
    return ""
}

private fun AgentProgressState.goalActivityText(): String? {
    val elapsed = elapsedSeconds?.takeIf { it >= 0 }?.let { formatAgentDuration(it) } ?: return null
    return "Goal active · $elapsed"
}

private fun formatAgentDuration(seconds: Long): String {
    val hours = seconds / 3600
    val minutes = (seconds % 3600) / 60
    val remainingSeconds = seconds % 60
    if (hours > 0) return "${hours}h ${minutes}m"
    if (minutes > 0) return "${minutes}m ${remainingSeconds}s"
    return "${remainingSeconds}s"
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
