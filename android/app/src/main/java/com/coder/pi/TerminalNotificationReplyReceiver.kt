package com.coder.pi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput

class TerminalNotificationReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TerminalNotificationReplyAction) return
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(TerminalNotificationReplyInputKey)?.toString().orEmpty().trim()
        if (text.isBlank()) return
        val workspaceId = intent.getStringExtra(TerminalNotificationWorkspaceIdKey).orEmpty()
        val terminalId = intent.getStringExtra(TerminalNotificationTerminalIdKey).orEmpty()
        if (TerminalConnectionManager.sendInput(terminalId, text) || CoderTerminalView.sendNotificationReply(workspaceId, text)) {
            NotificationManagerCompat.from(context).cancel(intent.getIntExtra(TerminalNotificationIdKey, 0))
        }
    }
}
