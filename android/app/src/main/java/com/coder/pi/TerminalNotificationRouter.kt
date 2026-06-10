package com.coder.pi

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.Icon
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
    private val agentState = TerminalAgentState()

    fun agentStateSnapshot(): TerminalAgentStateSnapshot = agentState.snapshot()

    fun handleOscEvent(
        event: TerminalOscEvent,
        terminalTitle: String,
    ) {
        when (event) {
            is TerminalOscEvent.Notification -> postNotification(event.title, event.body)
            is TerminalOscEvent.Progress -> Unit
            is TerminalOscEvent.Clipboard -> Unit
            is TerminalOscEvent.Pi -> handlePiOscEvent(event, terminalTitle)
            TerminalOscEvent.Ignored -> Unit
        }
    }

    private fun handlePiOscEvent(
        event: TerminalOscEvent.Pi,
        terminalTitle: String,
    ) {
        val snapshot = agentState.apply(event)
        when (event.eventName) {
            "agent.alert" ->
                snapshot.alerts
                    .lastOrNull()
                    ?.notificationPresentation()
                    ?.let { postNotification(it.title, it.body, it.url, TerminalAlertFeedback.stateFor(it.kind, it.severity)) }
            "agent.input" -> postNotification("π", "Message submitted", feedbackState = TerminalAlertFeedbackState.SUBMIT)
            "agent.aborted" ->
                postNotification(
                    "π",
                    event.envelope.data
                        .stringValue("message")
                        .ifBlank { "Operation aborted" },
                    feedbackState = TerminalAlertFeedbackState.INTERRUPTED,
                )
            "agent.progress", "agent.run", "agent.tool", "agent.compaction", "agent.turn" -> snapshot.progressPresentation()?.let { postPiAgentProgress(terminalTitle, it) }
        }
    }

    @SuppressLint("MissingPermission")
    private fun notifySafely(
        id: Int,
        notification: android.app.Notification,
    ) {
        if (!canPostNotifications()) return
        runCatching { NotificationManagerCompat.from(context).notify(id, notification) }
            .onFailure { SentryAppLogger.error("terminal notification post failed", mapOf("notificationId" to id), it) }
    }

    private fun postNotification(
        title: String,
        body: String,
        launchUrl: String? = null,
        feedbackState: TerminalAlertFeedbackState = TerminalAlertFeedbackState.SUCCESS,
    ) {
        val cleanTitle = TerminalNotificationFormat.cleanText(title).ifBlank { notificationContext.workspaceDisplayName.ifBlank { notificationContext.workspaceName }.ifBlank { "Terminal" } }
        val cleanBody = TerminalNotificationFormat.cleanText(body).ifBlank { cleanTitle }
        if (!canPostNotifications()) return
        val channelId = oscNotificationChannelId(feedbackState)
        val hapticId = TerminalAlertFeedback.hapticId(context, feedbackState)
        ensureAlertChannel(channelId, oscNotificationChannelName(feedbackState), feedbackState)
        val notificationId = nextNotificationId()
        val pendingIntent = PendingIntent.getActivity(context, notificationId, launchIntent(launchUrl), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder =
            NotificationCompat
                .Builder(context, channelId)
                .setSmallIcon(R.drawable.pi_logo_mark)
                .setContentTitle(cleanTitle.take(128))
                .setContentText(cleanBody.take(512))
                .setSubText(workspaceLabel())
                .setContentIntent(pendingIntent)
                .setColor(Color.rgb(125, 92, 255))
                .setColorized(false)
                .setLocalOnly(true)
                .setShowWhen(true)
                .setAutoCancel(true)
                .setGroup(groupKey())
                .setStyle(NotificationCompat.BigTextStyle().bigText(cleanBody.take(512)))
        if (launchUrl != null) {
            builder.addAction(R.drawable.ic_feather_globe, "Open", pendingIntent)
            builder.addAction(copyUrlAction(notificationId, launchUrl))
        } else {
            builder.addAction(R.drawable.ic_feather_terminal, "Open terminal", pendingIntent)
            builder.addAction(replyAction(notificationId))
        }
        val notification =
            TerminalNotificationBehavior
                .applyAlertDefaults(builder, hapticId)
                .build()
        TerminalNotificationBehavior.wakeScreen(context)
        notifySafely(notificationId, notification)
    }

    private fun postProgress(
        title: String,
        stateText: String,
        valueText: String,
        statusText: String = "",
    ) {
        // Legacy OSC 9 progress is intentionally not wired from handleOscEvent.
        // Pi agent progress now uses custom OSC 6767 agent.progress frames for bounded state and elapsed-time notifications.
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
        notifySafely(
            notificationId,
            NotificationCompat
                .Builder(context, oscProgressNotificationChannelId())
                .setSmallIcon(R.drawable.pi_logo_mark)
                .setContentTitle(title.ifBlank { "Terminal" }.take(128))
                .setContentText(statusText.ifBlank { WhimsicalStatusMessages.working[nextNotificationId().mod(WhimsicalStatusMessages.working.size)] })
                .setSubText(workspaceLabel())
                .setContentIntent(pendingIntent)
                .setOngoing(state == 1 || state == 3 || state == 4)
                .setAutoCancel(false)
                .setProgress(100, progress, indeterminate)
                .setGroup(groupKey())
                .addAction(R.drawable.ic_feather_terminal, "Open terminal", pendingIntent)
                .build(),
        )
    }

    private fun postPiAgentProgress(
        title: String,
        progress: TerminalAgentProgressPresentation,
    ) {
        val notificationId = piAgentProgressNotificationId()
        if (!progress.active) {
            NotificationManagerCompat.from(context).cancel(notificationId)
            return
        }
        if (!canPostNotifications()) return
        ensureChannel(oscProgressNotificationChannelId(), oscProgressNotificationChannelName(), silent = true)
        val notificationWhen = progressNotificationWhen(progress.elapsedSeconds)
        if (Build.VERSION.SDK_INT >= 36 && postNativePiAgentProgress(notificationId, title, progress, notificationWhen)) return
        val pendingIntent = PendingIntent.getActivity(context, notificationId, launchIntent(), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        notifySafely(
            notificationId,
            NotificationCompat
                .Builder(context, oscProgressNotificationChannelId())
                .setSmallIcon(R.drawable.pi_logo_mark)
                .setContentTitle(title.ifBlank { "Terminal" }.take(128))
                .setContentText(progress.body.ifBlank { WhimsicalStatusMessages.working[nextNotificationId().mod(WhimsicalStatusMessages.working.size)] })
                .setSubText(workspaceLabel())
                .setContentIntent(pendingIntent)
                .setColor(Color.rgb(125, 92, 255))
                .setColorized(false)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setOnlyAlertOnce(true)
                .setLocalOnly(true)
                .setShowWhen(true)
                .setWhen(notificationWhen)
                .setUsesChronometer(progress.elapsedSeconds != null)
                .setOngoing(true)
                .setAutoCancel(false)
                .setProgress(100, 0, true)
                .setGroup(groupKey())
                .addAction(R.drawable.ic_feather_terminal, "Open terminal", pendingIntent)
                .build(),
        )
    }

    @SuppressLint("NewApi")
    private fun postNativePiAgentProgress(
        notificationId: Int,
        title: String,
        progress: TerminalAgentProgressPresentation,
        notificationWhen: Long,
    ): Boolean {
        val pendingIntent = PendingIntent.getActivity(context, notificationId, launchIntent(), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notificationBody = progress.body.ifBlank { WhimsicalStatusMessages.working[nextNotificationId().mod(WhimsicalStatusMessages.working.size)] }.take(512)
        val style =
            android.app.Notification
                .ProgressStyle()
                .setStyledByProgress(true)
                .setProgressIndeterminate(true)
                .setProgress(0)
                .setProgressSegments(
                    listOf(
                        android.app.Notification.ProgressStyle
                            .Segment(28)
                            .setColor(Color.rgb(125, 92, 255))
                            .setId(1),
                        android.app.Notification.ProgressStyle
                            .Segment(36)
                            .setColor(Color.rgb(84, 174, 255))
                            .setId(2),
                        android.app.Notification.ProgressStyle
                            .Segment(36)
                            .setColor(Color.rgb(58, 211, 159))
                            .setId(3),
                    ),
                ).setProgressPoints(
                    listOf(
                        android.app.Notification.ProgressStyle
                            .Point(28)
                            .setColor(Color.WHITE)
                            .setId(1),
                        android.app.Notification.ProgressStyle
                            .Point(64)
                            .setColor(Color.WHITE)
                            .setId(2),
                    ),
                ).setProgressStartIcon(Icon.createWithResource(context, R.drawable.pi_logo_mark))
                .setProgressTrackerIcon(Icon.createWithResource(context, R.drawable.pi_logo_mark))
                .setProgressEndIcon(Icon.createWithResource(context, R.drawable.ic_feather_check))
        val notification =
            android.app.Notification
                .Builder(context, oscProgressNotificationChannelId())
                .setSmallIcon(R.drawable.pi_logo_mark)
                .setContentTitle(title.ifBlank { "Terminal" }.take(128))
                .setContentText(notificationBody)
                .setSubText(workspaceLabel())
                .setContentIntent(pendingIntent)
                .setColor(Color.rgb(125, 92, 255))
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setLocalOnly(true)
                .setShowWhen(true)
                .setWhen(notificationWhen)
                .setUsesChronometer(progress.elapsedSeconds != null)
                .setRequestPromotedOngoing(true)
                .setShortCriticalText(notificationBody.take(7))
                .setStyle(style)
                .addAction(
                    android.app.Notification.Action
                        .Builder(Icon.createWithResource(context, R.drawable.ic_feather_terminal), "Open terminal", pendingIntent)
                        .build(),
                ).build()
        notifySafely(notificationId, notification)
        return true
    }

    private fun progressNotificationWhen(elapsedSeconds: Long?): Long = elapsedSeconds?.takeIf { it >= 0 }?.let { System.currentTimeMillis() - it * 1000L } ?: System.currentTimeMillis()

    private fun canPostNotifications(): Boolean = Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun ensureChannel(
        id: String,
        name: String,
        silent: Boolean,
    ) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(id) == null) {
            manager.createNotificationChannel(
                NotificationChannel(id, name, NotificationManager.IMPORTANCE_DEFAULT).apply {
                    if (silent) {
                        setSound(null, null)
                        enableVibration(false)
                        enableLights(false)
                    }
                },
            )
        }
    }

    private fun ensureAlertChannel(
        id: String,
        name: String,
        feedbackState: TerminalAlertFeedbackState,
    ) = TerminalNotificationBehavior.ensureAlertChannel(context, id, name, TerminalAlertFeedback.soundId(context, feedbackState), TerminalAlertFeedback.hapticId(context, feedbackState))

    private fun replyAction(notificationId: Int): NotificationCompat.Action {
        val input = RemoteInput.Builder(TerminalNotificationReplyInputKey).setLabel("Follow up").build()
        val intent =
            Intent(context, TerminalNotificationReplyReceiver::class.java)
                .setAction(TerminalNotificationReplyAction)
                .putExtra(TerminalNotificationWorkspaceIdKey, notificationContext.workspaceId)
                .putExtra(TerminalNotificationTerminalIdKey, notificationContext.terminalId)
                .putExtra(TerminalNotificationIdKey, notificationId)
        val pendingIntent = PendingIntent.getBroadcast(context, notificationId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        return NotificationCompat.Action
            .Builder(R.drawable.ic_feather_message_circle, "Follow up", pendingIntent)
            .addRemoteInput(input)
            .setAllowGeneratedReplies(false)
            .build()
    }

    private fun copyUrlAction(
        notificationId: Int,
        url: String,
    ): NotificationCompat.Action {
        val intent = Intent(context, TerminalNotificationReplyReceiver::class.java).setAction(TerminalNotificationCopyUrlAction).putExtra(TerminalNotificationUrlKey, url).putExtra(TerminalNotificationIdKey, notificationId)
        val pendingIntent = PendingIntent.getBroadcast(context, notificationId xor 0x436f7079, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Action.Builder(R.drawable.ic_feather_clipboard, "Copy URL", pendingIntent).build()
    }

    private fun launchIntent(url: String? = null): Intent =
        ((url?.takeIf { it.startsWith("http://") || it.startsWith("https://") }?.let { Intent(Intent.ACTION_VIEW, it.toUri()) } ?: if (notificationContext.deepLink.isBlank()) context.packageManager.getLaunchIntentForPackage(context.packageName) else Intent(Intent.ACTION_VIEW, notificationContext.deepLink.toUri(), context, MainActivity::class.java)) ?: Intent(context, MainActivity::class.java)).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

    private fun workspaceLabel(): String = TerminalNotificationFormat.workspaceLabel(notificationContext)

    private fun groupKey(): String = TerminalNotificationFormat.groupKey(notificationContext, context.packageName)

    private fun oscNotificationChannelId(feedbackState: TerminalAlertFeedbackState): String = "${TerminalNotificationFormat.oscChannelId(notificationContext)}.${TerminalAlertFeedback.channelSuffix(context, feedbackState)}"

    private fun oscProgressNotificationChannelId(): String = TerminalNotificationFormat.progressChannelId(notificationContext)

    private fun oscNotificationChannelName(feedbackState: TerminalAlertFeedbackState): String = "${TerminalNotificationFormat.oscChannelName(notificationContext)} · ${feedbackState.label}"

    private fun oscProgressNotificationChannelName(): String = TerminalNotificationFormat.progressChannelName(notificationContext)

    private fun progressNotificationId(): Int = TerminalNotificationFormat.progressNotificationId(notificationContext)

    private fun piAgentProgressNotificationId(): Int = (progressNotificationId() xor 0x50694167) and 0x7fffffff

    private fun nextNotificationId(): Int = notificationIdCounter.updateAndGet { if (it == Int.MAX_VALUE) 1 else it + 1 }

    companion object {
        private val notificationIdCounter = AtomicInteger((System.currentTimeMillis() and 0x3fffffff).toInt())
    }
}
