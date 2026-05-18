package com.coder.pi

data class CoderSession(
    val baseUrl: String,
    val token: String,
    val user: CoderUser,
)

data class CoderUser(
    val id: String,
    val username: String,
    val email: String,
    val name: String?,
    val avatarUrl: String?,
)

data class CoderWorkspace(
    val id: String,
    val name: String,
    val templateName: String,
    val templateIcon: String?,
    val favorite: Boolean,
    val status: String,
    val transition: String,
    val agents: List<CoderWorkspaceAgent>,
) {
    val running: Boolean get() = status == "running" || agents.any { it.status == "connected" }
}

data class CoderWorkspaceAgent(
    val id: String,
    val name: String,
    val status: String,
)

data class CoderLocalWorkspaceState(
    val alias: String? = null,
    val pinned: Boolean = false,
    val iconUri: String? = null,
)

data class TmuxSession(
    val name: String,
    val windows: String,
    val attached: Boolean,
)

data class CoderReconnectToken(
    val id: String,
    val lastUsedAtMillis: Long,
)

data class CoderActiveTerminalMetadata(
    val baseUrl: String,
    val userId: String,
    val workspaceId: String,
    val workspaceName: String,
    val agentId: String,
    val agentName: String,
    val command: String,
    val reconnectId: String,
    val updatedAtMillis: Long,
    val preview: String = "",
    val detached: Boolean = false,
    val workspaceIconUrl: String? = null,
)
