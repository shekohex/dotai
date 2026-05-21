package com.coder.pi

data class TerminalAgentStatusPresentation(val title: String, val subtitle: String)
data class TerminalAgentNotificationPresentation(val title: String, val body: String, val url: String? = null, val severity: String = "info", val kind: String = "runtime")
data class TerminalAgentProgressPresentation(val active: Boolean, val body: String = "", val elapsedSeconds: Long? = null)

private const val AgentTitle = "Pi agent"
private const val ToolStateRunning = "running"
private const val ToolStateComplete = "complete"
private const val ProgressStateActive = "active"
private const val ProgressStateClear = "clear"
private const val ThinkingText = "Thinking"
private const val CompactingText = "Compacting context"
private val ShellTools = setOf("bash", "shell", "sh", "zsh", "fish")
private val ReadTools = setOf("read", "open")
private val SearchTools = setOf("grep", "rg", "find", "glob", "ls")
private val EditTools = setOf("edit", "write", "apply_patch", "patch")
private val WebTools = setOf("websearch", "web_search", "firecrawl", "webfetch", "web_fetch")
private val PlanningTools = setOf("todo", "planner", "plan")
private val ExternalTools = setOf("execute", "resume")

fun TerminalAgentStateSnapshot.statusPresentation(): TerminalAgentStatusPresentation? {
    if (run?.state == "idle" || progress?.state == ProgressStateClear) return null
    val tool = tools.lastOrNull { it.state == ToolStateRunning }
    if (tool != null) return TerminalAgentStatusPresentation(AgentTitle, tool.activityText())
    tools.lastOrNull { it.state == ToolStateComplete }?.completionText()?.takeIf { it.isNotBlank() }?.let { return TerminalAgentStatusPresentation(AgentTitle, it) }
    if (compaction?.state == "preparing") return TerminalAgentStatusPresentation(AgentTitle, CompactingText)
    progress?.goalActivityText()?.let { return TerminalAgentStatusPresentation(AgentTitle, it) }
    if (progress?.state == ProgressStateActive) return TerminalAgentStatusPresentation(AgentTitle, ThinkingText)
    if (turn?.state == ToolStateRunning) return TerminalAgentStatusPresentation(AgentTitle, ThinkingText)
    if (run?.state == ToolStateRunning) return TerminalAgentStatusPresentation(AgentTitle, ThinkingText)
    return null
}

fun TerminalAgentStateSnapshot.progressPresentation(): TerminalAgentProgressPresentation? {
    val progressState = when {
        progress?.state == ProgressStateActive -> progress.progressPresentation()
        progress?.state == ProgressStateClear && run?.state != ToolStateRunning -> progress.progressPresentation()
        run?.state == ToolStateRunning || turn?.state == ToolStateRunning -> TerminalAgentProgressPresentation(true)
        else -> run?.progressPresentation() ?: return null
    }
    if (!progressState.active) return progressState
    return progressState.copy(body = progressBody())
}

fun AgentAlertState.notificationPresentation(): TerminalAgentNotificationPresentation = TerminalAgentNotificationPresentation(
    title = title.agentDisplayText().ifBlank { AgentTitle }.take(128),
    body = body.agentDisplayText().ifBlank { kind.agentDisplayText() }.take(512),
    url = url?.takeIf { it.startsWith("http://") || it.startsWith("https://") }?.take(2048),
    severity = severity,
    kind = kind,
)

fun AgentProgressState.progressPresentation(): TerminalAgentProgressPresentation = when (state) {
    ProgressStateActive -> TerminalAgentProgressPresentation(true, elapsedSeconds = elapsedSeconds)
    else -> TerminalAgentProgressPresentation(false)
}

fun AgentRunState.progressPresentation(): TerminalAgentProgressPresentation? = when (state) {
    "idle" -> TerminalAgentProgressPresentation(false)
    else -> null
}

private fun String.agentDisplayText(): String = TerminalNotificationFormat.cleanText(this).replace(Regex("\\s+"), " ").trim()

private fun TerminalAgentStateSnapshot.progressBody(): String {
    val tool = tools.lastOrNull { it.state == ToolStateRunning }
    if (tool != null) return tool.activityText()
    tools.lastOrNull { it.state == ToolStateComplete }?.completionText()?.takeIf { it.isNotBlank() }?.let { return it }
    if (compaction?.state == "preparing") return CompactingText
    progress?.label?.agentDisplayText()?.takeIf { it.isNotBlank() }?.let { return it }
    progress?.goalActivityText()?.let { return it }
    if (progress?.state == ProgressStateActive || turn?.state == ToolStateRunning || run?.state == ToolStateRunning) return ThinkingText
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

private fun AgentToolState.activityText(): String = label?.agentDisplayText()?.ifBlank { null } ?: defaultActivityText()

private fun AgentToolState.completionText(): String = namedSummary() ?: when (toolName.lowercase()) {
    in ShellTools -> "Shell command finished"
    in ReadTools -> "Read file"
    in SearchTools -> "Explored files"
    in EditTools -> "Updated files"
    in WebTools -> "Research complete"
    in ExternalTools -> "External tool finished"
    "subagent" -> "Subagent task finished"
    "goal" -> "Goal updated"
    "interview" -> "Interview ready"
    else -> toolName.agentDisplayText().ifBlank { "Tool complete" }
}

private fun AgentToolState.namedSummary(): String? {
    val cleanSummary = summary?.agentDisplayText()?.ifBlank { null } ?: return null
    val fileName = label?.agentDisplayText()?.substringAfter(" ", "")?.takeIf { it.isNotBlank() }
    return when {
        cleanSummary == "Read file" && fileName != null -> "Read $fileName"
        cleanSummary == "Wrote file" && fileName != null -> "Wrote $fileName"
        cleanSummary == "Edited file" && fileName != null -> "Edited $fileName"
        cleanSummary == "Updated files" && fileName != null -> "Updated $fileName"
        else -> cleanSummary
    }
}

private fun AgentToolState.defaultActivityText(): String = when (toolName.lowercase()) {
    in ShellTools -> "Bashing"
    in ReadTools -> "Reading code"
    in SearchTools -> "Exploring code"
    in EditTools -> "Editing files"
    "review" -> "Reviewing"
    in WebTools -> "Researching"
    in PlanningTools -> "Planning"
    in ExternalTools -> "Calling external tool"
    "subagent" -> "Working with subagent"
    else -> toolName.agentDisplayText().ifBlank { "Vibing" }
}
