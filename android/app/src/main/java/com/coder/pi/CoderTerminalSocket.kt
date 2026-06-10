package com.coder.pi

import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readBytes
import io.sentry.SentryLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.concurrent.atomic.AtomicBoolean

class CoderTerminalSocket(
    private val session: DefaultClientWebSocketSession,
) {
    var onBytes: ((ByteArray) -> Unit)? = null
    var onClosed: (() -> Unit)? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var receiveJob: Job? = null
    private val closing = AtomicBoolean(false)
    private val closedNotified = AtomicBoolean(false)

    fun start() {
        SentryBreadcrumbs.terminal("socket receive loop start")
        receiveJob =
            scope.launch {
                runCatching {
                    for (frame in session.incoming) {
                        when (frame) {
                            is Frame.Binary -> onBytes?.invoke(frame.readBytes())
                            is Frame.Text -> onBytes?.invoke(frame.data)
                            is Frame.Close -> break
                            else -> Unit
                        }
                    }
                }.onFailure {
                    if (!closing.get()) {
                        SentryBreadcrumbs.terminal("socket receive failed", mapOf("error" to CoderTerminalSession.safeTerminalError(it)), SentryLevel.ERROR)
                        SentryAppLogger.error("terminal socket receive failed", throwable = it)
                    }
                }
                if (!closing.get() && closedNotified.compareAndSet(false, true)) onClosed?.invoke()
            }
    }

    fun send(bytes: ByteArray) {
        val payload = Json.encodeToString(mapOf("data" to bytes.toString(Charsets.UTF_8))).toByteArray()
        scope.launch { session.send(Frame.Binary(true, payload)) }
    }

    fun resize(
        width: Int,
        height: Int,
    ) {
        val payload = Json.encodeToString(mapOf("width" to width, "height" to height)).toByteArray()
        scope.launch { session.send(Frame.Binary(true, payload)) }
    }

    suspend fun close() {
        if (!closing.compareAndSet(false, true)) return
        SentryBreadcrumbs.terminal("socket close requested")
        receiveJob?.cancel()
        session.close()
        scope.cancel()
    }
}
