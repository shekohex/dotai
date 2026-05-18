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

    fun open(context: Context, launch: TerminalLaunchRequest, identity: TerminalIdentity) {
        context.startActivity(
            Intent(context, TerminalActivity::class.java)
                .setData(sessionUri(identity))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
                .putExtra(BaseUrl, launch.baseUrl)
                .putExtra(UserId, identity.userId)
                .putExtra(WorkspaceId, identity.workspaceId)
                .putExtra(WorkspaceName, launch.title)
                .putExtra(AgentId, launch.agentId)
                .putExtra(AgentName, launch.badge)
                .putExtra(Command, launch.command)
                .putExtra(ReconnectId, launch.reconnectId)
        )
    }

    fun sessionUri(identity: TerminalIdentity): Uri {
        return Uri.Builder()
            .scheme("pi")
            .authority("terminal")
            .appendPath(identity.userId)
            .appendPath(identity.workspaceId)
            .appendPath(identity.agentId)
            .appendQueryParameter(Command, identity.command)
            .build()
    }
}
