package com.coder.pi

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.net.toUri
import java.util.concurrent.atomic.AtomicInteger

class TerminalNotificationRouter(
    private val context: Context,
    private val notificationContext: TerminalNotificationContext,
) {
    fun handleOscEvent(event: String, terminalTitle: String) {
        val parts = event.split("\t", limit = 3)
        when (parts.getOrNull(0)) {
            "notification" -> postNotification(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
            "progress" -> postProgress(terminalTitle, parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
        }
    }

    @SuppressLint("MissingPermission")
    private fun notifySafely(id: Int, notification: android.app.Notification) {
        if (!canPostNotifications()) return
        runCatching { NotificationManagerCompat.from(context).notify(id, notification) }
    }

    private fun postNotification(title: String, body: String) {
        val cleanTitle = formatNotificationText(title).ifBlank { notificationContext.workspaceDisplayName.ifBlank { notificationContext.workspaceName }.ifBlank { "Terminal" } }
        val cleanBody = formatNotificationText(body).ifBlank { cleanTitle }
        if (!canPostNotifications()) return
        ensureChannel(oscNotificationChannelId(), oscNotificationChannelName(), silent = false)
        val notificationId = nextNotificationId()
        val pendingIntent = PendingIntent.getActivity(context, notificationId, launchIntent(), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        notifySafely(notificationId, NotificationCompat.Builder(context, oscNotificationChannelId())
            .setSmallIcon(R.drawable.pi_logo_mark)
            .setContentTitle(cleanTitle.take(128))
            .setContentText(cleanBody.take(512))
            .setSubText(workspaceLabel())
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setGroup(groupKey())
            .setStyle(NotificationCompat.BigTextStyle().bigText(cleanBody.take(512)))
            .addAction(R.drawable.ic_feather_terminal, "Open terminal", pendingIntent)
            .addAction(replyAction(notificationId))
            .build())
    }

    private fun postProgress(title: String, stateText: String, valueText: String) {
        val state = stateText.toIntOrNull() ?: return
        val notificationId = progressNotificationId()
        if (state == 0) {
            NotificationManagerCompat.from(context).cancel(notificationId)
            return
        }
        if (!canPostNotifications()) return
        ensureChannel(oscProgressNotificationChannelId(), oscProgressNotificationChannelName(), silent = true)
        val progress = valueText.toIntOrNull()?.coerceIn(0, 100) ?: 0
        val indeterminate = state == 3 || valueText.isBlank()
        val pendingIntent = PendingIntent.getActivity(context, notificationId, launchIntent(), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        notifySafely(notificationId, NotificationCompat.Builder(context, oscProgressNotificationChannelId())
            .setSmallIcon(R.drawable.pi_logo_mark)
            .setContentTitle(title.ifBlank { "Terminal" }.take(128))
            .setContentText(WhimsicalStatusMessages.working[nextNotificationId().mod(WhimsicalStatusMessages.working.size)])
            .setSubText(workspaceLabel())
            .setContentIntent(pendingIntent)
            .setOngoing(state == 1 || state == 3 || state == 4)
            .setAutoCancel(false)
            .setProgress(100, progress, indeterminate)
            .setGroup(groupKey())
            .addAction(R.drawable.ic_feather_terminal, "Open terminal", pendingIntent)
            .build())
    }

    private fun canPostNotifications(): Boolean = Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun ensureChannel(id: String, name: String, silent: Boolean) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(id) == null) {
            manager.createNotificationChannel(NotificationChannel(id, name, NotificationManager.IMPORTANCE_DEFAULT).apply {
                if (silent) {
                    setSound(null, null)
                    enableVibration(false)
                    enableLights(false)
                }
            })
        }
    }

    private fun replyAction(notificationId: Int): NotificationCompat.Action {
        val input = RemoteInput.Builder(TerminalNotificationReplyInputKey).setLabel("Follow up").build()
        val intent = Intent(context, TerminalNotificationReplyReceiver::class.java)
            .setAction(TerminalNotificationReplyAction)
            .putExtra(TerminalNotificationWorkspaceIdKey, notificationContext.workspaceId)
            .putExtra(TerminalNotificationTerminalIdKey, notificationContext.terminalId)
            .putExtra(TerminalNotificationIdKey, notificationId)
        val pendingIntent = PendingIntent.getBroadcast(context, notificationId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        return NotificationCompat.Action.Builder(R.drawable.ic_feather_terminal, "Follow up", pendingIntent).addRemoteInput(input).setAllowGeneratedReplies(false).build()
    }

    private fun launchIntent(): Intent = ((if (notificationContext.deepLink.isBlank()) context.packageManager.getLaunchIntentForPackage(context.packageName) else Intent(Intent.ACTION_VIEW, notificationContext.deepLink.toUri(), context, MainActivity::class.java)) ?: Intent(context, MainActivity::class.java)).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }

    private fun workspaceLabel(): String = notificationContext.workspaceDisplayName.ifBlank { notificationContext.workspaceName }.take(64)

    private fun groupKey(): String = "terminal:${notificationContext.terminalId.ifBlank { notificationContext.deepLink }.ifBlank { notificationContext.workspaceId }.ifBlank { context.packageName }}"

    private fun oscNotificationChannelId(): String = if (notificationContext.workspaceId.isBlank()) "terminal_osc" else "terminal_osc_${notificationContext.workspaceId.hashCode()}"

    private fun oscProgressNotificationChannelId(): String = if (notificationContext.workspaceId.isBlank()) "terminal_osc_progress" else "terminal_osc_progress_${notificationContext.workspaceId.hashCode()}"

    private fun oscNotificationChannelName(): String = if (notificationContext.workspaceName.isBlank()) "Terminal OSC" else "Terminal · ${notificationContext.workspaceName}"

    private fun oscProgressNotificationChannelName(): String = if (notificationContext.workspaceName.isBlank()) "Terminal Progress" else "Terminal Progress · ${notificationContext.workspaceName}"

    private fun progressNotificationId(): Int = (904 xor notificationContext.terminalId.ifBlank { notificationContext.deepLink }.ifBlank { notificationContext.workspaceId }.hashCode()) and 0x7fffffff

    private fun nextNotificationId(): Int = notificationIdCounter.updateAndGet { if (it == Int.MAX_VALUE) 1 else it + 1 }

    private fun formatNotificationText(text: String): String = text
        .replace(Regex("```[\\s\\S]*?```")) { it.value.removePrefix("```").removeSuffix("```") }
        .replace(Regex("`([^`]+)`"), "$1")
        .replace(Regex("!\\[([^]]*)]\\([^)]*\\)"), "$1")
        .replace(Regex("\\[([^]]+)]\\([^)]*\\)"), "$1")
        .replace(Regex("[*_~#>]+"), "")
        .lines()
        .map { it.trim().removePrefix("- ").removePrefix("* ") }
        .filter { it.isNotBlank() }
        .joinToString(" · ")
        .take(512)

    companion object {
        private val notificationIdCounter = AtomicInteger((System.currentTimeMillis() and 0x3fffffff).toInt())
    }
}
