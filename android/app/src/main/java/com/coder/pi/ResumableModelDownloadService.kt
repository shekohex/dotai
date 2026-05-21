package com.coder.pi

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Environment
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.edit
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class ResumableModelDownloadService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val pauseRequested = AtomicBoolean(false)
    private val cancelRequested = AtomicBoolean(false)
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        registerNetworkCallback()
        startForeground(NotificationId, notification("Preparing model download", 0, 0))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val artifact = ParakeetModelArtifacts.byId(intent?.getStringExtra(ModelIdExtra).orEmpty())
        when (intent?.action) {
            PauseAction -> pauseRequested.set(true)
            CancelAction -> {
                cancelRequested.set(true)
                ResumableModelDownloadStateStore.update(this, artifact, ModelDownloadState.Canceled, 0, artifact.sizeBytes, null, 0, -1)
                destinationFile(artifact).delete()
                stopSelf()
            }
            else -> executor.execute { download(artifact) }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        executor.shutdownNow()
        networkCallback?.let { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) }
        super.onDestroy()
    }

    private fun download(artifact: ParakeetModelArtifact, attempt: Int = 0) {
        pauseRequested.set(false)
        cancelRequested.set(false)
        val file = destinationFile(artifact)
        file.parentFile?.mkdirs()
        var downloaded = file.length().coerceAtLeast(0)
        val existingEtag = ResumableModelDownloadStateStore.etag(this, artifact)
        val speedSampler = DownloadSpeedSampler(downloaded)
        try {
            if (shouldPauseForMeteredNetwork() || !hasNetwork()) {
                ResumableModelDownloadStateStore.update(this, artifact, ModelDownloadState.Paused, downloaded, artifact.sizeBytes, existingEtag, 0, -1)
                getSystemService(NotificationManager::class.java).notify(NotificationId, notification("Model download paused", downloaded, artifact.sizeBytes, ModelDownloadState.Paused, 0, -1, artifact.id))
                return
            }
            val connection = (URL(artifact.url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000
                readTimeout = 30_000
                instanceFollowRedirects = true
                if (downloaded > 0) setRequestProperty("Range", "bytes=$downloaded-")
                if (downloaded > 0 && !existingEtag.isNullOrBlank()) setRequestProperty("If-Range", existingEtag)
            }
            val code = connection.responseCode
            if (downloaded > 0 && code == HttpURLConnection.HTTP_OK) {
                file.delete()
                downloaded = 0
            }
            check(code == HttpURLConnection.HTTP_OK || code == HttpURLConnection.HTTP_PARTIAL) { "HTTP $code" }
            val etag = connection.getHeaderField("ETag") ?: existingEtag
            val total = when (code) {
                HttpURLConnection.HTTP_PARTIAL -> artifact.sizeBytes
                else -> connection.contentLengthLong.takeIf { it > 0 } ?: artifact.sizeBytes
            }
            ResumableModelDownloadStateStore.update(this, artifact, ModelDownloadState.Running, downloaded, total, etag, 0, -1)
            connection.inputStream.use { input ->
                RandomAccessFile(file, "rw").use { output ->
                    output.seek(downloaded)
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        if (cancelRequested.get()) {
                            file.delete()
                            ResumableModelDownloadStateStore.update(this, artifact, ModelDownloadState.Canceled, downloaded, total, etag, 0, -1)
                            return
                        }
                        if (pauseRequested.get()) {
                            ResumableModelDownloadStateStore.update(this, artifact, ModelDownloadState.Paused, downloaded, total, etag, 0, -1)
                            getSystemService(NotificationManager::class.java).notify(NotificationId, notification("Model download paused", downloaded, total, ModelDownloadState.Paused, 0, -1, artifact.id))
                            return
                        }
                        if (shouldPauseForMeteredNetwork() || !hasNetwork()) {
                            ResumableModelDownloadStateStore.update(this, artifact, ModelDownloadState.Paused, downloaded, total, etag, 0, -1)
                            getSystemService(NotificationManager::class.java).notify(NotificationId, notification("Model download paused", downloaded, total, ModelDownloadState.Paused, 0, -1, artifact.id))
                            return
                        }
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        downloaded += read
                        val speed = speedSampler.speed(downloaded)
                        val eta = if (speed > 0 && total > downloaded) (total - downloaded) / speed else -1
                        ResumableModelDownloadStateStore.update(this, artifact, ModelDownloadState.Running, downloaded, total, etag, speed, eta)
                        getSystemService(NotificationManager::class.java).notify(NotificationId, notification(artifact.title, downloaded, total, ModelDownloadState.Running, speed, eta, artifact.id))
                    }
                }
            }
            if (downloaded == artifact.sizeBytes) {
                ResumableModelDownloadStateStore.update(this, artifact, ModelDownloadState.Success, downloaded, total, etag, 0, 0)
                getSystemService(NotificationManager::class.java).notify(NotificationId, notification("Model download complete", downloaded, total, ModelDownloadState.Success, 0, 0, artifact.id))
            } else {
                ResumableModelDownloadStateStore.update(this, artifact, ModelDownloadState.Failed, downloaded, artifact.sizeBytes, etag, 0, -1)
                getSystemService(NotificationManager::class.java).notify(NotificationId, notification("Model download incomplete", downloaded, artifact.sizeBytes, ModelDownloadState.Failed, 0, -1, artifact.id))
            }
        } catch (_: Throwable) {
            if (!pauseRequested.get() && !cancelRequested.get() && attempt < MaxRetryCount && hasNetwork()) {
                Thread.sleep((attempt + 1) * 1_500L)
                download(artifact, attempt + 1)
                return
            }
            ResumableModelDownloadStateStore.update(this, artifact, ModelDownloadState.Failed, downloaded, artifact.sizeBytes, existingEtag, 0, -1)
        } finally {
            val state = ResumableModelDownloadStateStore.state(this, artifact).status
            if (state == ModelDownloadState.Paused || state == ModelDownloadState.Failed || state == ModelDownloadState.Success) stopForeground(STOP_FOREGROUND_DETACH)
            stopSelf()
        }
    }

    private fun shouldPauseForMeteredNetwork(): Boolean {
        if (!SpeechSettingsStore.values(this).pauseModelDownloadsOnMeteredNetwork) return false
        val connectivityManager = getSystemService(ConnectivityManager::class.java) ?: return false
        return connectivityManager.isActiveNetworkMetered
    }

    private fun hasNetwork(): Boolean {
        val connectivityManager = getSystemService(ConnectivityManager::class.java) ?: return true
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun registerNetworkCallback() {
        val connectivityManager = getSystemService(ConnectivityManager::class.java) ?: return
        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onLost(network: Network) { pauseRequested.set(true) }
            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                if (SpeechSettingsStore.values(this@ResumableModelDownloadService).pauseModelDownloadsOnMeteredNetwork && !networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) pauseRequested.set(true)
            }
        }
        connectivityManager.registerDefaultNetworkCallback(networkCallback!!)
    }

    private fun notification(title: String, downloaded: Long, total: Long, status: Int = ModelDownloadState.Running, bytesPerSecond: Long = 0, etaSeconds: Long = -1, modelId: String = ""): android.app.Notification {
        val progress = if (total > 0) (downloaded * 100 / total).toInt().coerceIn(0, 100) else 0
        val text = when {
            status == ModelDownloadState.Paused -> "Paused at $progress%"
            status == ModelDownloadState.Success -> "Complete"
            bytesPerSecond > 0 -> "$progress% · ${bytesPerSecond.toSpeedLabel()} · ETA ${etaSeconds.toEtaLabel()}"
            total > 0 -> "$progress%"
            else -> "Starting"
        }
        if (Build.VERSION.SDK_INT >= 36) return nativeProgressNotification(title, text, downloaded, total, progress, status, modelId)
        val builder = NotificationCompat.Builder(this, ChannelId)
            .setSmallIcon(R.drawable.pi_logo_mark)
            .setContentTitle(title)
            .setContentText(text)
            .setSubText(if (total > 0) "${downloaded.toHumanBytesLabel()} / ${total.toHumanBytesLabel()}" else null)
            .setOngoing(status == ModelDownloadState.Running)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setProgress(100, progress, total <= 0)
            .setContentIntent(PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        if (modelId.isNotBlank()) {
            if (status == ModelDownloadState.Running) builder.addAction(R.drawable.ic_feather_pause, "Pause", PendingIntent.getService(this, 10, intent(this, PauseAction, modelId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            if (status == ModelDownloadState.Paused || status == ModelDownloadState.Failed) builder.addAction(R.drawable.ic_feather_play, "Resume", PendingIntent.getService(this, 11, intent(this, StartAction, modelId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            if (status == ModelDownloadState.Running || status == ModelDownloadState.Paused || status == ModelDownloadState.Failed) builder.addAction(R.drawable.ic_feather_x, "Cancel", PendingIntent.getService(this, 12, intent(this, CancelAction, modelId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        return builder.build()
    }

    private fun nativeProgressNotification(title: String, text: String, downloaded: Long, total: Long, progress: Int, status: Int, modelId: String): android.app.Notification {
        val pendingIntent = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val style = android.app.Notification.ProgressStyle()
            .setStyledByProgress(true)
            .setProgressIndeterminate(total <= 0)
            .setProgress(if (total > 0) progress else 0)
            .setProgressSegments(listOf(android.app.Notification.ProgressStyle.Segment(100).setColor(if (status == ModelDownloadState.Failed) Color.RED else Color.rgb(125, 92, 255))))
            .setProgressStartIcon(Icon.createWithResource(this, R.drawable.pi_logo_mark))
            .setProgressTrackerIcon(Icon.createWithResource(this, R.drawable.pi_logo_mark))
            .setProgressEndIcon(Icon.createWithResource(this, R.drawable.ic_feather_check))
        val builder = android.app.Notification.Builder(this, ChannelId)
            .setSmallIcon(R.drawable.pi_logo_mark)
            .setContentTitle(title.take(128))
            .setContentText(text)
            .setSubText(if (total > 0) "${downloaded.toHumanBytesLabel()} / ${total.toHumanBytesLabel()}" else null)
            .setContentIntent(pendingIntent)
            .setColor(Color.rgb(125, 92, 255))
            .setOngoing(status == ModelDownloadState.Running)
            .setCategory(android.app.Notification.CATEGORY_PROGRESS)
            .setVisibility(android.app.Notification.VISIBILITY_PUBLIC)
            .setAutoCancel(status == ModelDownloadState.Success)
            .setOnlyAlertOnce(true)
            .setLocalOnly(true)
            .setShowWhen(true)
            .setStyle(style)
        if (modelId.isNotBlank()) {
            if (status == ModelDownloadState.Running) builder.addAction(android.app.Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_feather_pause), "Pause", PendingIntent.getService(this, 10, intent(this, PauseAction, modelId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
            if (status == ModelDownloadState.Paused || status == ModelDownloadState.Failed) builder.addAction(android.app.Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_feather_play), "Resume", PendingIntent.getService(this, 11, intent(this, StartAction, modelId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
            if (status == ModelDownloadState.Running || status == ModelDownloadState.Paused || status == ModelDownloadState.Failed) builder.addAction(android.app.Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_feather_x), "Cancel", PendingIntent.getService(this, 12, intent(this, CancelAction, modelId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
        }
        return builder.build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(ChannelId) == null) manager.createNotificationChannel(NotificationChannel(ChannelId, "Speech Model Downloads", NotificationManager.IMPORTANCE_DEFAULT).apply {
            setSound(null, null)
            enableVibration(false)
            enableLights(false)
        })
    }

    private fun destinationFile(artifact: ParakeetModelArtifact): File = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "speech/${artifact.fileName}.part")

    companion object {
        const val StartAction = "com.coder.pi.speech.model.START"
        const val PauseAction = "com.coder.pi.speech.model.PAUSE"
        const val CancelAction = "com.coder.pi.speech.model.CANCEL"
        private const val ModelIdExtra = "model_id"
        private const val ChannelId = "speech_model_download_progress"
        private const val NotificationId = 902
        private const val MaxRetryCount = 3

        fun intent(context: Context, action: String, modelId: String): Intent = Intent(context, ResumableModelDownloadService::class.java).setAction(action).putExtra(ModelIdExtra, modelId)
    }
}

private class DownloadSpeedSampler(initialBytes: Long) {
    private var lastBytes = initialBytes
    private var lastTime = System.nanoTime()
    private var lastSpeed = 0L

    fun speed(bytes: Long): Long {
        val now = System.nanoTime()
        val elapsedNanos = now - lastTime
        if (elapsedNanos < 750_000_000L) return lastSpeed
        val delta = bytes - lastBytes
        lastSpeed = if (delta > 0) delta * 1_000_000_000L / elapsedNanos else 0
        lastBytes = bytes
        lastTime = now
        return lastSpeed
    }
}

private fun Long.toHumanBytesLabel(): String = when {
    this >= 1024L * 1024L * 1024L -> "%.1f GB".format(this / (1024.0 * 1024.0 * 1024.0))
    this >= 1024L * 1024L -> "%.1f MB".format(this / (1024.0 * 1024.0))
    this >= 1024L -> "%.1f KB".format(this / 1024.0)
    else -> "$this B"
}

private fun Long.toSpeedLabel(): String = when {
    this >= 1024L * 1024L * 1024L -> "%.1f GB/s".format(this / (1024.0 * 1024.0 * 1024.0))
    this >= 1024L * 1024L -> "%.1f MB/s".format(this / (1024.0 * 1024.0))
    this >= 1024L -> "%.1f KB/s".format(this / 1024.0)
    else -> "$this B/s"
}

private fun Long.toEtaLabel(): String = when {
    this < 0 -> "--"
    this < 60 -> "${this}s"
    this < 3600 -> "${this / 60}m ${this % 60}s"
    else -> "${this / 3600}h ${(this % 3600) / 60}m"
}

object ResumableModelDownloadStateStore {
    private const val PreferencesName = "terminal"

    fun state(context: Context, artifact: ParakeetModelArtifact): ModelDownloadState {
        val preferences = context.getSharedPreferences(PreferencesName, Context.MODE_PRIVATE)
        val prefix = prefix(artifact)
        return ModelDownloadState(preferences.getInt("$prefix.status", ModelDownloadState.Idle), preferences.getLong("$prefix.downloaded", 0), preferences.getLong("$prefix.total", artifact.sizeBytes), preferences.getLong("$prefix.speed", 0), preferences.getLong("$prefix.eta", -1))
    }

    fun etag(context: Context, artifact: ParakeetModelArtifact): String? = context.getSharedPreferences(PreferencesName, Context.MODE_PRIVATE).getString("${prefix(artifact)}.etag", null)

    fun update(context: Context, artifact: ParakeetModelArtifact, status: Int, downloaded: Long, total: Long, etag: String?, bytesPerSecond: Long, etaSeconds: Long) {
        context.getSharedPreferences(PreferencesName, Context.MODE_PRIVATE).edit {
            putInt("${prefix(artifact)}.status", status)
            putLong("${prefix(artifact)}.downloaded", downloaded)
            putLong("${prefix(artifact)}.total", total)
            putLong("${prefix(artifact)}.speed", bytesPerSecond)
            putLong("${prefix(artifact)}.eta", etaSeconds)
            if (etag == null) remove("${prefix(artifact)}.etag") else putString("${prefix(artifact)}.etag", etag)
        }
    }

    fun markFailed(context: Context, artifact: ParakeetModelArtifact, downloaded: Long, total: Long) = update(context, artifact, ModelDownloadState.Failed, downloaded, total, etag(context, artifact), 0, -1)

    fun clear(context: Context, artifact: ParakeetModelArtifact) {
        context.getSharedPreferences(PreferencesName, Context.MODE_PRIVATE).edit {
            remove("${prefix(artifact)}.status")
            remove("${prefix(artifact)}.downloaded")
            remove("${prefix(artifact)}.total")
            remove("${prefix(artifact)}.speed")
            remove("${prefix(artifact)}.eta")
            remove("${prefix(artifact)}.etag")
        }
    }

    private fun prefix(artifact: ParakeetModelArtifact): String = "speech.model_download.${artifact.id}"
}
