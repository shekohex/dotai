package com.coder.pi

import android.content.Context

object TerminalConnectionManager {
    private val sessions = mutableMapOf<String, RuntimeSession>()

    fun startHeadless(context: Context, launch: TerminalLaunchRequest, identity: TerminalIdentity, notificationContext: TerminalNotificationContext) {
        synchronized(sessions) {
            if (sessions.containsKey(notificationContext.terminalId)) return
            val endpoint = CoderHeadlessTerminalEndpoint(context.applicationContext, notificationContext)
            val session = CoderTerminalSession(
                CoderApi(launch.baseUrl, launch.token),
                endpoint,
                launch.agentId,
                launch.reconnectId,
                launch.command,
            )
            sessions[notificationContext.terminalId] = RuntimeSession(endpoint, session, ownsEndpoint = true)
            session.start()
        }
    }

    fun registerVisible(terminalId: String, endpoint: CoderTerminalEndpoint, session: CoderTerminalSession) {
        val previous = synchronized(sessions) {
            val existing = sessions[terminalId]
            sessions[terminalId] = RuntimeSession(endpoint, session, ownsEndpoint = false)
            existing
        }
        if (previous != null && previous.ownsEndpoint) {
            previous.session.stop()
            if (previous.endpoint is CoderHeadlessTerminalEndpoint) previous.endpoint.dispose()
        }
    }

    fun startSavedHeadless(context: Context): Int {
        val store = CoderSessionStore(context.applicationContext)
        val savedSession = store.loadSession() ?: return 0
        val baseUrl = savedSession.first
        val token = savedSession.second
        var started = 0
        store.activeTerminalsForBaseUrl(baseUrl).forEach { metadata ->
            val identity = TerminalIdentity(metadata.baseUrl, metadata.userId, metadata.workspaceId, metadata.agentId, metadata.command)
            val terminalId = terminalSessionKey(identity)
            val local = store.workspaceState(metadata.baseUrl, metadata.userId, metadata.workspaceId)
            startHeadless(
                context,
                TerminalLaunchRequest(metadata.baseUrl, token, metadata.agentId, metadata.reconnectId, metadata.command, metadata.workspaceName, metadata.agentName, metadata.workspaceName, metadata.workspaceIconUrl),
                identity,
                TerminalNotificationContext(metadata.workspaceId, metadata.workspaceName, local.alias ?: metadata.workspaceName, "pi://terminal?id=${android.net.Uri.encode(terminalId)}", local.iconUri.orEmpty(), metadata.workspaceIconUrl.orEmpty(), terminalId),
            )
            started++
        }
        return started
    }

    fun stop(terminalId: String) {
        val runtime = synchronized(sessions) { sessions.remove(terminalId) } ?: return
        runtime.session.stop()
        if (runtime.ownsEndpoint && runtime.endpoint is CoderHeadlessTerminalEndpoint) runtime.endpoint.dispose()
    }

    fun stopAll() {
        val ids = synchronized(sessions) { sessions.keys.toList() }
        ids.forEach(::stop)
    }

    fun sendInput(terminalId: String, text: String): Boolean {
        val runtime = synchronized(sessions) { sessions[terminalId] } ?: return false
        runtime.endpoint.sendInput((text.take(4096) + "\r").toByteArray(Charsets.UTF_8))
        return true
    }

    private data class RuntimeSession(val endpoint: CoderTerminalEndpoint, val session: CoderTerminalSession, val ownsEndpoint: Boolean)
}
