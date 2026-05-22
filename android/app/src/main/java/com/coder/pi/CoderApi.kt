package com.coder.pi

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.request.url
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Protocol
import java.io.Closeable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class CoderApi(
    private val baseUrl: String,
    private val token: String,
    private val onClose: () -> Unit = {},
) : Closeable {
    private val json =
        Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }
    private val client =
        HttpClient(OkHttp) {
            engine { config { protocols(listOf(Protocol.HTTP_3, Protocol.HTTP_2, Protocol.HTTP_1_1)) } }
            install(ContentNegotiation) { json(json) }
            install(WebSockets)
        }
    private val closed = AtomicBoolean(false)

    suspend fun me(): CoderUser = client.get(url("/api/v2/users/me")) { auth() }.body<CoderUserDto>().toModel()

    suspend fun workspaces(): List<CoderWorkspace> =
        client
            .get(url("/api/v2/workspaces")) {
                auth()
                parameter("limit", 100)
            }.body<WorkspacesResponseDto>()
            .workspaces
            .map { it.toModel() }

    suspend fun favoriteWorkspace(
        workspaceId: String,
        favorite: Boolean,
    ) {
        if (favorite) {
            client.put(url("/api/v2/workspaces/$workspaceId/favorite")) { auth() }
        } else {
            client.delete(url("/api/v2/workspaces/$workspaceId/favorite")) { auth() }
        }
    }

    suspend fun startWorkspace(workspaceId: String) {
        createWorkspaceBuild(workspaceId, "start")
    }

    suspend fun stopWorkspace(workspaceId: String) {
        createWorkspaceBuild(workspaceId, "stop")
    }

    suspend fun restartWorkspace(workspaceId: String) {
        createWorkspaceBuild(workspaceId, "stop")
        createWorkspaceBuild(workspaceId, "start")
    }

    suspend fun tmuxSessions(
        agentId: String,
        reconnectId: String,
    ): List<TmuxSession> {
        val output = runProcess(agentId, reconnectId, "tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}'", 5_000)
        return output.lines().mapNotNull { line ->
            val parts = line.split('|')
            if (parts.size < 3 || parts[0].isBlank()) null else TmuxSession(parts[0], parts[1], parts[2] == "1")
        }
    }

    suspend fun runProcess(
        agentId: String,
        reconnectId: String,
        command: String,
        timeoutMillis: Long,
    ): String =
        withContext(Dispatchers.IO) {
            val output = StringBuilder()
            val latch = CountDownLatch(1)
            val terminal = CoderTerminalSocket(connectTerminal(agentId, reconnectId, "bash -lc ${shellQuote(command)}", 100, 24))
            terminal.onBytes = { output.append(it.toString(Charsets.UTF_8)) }
            terminal.onClosed = { latch.countDown() }
            terminal.start()
            latch.await(timeoutMillis, TimeUnit.MILLISECONDS)
            terminal.close()
            output.toString()
        }

    suspend fun connectTerminal(
        agentId: String,
        reconnectId: String,
        command: String,
        width: Int,
        height: Int,
        container: String? = null,
        containerUser: String? = null,
        backendType: String? = null,
    ): DefaultClientWebSocketSession =
        client.webSocketSession {
            url(wsUrl("/api/v2/workspaceagents/$agentId/pty"))
            header(sessionTokenHeader, token)
            parameter("reconnect", reconnectId)
            parameter("width", width)
            parameter("height", height)
            parameter("command", command)
            container?.let { parameter("container", it) }
            if (container != null && containerUser != null) parameter("container_user", containerUser)
            backendType?.let { parameter("backend_type", it) }
        }

    private suspend fun createWorkspaceBuild(
        workspaceId: String,
        transition: String,
    ) {
        client.post(url("/api/v2/workspaces/$workspaceId/builds")) {
            auth()
            contentType(ContentType.Application.Json)
            setBody(WorkspaceBuildRequestDto(transition))
        }
    }

    private fun io.ktor.client.request.HttpRequestBuilder.auth() {
        header(sessionTokenHeader, token)
        header(HttpHeaders.Accept, ContentType.Application.Json)
    }

    private fun url(path: String) = baseUrl.trimEnd('/') + path

    private fun wsUrl(path: String) = baseUrl.trimEnd('/').replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + path

    private fun shellQuote(value: String) = "'" + value.replace("'", "'\\''") + "'"

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        client.close()
        onClose()
    }

    companion object {
        private const val sessionTokenHeader = "Coder-Session-Token"
    }
}

@Serializable
private data class CoderUserDto(
    val id: String,
    val username: String,
    val email: String = "",
    val name: String? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
) {
    fun toModel() = CoderUser(id, username, email, name, avatarUrl)
}

@Serializable
private data class WorkspacesResponseDto(
    val workspaces: List<CoderWorkspaceDto> = emptyList(),
)

@Serializable
private data class CoderWorkspaceDto(
    val id: String,
    val name: String,
    @SerialName("template_name") val templateName: String = "",
    @SerialName("template_icon") val templateIcon: String? = null,
    val favorite: Boolean = false,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("last_used_at") val lastUsedAt: String? = null,
    val health: CoderWorkspaceHealthDto? = null,
    @SerialName("latest_app_status") val latestAppStatus: CoderWorkspaceAppStatusDto? = null,
    @SerialName("latest_build") val latestBuild: CoderWorkspaceBuildDto,
) {
    fun toModel(): CoderWorkspace {
        val resources = latestBuild.resources.map { it.toModel() }
        val agents = resources.flatMap { it.agents }
        return CoderWorkspace(id, name, templateName, templateIcon, favorite, latestBuild.status, latestBuild.transition, agents, createdAt, updatedAt, latestBuild.startedAt, lastUsedAt, health?.toModel(), latestAppStatus?.toModel(), latestBuild.dailyCost, latestBuild.deadline, resources)
    }
}

@Serializable
private data class CoderWorkspaceHealthDto(
    @SerialName("healthy") val healthy: Boolean = true,
    @SerialName("failing_agents") val failingAgents: List<String> = emptyList(),
) {
    fun toModel(): CoderWorkspaceHealth = CoderWorkspaceHealth(healthy, failingAgents.size)
}

@Serializable
private data class CoderWorkspaceAppStatusDto(
    val state: String = "",
    val message: String = "",
    @SerialName("needs_user_attention") val needsUserAttention: Boolean = false,
) {
    fun toModel(): CoderWorkspaceAppStatus = CoderWorkspaceAppStatus(state, message, needsUserAttention)
}

@Serializable
private data class CoderWorkspaceBuildDto(
    val status: String = "",
    val transition: String = "",
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("daily_cost") val dailyCost: Int = 0,
    val deadline: String? = null,
    val resources: List<CoderWorkspaceResourceDto> = emptyList(),
)

@Serializable
private data class CoderWorkspaceResourceDto(
    val name: String = "",
    val type: String = "",
    @SerialName("daily_cost") val dailyCost: Int = 0,
    val metadata: List<CoderWorkspaceMetadataDto> = emptyList(),
    val agents: List<CoderWorkspaceAgentDto> = emptyList(),
) {
    fun toModel(): CoderWorkspaceResource = CoderWorkspaceResource(name, type, dailyCost, metadata.filterNot { it.sensitive }.mapNotNull { it.toModel() }, agents.map { it.toModel() })
}

@Serializable
private data class CoderWorkspaceMetadataDto(
    val key: String = "",
    val value: String = "",
    val sensitive: Boolean = false,
) {
    fun toModel(): CoderWorkspaceMetadata? = if (key.isBlank() || value.isBlank()) null else CoderWorkspaceMetadata(key, value)
}

@Serializable
private data class CoderWorkspaceAgentDto(
    val id: String,
    val name: String,
    val status: String = "",
    @SerialName("lifecycle_state") val lifecycleState: String = "",
    val health: CoderAgentHealthDto? = null,
    @SerialName("operating_system") val operatingSystem: String = "",
    val architecture: String = "",
    val version: String = "",
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("first_connected_at") val firstConnectedAt: String? = null,
    @SerialName("last_connected_at") val lastConnectedAt: String? = null,
    val latency: Map<String, CoderAgentLatencyDto> = emptyMap(),
    val apps: List<kotlinx.serialization.json.JsonElement> = emptyList(),
    val scripts: List<kotlinx.serialization.json.JsonElement> = emptyList(),
) {
    fun toModel(): CoderWorkspaceAgent = CoderWorkspaceAgent(id, name, status, lifecycleState, health?.toModel(), operatingSystem, architecture, version, startedAt, firstConnectedAt, lastConnectedAt, latency.values.minOfOrNull { it.latencyMilliseconds }, apps.size, scripts.size)
}

@Serializable
private data class CoderAgentHealthDto(
    val healthy: Boolean = true,
    val reason: String = "",
) {
    fun toModel(): CoderAgentHealth = CoderAgentHealth(healthy, reason)
}

@Serializable
private data class CoderAgentLatencyDto(
    @SerialName("latency_ms") val latencyMilliseconds: Double = 0.0,
)

@Serializable
private data class WorkspaceBuildRequestDto(
    val transition: String,
)
