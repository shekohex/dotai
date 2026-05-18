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
        val terminalId = intent.getStringExtra(TerminalNotificationTerminalIdKey).orEmpty()
        val sent = TerminalConnectionManager.sendInput(terminalId, text)
            || run {
                TerminalConnectionManager.startSavedHeadless(context)
                TerminalConnectionManager.sendInput(terminalId, text)
            }
        if (sent) {
            NotificationManagerCompat.from(context).cancel(intent.getIntExtra(TerminalNotificationIdKey, 0))
        }
    }
}
