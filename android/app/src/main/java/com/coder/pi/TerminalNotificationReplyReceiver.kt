package com.coder.pi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput

class TerminalNotificationReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TerminalNotificationReplyAction) return
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(TerminalNotificationReplyInputKey)?.toString().orEmpty().trim()
        if (text.isBlank()) return
        val workspaceId = intent.getStringExtra(TerminalNotificationWorkspaceIdKey).orEmpty()
        CoderTerminalView.sendNotificationReply(workspaceId, text)
    }
}
