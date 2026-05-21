package com.coder.pi

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.google.ai.edge.litert.Accelerator
import com.google.ai.edge.litert.CompiledModel
import com.google.ai.edge.litert.Environment
import com.google.ai.edge.litert.TensorBuffer
import com.google.ai.edge.litert.TensorType
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

data class ParakeetModelCacheStatus(
    val ready: Boolean,
    val bytesOnDisk: Long,
    val expectedBytes: Long,
    val gitLfsPointer: Boolean,
) {
    val hasCache: Boolean get() = bytesOnDisk > 0
    val label: String get() = when {
        ready -> "Ready (${bytesOnDisk.toHumanBytes()})"
        gitLfsPointer -> "Git LFS pointer, model payload missing"
        hasCache -> "Incomplete cache (${bytesOnDisk.toHumanBytes()} of ${expectedBytes.toHumanBytes()})"
        else -> "Parakeet model is not downloaded"
    }

    companion object {
        fun from(modelFile: File, artifact: ParakeetModelArtifact): ParakeetModelCacheStatus {
            val bytesOnDisk = if (modelFile.isFile) modelFile.length() else 0L
            val gitLfsPointer = modelFile.isGitLfsPointerFile()
            val ready = modelFile.isFile && !gitLfsPointer && bytesOnDisk == artifact.sizeBytes && modelFile.sha256OrNull() == artifact.sha256
            return ParakeetModelCacheStatus(ready, bytesOnDisk, artifact.sizeBytes, gitLfsPointer)
        }
    }
}

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

    fun isReady(): Boolean = modelFile.isFile && !modelFile.isGitLfsPointerFile() && modelFile.length() == artifact.sizeBytes && modelFile.sha256OrNull() == artifact.sha256

    fun status(): ParakeetModelCacheStatus = ParakeetModelCacheStatus.from(modelFile, artifact)

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

internal fun File.isGitLfsPointerFile(): Boolean {
    if (!isFile || length() > 512L) return false
    return runCatching { useLines { lines -> lines.firstOrNull()?.startsWith("version https://git-lfs.github.com/spec/v1") == true } }.getOrDefault(false)
}

class ParakeetTokenizerCache(private val context: Context, private val artifact: ParakeetTokenizerArtifact = ParakeetTokenizerArtifact()) {
    private val directory: File = File(context.filesDir, "speech/parakeet")
    val tokenizerFile: File = File(directory, artifact.fileName)

    fun isReady(): Boolean = tokenizerFile.isFile && tokenizerFile.length() > 0 && tokenizerFile.isValidParakeetTokenizer()

    suspend fun ensureTokenizer(): Result<File> = withContext(Dispatchers.IO) {
        runCatching {
            if (isReady()) return@runCatching tokenizerFile
            directory.mkdirs()
            val tempFile = File(directory, "${artifact.fileName}.part")
            URL(artifact.url).openStream().use { input -> tempFile.outputStream().use { output -> input.copyTo(output) } }
            check(tempFile.isValidParakeetTokenizer()) { "Tokenizer integrity failed" }
            if (tokenizerFile.exists()) tokenizerFile.delete()
            check(tempFile.renameTo(tokenizerFile)) { "Unable to move tokenizer into cache" }
            tokenizerFile
        }
    }
}

private fun File.isValidParakeetTokenizer(): Boolean = runCatching {
    val tokenizer = ParakeetTokenizer.fromTokenizerJson(readText())
    tokenizer.vocabularySize > 0
}.getOrDefault(false)

class LiteRtParakeetTranscriber(private val modelCache: ParakeetModelCache, private val tokenizerCache: ParakeetTokenizerCache) : SpeechTranscriber {
    private var compiledModel: CompiledModel? = null
    private var inputBuffers: List<TensorBuffer>? = null
    private var outputBuffers: List<TensorBuffer>? = null
    private val featureExtractor = ParakeetFeatureExtractor()

    override suspend fun transcribe(samples: FloatArray, sampleRate: Int, onEvent: (SpeechTranscriberEvent) -> Unit): Result<SpeechTranscriptResult> {
        if (!modelCache.isReady()) return Result.failure(SpeechTranscriberException(SpeechTranscriberFailure.ModelMissing))
        if (!tokenizerCache.isReady()) return Result.failure(SpeechTranscriberException(SpeechTranscriberFailure.ModelMissing))
        return runCatching {
            val startedAt = System.currentTimeMillis()
            ensureWarmModel()
            val model = compiledModel ?: throw SpeechTranscriberException(SpeechTranscriberFailure.RuntimeUnavailable)
            val inputs = inputBuffers ?: throw SpeechTranscriberException(SpeechTranscriberFailure.RuntimeUnavailable)
            val outputs = outputBuffers ?: throw SpeechTranscriberException(SpeechTranscriberFailure.RuntimeUnavailable)
            inputs[0].writeFloat(featureExtractor.extract(samples, sampleRate).fitTo(model.getInputTensorType(inputBufferName(0), ENCODE_SIGNATURE).numElements))
            model.run(inputs, outputs, ENCODE_SIGNATURE)
            if (isUnsafeReadFloatRuntime()) throw SpeechTranscriberException(SpeechTranscriberFailure.RuntimeUnavailable)
            val tokenIds = ParakeetTdtLiteRtDecoder(model).decode(outputs).map { it.first }.filter { it != END_OF_SEQUENCE }.toList()
            val tokenizer = ParakeetTokenizer.fromTokenizerJson(tokenizerCache.tokenizerFile.readText())
            SpeechTranscriptResult(tokenizer.decode(tokenIds), System.currentTimeMillis() - startedAt)
        }
    }

    private fun ensureWarmModel() {
        if (compiledModel != null) return
        val model = CompiledModel.create(modelCache.modelFile.absolutePath, CompiledModel.Options(setOf(Accelerator.CPU)), Environment.create())
        compiledModel = model
        inputBuffers = model.createInputBuffers(ENCODE_SIGNATURE)
        outputBuffers = model.createOutputBuffers(ENCODE_SIGNATURE)
    }

    override fun close() {
        compiledModel?.close()
        compiledModel = null
        inputBuffers = null
        outputBuffers = null
    }

    private fun isUnsafeReadFloatRuntime(): Boolean = android.os.Build.MODEL.contains("Pixel 7 Pro", ignoreCase = true) && android.os.Build.VERSION.SDK_INT >= 36

    companion object {
        const val ENCODE_SIGNATURE = "encode"
        const val DECODE_SIGNATURE = "decode"
        const val DECODE_1_SIGNATURE = "decode_1"
        const val END_OF_SEQUENCE = -1
        const val DECODE_START_TOKEN_ID = 8192
        const val NUM_FEATURES = 1024
        const val NUM_DURATIONS = 5

        fun inputBufferName(index: Int) = "args_$index"

        fun outputBufferName(index: Int) = "output_$index"
    }
}

private val TensorType.numElements: Int
    get() = layout!!.dimensions.fold(1, Int::times)

private fun FloatArray.fitTo(size: Int): FloatArray = when {
    this.size == size -> this
    this.size < size -> copyOf(size)
    else -> sliceArray((this.size - size) until this.size)
}

private fun Long.toHumanBytes(): String = when {
    this >= 1_000_000_000L -> "${this / 1_000_000_000L} GB"
    this >= 1_000_000L -> "${this / 1_000_000L} MB"
    this >= 1_000L -> "${this / 1_000L} KB"
    else -> "$this B"
}

class ParakeetTdtLiteRtDecoder(private val compiledModel: CompiledModel) {
    private val inputBuffers = compiledModel.createInputBuffers(LiteRtParakeetTranscriber.DECODE_SIGNATURE)
    private val outputBuffers = compiledModel.createOutputBuffers(LiteRtParakeetTranscriber.DECODE_SIGNATURE)
    private val maxTimeIndex = compiledModel.getInputTensorType(LiteRtParakeetTranscriber.inputBufferName(0), LiteRtParakeetTranscriber.DECODE_SIGNATURE).numElements / LiteRtParakeetTranscriber.NUM_FEATURES
    private val tokenCount = compiledModel.getInputTensorType(LiteRtParakeetTranscriber.inputBufferName(1), LiteRtParakeetTranscriber.DECODE_SIGNATURE).numElements
    private val logitsPerToken = compiledModel.getOutputTensorType(LiteRtParakeetTranscriber.outputBufferName(0), LiteRtParakeetTranscriber.DECODE_SIGNATURE).numElements / tokenCount / maxTimeIndex
    private val stateCount = compiledModel.getInputTensorType(LiteRtParakeetTranscriber.inputBufferName(2), LiteRtParakeetTranscriber.DECODE_SIGNATURE).numElements
    private val decode1InputBuffers = runCatching { compiledModel.createInputBuffers(LiteRtParakeetTranscriber.DECODE_1_SIGNATURE) }.getOrNull()
    private val decode1OutputBuffers = decode1InputBuffers?.let { compiledModel.createOutputBuffers(LiteRtParakeetTranscriber.DECODE_1_SIGNATURE) }
    private val stateBuffers = listOf(listOf(inputBuffers[2], inputBuffers[3]), listOf(outputBuffers[1], outputBuffers[2]))
    private var inputStateBuffersIndex = 0

    fun decode(encodeOutputBuffers: List<TensorBuffer>): Sequence<Pair<Int, Int>> = sequence {
        stateBuffers[inputStateBuffersIndex].forEach { it.writeFloat(FloatArray(stateCount)) }
        var inferenceSignature = LiteRtParakeetTranscriber.DECODE_SIGNATURE
        var inferenceTokenCount = tokenCount
        var inferenceTokenIdsBuffer = inputBuffers[1]
        var inferenceTokenIds = IntArray(tokenCount)
        inferenceTokenIds[0] = LiteRtParakeetTranscriber.DECODE_START_TOKEN_ID
        var inferenceLogitsBuffer = outputBuffers[0]
        var tokenIndex = 0
        var timeIndex = 0
        while (timeIndex < maxTimeIndex) {
            inferenceTokenIdsBuffer.writeInt(inferenceTokenIds)
            compiledModel.run(inputBuffersFor(encodeOutputBuffers, inferenceTokenIdsBuffer), outputBuffersFor(inferenceLogitsBuffer), inferenceSignature)
            val logits = inferenceLogitsBuffer.readFloat()
            val stepStart = timeIndex * inferenceTokenCount * logitsPerToken
            val tokenStart = stepStart + tokenIndex * logitsPerToken
            val durationEnd = stepStart + (tokenIndex + 1) * logitsPerToken
            val tokenEnd = durationEnd - LiteRtParakeetTranscriber.NUM_DURATIONS
            val tokenId = (tokenStart until tokenEnd).maxBy { logits[it] } - tokenStart
            if (tokenId != LiteRtParakeetTranscriber.DECODE_START_TOKEN_ID) {
                yield(tokenId to timeIndex)
                if (inferenceTokenCount > 1) {
                    tokenIndex++
                    if (tokenIndex >= inferenceTokenCount - 1) {
                        val decode1Inputs = decode1InputBuffers
                        val decode1Outputs = decode1OutputBuffers
                        if (decode1Inputs == null || decode1Outputs == null) break
                        inferenceSignature = LiteRtParakeetTranscriber.DECODE_1_SIGNATURE
                        inferenceTokenCount = 1
                        inferenceTokenIdsBuffer = decode1Inputs[1]
                        inferenceTokenIds = IntArray(1)
                        inferenceLogitsBuffer = decode1Outputs[0]
                        tokenIndex = 0
                    }
                }
                inferenceTokenIds[tokenIndex] = tokenId
            }
            val duration = (tokenEnd until durationEnd).maxBy { logits[it] } - tokenEnd
            timeIndex += if (duration == 0 && tokenId == LiteRtParakeetTranscriber.DECODE_START_TOKEN_ID) 1 else duration
            if (inferenceTokenCount == 1) inputStateBuffersIndex = 1 - inputStateBuffersIndex
        }
        yield(LiteRtParakeetTranscriber.END_OF_SEQUENCE to maxTimeIndex)
    }

    private fun inputBuffersFor(encodeOutputBuffers: List<TensorBuffer>, tokenIdsBuffer: TensorBuffer): List<TensorBuffer> = buildList {
        addAll(encodeOutputBuffers)
        add(tokenIdsBuffer)
        addAll(stateBuffers[inputStateBuffersIndex])
    }

    private fun outputBuffersFor(logitsBuffer: TensorBuffer): List<TensorBuffer> = listOf(logitsBuffer) + stateBuffers[1 - inputStateBuffersIndex]
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
    val vocabularySize: Int get() = vocabulary.size

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
