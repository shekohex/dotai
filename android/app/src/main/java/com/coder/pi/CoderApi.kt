package com.coder.pi

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class CoderApi(private val baseUrl: String, private val token: String) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val client = HttpClient(CIO) {
        install(ContentNegotiation) { json(json) }
        install(WebSockets)
    }

    suspend fun me(): CoderUser = client.get(url("/api/v2/users/me")) { auth() }.body<CoderUserDto>().toModel()

    suspend fun workspaces(): List<CoderWorkspace> = client.get(url("/api/v2/workspaces")) {
        auth()
        parameter("limit", 100)
    }.body<WorkspacesResponseDto>().workspaces.map { it.toModel() }

    suspend fun favoriteWorkspace(workspaceId: String, favorite: Boolean) {
        if (favorite) client.put(url("/api/v2/workspaces/$workspaceId/favorite")) { auth() }
        else client.delete(url("/api/v2/workspaces/$workspaceId/favorite")) { auth() }
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

    suspend fun tmuxSessions(agentId: String, reconnectId: String): List<TmuxSession> {
        val output = runProcess(agentId, reconnectId, "tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}'", 5_000)
        return output.lines().mapNotNull { line ->
            val parts = line.split('|')
            if (parts.size < 3 || parts[0].isBlank()) null else TmuxSession(parts[0], parts[1], parts[2] == "1")
        }
    }

    suspend fun runProcess(agentId: String, reconnectId: String, command: String, timeoutMillis: Long): String = withContext(Dispatchers.IO) {
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

    suspend fun connectTerminal(agentId: String, reconnectId: String, command: String, width: Int, height: Int, container: String? = null, containerUser: String? = null, backendType: String? = null): DefaultClientWebSocketSession {
        return client.webSocketSession {
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
    }

    private suspend fun createWorkspaceBuild(workspaceId: String, transition: String) {
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
private data class WorkspacesResponseDto(val workspaces: List<CoderWorkspaceDto> = emptyList())

@Serializable
private data class CoderWorkspaceDto(
    val id: String,
    val name: String,
    @SerialName("template_name") val templateName: String = "",
    @SerialName("template_icon") val templateIcon: String? = null,
    val favorite: Boolean = false,
    @SerialName("latest_build") val latestBuild: CoderWorkspaceBuildDto,
) {
    fun toModel(): CoderWorkspace {
        val agents = latestBuild.resources.flatMap { it.agents }.map { CoderWorkspaceAgent(it.id, it.name, it.status) }
        return CoderWorkspace(id, name, templateName, templateIcon, favorite, latestBuild.status, latestBuild.transition, agents)
    }
}

@Serializable
private data class CoderWorkspaceBuildDto(
    val status: String = "",
    val transition: String = "",
    val resources: List<CoderWorkspaceResourceDto> = emptyList(),
)

@Serializable
private data class CoderWorkspaceResourceDto(val agents: List<CoderWorkspaceAgentDto> = emptyList())

@Serializable
private data class CoderWorkspaceAgentDto(val id: String, val name: String, val status: String = "")

@Serializable
private data class WorkspaceBuildRequestDto(val transition: String)
