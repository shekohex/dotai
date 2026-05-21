package com.coder.pi

import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateContentSize
import android.Manifest
import android.net.Uri
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import android.content.pm.PackageManager
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import androidx.compose.ui.layout.ContentScale
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.math.pow

data class ChatImageAttachment(val uri: Uri, val caption: String = "")

@Composable
fun ChatInputBar(tokens: UiTokens, text: String, onTextChanged: (String) -> Unit, modifier: Modifier = Modifier, attachments: List<ChatImageAttachment> = emptyList(), onAttach: () -> Unit = {}, onRemoveAttachment: (Int) -> Unit = {}, onReplaceAttachment: (Int) -> Unit = {}, onCaptionAttachment: (Int, String) -> Unit = { _, _ -> }, visibleTerminalLines: () -> List<String> = { emptyList() }, speechEnhancementClient: SpeechEnhancementClient? = null, onClear: () -> Unit, onSubmit: (String) -> Unit, onReturn: () -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var speechSettings by remember(context) { mutableStateOf(SpeechSettingsStore.values(context)) }
    DisposableEffect(context) {
        val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key?.startsWith("speech.") == true) speechSettings = SpeechSettingsStore.values(context)
        }
        val preferences = SpeechSettingsStore.registerChangeListener(context, listener)
        onDispose { preferences.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    val speechModelCache = remember(context, speechSettings.selectedSpeechModelId) { ParakeetModelCache(context, ParakeetModelArtifacts.byId(speechSettings.selectedSpeechModelId)) }
    val speechTokenizerCache = remember(context) { ParakeetTokenizerCache(context) }
    val speechAudioCapture = remember(context, speechSettings.vadSensitivity) { SpeechAudioCapture(context, speechSettings.toAudioCaptureConfig()) }
    var speechTranscriber by remember(context, speechSettings.selectedSpeechModelId, speechSettings.accelerator) { mutableStateOf<LiteRtParakeetTranscriber?>(null) }
    val speechPromptRenderer = remember { SpeechEnhancementPromptRenderer() }
    val speechSoundFeedback = remember(context) { SpeechSoundFeedback(context) }
    var dictating by remember { mutableStateOf(false) }
    var dictationState by remember { mutableStateOf(SpeechDictationDisplayState.IDLE) }
    var dictationTranscript by remember { mutableStateOf("") }
    var dictationRawTranscript by remember { mutableStateOf("") }
    var dictationMeter by remember { mutableStateOf(0f) }
    var dictationWaveformLevels by remember { mutableStateOf(List(15) { 0f }) }
    val dictationAudioFrames = remember { mutableListOf<FloatArray>() }
    var partialTranscriptionJob by remember { mutableStateOf<Job?>(null) }
    var partialTranscriptionLoopJob by remember { mutableStateOf<Job?>(null) }
    var finalTranscriptionJob by remember { mutableStateOf<Job?>(null) }
    var enhancementJob by remember { mutableStateOf<Job?>(null) }
    var warmModelJob by remember { mutableStateOf<Job?>(null) }
    var dictationSessionId by remember { mutableIntStateOf(0) }
    var liveChunkEndSample by remember { mutableIntStateOf(16_000) }
    val liveTranscriptMerger = remember { LiveSpeechTranscriptMerger() }
    val speechTranscriberMutex = remember { Mutex() }
    var dictationStartedAt by remember { mutableStateOf(0L) }
    var firstPartialAt by remember { mutableStateOf<Long?>(null) }
    var lastSpeechMetrics by remember { mutableStateOf<SpeechTranscriptionMetrics?>(null) }
    var lastAppliedPartialEndSample by remember { mutableIntStateOf(0) }
    val frameJobs = remember { mutableListOf<Job>() }
    var expandedEditor by remember { mutableStateOf(false) }
    var selectedAttachmentIndex by remember { mutableStateOf<Int?>(null) }
    val attachmentVisible = attachments.isNotEmpty()
    val submitText = {
        text.trimEnd().takeIf { it.isNotBlank() }?.let(onSubmit)
        onTextChanged("")
    }
    fun stopDictationCapture() {
        dictationMeter = 0f
        scope.launch { speechAudioCapture.stop() }
    }
    suspend fun stopDictationCaptureAndDrainFrames() {
        dictationMeter = 0f
        speechAudioCapture.stop()
        frameJobs.toList().forEach { it.join() }
        frameJobs.clear()
    }
    fun clearDictationSession() {
        dictationSessionId++
        finalTranscriptionJob?.cancel()
        finalTranscriptionJob = null
        enhancementJob?.cancel()
        enhancementJob = null
        partialTranscriptionJob?.cancel()
        partialTranscriptionJob = null
        partialTranscriptionLoopJob?.cancel()
        partialTranscriptionLoopJob = null
        frameJobs.forEach { it.cancel() }
        frameJobs.clear()
        dictating = false
        dictationState = SpeechDictationDisplayState.IDLE
        dictationTranscript = ""
        dictationRawTranscript = ""
        dictationAudioFrames.clear()
        liveChunkEndSample = speechAudioCapture.sampleRate
        liveTranscriptMerger.reset()
        dictationWaveformLevels = List(15) { 0f }
    }
    fun acceptDictationTranscript(transcript: String = dictationTranscript) {
        val mergedDraft = mergeSpeechTranscriptIntoDraft(text, transcript)
        if (mergedDraft.isNotBlank()) onTextChanged(mergedDraft)
        if (speechSettings.soundFeedbackEnabled) speechSoundFeedback.playStop()
        stopDictationCapture()
        clearDictationSession()
    }
    fun enhanceTranscript(transcript: String, sessionId: Int) {
        if (!speechSettings.enhancementEnabled || speechEnhancementClient == null || transcript.isBlank()) {
            dictationState = SpeechDictationDisplayState.TRANSCRIPT_READY
            return
        }
        dictationState = SpeechDictationDisplayState.ENHANCING_COLLAPSED
        enhancementJob?.cancel()
        enhancementJob = scope.launch {
            runCatching {
                val prompt = speechSettings.resolvedPrompt(SpeechSettingsStore.defaultPrompt(context))
                val contextLines = if (speechSettings.includeVisibleTerminalContext) visibleTerminalLines() else emptyList()
                val request = speechPromptRenderer.render(prompt, transcript, contextLines)
                SpeechEnhancer(speechEnhancementClient).enhanceOrRaw(request)
            }.fold(
                onSuccess = { result ->
                    if (sessionId != dictationSessionId) return@fold
                    dictationTranscript = result.text
                    dictationState = if (result.enhanced) SpeechDictationDisplayState.ENHANCED_READY else SpeechDictationDisplayState.TRANSCRIPT_READY
                },
                onFailure = {
                    if (sessionId != dictationSessionId) return@fold
                    dictationTranscript = transcript
                    dictationState = SpeechDictationDisplayState.TRANSCRIPT_READY
                },
            )
        }
    }
    fun transcribeDictationAudio(frames: List<FloatArray> = dictationAudioFrames.toList()) {
        partialTranscriptionLoopJob?.cancel()
        partialTranscriptionLoopJob = null
        partialTranscriptionJob?.cancel()
        partialTranscriptionJob = null
        finalTranscriptionJob?.cancel()
        val sessionId = dictationSessionId
        finalTranscriptionJob = scope.launch {
            val samples = withContext(Dispatchers.Default) { frames.flattenToFloatArray() }
            if (sessionId != dictationSessionId) return@launch
            if (!speechSettings.localTranscriptionEnabled || samples.isEmpty()) {
                dictationTranscript = "Speech transcription unavailable."
                dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
                return@launch
            }
            val activeTranscriber = speechTranscriber
            if (activeTranscriber == null) {
                dictationTranscript = "Speech model is still warming. Try again in a moment."
                dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
                return@launch
            }
            val result = transcribeFinalSpeech(samples, speechAudioCapture.sampleRate, activeTranscriber, speechTranscriberMutex)
            if (sessionId != dictationSessionId) return@launch
            result.getOrNull()?.metrics?.let { lastSpeechMetrics = it }
            result.fold(
                onSuccess = {
                    val transcript = selectFinalSpeechTranscript(it.text, dictationTranscript)
                    if (transcript.isBlank()) {
                        dictationTranscript = "No speech detected."
                        dictationState = SpeechDictationDisplayState.NO_SPEECH
                    } else {
                        dictationRawTranscript = transcript
                        dictationTranscript = transcript
                        enhanceTranscript(transcript, sessionId)
                    }
                },
                onFailure = {
                    dictationTranscript = "Speech transcription unavailable."
                    dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
                },
            )
        }
    }
    suspend fun runPartialTranscriptionPass(sessionId: Int) {
        if (!speechSettings.localTranscriptionEnabled) return
        val totalSamples = dictationAudioFrames.totalSampleCount()
        if (totalSamples < liveChunkEndSample) return
        val partialEndSample = totalSamples
        val liveWindowSamples = liveSpeechWindowSamples(speechAudioCapture.sampleRate)
        val trailingSilenceSamples = liveSpeechTrailingSilenceSamples(speechAudioCapture.sampleRate)
        val snapshot = dictationAudioFrames.sliceSampleWindow(liveSpeechWindowStartSample(partialEndSample, speechAudioCapture.sampleRate), partialEndSample, liveWindowSamples).padTrailingSilence(trailingSilenceSamples)
        liveChunkEndSample = nextLiveSpeechPassSample(totalSamples, speechAudioCapture.sampleRate)
        val activeTranscriber = speechTranscriber ?: return
        val result = speechTranscriberMutex.withLock { activeTranscriber.transcribe(snapshot, speechAudioCapture.sampleRate) }
        if (sessionId != dictationSessionId) return
        if (partialEndSample <= lastAppliedPartialEndSample) return
        result.getOrNull()?.metrics?.let { lastSpeechMetrics = it }
        result.getOrNull()?.text?.trim()?.takeIf { it.isNotBlank() }?.let { partialText ->
            if (dictationState in setOf(SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationDisplayState.RECORDING_WITH_SPEECH)) {
                if (firstPartialAt == null) firstPartialAt = SystemClock.elapsedRealtime()
                dictationTranscript = liveTranscriptMerger.merge(partialText)
                lastAppliedPartialEndSample = partialEndSample
            }
        }
    }
    fun startPartialTranscriptionLoop(sessionId: Int) {
        partialTranscriptionLoopJob?.cancel()
        partialTranscriptionLoopJob = scope.launch {
            while (sessionId == dictationSessionId && dictationState in setOf(SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationDisplayState.RECORDING_WITH_SPEECH)) {
                delay(1_000L)
                if (sessionId != dictationSessionId) return@launch
                if (dictationState !in setOf(SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationDisplayState.RECORDING_WITH_SPEECH)) return@launch
                if (speechAudioCapture.sampleRate <= 0) continue
                runPartialTranscriptionPass(sessionId)
                if (sessionId == dictationSessionId) {
                    partialTranscriptionJob = null
                }
            }
        }
    }
    fun startDictationCapture() {
        if (speechSettings.localTranscriptionEnabled && (!speechModelCache.isReady() || !speechTokenizerCache.isReady())) {
            dictating = true
            dictationTranscript = if (!speechModelCache.isReady()) "Speech model not ready. Open Speech Models to download or import it." else "Speech tokenizer not ready. Open Speech Models to download or import it."
            dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
            if (speechSettings.soundFeedbackEnabled) speechSoundFeedback.playFailure()
            return
        }
        if (speechSettings.soundFeedbackEnabled) speechSoundFeedback.playStart()
        dictationSessionId++
        dictationStartedAt = SystemClock.elapsedRealtime()
        firstPartialAt = null
        lastSpeechMetrics = null
        lastAppliedPartialEndSample = 0
        dictationState = SpeechDictationDisplayState.RECORDING_EMPTY
        dictationTranscript = ""
        dictationRawTranscript = ""
        dictationMeter = 0f
        dictationAudioFrames.clear()
        partialTranscriptionJob?.cancel()
        partialTranscriptionJob = null
        partialTranscriptionLoopJob?.cancel()
        partialTranscriptionLoopJob = null
        finalTranscriptionJob?.cancel()
        finalTranscriptionJob = null
        enhancementJob?.cancel()
        enhancementJob = null
        liveChunkEndSample = speechAudioCapture.sampleRate
        liveTranscriptMerger.reset()
        dictationWaveformLevels = List(15) { 0f }
        dictating = true
        val sessionId = dictationSessionId
        startPartialTranscriptionLoop(sessionId)
        speechAudioCapture.start(
            onFrame = { frame ->
                val job = scope.launch {
                    dictationAudioFrames.add(frame.samples.copyOf())
                    dictationMeter = frame.meter
                    dictationWaveformLevels = dictationWaveformLevels.drop(1) + frame.meter
                    if (frame.speechDetected && dictationState == SpeechDictationDisplayState.RECORDING_EMPTY) dictationState = SpeechDictationDisplayState.RECORDING_WITH_SPEECH
                }
                frameJobs.add(job)
            },
            onFailure = { failure ->
                scope.launch {
                    dictationTranscript = when (failure) {
                        SpeechAudioCaptureFailure.PermissionDenied -> "Microphone permission denied."
                        SpeechAudioCaptureFailure.InitializationFailed -> "Microphone unavailable."
                        SpeechAudioCaptureFailure.SilencedBySystem -> "Microphone capture was silenced by Android."
                        is SpeechAudioCaptureFailure.ReadFailed -> "Microphone capture failed."
                    }
                    dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
                    if (speechSettings.soundFeedbackEnabled) speechSoundFeedback.playFailure()
                    stopDictationCapture()
                }
            },
        )
    }
    val audioPermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            startDictationCapture()
        } else {
            dictationTranscript = "Microphone permission denied."
            dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
            dictating = true
        }
    }
    LaunchedEffect(speechSettings.keepModelWarmEnabled, speechSettings.keepModelWarmMinutes, speechSettings.selectedSpeechModelId, speechSettings.accelerator, speechSettings.localTranscriptionEnabled) {
        warmModelJob?.cancel()
        warmModelJob = null
        if (speechSettings.keepModelWarmEnabled && speechSettings.localTranscriptionEnabled) {
            warmModelJob = scope.launch {
                SpeechWarmModelService.start(context)
                speechTranscriber = SpeechWarmModelStore.transcriber(context, speechSettings)
                lastSpeechMetrics = speechTranscriberMutex.withLock { SpeechWarmModelStore.warm(context, speechSettings) }.getOrNull()
            }
        } else {
            SpeechWarmModelService.stop(context)
        }
    }
    LaunchedEffect(context, speechSettings.selectedSpeechModelId, speechSettings.accelerator) {
        speechTranscriber = SpeechWarmModelStore.transcriber(context, speechSettings)
    }
    DisposableEffect(speechAudioCapture) { onDispose { partialTranscriptionLoopJob?.cancel(); partialTranscriptionJob?.cancel(); finalTranscriptionJob?.cancel(); enhancementJob?.cancel(); warmModelJob?.cancel(); speechAudioCapture.stopAsync() } }
    if (dictating) {
        DictationInputSurface(
            tokens = tokens,
            displayState = dictationState,
            transcript = dictationTranscript,
            meter = dictationMeter,
            waveformLevels = dictationWaveformLevels,
            metrics = lastSpeechMetrics,
            firstPartialMillis = firstPartialAt?.let { it - dictationStartedAt },
            modifier = modifier,
            onAction = { action ->
                val nextState = SpeechDictationUxContract.transition(dictationState, action)
                dictationState = nextState
                when (action) {
                    SpeechDictationAction.START_RECORDING -> startDictationCapture()
                    SpeechDictationAction.DETECT_SPEECH -> dictationTranscript = SpeechDictationUxContract.fixtures.partialTranscript
                    SpeechDictationAction.COMPLETE_TRANSCRIPTION -> dictationTranscript = SpeechDictationUxContract.fixtures.finalTranscript
                    SpeechDictationAction.COMPLETE_ENHANCEMENT -> dictationTranscript = SpeechDictationUxContract.fixtures.enhancedTranscript
                    SpeechDictationAction.START_ENHANCEMENT, SpeechDictationAction.RETRY_ENHANCEMENT -> enhanceTranscript(dictationRawTranscript.ifBlank { dictationTranscript }, dictationSessionId)
                    SpeechDictationAction.SEND_RAW -> acceptDictationTranscript(dictationRawTranscript.ifBlank { dictationTranscript })
                    SpeechDictationAction.SEND_ENHANCED -> acceptDictationTranscript(dictationTranscript)
                    SpeechDictationAction.CANCEL, SpeechDictationAction.RESET -> {
                        if (speechSettings.soundFeedbackEnabled) speechSoundFeedback.playCancel()
                        stopDictationCapture()
                        clearDictationSession()
                    }
                    SpeechDictationAction.STOP_RECORDING -> {
                        dictationState = SpeechDictationDisplayState.TRANSCRIBING
                        if (speechSettings.soundFeedbackEnabled) speechSoundFeedback.playStop()
                        scope.launch {
                            stopDictationCaptureAndDrainFrames()
                            transcribeDictationAudio()
                        }
                    }
                    else -> Unit
                }
            },
        )
        return
    }
    ChatModeDock(tokens, modifier, attachmentVisible) {
        ChatDraftField(
            text = text,
            tokens = tokens,
            attachments = attachments,
            onExpand = { expandedEditor = true },
            onAttachment = { selectedAttachmentIndex = it },
            onRemoveAttachment = onRemoveAttachment,
            onTextChanged = { value ->
                onTextChanged(value)
            },
        )
        ChatActionRail(
            tokens = tokens,
            onAttach = { hapticClick(); onAttach() },
            onClose = onClose,
            onClear = onClear,
            canClear = text.isNotBlank() || attachments.isNotEmpty(),
            onMic = {
                hapticClick()
                if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startDictationCapture() else audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            },
            sendIcon = if (text.isBlank()) R.drawable.ic_feather_corner_down_left else R.drawable.ic_feather_arrow_up,
            sendAccent = text.isNotBlank(),
            onSend = { if (text.isBlank()) onReturn() else submitText() },
        )
    }
    if (expandedEditor) FullscreenChatEditor(text, tokens, onTextChanged, { expandedEditor = false })
    selectedAttachmentIndex?.let { index ->
        attachments.getOrNull(index)?.let { attachment ->
            AttachmentDetailsDialog(attachment, tokens, { selectedAttachmentIndex = null }, { onRemoveAttachment(index); selectedAttachmentIndex = null }, { onReplaceAttachment(index); selectedAttachmentIndex = null }) { onCaptionAttachment(index, it) }
        } ?: run { selectedAttachmentIndex = null }
    }
}

fun selectFinalSpeechTranscript(finalTranscript: String, liveTranscript: String, sampleCount: Int = 0, sampleRate: Int = 16_000): String {
    val finalClean = finalTranscript.trim()
    val liveClean = liveTranscript.trim()
    if (finalClean.isNotBlank()) return finalClean
    return liveClean
}

suspend fun transcribeFinalSpeech(samples: FloatArray, sampleRate: Int, speechTranscriber: SpeechTranscriber, speechTranscriberMutex: Mutex): Result<SpeechTranscriptResult> {
    if (sampleRate <= 0 || samples.size <= sampleRate * 5) return speechTranscriberMutex.withLock { speechTranscriber.transcribe(samples, sampleRate) }
    val merger = LiveSpeechTranscriptMerger(confirmationsNeeded = 1, minWordsToConfirm = 2)
    var lastMetrics: SpeechTranscriptionMetrics? = null
    var elapsedMillis = 0L
    var hasFailure: Throwable? = null
    finalSpeechChunks(samples, sampleRate).forEach { chunk ->
        val result = speechTranscriberMutex.withLock { speechTranscriber.transcribe(chunk, sampleRate) }
        result.fold(
            onSuccess = {
                elapsedMillis += it.elapsedMillis
                lastMetrics = it.metrics
                it.text.trim().takeIf { text -> text.isNotBlank() }?.let(merger::merge)
            },
            onFailure = { if (hasFailure == null) hasFailure = it },
        )
    }
    val text = merger.merge("").trim()
    if (text.isNotBlank()) return Result.success(SpeechTranscriptResult(text, elapsedMillis, lastMetrics ?: SpeechTranscriptionMetrics(totalMillis = elapsedMillis, sampleCount = samples.size, sampleRate = sampleRate)))
    return hasFailure?.let { Result.failure(it) } ?: Result.success(SpeechTranscriptResult("", elapsedMillis, lastMetrics ?: SpeechTranscriptionMetrics(totalMillis = elapsedMillis, sampleCount = samples.size, sampleRate = sampleRate)))
}

fun finalSpeechChunks(samples: FloatArray, sampleRate: Int): List<FloatArray> {
    if (sampleRate <= 0 || samples.isEmpty()) return emptyList()
    val windowSamples = sampleRate * 4
    val stepSamples = sampleRate * 2
    val trailingSilenceSamples = sampleRate
    val chunks = mutableListOf<FloatArray>()
    var start = 0
    while (start < samples.size) {
        val end = (start + windowSamples).coerceAtMost(samples.size)
        chunks.add(samples.copyOfRange(start, end).padTrailingSilence(trailingSilenceSamples))
        if (end == samples.size) break
        start += stepSamples
    }
    return chunks
}

fun mergeSpeechTranscriptIntoDraft(draft: String, transcript: String): String {
    val cleanTranscript = transcript.trim()
    if (cleanTranscript.isBlank()) return draft
    if (draft.isBlank()) return cleanTranscript
    val separator = if (draft.endsWith("\n") || draft.endsWith(" ")) "" else " "
    return draft + separator + cleanTranscript
}

internal fun SpeechSettingsValues.toAudioCaptureConfig(): SpeechAudioCaptureConfig {
    val threshold = when (vadSensitivity.coerceIn(0, 4)) {
        0 -> 0.024f
        1 -> 0.018f
        2 -> 0.012f
        3 -> 0.008f
        else -> 0.005f
    }
    return SpeechAudioCaptureConfig(silenceThreshold = threshold, peakThreshold = threshold * 3.75f)
}

private fun List<FloatArray>.flattenToFloatArray(): FloatArray {
    val totalSize = sumOf { it.size }
    val samples = FloatArray(totalSize)
    var offset = 0
    forEach { frame ->
        frame.copyInto(samples, offset)
        offset += frame.size
    }
    return samples
}

private fun List<FloatArray>.takeLastFramesForSamples(maxSamples: Int): List<FloatArray> {
    if (maxSamples <= 0 || isEmpty()) return emptyList()
    var total = 0
    val frames = ArrayDeque<FloatArray>()
    asReversed().forEach { frame ->
        if (total >= maxSamples) return@forEach
        frames.addFirst(frame)
        total += frame.size
    }
    return frames.toList()
}

fun liveSpeechWindowSamples(sampleRate: Int): Int = sampleRate * 4

fun liveSpeechTrailingSilenceSamples(sampleRate: Int): Int = sampleRate

fun nextLiveSpeechPassSample(totalSamples: Int, sampleRate: Int): Int = totalSamples + sampleRate / 2

fun liveSpeechWindowStartSample(partialEndSample: Int, sampleRate: Int): Int = partialEndSample - liveSpeechWindowSamples(sampleRate)

private fun List<FloatArray>.totalSampleCount(): Int = sumOf { it.size }

private fun List<FloatArray>.sliceSampleWindow(startInclusive: Int, endExclusive: Int, size: Int): FloatArray {
    val output = FloatArray(size)
    val normalizedStart = startInclusive.coerceAtLeast(0)
    var sourceOffset = 0
    forEach { frame ->
        val frameStart = sourceOffset
        val frameEnd = sourceOffset + frame.size
        val copyStart = maxOf(frameStart, normalizedStart)
        val copyEnd = minOf(frameEnd, endExclusive)
        if (copyStart < copyEnd) {
            val outputOffset = copyStart - startInclusive
            frame.copyInto(output, outputOffset, copyStart - frameStart, copyEnd - frameStart)
        }
        sourceOffset = frameEnd
        if (sourceOffset >= endExclusive) return@forEach
    }
    return output
}

private fun FloatArray.padTrailingSilence(sampleRate: Int): FloatArray {
    val trailingSilenceSamples = sampleRate
    val maxSingleChunkSamples = sampleRate * 15
    if (size + trailingSilenceSamples > maxSingleChunkSamples) return this
    return copyOf(size + trailingSilenceSamples)
}

@Composable
private fun ChatModeDock(tokens: UiTokens, modifier: Modifier, attachmentVisible: Boolean, content: @Composable ColumnScope.() -> Unit) {
    val contentHeight = if (attachmentVisible) 214.dp else 144.dp
    Column(modifier.fillMaxWidth().imePadding().wrapContentHeight().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.Bottom) {
        Column(
            Modifier
                .fillMaxWidth()
                .height(contentHeight)
                .shadow(10.dp, RoundedCornerShape(28.dp), ambientColor = Color.Black.copy(alpha = 0.18f), spotColor = Color.Black.copy(alpha = 0.18f))
                .clip(RoundedCornerShape(28.dp))
                .background(tokens.surfaceHigh)
                .border(BorderStroke(0.7.dp, tokens.separator), RoundedCornerShape(28.dp))
                .animateContentSize()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.SpaceBetween,
            content = content,
        )
    }
}

@Composable
private fun ChatDraftField(text: String, tokens: UiTokens, attachments: List<ChatImageAttachment>, onExpand: () -> Unit, onAttachment: (Int) -> Unit, onRemoveAttachment: (Int) -> Unit, onTextChanged: (String) -> Unit) {
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) {
        focusRequester.requestFocus()
        keyboardController?.show()
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (attachments.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                attachments.forEachIndexed { index, attachment ->
                    AttachmentPreview(attachment, tokens, Modifier, { onAttachment(index) }) { onRemoveAttachment(index) }
                }
            }
        }
        val lineCount = text.count { it == '\n' } + 1
        val showExpand = text.isNotBlank() && (lineCount > 3 || text.length > 120)
        val inputHeight = when {
            attachments.isNotEmpty() -> 92.dp
            else -> 82.dp
        }
        Box(Modifier.fillMaxWidth().height(inputHeight).padding(horizontal = 8.dp, vertical = 4.dp)) {
            BasicTextField(
                value = text,
                onValueChange = { onTextChanged(applyMarkdownContinuation(text, it)) },
                textStyle = TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace, lineHeight = 23.sp),
                modifier = Modifier.fillMaxSize().focusRequester(focusRequester),
                cursorBrush = SolidColor(tokens.accent),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Default),
                maxLines = 5,
                decorationBox = { inner ->
                    if (text.isEmpty()) Text("Type message...", color = tokens.secondary.copy(alpha = 0.72f), fontSize = bodySize(), fontFamily = FontFamily.Monospace, lineHeight = 23.sp)
                    inner()
                },
            )
            if (showExpand) Icon(painterResource(R.drawable.ic_feather_maximize_2), null, tint = tokens.secondary, modifier = Modifier.align(Alignment.TopEnd).size(20.dp).clickable { hapticClick(); onExpand() }.padding(2.dp))
        }
    }
}

@Composable
private fun FullscreenChatEditor(text: String, tokens: UiTokens, onTextChanged: (String) -> Unit, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(tokens.background).imePadding()) {
            BasicTextField(
                value = text,
                onValueChange = onTextChanged,
                textStyle = TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace, lineHeight = 23.sp),
                visualTransformation = MarkdownEditorVisualTransformation(tokens),
                cursorBrush = SolidColor(tokens.accent),
                modifier = Modifier.fillMaxSize().padding(horizontal = 22.dp, vertical = 72.dp),
                decorationBox = { inner -> if (text.isBlank()) Text("Type message...", color = tokens.secondary, fontSize = bodySize(), fontFamily = FontFamily.Monospace); inner() },
            )
            Box(Modifier.align(Alignment.TopEnd).padding(top = 28.dp, end = 22.dp).size(44.dp).clickable { hapticClick(); onDismiss() }, contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_feather_minimize_2), null, tint = tokens.text, modifier = Modifier.size(20.dp))
            }
        }
    }
}

private class MarkdownEditorVisualTransformation(private val tokens: UiTokens) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val builder = AnnotatedString.Builder(text.text)
        val source = text.text
        source.lineSequence().fold(0) { offset, line ->
            applyLineStyles(builder, source, offset, line)
            offset + line.length + 1
        }
        Regex("(\\*\\*|__)(.+?)\\1").findAll(source).forEach { match -> builder.addStyle(SpanStyle(fontWeight = FontWeight.Bold), match.range.first, match.range.last + 1) }
        Regex("(?<!\\*)\\*([^*\\n]+)\\*(?!\\*)|_([^_\\n]+)_").findAll(source).forEach { match -> builder.addStyle(SpanStyle(fontStyle = FontStyle.Italic), match.range.first, match.range.last + 1) }
        Regex("~~(.+?)~~").findAll(source).forEach { match -> builder.addStyle(SpanStyle(textDecoration = TextDecoration.LineThrough), match.range.first, match.range.last + 1) }
        Regex("`([^`\\n]+)`").findAll(source).forEach { match -> builder.addStyle(SpanStyle(color = tokens.accent, fontFamily = FontFamily.Monospace), match.range.first, match.range.last + 1) }
        return TransformedText(builder.toAnnotatedString(), OffsetMapping.Identity)
    }

    private fun applyLineStyles(builder: AnnotatedString.Builder, source: String, offset: Int, line: String) {
        val end = (offset + line.length).coerceAtMost(source.length)
        when {
            line.startsWith("# ") -> builder.addStyle(SpanStyle(fontWeight = FontWeight.Bold, color = tokens.text, fontSize = 24.sp), offset, end)
            line.startsWith("## ") -> builder.addStyle(SpanStyle(fontWeight = FontWeight.Bold, color = tokens.text, fontSize = 22.sp), offset, end)
            line.startsWith("### ") -> builder.addStyle(SpanStyle(fontWeight = FontWeight.Bold, color = tokens.text, fontSize = 20.sp), offset, end)
            line.startsWith("#### ") -> builder.addStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = tokens.text, fontSize = 18.sp), offset, end)
            line.startsWith("##### ") -> builder.addStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = tokens.text, fontSize = 16.sp), offset, end)
            line.startsWith("###### ") -> builder.addStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = tokens.secondary, fontSize = 14.sp), offset, end)
            line.trimStart().startsWith(">") -> builder.addStyle(SpanStyle(fontStyle = FontStyle.Italic, color = tokens.secondary), offset, end)
            Regex("^\\s*([-*+] )").containsMatchIn(line) -> builder.addStyle(SpanStyle(color = tokens.text), offset, end)
            Regex("^\\s*\\d+\\. ").containsMatchIn(line) -> builder.addStyle(SpanStyle(color = tokens.text), offset, end)
            Regex("^\\s*[-*+] \\[[ xX]\\] ").containsMatchIn(line) -> builder.addStyle(SpanStyle(color = tokens.text), offset, end)
        }
    }
}

private fun applyMarkdownContinuation(previous: String, next: String): String {
    if (!next.endsWith("\n") || next.length != previous.length + 1 || !next.startsWith(previous)) return next
    val currentLine = previous.substringAfterLast('\n')
    val indentation = currentLine.takeWhile { it == ' ' || it == '\t' }
    val trimmedLine = currentLine.drop(indentation.length)
    if (trimmedLine.isBlank()) return next
    Regex("^(\\d+)\\.\\s+(.*)$").matchEntire(trimmedLine)?.let { match ->
        if (match.groupValues[2].isBlank()) return next
        return next + indentation + "${match.groupValues[1].toIntOrNull()?.plus(1) ?: 1}. "
    }
    Regex("^([-*+])\\s+\\[([ xX])\\]\\s+(.*)$").matchEntire(trimmedLine)?.let { match ->
        if (match.groupValues[3].isBlank()) return next
        return next + indentation + "${match.groupValues[1]} [ ] "
    }
    Regex("^([-*+])\\s+(.*)$").matchEntire(trimmedLine)?.let { match ->
        if (match.groupValues[2].isBlank()) return next
        return next + indentation + "${match.groupValues[1]} "
    }
    Regex("^>\\s?(.*)$").matchEntire(trimmedLine)?.let { match ->
        if (match.groupValues[1].isBlank()) return next
        return next + indentation + "> "
    }
    return next
}

@Composable
private fun AttachmentPreview(attachment: ChatImageAttachment, tokens: UiTokens, modifier: Modifier, onOpen: () -> Unit, onRemove: () -> Unit) {
    Box(modifier.size(72.dp).clip(RoundedCornerShape(18.dp)).background(tokens.background).border(BorderStroke(0.6.dp, tokens.separator), RoundedCornerShape(18.dp)).clickable { hapticClick(); onOpen() }, contentAlignment = Alignment.Center) {
        AsyncImage(model = attachment.uri, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        if (attachment.caption.isNotBlank()) Text("Aa", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.BottomStart).padding(5.dp).clip(RoundedCornerShape(6.dp)).background(Color.Black.copy(alpha = 0.56f)).padding(horizontal = 5.dp, vertical = 2.dp))
        Box(Modifier.align(Alignment.TopEnd).size(26.dp).clip(CircleShape).background(tokens.surfaceHigh).clickable { hapticClick(); onRemove() }, contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_feather_x), null, tint = tokens.text, modifier = Modifier.size(15.dp))
        }
    }
}

@Composable
private fun AttachmentDetailsDialog(attachment: ChatImageAttachment, tokens: UiTokens, onDismiss: () -> Unit, onRemove: () -> Unit, onReplace: () -> Unit, onCaption: (String) -> Unit) {
    var caption by remember(attachment.uri) { mutableStateOf(attachment.caption) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = tokens.surfaceHigh,
        titleContentColor = tokens.text,
        textContentColor = tokens.secondary,
        shape = RoundedCornerShape(28.dp),
        tonalElevation = 0.dp,
        title = { Text("Image") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                AsyncImage(model = attachment.uri, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(18.dp)))
                BasicTextField(value = caption, onValueChange = { caption = it; onCaption(it) }, textStyle = TextStyle(color = tokens.text, fontSize = bodySize(), lineHeight = 22.sp), cursorBrush = SolidColor(tokens.accent), modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(tokens.surfaceHigh).padding(14.dp), decorationBox = { inner -> if (caption.isBlank()) Text("Caption...", color = tokens.secondary, fontSize = bodySize()); inner() })
            }
        },
        confirmButton = { TextButton(onClick = onReplace) { Text("Replace", color = tokens.accent) } },
        dismissButton = { Row { TextButton(onClick = onRemove) { Text("Remove", color = Color(0xffff5c7a)) }; TextButton(onClick = onDismiss) { Text("Done", color = tokens.text) } } },
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatActionRail(tokens: UiTokens, onAttach: () -> Unit, onClose: () -> Unit, onClear: () -> Unit, canClear: Boolean, onMic: () -> Unit, sendIcon: Int, sendAccent: Boolean, onSend: () -> Unit) {
    var clearArmed by remember { mutableStateOf(false) }
    LaunchedEffect(canClear) { if (!canClear) clearArmed = false }
    Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
        ChatRoundAction(R.drawable.ic_feather_plus, tokens.text, Color.Transparent, onClick = onAttach)
        Spacer(Modifier.width(10.dp))
        ChatRoundAction(if (clearArmed) R.drawable.ic_feather_trash_2 else R.drawable.ic_feather_x, if (clearArmed) Color(0xffff5c7a) else tokens.text, Color.Transparent, onLongClick = if (canClear) ({ hapticClick(); clearArmed = true }) else null) {
            hapticClick()
            if (clearArmed) {
                onClear()
                clearArmed = false
            } else {
                onClose()
            }
        }
        Spacer(Modifier.weight(1f))
        ChatRoundAction(R.drawable.ic_feather_mic, tokens.secondary, Color.Transparent, onClick = onMic)
        Spacer(Modifier.width(12.dp))
        ChatSendAction(sendIcon, sendAccent, tokens, onSend)
    }
}

@Composable
fun DictationInputSurface(tokens: UiTokens, displayState: SpeechDictationDisplayState, transcript: String, modifier: Modifier = Modifier, meter: Float = 0f, waveformLevels: List<Float> = List(15) { 0f }, metrics: SpeechTranscriptionMetrics? = null, firstPartialMillis: Long? = null, onAction: (SpeechDictationAction) -> Unit) {
    val contract = SpeechDictationUxContract.contractFor(displayState)
    val scrollState = rememberScrollState()
    LaunchedEffect(transcript) { scrollState.animateScrollTo(scrollState.maxValue) }
    val hasTranscript = transcript.isNotBlank()
    val processingState = displayState in setOf(SpeechDictationDisplayState.TRANSCRIBING, SpeechDictationDisplayState.ENHANCING_COLLAPSED)
    val showTranscript = hasTranscript && !processingState
    val visibleActions = SpeechDictationUxContract.visibleActionsFor(displayState)
    Column(modifier.fillMaxWidth().imePadding().wrapContentHeight().padding(horizontal = 28.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.width(if (showTranscript) 300.dp else 184.dp).clip(RoundedCornerShape(if (showTranscript) 14.dp else 20.dp)).background(tokens.surfaceHigh).border(BorderStroke(0.7.dp, tokens.separator), RoundedCornerShape(if (showTranscript) 14.dp else 20.dp)).animateContentSize()) {
            if (showTranscript) {
                Column(Modifier.fillMaxWidth().height(74.dp).padding(horizontal = 14.dp, vertical = 9.dp).verticalScroll(scrollState)) {
                    Text(transcript, color = tokens.text.copy(alpha = 0.88f), fontSize = 13.sp, lineHeight = 18.sp)
                }
                Box(Modifier.fillMaxWidth().height(0.7.dp).background(tokens.separator.copy(alpha = 0.55f)))
            }
            Row(Modifier.fillMaxWidth().height(40.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                DictationMiniSideButton(visibleActions.secondary.firstOrNull { it == SpeechDictationAction.START_ENHANCEMENT || it == SpeechDictationAction.RETRY_ENHANCEMENT }, tokens, onAction)
                Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    if (processingState) {
                        DictationProcessingStatus(if (displayState == SpeechDictationDisplayState.TRANSCRIBING) "Transcribing" else "Enhancing", tokens)
                    } else if (displayState in setOf(SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationDisplayState.RECORDING_WITH_SPEECH)) {
                        DictationWaveform(active = true, meter = meter, levels = waveformLevels, color = tokens.accent)
                    } else {
                        DictationStaticWaveform(tokens)
                    }
                }
                DictationPrimaryAction(visibleActions.primary, tokens, onAction)
            }
        }
        DictationSecondaryActions(visibleActions.secondary.filterNot { it == SpeechDictationAction.START_ENHANCEMENT || it == SpeechDictationAction.RETRY_ENHANCEMENT }, tokens, onAction)
    }
}

@Composable
private fun DictationProcessingStatus(label: String, tokens: UiTokens) {
    var activeDot by remember(label) { mutableIntStateOf(0) }
    LaunchedEffect(label) {
        while (true) {
            delay(if (label == "Transcribing") 180L else 220L)
            activeDot = (activeDot + 1) % 7
        }
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = tokens.text.copy(alpha = 0.9f), fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1)
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
            repeat(5) { index ->
                Box(Modifier.width(3.dp).height(3.dp).clip(RoundedCornerShape(2.dp)).background(tokens.text.copy(alpha = if (index <= activeDot.coerceAtMost(4)) 0.85f else 0.25f)))
            }
        }
    }
}

@Composable
private fun DictationMiniSideButton(action: SpeechDictationAction?, tokens: UiTokens, onAction: (SpeechDictationAction) -> Unit) {
    Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
        if (action != null) Icon(painterResource(action.secondaryIcon()), null, tint = tokens.text.copy(alpha = 0.7f), modifier = Modifier.size(14.dp).clickable { hapticClick(); onAction(action) })
    }
}

@Composable
private fun DictationMetricsSummary(metrics: SpeechTranscriptionMetrics?, firstPartialMillis: Long?, tokens: UiTokens) {
    val text = metrics?.let {
        listOfNotNull(
            "total ${it.totalMillis}ms",
            firstPartialMillis?.let { value -> "first ${value}ms" },
            it.firstTokenMillis?.let { value -> "token ${value}ms" },
            it.accelerator,
            if (it.modelWasWarm) "warm" else "cold",
        ).joinToString(" · ")
    } ?: "Ready"
    Text(text, color = tokens.secondary, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

@Composable
private fun DictationWaveform(active: Boolean, meter: Float, levels: List<Float>, color: Color) {
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(15) { index ->
            val weight = 1f - kotlin.math.abs(index - 7) / 8f
            val level = (levels.getOrNull(index) ?: meter).coerceIn(0f, 1f)
            val height = if (active) 4.dp + (24.dp * level.powForWaveform() * (0.7f + weight * 0.3f)) else 4.dp
            Box(Modifier.width(3.dp).height(height.coerceAtLeast(4.dp)).clip(RoundedCornerShape(3.dp)).background(color.copy(alpha = if (active) 0.85f else 0.5f)))
        }
    }
}

@Composable
private fun DictationStaticWaveform(tokens: UiTokens) {
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(15) {
            Box(Modifier.width(3.dp).height(4.dp).clip(RoundedCornerShape(3.dp)).background(tokens.secondary.copy(alpha = 0.5f)))
        }
    }
}

private fun Float.powForWaveform(): Float = this.toDouble().pow(0.7).toFloat()

@Composable
private fun DictationPrimaryAction(action: SpeechDictationAction?, tokens: UiTokens, onAction: (SpeechDictationAction) -> Unit) {
    if (action == null) {
        Spacer(Modifier.size(48.dp))
        return
    }
    val icon = when (action) {
        SpeechDictationAction.START_RECORDING -> R.drawable.ic_feather_mic
        SpeechDictationAction.STOP_RECORDING -> R.drawable.ic_feather_send
        SpeechDictationAction.RETRY_ENHANCEMENT -> R.drawable.ic_feather_rotate_ccw
        SpeechDictationAction.SEND_RAW, SpeechDictationAction.SEND_ENHANCED -> R.drawable.ic_feather_arrow_up
        else -> R.drawable.ic_feather_check
    }
    Box(Modifier.size(22.dp).semantics { contentDescription = action.accessibilityLabel() }.clickable { hapticClick(); onAction(action) }, contentAlignment = Alignment.Center) {
        Box(Modifier.size(22.dp).clip(CircleShape).background(if (action == SpeechDictationAction.STOP_RECORDING) Color(0xfff04452) else Color(0xff4c4c59)), contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), null, tint = Color.White, modifier = Modifier.size(12.dp))
        }
    }
}

private fun SpeechDictationAction.accessibilityLabel(): String = when (this) {
    SpeechDictationAction.START_RECORDING -> "Retry voice input"
    SpeechDictationAction.STOP_RECORDING -> "Finish voice input"
    SpeechDictationAction.SEND_RAW -> "Send transcript"
    SpeechDictationAction.SEND_ENHANCED -> "Send enhanced transcript"
    else -> secondaryLabel()
}

private fun SpeechDictationAction.secondaryLabel(): String = when (this) {
    SpeechDictationAction.START_ENHANCEMENT -> "Enhance"
    SpeechDictationAction.RETRY_ENHANCEMENT -> "Retry"
    SpeechDictationAction.SEND_RAW -> "Original"
    SpeechDictationAction.CANCEL -> "Cancel"
    else -> name.lowercase().replace('_', ' ')
}

private fun SpeechDictationAction.secondaryIcon(): Int = when (this) {
    SpeechDictationAction.START_ENHANCEMENT -> R.drawable.ic_feather_zap
    SpeechDictationAction.RETRY_ENHANCEMENT -> R.drawable.ic_feather_rotate_ccw
    SpeechDictationAction.SEND_RAW -> R.drawable.ic_feather_arrow_up
    SpeechDictationAction.CANCEL -> R.drawable.ic_feather_x
    else -> R.drawable.ic_feather_circle
}

@Composable
private fun DictationSecondaryActions(actions: List<SpeechDictationAction>, tokens: UiTokens, onAction: (SpeechDictationAction) -> Unit) {
    if (actions.isEmpty()) return
    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        actions.forEach { action ->
            DictationIconAction(action.secondaryLabel(), action.secondaryIcon(), tokens) { onAction(action) }
        }
    }
}

@Composable
private fun DictationIconAction(label: String, icon: Int, tokens: UiTokens, onClick: () -> Unit) {
    Row(Modifier.height(44.dp).clip(RoundedCornerShape(22.dp)).background(tokens.surfaceHigh).semantics { contentDescription = label }.clickable { hapticClick(); onClick() }.padding(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(icon), null, tint = tokens.text, modifier = Modifier.size(17.dp))
        Text(label, color = tokens.text, fontSize = 13.sp, maxLines = 1)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatRoundAction(icon: Int, color: Color, background: Color, onLongClick: (() -> Unit)? = null, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).clip(CircleShape).background(background).combinedClickable(onClick = onClick, onLongClick = onLongClick), contentAlignment = Alignment.Center) {
        Icon(painterResource(icon), null, tint = color, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun ChatSendAction(icon: Int, accent: Boolean, tokens: UiTokens, onSend: () -> Unit) {
    val tint = if (accent) tokens.accent else tokens.text
    Box(Modifier.size(44.dp).clip(CircleShape).clickable { hapticClick(); onSend() }, contentAlignment = Alignment.Center) {
        Crossfade(icon, label = "chat-send-icon") { targetIcon ->
            Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
                Icon(painterResource(targetIcon), null, tint = tint, modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
fun SheetScrim(onDismiss: () -> Unit, alpha: Float = 0.34f) {
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = alpha)).clickable { hapticClick(); onDismiss() })
}

@Composable
fun ColumnScope.SheetHandle(tokens: UiTokens, onClick: (() -> Unit)? = null, dragModifier: Modifier = Modifier) {
    val modifier = if (onClick == null) Modifier.fillMaxWidth().height(18.dp) else Modifier.fillMaxWidth().height(28.dp).then(dragModifier).clickable { hapticClick(); onClick() }
    Box(modifier, contentAlignment = Alignment.Center) { Box(Modifier.width(44.dp).height(4.dp).clip(CircleShape).background(tokens.separator)) }
}

fun Modifier.alignBottomSheet(tokens: UiTokens, expanded: Boolean = false, clipContent: Boolean = true): Modifier {
    val base = fillMaxWidth()
    if (!clipContent) return base.background(tokens.background)
    return base.clip(RoundedCornerShape(topStart = if (expanded) 0.dp else 24.dp, topEnd = if (expanded) 0.dp else 24.dp)).background(tokens.background)
}

fun LazyListScope.HomeSection(title: String, tokens: UiTokens, trailing: String? = null, content: @Composable ColumnScope.() -> Unit) {
    item {
        Row(Modifier.fillMaxWidth().padding(start = spacingLarge(), end = spacingLarge(), top = 20.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, color = tokens.secondary, fontSize = sectionSize(), letterSpacing = 0.6.sp, modifier = Modifier.weight(1f))
            if (trailing != null) Text(trailing, color = tokens.accent, fontSize = sectionSize())
        }
        Column(Modifier.padding(horizontal = spacingLarge())) { content() }
    }
}
