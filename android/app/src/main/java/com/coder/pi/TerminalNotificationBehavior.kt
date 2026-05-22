package com.coder.pi

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.graphics.Color
import android.media.AudioAttributes
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationCompat

object TerminalNotificationBehavior {
    private val vibrationPattern = longArrayOf(0, 80, 50, 160, 80, 240)

    fun ensureAlertChannel(
        context: Context,
        id: String,
        name: String,
        soundId: String,
        hapticId: String = TerminalHapticPatterns.defaultAttentionPatternId,
    ) {
        if (Build.VERSION.SDK_INT < 26) return
        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val existingChannel = notificationManager.getNotificationChannel(id)
        if (existingChannel != null) return
        val soundUri = TerminalNotificationSounds.uri(context, soundId)
        val haptic = TerminalHapticPatterns.option(hapticId)
        val audioAttributes =
            AudioAttributes
                .Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        notificationManager.createNotificationChannel(
            NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH).apply {
                setSound(soundUri, audioAttributes)
                enableVibration(haptic.id != "none")
                vibrationPattern = haptic.timings
                enableLights(true)
                lightColor = Color.rgb(120, 91, 255)
                setShowBadge(true)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            },
        )
    }

    fun applyAlertDefaults(
        builder: NotificationCompat.Builder,
        hapticId: String = TerminalHapticPatterns.defaultAttentionPatternId,
    ): NotificationCompat.Builder {
        val haptic = TerminalHapticPatterns.option(hapticId)
        return builder
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVibrate(if (haptic.id == "none") longArrayOf(0) else haptic.timings)
            .setLights(Color.rgb(120, 91, 255), 700, 1_500)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
    }

    @Suppress("DEPRECATION")
    fun wakeScreen(context: Context) {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (powerManager.isInteractive) return
        val wakeLock = powerManager.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "DotAI:TerminalNotification")
        wakeLock.acquire(3_000)
    }
}
