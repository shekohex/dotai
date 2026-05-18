package com.coder.pi

object TerminalNotificationFormat {
    const val progressBaseId = 904
    const val defaultOscChannelId = "terminal_osc_alerts"
    const val defaultProgressChannelId = "terminal_osc_progress"

    fun cleanText(text: String): String = text
        .replace(Regex("```[\\s\\S]*?```")) { it.value.removePrefix("```").removeSuffix("```") }
        .replace(Regex("`([^`]+)`"), "$1")
        .replace(Regex("!\\[([^]]*)]\\([^)]*\\)"), "$1")
        .replace(Regex("\\[([^]]+)]\\([^)]*\\)"), "$1")
        .replace(Regex("[*_~#>]+"), "")
        .lines()
        .map { it.trim().removePrefix("- ").removePrefix("* ") }
        .filter { it.isNotBlank() }
        .joinToString(" · ")
        .take(512)

    fun workspaceLabel(context: TerminalNotificationContext): String = context.workspaceDisplayName.ifBlank { context.workspaceName }.take(64)

    fun groupKey(context: TerminalNotificationContext, fallback: String): String = "terminal:${context.terminalId.ifBlank { context.deepLink }.ifBlank { context.workspaceId }.ifBlank { fallback }}"

    fun oscChannelId(context: TerminalNotificationContext): String = if (context.workspaceId.isBlank()) defaultOscChannelId else "terminal_osc_alerts_${context.workspaceId.hashCode()}"

    fun progressChannelId(context: TerminalNotificationContext): String = if (context.workspaceId.isBlank()) defaultProgressChannelId else "terminal_osc_progress_${context.workspaceId.hashCode()}"

    fun oscChannelName(context: TerminalNotificationContext): String = if (context.workspaceName.isBlank()) "Terminal OSC" else "Terminal · ${context.workspaceName}"

    fun progressChannelName(context: TerminalNotificationContext): String = if (context.workspaceName.isBlank()) "Terminal Progress" else "Terminal Progress · ${context.workspaceName}"

    fun progressNotificationId(context: TerminalNotificationContext): Int = (progressBaseId xor context.terminalId.ifBlank { context.deepLink }.ifBlank { context.workspaceId }.hashCode()) and 0x7fffffff
}
