package com.coder.pi

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.google.ai.edge.litert.Accelerator
import com.google.ai.edge.litert.CompiledModel
import com.google.ai.edge.litert.Environment
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

data class ParakeetTokenizerArtifact(
    val fileName: String = "parakeet_tdt_0.6b_v3_tokenizer.json",
    val url: String = "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/main/tokenizer.json",
)

data class ParakeetFeatureConfig(
    val sampleRate: Int = 16_000,
    val inputMilliseconds: Int = 5_000,
    val nFft: Int = 512,
    val nMels: Int = 128,
    val nFrames: Int = 500,
    val preemphasis: Float = 0.97f,
) {
    val inputSamples: Int = sampleRate * inputMilliseconds / 1_000
    val featureCount: Int = nMels * nFrames
}

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

class ParakeetTokenizerCache(private val context: Context, private val artifact: ParakeetTokenizerArtifact = ParakeetTokenizerArtifact()) {
    private val directory: File = File(context.filesDir, "speech/parakeet")
    val tokenizerFile: File = File(directory, artifact.fileName)

    fun isReady(): Boolean = tokenizerFile.isFile && tokenizerFile.length() > 0

    suspend fun ensureTokenizer(): Result<File> = withContext(Dispatchers.IO) {
        runCatching {
            if (isReady()) return@runCatching tokenizerFile
            directory.mkdirs()
            URL(artifact.url).openStream().use { input -> tokenizerFile.outputStream().use { output -> input.copyTo(output) } }
            tokenizerFile
        }
    }
}

class LiteRtParakeetTranscriber(private val modelCache: ParakeetModelCache) : SpeechTranscriber {
    private var compiledModel: CompiledModel? = null

    override suspend fun transcribe(samples: FloatArray, sampleRate: Int, onEvent: (SpeechTranscriberEvent) -> Unit): Result<SpeechTranscriptResult> {
        if (!modelCache.isReady()) return Result.failure(SpeechTranscriberException(SpeechTranscriberFailure.ModelMissing))
        return runCatching {
            ensureWarmModel()
            throw SpeechTranscriberException(SpeechTranscriberFailure.RuntimeUnavailable)
        }
    }

    private fun ensureWarmModel() {
        if (compiledModel != null) return
        compiledModel = CompiledModel.create(modelCache.modelFile.absolutePath, CompiledModel.Options(setOf(Accelerator.CPU)), Environment.create())
    }

    override fun close() {
        compiledModel?.close()
        compiledModel = null
    }
}

class ParakeetFeatureExtractor(private val config: ParakeetFeatureConfig = ParakeetFeatureConfig()) {
    fun extract(samples: FloatArray, sampleRate: Int): FloatArray {
        require(sampleRate == config.sampleRate) { "Expected ${config.sampleRate} Hz audio" }
        val padded = samples.copyOf(config.inputSamples)
        val emphasized = applyPreemphasis(padded)
        val features = FloatArray(config.featureCount)
        val hop = (emphasized.size / config.nFrames).coerceAtLeast(1)
        for (frame in 0 until config.nFrames) {
            val start = frame * hop
            if (start >= emphasized.size) break
            var energy = 0f
            val end = minOf(start + hop, emphasized.size)
            for (index in start until end) energy += emphasized[index] * emphasized[index]
            val logEnergy = kotlin.math.ln((energy / (end - start).coerceAtLeast(1)) + 1e-6f)
            for (mel in 0 until config.nMels) features[mel * config.nFrames + frame] = logEnergy
        }
        return features
    }

    private fun applyPreemphasis(samples: FloatArray): FloatArray {
        if (samples.isEmpty()) return samples
        val output = FloatArray(samples.size)
        output[0] = samples[0]
        for (index in 1 until samples.size) output[index] = samples[index] - config.preemphasis * samples[index - 1]
        return output
    }
}

class ParakeetTokenizer(private val vocabulary: Map<Int, String>) {
    fun decode(tokenIds: Iterable<Int>): String = tokenIds.mapNotNull(vocabulary::get).joinToString("").replace("▁", " ").trim()

    companion object {
        fun fromTokenizerJson(jsonText: String): ParakeetTokenizer {
            val root = Json.parseToJsonElement(jsonText).jsonObject
            val vocabularyObject = root["model"]?.jsonObject?.get("vocab")?.jsonObject ?: root["vocab"]?.jsonObject ?: JsonObject(emptyMap())
            val vocabulary = vocabularyObject.mapNotNull { (token, idElement) ->
                val id = idElement.jsonPrimitive.intOrNull ?: return@mapNotNull null
                id to token
            }.toMap()
            return ParakeetTokenizer(vocabulary)
        }
    }
}

object TdtGreedyDecoder {
    fun decode(logitsByStep: List<FloatArray>, blankTokenId: Int, durationCount: Int = 5): List<Int> {
        return logitsByStep.mapNotNull { logits ->
            if (logits.size <= durationCount) return@mapNotNull null
            val tokenLogitEnd = logits.size - durationCount
            val tokenId = (0 until tokenLogitEnd).maxBy { logits[it] }
            tokenId.takeIf { it != blankTokenId }
        }
    }
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
