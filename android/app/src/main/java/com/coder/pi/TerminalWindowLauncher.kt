package com.coder.pi

import android.content.Context
import android.content.Intent
import android.net.Uri

object TerminalWindowLauncher {
    const val BaseUrl = "base_url"
    const val UserId = "user_id"
    const val WorkspaceId = "workspace_id"
    const val WorkspaceName = "workspace_name"
    const val AgentId = "agent_id"
    const val AgentName = "agent_name"
    const val Command = "command"
    const val ReconnectId = "reconnect_id"
    const val WorkspaceIconUrl = "workspace_icon_url"

    fun open(
        context: Context,
        launch: TerminalLaunchRequest,
        identity: TerminalIdentity,
    ) {
        context.startActivity(intent(context, launch, identity))
    }

    fun intent(
        context: Context,
        launch: TerminalLaunchRequest,
        identity: TerminalIdentity,
    ): Intent =
        Intent(context, TerminalActivity::class.java)
            .setData(sessionUri(identity))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
            .putExtra(BaseUrl, launch.baseUrl)
            .putExtra(UserId, identity.userId)
            .putExtra(WorkspaceId, identity.workspaceId)
            .putExtra(WorkspaceName, launch.workspaceName)
            .putExtra(AgentId, launch.agentId)
            .putExtra(AgentName, launch.badge)
            .putExtra(Command, launch.command)
            .putExtra(ReconnectId, launch.reconnectId)
            .putExtra(WorkspaceIconUrl, launch.workspaceIconUrl)

    fun intent(
        context: Context,
        metadata: CoderActiveTerminalMetadata,
    ): Intent {
        val localWorkspaceState = CoderSessionStore(context).workspaceState(metadata.baseUrl, metadata.userId, metadata.workspaceId)
        val launch = TerminalLaunchRequest(metadata.baseUrl, "", metadata.agentId, metadata.reconnectId, metadata.command, localWorkspaceState.alias ?: metadata.workspaceName, metadata.agentName, metadata.workspaceName, metadata.workspaceIconUrl)
        val identity = TerminalIdentity(metadata.baseUrl, metadata.userId, metadata.workspaceId, metadata.agentId, metadata.command)
        return intent(context, launch, identity)
    }

    fun intentForSavedTerminal(
        context: Context,
        terminalId: String,
    ): Intent? {
        if (terminalId.isBlank()) return null
        val store = CoderSessionStore(context)
        val baseUrl = store.loadSession()?.first ?: return null
        val metadata =
            store
                .activeTerminalsForBaseUrl(baseUrl)
                .firstOrNull { terminalSessionKey(TerminalIdentity(it.baseUrl, it.userId, it.workspaceId, it.agentId, it.command)) == terminalId }
                ?: return null
        return intent(context, metadata)
    }

    fun sessionUri(identity: TerminalIdentity): Uri =
        Uri
            .Builder()
            .scheme("pi")
            .authority("terminal")
            .appendPath(identity.userId)
            .appendPath(identity.workspaceId)
            .appendPath(identity.agentId)
            .appendQueryParameter(Command, identity.command)
            .build()
}
