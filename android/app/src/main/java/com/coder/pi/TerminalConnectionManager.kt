package com.coder.pi

import android.content.Context

object TerminalConnectionManager {
    private val sessions = mutableMapOf<String, RuntimeSession>()

    fun startHeadless(context: Context, launch: TerminalLaunchRequest, identity: TerminalIdentity, notificationContext: TerminalNotificationContext): CoderTerminalSession? {
        if (synchronized(sessions) { sessions.containsKey(notificationContext.terminalId) }) return synchronized(sessions) { sessions[notificationContext.terminalId]?.session }
        val endpoint = CoderHeadlessTerminalEndpoint(context.applicationContext, notificationContext)
        val proxy = TerminalEndpointProxy(endpoint)
        val session = CoderTerminalSession(CoderApi(launch.baseUrl, launch.token), proxy, launch.agentId, launch.reconnectId, launch.command)
        val shouldStart = synchronized(sessions) {
            if (sessions.containsKey(notificationContext.terminalId)) false else {
                sessions[notificationContext.terminalId] = RuntimeSession(proxy, endpoint, session, ownsEndpoint = true)
                true
            }
        }
        if (shouldStart) {
            session.start()
            return session
        }
        endpoint.dispose()
        return synchronized(sessions) { sessions[notificationContext.terminalId]?.session }
    }

    fun attachRenderer(terminalId: String, endpoint: CoderTerminalEndpoint, session: CoderTerminalSession) {
        if (endpoint is CoderTerminalView) endpoint.releaseEngineOwnershipToManager()
        val previous: RuntimeSession?
        val existingSameSession: RuntimeSession?
        synchronized(sessions) {
            val existing = sessions[terminalId]
            if (existing != null && existing.session === session) {
                sessions[terminalId] = existing.copy(endpoint = endpoint, ownsEndpoint = false)
                existingSameSession = existing
                previous = existing
            } else {
                val proxy = TerminalEndpointProxy(endpoint)
                sessions[terminalId] = RuntimeSession(proxy, endpoint, session, ownsEndpoint = false)
                existingSameSession = null
                previous = existing
            }
        }
        existingSameSession?.proxy?.attachEndpoint(endpoint)
        if (previous != null && previous.session !== session) previous.session.stop()
        if (previous != null && previous.ownsEndpoint && previous.endpoint is CoderHeadlessTerminalEndpoint) previous.endpoint.dispose()
    }

    fun startVisible(
        terminalId: String,
        launch: TerminalLaunchRequest,
        endpoint: CoderTerminalEndpoint,
        onStatusChanged: (String) -> Unit = {},
        onErrorChanged: (String?) -> Unit = {},
    ): CoderTerminalSession {
        attachRendererToExistingSession(terminalId, endpoint)?.let {
            it.updateCallbacks(onStatusChanged, onErrorChanged)
            return it
        }
        val proxy = TerminalEndpointProxy(endpoint)
        val session = CoderTerminalSession(CoderApi(launch.baseUrl, launch.token), proxy, launch.agentId, launch.reconnectId, launch.command, onStatusChanged, onErrorChanged)
        attachRenderer(terminalId, endpoint, session)
        session.start()
        return session
    }

    fun detachRenderer(terminalId: String) {
        val runtime = synchronized(sessions) { sessions[terminalId] } ?: return
        val visibleEndpoint = runtime.endpoint as? CoderTerminalView ?: run {
            runtime.proxy.detachEndpoint(runtime.endpoint)
            return
        }
        val notificationContext = visibleEndpoint.notificationContextSnapshot() ?: TerminalNotificationContext(terminalId = terminalId)
        val headlessEndpoint = CoderHeadlessTerminalEndpoint(visibleEndpoint.context.applicationContext, notificationContext, visibleEndpoint.terminalEngine, ownsEngine = true)
        runtime.proxy.attachEndpoint(headlessEndpoint)
        synchronized(sessions) {
            val current = sessions[terminalId]
            if (current === runtime) sessions[terminalId] = runtime.copy(endpoint = headlessEndpoint, ownsEndpoint = true)
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
            if (startHeadless(
                context,
                TerminalLaunchRequest(metadata.baseUrl, token, metadata.agentId, metadata.reconnectId, metadata.command, metadata.workspaceName, metadata.agentName, metadata.workspaceName, metadata.workspaceIconUrl),
                identity,
                TerminalNotificationContext(metadata.workspaceId, metadata.workspaceName, local.alias ?: metadata.workspaceName, "pi://terminal?id=${android.net.Uri.encode(terminalId)}", local.iconUri.orEmpty(), metadata.workspaceIconUrl.orEmpty(), terminalId),
            ) != null) {
            started++
            }
        }
        return started
    }

    fun stop(terminalId: String) {
        val runtime = synchronized(sessions) { sessions.remove(terminalId) } ?: return
        runtime.session.stop()
        if (runtime.ownsEndpoint && runtime.endpoint is CoderHeadlessTerminalEndpoint) runtime.endpoint.dispose()
        if (runtime.endpoint is CoderTerminalView) runtime.endpoint.disposeManagerOwnedEngine()
    }

    fun stopAll() {
        val ids = synchronized(sessions) { sessions.keys.toList() }
        ids.forEach(::stop)
    }

    fun sendInput(terminalId: String, text: String): Boolean {
        val runtime = synchronized(sessions) { sessions[terminalId] } ?: return false
        runtime.proxy.sendInput((text.take(4096) + "\r").toByteArray(Charsets.UTF_8))
        return true
    }

    fun sendBytes(terminalId: String, bytes: ByteArray): Boolean {
        val runtime = synchronized(sessions) { sessions[terminalId] } ?: return false
        runtime.proxy.sendInput(bytes)
        return true
    }

    fun engineFor(terminalId: String): TerminalEngine? {
        val runtime = synchronized(sessions) { sessions[terminalId] } ?: return null
        return when (val endpoint = runtime.proxy.currentEndpoint()) {
            is CoderHeadlessTerminalEndpoint -> endpoint.engine
            is CoderTerminalView -> endpoint.terminalEngine
            else -> null
        }
    }

    fun agentStatus(terminalId: String): TerminalAgentStatusPresentation? {
        val runtime = synchronized(sessions) { sessions[terminalId] } ?: return null
        return when (val endpoint = runtime.proxy.currentEndpoint()) {
            is CoderHeadlessTerminalEndpoint -> endpoint.agentStateSnapshot().statusPresentation()
            is CoderTerminalView -> endpoint.agentStateSnapshot().statusPresentation()
            else -> null
        }
    }

    fun hasRuntime(terminalId: String): Boolean = synchronized(sessions) { sessions.containsKey(terminalId) }

    private fun attachRendererToExistingSession(terminalId: String, endpoint: CoderTerminalEndpoint): CoderTerminalSession? {
        if (endpoint is CoderTerminalView) endpoint.releaseEngineOwnershipToManager()
        val existing = synchronized(sessions) {
            val existing = sessions[terminalId] ?: return null
            sessions[terminalId] = existing.copy(endpoint = endpoint, ownsEndpoint = false)
            existing
        }
        val previousEndpoint = existing.proxy.attachEndpoint(endpoint)
        if (previousEndpoint is CoderHeadlessTerminalEndpoint) previousEndpoint.dispose(disposeEngine = false)
        return existing.session
    }

    private data class RuntimeSession(val proxy: TerminalEndpointProxy, val endpoint: CoderTerminalEndpoint, val session: CoderTerminalSession, val ownsEndpoint: Boolean)
}
