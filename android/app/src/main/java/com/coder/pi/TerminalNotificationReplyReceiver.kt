package com.coder.pi

import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput

class TerminalNotificationReplyReceiver : BroadcastReceiver() {
    override fun onReceive(
        context: Context,
        intent: Intent,
    ) {
        if (intent.action == TerminalNotificationCopyUrlAction) {
            val url = intent.getStringExtra(TerminalNotificationUrlKey).orEmpty().takeIf { it.startsWith("http://") || it.startsWith("https://") } ?: return
            SentryBreadcrumbs.notification("copy url action")
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("Interview URL", url))
            return
        }
        if (intent.action != TerminalNotificationReplyAction) return
        val text =
            RemoteInput
                .getResultsFromIntent(intent)
                ?.getCharSequence(TerminalNotificationReplyInputKey)
                ?.toString()
                .orEmpty()
                .trim()
        if (text.isBlank()) return
        val terminalId = intent.getStringExtra(TerminalNotificationTerminalIdKey).orEmpty()
        SentryBreadcrumbs.notification("reply received", mapOf("terminalId" to terminalId, "length" to text.length))
        val sent =
            TerminalConnectionManager.sendInput(terminalId, text) ||
                run {
                    TerminalConnectionManager.startSavedHeadless(context)
                    TerminalConnectionManager.sendInput(terminalId, text)
                }
        if (sent) {
            SentryBreadcrumbs.notification("reply sent", mapOf("terminalId" to terminalId))
            NotificationManagerCompat.from(context).cancel(intent.getIntExtra(TerminalNotificationIdKey, 0))
        } else {
            SentryBreadcrumbs.notification("reply send failed", mapOf("terminalId" to terminalId))
        }
    }
}
