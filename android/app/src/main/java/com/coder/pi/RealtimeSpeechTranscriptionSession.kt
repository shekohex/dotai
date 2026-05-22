package com.coder.pi

import android.util.Base64
import android.util.Log
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URLEncoder
import kotlin.math.roundToInt

class RealtimeSpeechTranscriptionSession(
    private val settings: SpeechSettingsValues,
    private val apiKey: String,
    private val onDelta: (String) -> Unit,
) {
    private companion object {
        const val PcmSampleRate = 24_000
        const val LogTag = "RealtimeSpeech"
    }

    private val json =
        Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }
    private val client = HttpClient(OkHttp) { install(WebSockets) }
    private val scope = CoroutineScope(Dispatchers.IO)
    private val audioFrames = Channel<FloatArray>(capacity = 32, onBufferOverflow = BufferOverflow.DROP_LATEST)
    private val finalTranscript = CompletableDeferred<String>()
    private var receiveJob: Job? = null
    private var sendJob: Job? = null
    private var session: io.ktor.client.plugins.websocket.DefaultClientWebSocketSession? = null
    private var partialTranscript = ""
    private var errorMessage = ""

    suspend fun start() {
        session =
            client.webSocketSession(realtimeUrl(settings, apiKey)) {
                if (apiKey.isNotBlank()) header(HttpHeaders.Authorization, "Bearer $apiKey")
                header("OpenAI-Beta", "realtime=v1")
            }
        receiveJob = scope.launch { receiveEvents() }
        sendJob = scope.launch { sendAudioFrames() }
    }

    fun append(
        samples: FloatArray,
        sampleRate: Int,
    ) {
        if (sampleRate != PcmSampleRate) return
        audioFrames.trySend(samples.copyOf())
    }

    suspend fun finish(): String {
        audioFrames.close()
        withTimeoutOrNull(1_000L) { sendJob?.join() }
        if (partialTranscript.isBlank()) withTimeoutOrNull(settings.enhancementTimeoutSeconds * 1_000L) { finalTranscript.await() }
        return partialTranscript
    }

    suspend fun close() {
        audioFrames.close()
        sendJob?.cancelAndJoin()
        receiveJob?.cancelAndJoin()
        session?.close()
        client.close()
    }

    private suspend fun sendAudioFrames() {
        val socket = session ?: return
        for (samples in audioFrames) {
            val audio = Base64.encodeToString(samples.toPcm16Bytes(), Base64.NO_WRAP)
            runCatching {
                socket.send(
                    Frame.Text(
                        json.encodeToString(
                            buildJsonObject {
                                put("type", "input_audio_buffer.append")
                                put("audio", audio)
                            },
                        ),
                    ),
                )
            }
        }
    }

    private suspend fun receiveEvents() {
        val socket = session ?: return
        runCatching {
            for (frame in socket.incoming) {
                if (frame !is Frame.Text) continue
                val root = runCatching { json.parseToJsonElement(frame.readText()).jsonObject }.getOrNull() ?: continue
                val type = root["type"]?.jsonPrimitive?.contentOrNull.orEmpty()
                Log.d(LogTag, "event=$type")
                when (type) {
                    "conversation.item.input_audio_transcription.delta" -> {
                        val delta = root["delta"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        partialTranscript += delta
                        onDelta(partialTranscript)
                    }
                    "conversation.item.input_audio_transcription.completed" -> appendCompletedTranscript(root["transcript"]?.jsonPrimitive?.contentOrNull.orEmpty())
                    "input_audio_buffer.speech_stopped" -> Unit
                    "error" -> {
                        errorMessage = root.toString()
                        Log.e(LogTag, "error=$errorMessage")
                        if (!errorMessage.contains("already exists", ignoreCase = true)) finalTranscript.complete("")
                    }
                    else -> handleLooseTranscriptEvent(root, type)
                }
            }
        }.onFailure { failure ->
            if (failure is kotlinx.coroutines.CancellationException) return@onFailure
            errorMessage = failure.message.orEmpty().ifBlank { failure::class.java.simpleName }
            Log.e(LogTag, "receive failed", failure)
            if (!finalTranscript.isCompleted) finalTranscript.complete("")
        }
    }

    private fun appendCompletedTranscript(transcript: String) {
        val text = transcript.trim()
        if (text.isBlank()) return
        partialTranscript = listOf(partialTranscript.trim(), text).filter { it.isNotBlank() }.joinToString(" ")
        onDelta(partialTranscript)
        if (!finalTranscript.isCompleted) finalTranscript.complete(partialTranscript)
    }

    private fun handleLooseTranscriptEvent(
        root: kotlinx.serialization.json.JsonObject,
        type: String,
    ) {
        val delta = root["delta"]?.jsonPrimitive?.contentOrNull.orEmpty()
        if (delta.isNotBlank() && type.contains("transcription", ignoreCase = true)) {
            partialTranscript += delta
            onDelta(partialTranscript)
            return
        }
        val transcript = root["transcript"]?.jsonPrimitive?.contentOrNull.orEmpty()
        if (transcript.isNotBlank() && type.contains("transcription", ignoreCase = true)) {
            if (type.contains("completed", ignoreCase = true) || type.contains("done", ignoreCase = true)) {
                appendCompletedTranscript(transcript)
            } else {
                partialTranscript = transcript
                onDelta(partialTranscript)
            }
        }
    }

    fun lastError(): String = errorMessage
}

private fun realtimeUrl(
    settings: SpeechSettingsValues,
    apiKey: String,
): String {
    val base = OpenAiProviderEndpointResolver.activeBaseUrl(OpenAiProviderTask.Transcription, settings.realtimeTranscriptionBaseUrl).removeSuffix("/v1")
    val websocketBase = base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
    val model = settings.realtimeTranscriptionModel.urlEncoded()
    val language = settings.realtimeTranscriptionLanguage.trim().urlEncoded()
    val key = apiKey.takeIf { it.isNotBlank() }?.let { "&api_key=${it.urlEncoded()}" }.orEmpty()
    return "$websocketBase/v1/realtime?intent=transcription&model=$model&transcription_model=$model&language=$language$key"
}

private fun String.urlEncoded(): String = URLEncoder.encode(this, Charsets.UTF_8.name())

private fun FloatArray.toPcm16Bytes(): ByteArray {
    val bytes = ByteArray(size * 2)
    forEachIndexed { index, sample ->
        val value = (sample.coerceIn(-1f, 1f) * Short.MAX_VALUE).roundToInt().toShort()
        bytes[index * 2] = (value.toInt() and 0xff).toByte()
        bytes[index * 2 + 1] = ((value.toInt() shr 8) and 0xff).toByte()
    }
    return bytes
}
