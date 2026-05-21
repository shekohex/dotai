package com.coder.pi

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

data class TerminalAgentStateSnapshot(
    val hello: AgentEventMetadata? = null,
    val session: AgentSessionState? = null,
    val run: AgentRunState? = null,
    val turn: AgentTurnState? = null,
    val progress: AgentProgressState? = null,
    val tools: List<AgentToolState> = emptyList(),
    val alerts: List<AgentAlertState> = emptyList(),
    val compaction: AgentCompactionState? = null,
)

data class AgentEventMetadata(val id: String, val ts: Long, val source: String, val sessionId: String?, val cwd: String?, val seq: Long?)
data class AgentSessionState(val state: String, val reason: String, val event: AgentEventMetadata)
data class AgentRunState(val state: String, val event: AgentEventMetadata)
data class AgentTurnState(val state: String, val turnIndex: Long, val event: AgentEventMetadata)
data class AgentProgressState(val state: String, val label: String?, val elapsedSeconds: Long?, val event: AgentEventMetadata)
data class AgentToolState(val toolCallId: String, val toolName: String, val state: String, val isError: Boolean, val label: String?, val summary: String?, val event: AgentEventMetadata)
data class AgentAlertState(val kind: String, val title: String, val body: String, val severity: String, val statusCode: Long?, val url: String?, val event: AgentEventMetadata)
data class AgentCompactionState(val state: String, val event: AgentEventMetadata)

class TerminalAgentState(
    private val maxTools: Int = 24,
    private val maxAlerts: Int = 8,
) {
    private var current = TerminalAgentStateSnapshot()

    fun snapshot(): TerminalAgentStateSnapshot = current

    fun clear() {
        current = TerminalAgentStateSnapshot()
    }

    fun apply(event: TerminalOscEvent.Pi): TerminalAgentStateSnapshot {
        val data = event.envelope.data
        val metadata = event.envelope.toMetadata()
        current = when (event.eventName) {
            "hello" -> current.copy(hello = metadata)
            "agent.session" -> current.copy(session = AgentSessionState(data.stringValue("state"), data.stringValue("reason"), metadata))
            "agent.run" -> current.copy(run = AgentRunState(data.stringValue("state"), metadata))
            "agent.turn" -> current.copy(turn = AgentTurnState(data.stringValue("state"), data.longValue("turnIndex"), metadata))
            "agent.progress" -> current.copy(progress = AgentProgressState(data.stringValue("state"), data.optionalStringValue("label"), data["elapsedSeconds"]?.jsonPrimitive?.longOrNull, metadata))
            "agent.tool" -> current.copy(tools = upsertTool(data, metadata))
            "agent.alert" -> current.copy(alerts = appendAlert(data, metadata))
            "agent.compaction" -> current.copy(compaction = AgentCompactionState(data.stringValue("state"), metadata))
            else -> current
        }
        return current
    }

    private fun upsertTool(data: JsonObject, metadata: AgentEventMetadata): List<AgentToolState> {
        val previous = current.tools.lastOrNull { it.toolCallId == data.stringValue("toolCallId") }
        val next = AgentToolState(
            toolCallId = data.stringValue("toolCallId"),
            toolName = data.stringValue("toolName"),
            state = data.stringValue("state"),
            isError = data["isError"]?.jsonPrimitive?.booleanOrNull ?: false,
            label = data.optionalStringValue("label") ?: previous?.label,
            summary = data.optionalStringValue("summary") ?: previous?.summary,
            event = metadata,
        )
        return (current.tools.filterNot { it.toolCallId == next.toolCallId } + next).takeLast(maxTools)
    }

    private fun appendAlert(data: JsonObject, metadata: AgentEventMetadata): List<AgentAlertState> = (current.alerts + AgentAlertState(
        kind = data.stringValue("kind"),
        title = data.stringValue("title"),
        body = data.stringValue("body"),
        severity = data.stringValue("severity"),
        statusCode = data["statusCode"]?.jsonPrimitive?.longOrNull,
        url = data.optionalStringValue("url"),
        event = metadata,
    )).takeLast(maxAlerts)
}

private fun PiOscEnvelope.toMetadata(): AgentEventMetadata = AgentEventMetadata(id, ts, source, sessionId, cwd, seq)

private fun JsonObject.stringValue(name: String): String = this[name]?.jsonPrimitive?.contentOrNull.orEmpty()
private fun JsonObject.optionalStringValue(name: String): String? = this[name]?.jsonPrimitive?.contentOrNull
private fun JsonObject.longValue(name: String): Long = this[name]?.jsonPrimitive?.longOrNull ?: 0L
