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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.math.roundToInt

class RealtimeSpeechTranscriptionSession(
    private val settings: SpeechSettingsValues,
    private val apiKey: String,
    private val onDelta: (String) -> Unit,
) {
    private companion object {
        const val PcmSampleRate = 24_000
    }

    private val json =
        Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }
    private val client = HttpClient(OkHttp) { install(WebSockets) }
    private val scope = CoroutineScope(Dispatchers.IO)
    private val audioFrames = Channel<FloatArray>(capacity = 32, onBufferOverflow = BufferOverflow.DROP_LATEST)
    private var finalTranscript = CompletableDeferred<String>()
    private var receiveJob: Job? = null
    private var sendJob: Job? = null
    private var session: io.ktor.client.plugins.websocket.DefaultClientWebSocketSession? = null
    private val connectionMutex = Mutex()

    @Volatile private var closed = false

    @Volatile private var reconnectAttempt = 0
    private val eventHandler = RealtimeTranscriptionEventHandler(onDelta)

    suspend fun start() {
        ensureConnected()
        if (sendJob == null) sendJob = scope.launch { sendAudioFrames() }
    }

    fun beginUtterance() {
        finalTranscript = CompletableDeferred()
        eventHandler.reset()
    }

    fun append(
        samples: FloatArray,
        sampleRate: Int,
    ) {
        if (sampleRate != PcmSampleRate) return
        audioFrames.trySend(samples.copyOf())
    }

    suspend fun finish(): String {
        if (eventHandler.transcript.isBlank()) withTimeoutOrNull(settings.enhancementTimeoutSeconds * 1_000L) { finalTranscript.await() }
        return eventHandler.transcript
    }

    suspend fun close() {
        closed = true
        audioFrames.close()
        sendJob?.cancelAndJoin()
        receiveJob?.cancelAndJoin()
        session?.close()
        client.close()
    }

    private suspend fun sendAudioFrames() {
        for (samples in audioFrames) {
            val audio = Base64.encodeToString(samples.toPcm16Bytes(), Base64.NO_WRAP)
            runCatching {
                val socket = ensureConnected() ?: return@runCatching
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
            }.onFailure { failure ->
                if (failure !is kotlinx.coroutines.CancellationException) {
                    Log.w(RealtimeTranscriptionEventHandler.LogTag, "send failed; reconnecting", failure)
                    disconnectSocket()
                }
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
                Log.d(RealtimeTranscriptionEventHandler.LogTag, "event=$type")
                eventHandler.handle(root, finalTranscript)
            }
        }.onFailure { failure ->
            if (failure is kotlinx.coroutines.CancellationException) return@onFailure
            Log.e(RealtimeTranscriptionEventHandler.LogTag, "receive failed", failure)
            markDisconnected()
            if (!finalTranscript.isCompleted) finalTranscript.complete("")
        }
    }

    private suspend fun ensureConnected(): io.ktor.client.plugins.websocket.DefaultClientWebSocketSession? =
        connectionMutex.withLock {
            if (closed) return@withLock null
            val currentSession = session
            if (currentSession != null) return@withLock currentSession
            val delayMillis = reconnectDelayMillis(reconnectAttempt)
            if (reconnectAttempt > 0) delay(delayMillis)
            val connectedSession =
                runCatching {
                    client.webSocketSession(RealtimeTranscriptionUrlBuilder.url(settings, apiKey)) {
                        if (apiKey.isNotBlank()) header(HttpHeaders.Authorization, "Bearer $apiKey")
                        header("OpenAI-Beta", "realtime=v1")
                    }
                }.onFailure { failure ->
                    reconnectAttempt++
                    Log.e(RealtimeTranscriptionEventHandler.LogTag, "connect failed", failure)
                }.getOrNull() ?: return@withLock null
            reconnectAttempt = 0
            session = connectedSession
            receiveJob?.cancelAndJoin()
            receiveJob = scope.launch { receiveEvents() }
            connectedSession
        }

    private suspend fun disconnectSocket() {
        connectionMutex.withLock {
            session?.close()
            session = null
            receiveJob?.cancelAndJoin()
            receiveJob = null
        }
    }

    private suspend fun markDisconnected() {
        connectionMutex.withLock {
            session = null
            receiveJob = null
            reconnectAttempt++
        }
    }

    private fun reconnectDelayMillis(attempt: Int): Long =
        when {
            attempt <= 0 -> 0L
            attempt == 1 -> 250L
            attempt == 2 -> 500L
            attempt == 3 -> 1_000L
            else -> 2_000L
        }

    fun lastError(): String = eventHandler.lastError
}

private fun FloatArray.toPcm16Bytes(): ByteArray {
    val bytes = ByteArray(size * 2)
    forEachIndexed { index, sample ->
        val value = (sample.coerceIn(-1f, 1f) * Short.MAX_VALUE).roundToInt().toShort()
        bytes[index * 2] = (value.toInt() and 0xff).toByte()
        bytes[index * 2 + 1] = ((value.toInt() shr 8) and 0xff).toByte()
    }
    return bytes
}
