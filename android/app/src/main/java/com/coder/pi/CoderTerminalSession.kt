package com.coder.pi

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class CoderTerminalSession(
    private val api: CoderApi,
    private val terminalView: CoderTerminalView,
    private val agentId: String,
    private val reconnectId: String,
    private val command: String,
    private val onStatusChanged: (String) -> Unit = {},
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var socket: CoderTerminalSocket? = null
    private var stopped = false
    private var reconnectAttempts = 0

    private fun updateStatus(status: String) {
        mainScope.launch { onStatusChanged(status) }
    }

    fun start() {
        stopped = false
        reconnectAttempts = 0
        updateStatus(TerminalConnectionStatus.Connecting.wireName)
        terminalView.feedRemoteOutput("\u001bcconnecting to coder workspace\r\n".toByteArray())
        connect(false)
    }

    private fun connect(reconnecting: Boolean) {
        scope.launch {
            runCatching {
                if (reconnecting) updateStatus(TerminalConnectionStatus.Reconnecting.wireName)
                val initialWidth = terminalView.terminalColumns().takeIf { it > 0 } ?: 80
                val initialHeight = terminalView.terminalRows().takeIf { it > 0 } ?: 24
                val terminalSocket = CoderTerminalSocket(api.connectTerminal(agentId, reconnectId, command, initialWidth, initialHeight))
                socket = terminalSocket
                terminalView.attachRemote { bytes -> terminalSocket.send(bytes) }
                terminalView.onTerminalSizeChanged = { width, height -> terminalSocket.resize(width, height) }
                terminalSocket.onBytes = { terminalView.feedRemoteOutput(it) }
                terminalSocket.onClosed = { handleClosed() }
                terminalSocket.start()
                terminalSocket.resize(initialWidth, initialHeight)
                reconnectAttempts = 0
                updateStatus(TerminalConnectionStatus.Connected.wireName)
                terminalView.feedRemoteOutput((if (reconnecting) "\r\nreconnected to coder workspace\r\n" else "\u001bcconnected to coder workspace\r\n").toByteArray())
            }.onFailure {
                if (reconnecting && reconnectAttempts < 3 && !stopped) {
                    scheduleReconnect()
                } else {
                    updateStatus(TerminalConnectionStatus.Failed.wireName)
                    terminalView.feedRemoteOutput("\r\nconnection failed: ${safeTerminalError(it)}\r\n".toByteArray())
                }
            }
        }
    }

    private fun handleClosed() {
        socket = null
        terminalView.detachRemote()
        if (stopped) {
            updateStatus(TerminalConnectionStatus.Disconnected.wireName)
            return
        }
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        reconnectAttempts += 1
        if (reconnectAttempts > 3) {
            updateStatus(TerminalConnectionStatus.Disconnected.wireName)
            terminalView.feedRemoteOutput("\r\nconnection disconnected\r\n".toByteArray())
            return
        }
        updateStatus(TerminalConnectionStatus.Reconnecting.wireName)
        terminalView.feedRemoteOutput("\r\nreconnecting to coder workspace\r\n".toByteArray())
        scope.launch {
            delay((reconnectAttempts * 750L).coerceAtMost(2500L))
            if (!stopped) connect(true)
        }
    }

    fun stop() {
        stopped = true
        terminalView.detachRemote()
        terminalView.onTerminalSizeChanged = null
        scope.launch { socket?.close() }
        updateStatus(TerminalConnectionStatus.Disconnected.wireName)
        socket = null
    }

    companion object {
        fun safeTerminalError(error: Throwable): String {
            val message = error.message.orEmpty()
                .replace(Regex("Coder-Session-Token=[^\\s&]+", RegexOption.IGNORE_CASE), "Coder-Session-Token=<hidden>")
                .replace(Regex("(token|reconnect|command)=([^\\s&]+)", RegexOption.IGNORE_CASE), "$1=<hidden>")
                .replace(Regex("https?://[^\\s]+"), "<url>")
                .replace(Regex("wss?://[^\\s]+"), "<url>")
            return message.ifBlank { error::class.simpleName ?: "unknown error" }.take(160)
        }
    }
}
