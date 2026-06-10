package com.coder.pi

import io.sentry.SentryLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class CoderTerminalSession(
    private val api: CoderApi,
    private val terminalEndpoint: CoderTerminalEndpoint,
    private val agentId: String,
    private val reconnectId: String,
    private val command: String,
    private var onStatusChanged: (String) -> Unit = {},
    private var onErrorChanged: (String?) -> Unit = {},
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    @Volatile private var socket: CoderTerminalSocket? = null

    @Volatile private var stopped = false
    private var reconnectAttempts = 0

    @Volatile private var reconnectScheduled = false

    @Volatile private var networkUnavailable = false

    private val maxReconnectAttempts = Int.MAX_VALUE

    fun updateCallbacks(
        onStatusChanged: (String) -> Unit,
        onErrorChanged: (String?) -> Unit,
    ) {
        this.onStatusChanged = onStatusChanged
        this.onErrorChanged = onErrorChanged
    }

    private fun updateStatus(status: String) {
        mainScope.launch { onStatusChanged(status) }
    }

    private fun updateError(error: String?) {
        mainScope.launch { onErrorChanged(error) }
    }

    fun start() {
        SentryBreadcrumbs.terminal("session start", mapOf("agentId" to agentId, "reconnectId" to reconnectId, "command" to command.take(64)))
        stopped = false
        reconnectAttempts = 0
        updateError(null)
        updateStatus(TerminalConnectionStatus.Connecting.wireName)
        connect(false)
    }

    private fun connect(reconnecting: Boolean) {
        scope.launch {
            runCatching {
                if (reconnecting) updateStatus(TerminalConnectionStatus.Reconnecting.wireName)
                val initialWidth = terminalEndpoint.terminalColumns().takeIf { it > 0 } ?: 80
                val initialHeight = terminalEndpoint.terminalRows().takeIf { it > 0 } ?: 24
                SentryBreadcrumbs.terminal("socket connecting", mapOf("reconnecting" to reconnecting, "columns" to initialWidth, "rows" to initialHeight, "attempt" to reconnectAttempts))
                val terminalSocket = CoderTerminalSocket(api.connectTerminal(agentId, reconnectId, command, initialWidth, initialHeight))
                socket = terminalSocket
                terminalEndpoint.attachRemote { bytes -> terminalSocket.send(bytes) }
                terminalEndpoint.onTerminalSizeChanged = { width, height -> terminalSocket.resize(width, height) }
                terminalSocket.onBytes = { terminalEndpoint.feedRemoteOutput(it) }
                terminalSocket.onClosed = { handleClosed() }
                terminalSocket.start()
                terminalSocket.resize(initialWidth, initialHeight)
                reconnectAttempts = 0
                reconnectScheduled = false
                updateError(null)
                updateStatus(TerminalConnectionStatus.Connected.wireName)
                SentryBreadcrumbs.terminal("socket connected", mapOf("columns" to initialWidth, "rows" to initialHeight))
            }.onFailure {
                SentryBreadcrumbs.terminal("socket connect failed", mapOf("reconnecting" to reconnecting, "attempt" to reconnectAttempts, "error" to safeTerminalError(it)), SentryLevel.ERROR)
                SentryAppLogger.error("terminal socket connect failed", mapOf("agentId" to agentId, "attempt" to reconnectAttempts, "reconnecting" to reconnecting), it)
                if (!stopped) {
                    scheduleReconnect()
                } else {
                    val safeError = safeTerminalError(it)
                    updateError(safeError)
                    updateStatus(TerminalConnectionStatus.Failed.wireName)
                }
            }
        }
    }

    private fun handleClosed() {
        SentryBreadcrumbs.terminal("socket closed", mapOf("stopped" to stopped, "attempt" to reconnectAttempts))
        socket = null
        terminalEndpoint.detachRemote()
        if (stopped) {
            updateStatus(TerminalConnectionStatus.Disconnected.wireName)
            return
        }
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (reconnectScheduled) return
        reconnectScheduled = true
        reconnectAttempts += 1
        if (reconnectAttempts > maxReconnectAttempts) {
            reconnectScheduled = false
            updateError("Connection closed after reconnect attempts")
            updateStatus(TerminalConnectionStatus.Disconnected.wireName)
            return
        }
        updateStatus(TerminalConnectionStatus.Reconnecting.wireName)
        val delayMillis = (500L shl (reconnectAttempts - 1).coerceAtMost(4)).coerceAtMost(8000L)
        SentryBreadcrumbs.terminal("reconnect scheduled", mapOf("attempt" to reconnectAttempts, "delayMillis" to delayMillis, "networkUnavailable" to networkUnavailable))
        updateError("${if (networkUnavailable) "Network unavailable · " else ""}reconnecting in ${delayMillis / 1000.0}s · attempt $reconnectAttempts")
        scope.launch {
            delay(delayMillis)
            reconnectScheduled = false
            if (!stopped && !networkUnavailable) connect(true)
        }
    }

    fun networkLost() {
        if (stopped) return
        SentryBreadcrumbs.terminal("network lost")
        networkUnavailable = true
        val terminalSocket = socket
        socket = null
        terminalEndpoint.detachRemote()
        updateError("Network unavailable")
        updateStatus(TerminalConnectionStatus.Reconnecting.wireName)
        scope.launch { terminalSocket?.close() }
    }

    fun networkAvailable() {
        if (stopped || socket != null) return
        SentryBreadcrumbs.terminal("network available")
        networkUnavailable = false
        updateError("Network available, reconnecting")
        reconnectScheduled = false
        if (!reconnectScheduled) connect(true)
    }

    fun stop() {
        SentryBreadcrumbs.terminal("session stop")
        stopped = true
        networkUnavailable = false
        reconnectScheduled = false
        terminalEndpoint.detachRemote()
        terminalEndpoint.onTerminalSizeChanged = null
        val terminalSocket = socket
        socket = null
        scope.launch {
            terminalSocket?.close()
            api.close()
            scope.cancel()
        }
        mainScope.launch {
            onErrorChanged(null)
            onStatusChanged(TerminalConnectionStatus.Disconnected.wireName)
            mainScope.cancel()
        }
    }

    companion object {
        fun safeTerminalError(error: Throwable): String {
            val message =
                error.message
                    .orEmpty()
                    .replace(Regex("Coder-Session-Token=[^\\s&]+", RegexOption.IGNORE_CASE), "Coder-Session-Token=<hidden>")
                    .replace(Regex("(token|reconnect|command)=([^\\s&]+)", RegexOption.IGNORE_CASE), "$1=<hidden>")
                    .replace(Regex("https?://[^\\s]+"), "<url>")
                    .replace(Regex("wss?://[^\\s]+"), "<url>")
            return message.ifBlank { error::class.simpleName ?: "unknown error" }.take(160)
        }
    }
}
