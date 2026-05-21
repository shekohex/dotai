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
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

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
    private val melFilters = createMelFilters()

    fun extract(samples: FloatArray, sampleRate: Int): FloatArray {
        require(sampleRate == config.sampleRate) { "Expected ${config.sampleRate} Hz audio" }
        val padded = samples.copyOf(config.inputSamples)
        val emphasized = applyPreemphasis(padded)
        val spectrogram = Array(config.nMels) { FloatArray(config.nFrames) }
        val hop = 160
        val window = FloatArray(config.nFft) { index -> (0.5 - 0.5 * cos(2.0 * PI * index / (config.nFft - 1))).toFloat() }
        for (frame in 0 until config.nFrames) {
            val start = frame * hop
            val power = powerSpectrum(emphasized, start, window)
            for (mel in 0 until config.nMels) {
                var energy = 0f
                val filter = melFilters[mel]
                for (bin in filter.indices) energy += power[bin] * filter[bin]
                spectrogram[mel][frame] = ln(energy + 2.0f.pow(-24))
            }
        }
        normalizeByMel(spectrogram)
        return FloatArray(config.featureCount) { index -> spectrogram[index / config.nFrames][index % config.nFrames] }
    }

    private fun applyPreemphasis(samples: FloatArray): FloatArray {
        if (samples.isEmpty()) return samples
        val output = FloatArray(samples.size)
        output[0] = samples[0]
        for (index in 1 until samples.size) output[index] = samples[index] - config.preemphasis * samples[index - 1]
        return output
    }

    private fun powerSpectrum(samples: FloatArray, start: Int, window: FloatArray): FloatArray {
        val bins = config.nFft / 2 + 1
        val power = FloatArray(bins)
        for (bin in 0 until bins) {
            var real = 0.0
            var imaginary = 0.0
            for (index in 0 until config.nFft) {
                val sample = samples.getOrElse(start + index) { 0f } * window[index]
                val angle = 2.0 * PI * bin * index / config.nFft
                real += sample * cos(angle)
                imaginary -= sample * sin(angle)
            }
            power[bin] = ((real * real + imaginary * imaginary) / config.nFft).toFloat()
        }
        return power
    }

    private fun createMelFilters(): Array<FloatArray> {
        val bins = config.nFft / 2 + 1
        val minMel = hzToMel(0f)
        val maxMel = hzToMel(config.sampleRate / 2f)
        val melPoints = FloatArray(config.nMels + 2) { index -> minMel + (maxMel - minMel) * index / (config.nMels + 1) }
        val binPoints = melPoints.map { mel -> ((config.nFft + 1) * melToHz(mel) / config.sampleRate).toInt().coerceIn(0, bins - 1) }
        return Array(config.nMels) { melIndex ->
            FloatArray(bins) { bin ->
                val left = binPoints[melIndex]
                val center = binPoints[melIndex + 1].coerceAtLeast(left + 1)
                val right = binPoints[melIndex + 2].coerceAtLeast(center + 1)
                when (bin) {
                    in left until center -> (bin - left).toFloat() / (center - left)
                    in center until right -> (right - bin).toFloat() / (right - center)
                    else -> 0f
                }
            }
        }
    }

    private fun normalizeByMel(spectrogram: Array<FloatArray>) {
        spectrogram.forEach { frames ->
            val mean = frames.average().toFloat()
            var variance = 0f
            frames.forEach { value -> variance += (value - mean) * (value - mean) }
            val std = sqrt(variance / (frames.size - 1).coerceAtLeast(1)) + 1e-5f
            for (index in frames.indices) frames[index] = (frames[index] - mean) / std
        }
    }

    private fun hzToMel(hz: Float): Float = (2595.0 * kotlin.math.log10(1.0 + hz / 700.0)).toFloat()

    private fun melToHz(mel: Float): Float = (700.0 * (10.0.pow(mel / 2595.0) - 1.0)).toFloat()
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
