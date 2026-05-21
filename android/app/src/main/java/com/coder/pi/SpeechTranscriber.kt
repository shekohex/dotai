package com.coder.pi

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.URL
import java.security.MessageDigest

data class SpeechTranscriptResult(
    val text: String,
    val elapsedMillis: Long,
)

sealed interface SpeechTranscriberFailure {
    data object ModelMissing : SpeechTranscriberFailure
    data object RuntimeUnavailable : SpeechTranscriberFailure
    data class ModelIntegrityFailed(val expectedSha256: String, val actualSha256: String) : SpeechTranscriberFailure
    data class IoFailure(val message: String) : SpeechTranscriberFailure
}

sealed interface SpeechTranscriberEvent {
    data class ModelDownloadProgress(val bytesRead: Long, val totalBytes: Long) : SpeechTranscriberEvent
    data object ModelReady : SpeechTranscriberEvent
}

interface SpeechTranscriber : AutoCloseable {
    suspend fun transcribe(samples: FloatArray, sampleRate: Int, onEvent: (SpeechTranscriberEvent) -> Unit = {}): Result<SpeechTranscriptResult>
}

data class ParakeetModelArtifact(
    val fileName: String,
    val url: String,
    val sha256: String,
    val sizeBytes: Long,
)

object ParakeetModelArtifacts {
    val int8 = ParakeetModelArtifact(
        fileName = "parakeet_tdt_0.6b_v3_5s_i8.tflite",
        url = "https://huggingface.co/litert-community/parakeet-tdt-0.6b-v3/resolve/main/parakeet_tdt_0.6b_v3_5s_i8.tflite",
        sha256 = "f25e5972fe72048f67272e26d4badfe19d876e0fa19027cb2c6c0e0fc4da692b",
        sizeBytes = 614_437_424L,
    )
}

class ParakeetModelCache(private val context: Context, private val artifact: ParakeetModelArtifact = ParakeetModelArtifacts.int8) {
    private val directory: File = File(context.filesDir, "speech/parakeet")
    val modelFile: File = File(directory, artifact.fileName)

    fun isReady(): Boolean = modelFile.isFile && modelFile.length() == artifact.sizeBytes && modelFile.sha256OrNull() == artifact.sha256

    suspend fun ensureModel(onEvent: (SpeechTranscriberEvent.ModelDownloadProgress) -> Unit = {}): Result<File> = withContext(Dispatchers.IO) {
        runCatching {
            if (isReady()) return@runCatching modelFile
            directory.mkdirs()
            val tempFile = File(directory, "${artifact.fileName}.part")
            URL(artifact.url).openStream().use { input ->
                tempFile.outputStream().use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var total = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        total += read
                        onEvent(SpeechTranscriberEvent.ModelDownloadProgress(total, artifact.sizeBytes))
                    }
                }
            }
            val actualSha256 = tempFile.sha256OrNull().orEmpty()
            if (actualSha256 != artifact.sha256) {
                tempFile.delete()
                error("Model integrity failed: expected ${artifact.sha256}, got $actualSha256")
            }
            if (modelFile.exists()) modelFile.delete()
            check(tempFile.renameTo(modelFile)) { "Unable to move model into cache" }
            modelFile
        }
    }

    fun delete(): Boolean {
        if (!directory.exists()) return true
        return directory.deleteRecursively()
    }
}

class LiteRtParakeetTranscriber(private val modelCache: ParakeetModelCache) : SpeechTranscriber {
    override suspend fun transcribe(samples: FloatArray, sampleRate: Int, onEvent: (SpeechTranscriberEvent) -> Unit): Result<SpeechTranscriptResult> {
        if (!modelCache.isReady()) return Result.failure(SpeechTranscriberException(SpeechTranscriberFailure.ModelMissing))
        return Result.failure(SpeechTranscriberException(SpeechTranscriberFailure.RuntimeUnavailable))
    }

    override fun close() = Unit
}

class SpeechTranscriberException(val failure: SpeechTranscriberFailure) : Exception(failure.toString())

object SpeechTranscriptOverlapMerger {
    fun merge(previous: String, next: String): String {
        val left = previous.trim()
        val right = next.trim()
        if (left.isEmpty()) return right
        if (right.isEmpty()) return left
        val leftWords = left.split(Regex("\\s+"))
        val rightWords = right.split(Regex("\\s+"))
        val maxOverlap = minOf(leftWords.size, rightWords.size, 24)
        val overlap = (maxOverlap downTo 1).firstOrNull { count ->
            leftWords.takeLast(count).map { it.lowercase() } == rightWords.take(count).map { it.lowercase() }
        } ?: 0
        return (leftWords + rightWords.drop(overlap)).joinToString(" ")
    }
}

private fun File.sha256OrNull(): String? = runCatching {
    val digest = MessageDigest.getInstance("SHA-256")
    inputStream().use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
        }
    }
    digest.digest().joinToString("") { byte -> "%02x".format(byte) }
}.getOrNull()
