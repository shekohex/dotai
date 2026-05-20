package com.coder.pi

import java.util.Base64
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

sealed interface TerminalOscEvent {
    data class Clipboard(val kind: String, val data: String) : TerminalOscEvent
    data class Notification(val title: String, val body: String) : TerminalOscEvent
    data class Progress(val stateText: String, val valueText: String) : TerminalOscEvent
    data class Pi(val version: Int, val eventName: String, val envelope: PiOscEnvelope) : TerminalOscEvent
    data object Ignored : TerminalOscEvent
}

data class PiOscEnvelope(
    val id: String,
    val ts: Long,
    val source: String,
    val sessionId: String?,
    val cwd: String?,
    val seq: Long?,
    val data: JsonObject,
)

private val piOscJson = Json { ignoreUnknownKeys = true; explicitNulls = false }
private val piOscPayloadPattern = Regex("^[A-Za-z0-9_-]+$")
private val piOscEvents = setOf("hello", "agent.session", "agent.run", "agent.turn", "agent.progress", "agent.tool", "agent.alert", "agent.compaction")

fun parseTerminalOscEvent(raw: String): TerminalOscEvent {
    val parts = raw.split("\t", limit = if (raw.startsWith("pi\t")) 4 else 3)
    return when (parts.getOrNull(0)) {
        "clipboard" -> TerminalOscEvent.Clipboard(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
        "notification" -> TerminalOscEvent.Notification(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
        "progress" -> TerminalOscEvent.Progress(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
        "pi" -> parsePiOscEvent(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty(), parts.getOrNull(3).orEmpty())
        else -> TerminalOscEvent.Ignored
    }
}

fun Array<String>.toTerminalOscEvents(): List<TerminalOscEvent> = map(::parseTerminalOscEvent).filterNot { it is TerminalOscEvent.Ignored }

private fun parsePiOscEvent(versionText: String, eventName: String, payload: String): TerminalOscEvent = runCatching {
    val version = versionText.toIntOrNull() ?: return TerminalOscEvent.Ignored
    if (version != 1 || eventName !in piOscEvents || payload.isBlank() || payload.length > 8192 || !piOscPayloadPattern.matches(payload)) return TerminalOscEvent.Ignored
    val bytes = Base64.getUrlDecoder().decode(paddedBase64Url(payload))
    if (bytes.size > 8192) return TerminalOscEvent.Ignored
    val root = piOscJson.parseToJsonElement(strictUtf8(bytes)).jsonObject
    val envelope = parsePiOscEnvelope(root) ?: return TerminalOscEvent.Ignored
    if (!isValidPiOscPayload(eventName, envelope.data)) return TerminalOscEvent.Ignored
    TerminalOscEvent.Pi(version, eventName, envelope)
}.getOrElse { TerminalOscEvent.Ignored }

private fun paddedBase64Url(value: String): String {
    val padding = (4 - value.length % 4) % 4
    return value + "=".repeat(padding)
}

private fun parsePiOscEnvelope(root: JsonObject): PiOscEnvelope? {
    val id = root.stringField("id", 128) ?: return null
    val ts = root["ts"]?.jsonPrimitive?.longOrNull ?: return null
    val source = root.stringField("source", 32) ?: return null
    if (source != "agent") return null
    val data = root["data"] as? JsonObject ?: return null
    return PiOscEnvelope(
        id = id,
        ts = ts,
        source = source,
        sessionId = root.stringField("sessionId", 256, required = false),
        cwd = root.stringField("cwd", 1024, required = false),
        seq = root["seq"]?.jsonPrimitive?.longOrNull,
        data = data,
    )
}

private fun strictUtf8(bytes: ByteArray): String = try {
    StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
} catch (_: CharacterCodingException) {
    throw IllegalArgumentException("Invalid UTF-8")
}

private fun JsonObject.stringField(name: String, maxLength: Int, required: Boolean = true): String? {
    val value = this[name] ?: return if (required) null else null
    val primitive = value as? JsonPrimitive ?: return null
    if (!primitive.isString) return null
    val text = primitive.contentOrNull ?: return null
    return text.takeIf { it.isNotBlank() && it.length <= maxLength }
}

private fun isValidPiOscPayload(eventName: String, data: JsonObject): Boolean = when (eventName) {
    "hello" -> data.intField("protocol") == 1 && data.stringEquals("extension", "pi-osc") && data["version"]?.jsonPrimitive?.longOrNull != null && data.keys == setOf("protocol", "extension", "version")
    "agent.session" -> data.stringEquals("state", "started") && data.stringIn("reason", setOf("startup", "reload", "new", "resume", "fork")) && data.keys == setOf("state", "reason")
    "agent.run" -> data.stringIn("state", setOf("running", "idle")) && data.keys == setOf("state")
    "agent.turn" -> data.stringIn("state", setOf("running", "complete")) && data["turnIndex"]?.jsonPrimitive?.longOrNull != null && data.keys == setOf("state", "turnIndex")
    "agent.progress" -> data.stringIn("state", setOf("active", "clear")) && data.keys == setOf("state")
    "agent.tool" -> isValidPiOscToolPayload(data)
    "agent.alert" -> isValidPiOscAlertPayload(data)
    "agent.compaction" -> data.stringIn("state", setOf("preparing", "complete")) && data.keys == setOf("state")
    else -> false
}

private fun isValidPiOscToolPayload(data: JsonObject): Boolean {
    val allowed = setOf("toolCallId", "toolName", "state", "isError", "label", "summary")
    if (!allowed.containsAll(data.keys)) return false
    if (data.stringField("toolCallId", 128) == null || data.stringField("toolName", 128) == null || !data.stringIn("state", setOf("running", "complete"))) return false
    if (data["isError"] != null && data["isError"]?.jsonPrimitive?.booleanOrNull == null) return false
    if (data["label"] != null && data.stringField("label", 128) == null) return false
    if (data["summary"] != null && data.stringField("summary", 512) == null) return false
    return true
}

private fun isValidPiOscAlertPayload(data: JsonObject): Boolean {
    val allowed = setOf("kind", "title", "body", "severity", "statusCode")
    if (!allowed.containsAll(data.keys)) return false
    if (!data.stringIn("kind", setOf("provider", "runtime")) || data.stringField("title", 128) == null || data.stringField("body", 512) == null || !data.stringIn("severity", setOf("info", "warning", "error"))) return false
    if (data["statusCode"] != null && data["statusCode"]?.jsonPrimitive?.intOrNull == null) return false
    return true
}

private fun JsonObject.stringEquals(name: String, expected: String): Boolean = stringField(name, expected.length) == expected

private fun JsonObject.stringIn(name: String, values: Set<String>): Boolean = stringField(name, values.maxOf { it.length }) in values

private fun JsonObject.intField(name: String): Int? = (this[name] as? JsonPrimitive)?.intOrNull
