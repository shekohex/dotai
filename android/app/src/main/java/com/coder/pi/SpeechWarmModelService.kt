package com.coder.pi

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

object SpeechWarmModelStore {
    private val mutex = Mutex()
    private var key: String? = null
    private var transcriber: LiteRtParakeetTranscriber? = null

    suspend fun transcriber(context: Context, settings: SpeechSettingsValues): LiteRtParakeetTranscriber = mutex.withLock {
        val nextKey = listOf(settings.selectedSpeechModelId, settings.accelerator).joinToString(":")
        transcriber?.takeIf { key == nextKey } ?: LiteRtParakeetTranscriber(
            ParakeetModelCache(context.applicationContext, ParakeetModelArtifacts.byId(settings.selectedSpeechModelId)),
            ParakeetTokenizerCache(context.applicationContext),
            SpeechAcceleratorMode.byId(settings.accelerator),
        ).also {
            transcriber?.close()
            transcriber = it
            key = nextKey
        }
    }

    suspend fun warm(context: Context, settings: SpeechSettingsValues): Result<SpeechTranscriptionMetrics> = transcriber(context, settings).warm()

    suspend fun close() = mutex.withLock {
        transcriber?.close()
        transcriber = null
        key = null
    }
}

class SpeechWarmModelService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var warmJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        startForeground(NotificationId, notification("Warming speech model"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == StopAction) {
            scope.launch { SpeechWarmModelStore.close(); stopSelf() }
            return START_NOT_STICKY
        }
        if (warmJob?.isActive != true) warmJob = scope.launch { keepWarm() }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun keepWarm() {
        while (true) {
            val settings = SpeechSettingsStore.values(this)
            if (!settings.keepModelWarmEnabled || !settings.localTranscriptionEnabled) {
                SpeechWarmModelStore.close()
                stopSelf()
                return
            }
            val result = SpeechWarmModelStore.warm(this, settings)
            val text = result.getOrNull()?.let { metrics -> "Warm · ${metrics.accelerator} · ${metrics.totalMillis}ms" } ?: "Warm failed"
            getSystemService(NotificationManager::class.java).notify(NotificationId, notification(text))
            delay(settings.keepModelWarmMinutes * 60_000L)
        }
    }

    private fun notification(text: String) = NotificationCompat.Builder(this, ChannelId)
        .setSmallIcon(R.drawable.ic_feather_zap)
        .setContentTitle("Speech model warm")
        .setContentText(text)
        .setOngoing(true)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
        .addAction(R.drawable.ic_feather_x, "Stop", PendingIntent.getService(this, 31, Intent(this, SpeechWarmModelService::class.java).setAction(StopAction), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        .build()

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(ChannelId) == null) manager.createNotificationChannel(NotificationChannel(ChannelId, "Speech Model Warm Cache", NotificationManager.IMPORTANCE_LOW))
    }

    companion object {
        private const val ChannelId = "speech_model_warm"
        private const val NotificationId = 48_621
        private const val StopAction = "com.coder.pi.speech.WARM_STOP"

        fun start(context: Context) = ContextCompat.startForegroundService(context, Intent(context, SpeechWarmModelService::class.java))
        fun stop(context: Context) = context.startService(Intent(context, SpeechWarmModelService::class.java).setAction(StopAction))
    }
}
