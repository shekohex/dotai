package com.coder.pi

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.sqrt

data class SpeechAudioCaptureConfig(
    val sampleRate: Int = 16_000,
    val frameMillis: Int = 20,
    val silenceThreshold: Float = 0.012f,
    val peakThreshold: Float = 0.045f,
    val speechStartFrames: Int = 3,
    val trailingSilenceMillis: Int = 900,
    val preRollMillis: Int = 400,
) {
    val frameSamples: Int = (sampleRate * frameMillis / 1_000).coerceAtLeast(1)
    val trailingSilenceFrames: Int = (trailingSilenceMillis / frameMillis).coerceAtLeast(1)
    val preRollFrames: Int = (preRollMillis / frameMillis).coerceAtLeast(1)
}

data class SpeechAudioFrame(
    val samples: FloatArray,
    val meter: Float,
    val speechDetected: Boolean,
    val voiceActive: Boolean,
    val speechPaused: Boolean,
    val finalized: Boolean,
    val silenced: Boolean,
) {
    override fun equals(other: Any?): Boolean = other is SpeechAudioFrame && samples.contentEquals(other.samples) && meter == other.meter && speechDetected == other.speechDetected && voiceActive == other.voiceActive && speechPaused == other.speechPaused && finalized == other.finalized && silenced == other.silenced

    override fun hashCode(): Int {
        var result = samples.contentHashCode()
        result = 31 * result + meter.hashCode()
        result = 31 * result + speechDetected.hashCode()
        result = 31 * result + voiceActive.hashCode()
        result = 31 * result + speechPaused.hashCode()
        result = 31 * result + finalized.hashCode()
        result = 31 * result + silenced.hashCode()
        return result
    }
}

sealed interface SpeechAudioCaptureFailure {
    data object PermissionDenied : SpeechAudioCaptureFailure
    data object InitializationFailed : SpeechAudioCaptureFailure
    data object SilencedBySystem : SpeechAudioCaptureFailure
    data class ReadFailed(val code: Int) : SpeechAudioCaptureFailure
}

class SpeechVadSegmenter(private val config: SpeechAudioCaptureConfig) {
    private var speechFrames = 0
    private var silenceFrames = 0
    private var meter = 0f
    private var speechStarted = false
    private var totalFrames = 0L

    fun accept(samples: FloatArray, silenced: Boolean = false): SpeechAudioFrame {
        totalFrames++
        val metrics = samples.metrics()
        meter = meter * 0.78f + metrics.magnitude * 0.22f
        val voiceActive = !silenced && (metrics.rms >= config.silenceThreshold || metrics.peak >= config.peakThreshold)
        if (!speechStarted) {
            speechFrames = if (voiceActive) speechFrames + 1 else 0
            speechStarted = speechFrames >= config.speechStartFrames
        } else {
            silenceFrames = if (voiceActive) 0 else silenceFrames + 1
        }
        val speechPaused = speechStarted && !voiceActive && silenceFrames >= config.trailingSilenceFrames
        return SpeechAudioFrame(samples = samples, meter = meter.coerceIn(0f, 1f), speechDetected = speechStarted, voiceActive = voiceActive, speechPaused = speechPaused, finalized = false, silenced = silenced)
    }

    fun reset() {
        speechFrames = 0
        silenceFrames = 0
        meter = 0f
        speechStarted = false
        totalFrames = 0L
    }
}

class SpeechAudioCapture(private val context: Context, private val config: SpeechAudioCaptureConfig = SpeechAudioCaptureConfig()) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var job: Job? = null
    private var audioRecord: AudioRecord? = null
    @Volatile private var silenced = false

    val sampleRate: Int get() = config.sampleRate

    fun hasRecordPermission(): Boolean = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")
    fun start(onFrame: (SpeechAudioFrame) -> Unit, onFailure: (SpeechAudioCaptureFailure) -> Unit) {
        if (!hasRecordPermission()) {
            onFailure(SpeechAudioCaptureFailure.PermissionDenied)
            return
        }
        stopAsync()
        val minBufferSize = AudioRecord.getMinBufferSize(config.sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBufferSize <= 0) {
            onFailure(SpeechAudioCaptureFailure.InitializationFailed)
            return
        }
        val recorder = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, config.sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBufferSize, config.frameSamples * 2))
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            onFailure(SpeechAudioCaptureFailure.InitializationFailed)
            return
        }
        audioRecord = recorder
        registerRecordingCallback(recorder)
        val segmenter = SpeechVadSegmenter(config)
        job = scope.launch {
            val shorts = ShortArray(config.frameSamples)
            try {
                recorder.startRecording()
                while (isActive) {
                    val read = recorder.read(shorts, 0, shorts.size)
                    if (read == AudioRecord.ERROR_DEAD_OBJECT || read == AudioRecord.ERROR_INVALID_OPERATION) {
                        onFailure(SpeechAudioCaptureFailure.ReadFailed(read))
                        break
                    }
                    if (read <= 0) continue
                    val frame = FloatArray(read) { index -> shorts[index] / 32768f }
                    val audioFrame = segmenter.accept(frame, silenced)
                    onFrame(audioFrame)
                    if (audioFrame.silenced) onFailure(SpeechAudioCaptureFailure.SilencedBySystem)
                }
            } finally {
                releaseRecorder(recorder)
                if (audioRecord === recorder) audioRecord = null
            }
        }
    }

    suspend fun stop() {
        job?.cancelAndJoin()
        job = null
        audioRecord?.let(::releaseRecorder)
        audioRecord = null
        silenced = false
    }

    fun stopAsync() {
        job?.cancel()
        job = null
        audioRecord?.let(::releaseRecorder)
        audioRecord = null
        silenced = false
    }

    private fun registerRecordingCallback(recorder: AudioRecord) {
        if (Build.VERSION.SDK_INT < 29) return
        val audioManager = context.getSystemService(AudioManager::class.java) ?: return
        recorder.registerAudioRecordingCallback(context.mainExecutor, object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<android.media.AudioRecordingConfiguration>?) {
                val activeConfig = configs.orEmpty().firstOrNull { it.clientAudioSessionId == recorder.audioSessionId }
                silenced = activeConfig?.isClientSilenced == true
            }
        })
    }

    private fun releaseRecorder(recorder: AudioRecord) {
        runCatching { if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop() }
        runCatching { recorder.release() }
    }
}

private data class SpeechSampleMetrics(val rms: Float, val peak: Float, val magnitude: Float)

private fun FloatArray.metrics(): SpeechSampleMetrics {
    if (isEmpty()) return SpeechSampleMetrics(0f, 0f, 0f)
    var sum = 0.0
    var peak = 0f
    forEach { sample ->
        sum += sample * sample
        peak = maxOf(peak, kotlin.math.abs(sample))
    }
    val rms = sqrt(sum / size).toFloat()
    return SpeechSampleMetrics(rms = rms, peak = peak, magnitude = maxOf(rms, peak * 0.55f))
}
