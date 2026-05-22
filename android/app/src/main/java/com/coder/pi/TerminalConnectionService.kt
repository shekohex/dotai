package com.coder.pi

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class TerminalConnectionService : Service() {
    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        startForeground(ServiceNotificationId, serviceNotification())
    }

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        if (intent?.action == StopAction) {
            TerminalConnectionManager.stopAll()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        TerminalConnectionManager.startSavedHeadless(this)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        TerminalConnectionManager.stopAll()
        super.onDestroy()
    }

    private fun serviceNotification() =
        NotificationCompat
            .Builder(this, ServiceChannelId)
            .setSmallIcon(R.drawable.pi_logo_mark)
            .setContentTitle("Terminal connections active")
            .setContentText("Keeping terminal sessions connected in background")
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setLocalOnly(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .setContentIntent(PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .addAction(R.drawable.ic_feather_x, "Stop", PendingIntent.getService(this, 1, Intent(this, TerminalConnectionService::class.java).setAction(StopAction), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .build()

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(ServiceChannelId) == null) {
            manager.createNotificationChannel(
                NotificationChannel(ServiceChannelId, "Terminal Connections", NotificationManager.IMPORTANCE_MIN).apply {
                    setSound(null, null)
                    enableVibration(false)
                    enableLights(false)
                    setShowBadge(false)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_SECRET
                },
            )
        }
    }

    companion object {
        private const val ServiceNotificationId = 901
        private const val ServiceChannelId = "terminal_connections_minimized"
        private const val StopAction = "com.coder.pi.STOP_TERMINAL_CONNECTIONS"
    }
}
