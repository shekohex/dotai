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
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val startedAt: String? = null,
    val lastUsedAt: String? = null,
    val health: CoderWorkspaceHealth? = null,
    val latestAppStatus: CoderWorkspaceAppStatus? = null,
    val dailyCost: Int = 0,
    val deadline: String? = null,
    val resources: List<CoderWorkspaceResource> = emptyList(),
) {
    val running: Boolean get() = status == "running" || agents.any { it.status == "connected" }
}

data class CoderWorkspaceResource(
    val name: String,
    val type: String,
    val dailyCost: Int,
    val metadata: List<CoderWorkspaceMetadata>,
    val agents: List<CoderWorkspaceAgent>,
)

data class CoderWorkspaceHealth(
    val healthy: Boolean,
    val failingAgents: Int,
)

data class CoderWorkspaceAppStatus(
    val state: String,
    val message: String,
    val needsUserAttention: Boolean,
)

data class CoderWorkspaceMetadata(
    val key: String,
    val value: String,
)

data class CoderWorkspaceAgent(
    val id: String,
    val name: String,
    val status: String,
    val lifecycleState: String = "",
    val health: CoderAgentHealth? = null,
    val operatingSystem: String = "",
    val architecture: String = "",
    val version: String = "",
    val startedAt: String? = null,
    val firstConnectedAt: String? = null,
    val lastConnectedAt: String? = null,
    val latencyMilliseconds: Double? = null,
    val appsCount: Int = 0,
    val scriptsCount: Int = 0,
)

data class CoderAgentHealth(
    val healthy: Boolean,
    val reason: String = "",
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
    val workspaceIconUrl: String? = null,
    val agentStatusTitle: String? = null,
    val agentStatusSubtitle: String? = null,
)
