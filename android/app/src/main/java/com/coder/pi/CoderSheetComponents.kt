package com.coder.pi

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGestures
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
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
import androidx.core.content.ContextCompat
import coil.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.pow

data class ChatImageAttachment(
    val uri: Uri,
    val caption: String = "",
)

@Composable
fun ChatInputBar(
    tokens: UiTokens,
    text: String,
    onTextChanged: (String) -> Unit,
    modifier: Modifier = Modifier,
    attachments: List<ChatImageAttachment> = emptyList(),
    onAttach: () -> Unit = {},
    onRemoveAttachment: (Int) -> Unit = {},
    onReplaceAttachment: (Int) -> Unit = {},
    onCaptionAttachment: (Int, String) -> Unit = { _, _ -> },
    visibleTerminalLines: () -> List<String> = { emptyList() },
    speechEnhancementClient: SpeechEnhancementClient? = null,
    submitLocked: Boolean = false,
    onClear: () -> Unit,
    onSubmit: (String) -> Boolean,
    onReturn: () -> Unit,
    onClose: () -> Unit,
    startDictationRequest: Int = 0,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var speechSettings by remember(context) { mutableStateOf(SpeechSettingsStore.values(context)) }
    DisposableEffect(context) {
        val listener =
            android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
                if (key?.startsWith("speech.") == true) speechSettings = SpeechSettingsStore.values(context)
            }
        val preferences = SpeechSettingsStore.registerChangeListener(context, listener)
        onDispose { preferences.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    val speechAudioCapture = remember(context, speechSettings.vadSensitivity) { SpeechAudioCapture(context, speechSettings.toAudioCaptureConfig()) }
    val speechPromptRenderer = remember { SpeechEnhancementPromptRenderer() }
    val speechSoundFeedback = remember(context) { SpeechSoundFeedback(context) }
    var dictating by remember { mutableStateOf(false) }
    var dictationState by remember { mutableStateOf(SpeechDictationDisplayState.IDLE) }
    var dictationTranscript by remember { mutableStateOf("") }
    var dictationRawTranscript by remember { mutableStateOf("") }
    var dictationMeter by remember { mutableStateOf(0f) }
    var dictationPaused by remember { mutableStateOf(false) }
    var dictationWaveformLevels by remember { mutableStateOf(List(15) { 0f }) }
    var finalTranscriptionJob by remember { mutableStateOf<Job?>(null) }
    var enhancementJob by remember { mutableStateOf<Job?>(null) }
    var enhancementHapticJob by remember { mutableStateOf<Job?>(null) }
    var dictationSessionId by remember { mutableIntStateOf(0) }
    var dictationStartedAt by remember { mutableStateOf(0L) }
    var firstPartialAt by remember { mutableStateOf<Long?>(null) }
    var realtimeTranscriptionSession by remember { mutableStateOf<RealtimeSpeechTranscriptionSession?>(null) }
    var realtimeTranscriptionSessionKey by remember { mutableStateOf("") }
    var expandedEditor by remember { mutableStateOf(false) }
    var selectedAttachmentIndex by remember { mutableStateOf<Int?>(null) }
    val attachmentVisible = attachments.isNotEmpty()
    val submitText = {
        val submitted = text.trimEnd().takeIf { it.isNotBlank() }
        if (!submitLocked && submitted != null && onSubmit(submitted)) onTextChanged("")
    }

    fun stopDictationCapture() {
        dictationMeter = 0f
        scope.launch { speechAudioCapture.stop() }
    }

    suspend fun stopDictationCaptureAndDrainFrames() {
        dictationMeter = 0f
        speechAudioCapture.stop()
    }

    fun clearDictationSession() {
        dictationSessionId++
        finalTranscriptionJob?.cancel()
        finalTranscriptionJob = null
        enhancementJob?.cancel()
        enhancementHapticJob?.cancel()
        enhancementJob = null
        enhancementHapticJob = null
        dictating = false
        dictationPaused = false
        dictationState = SpeechDictationDisplayState.IDLE
        dictationTranscript = ""
        dictationRawTranscript = ""
        dictationWaveformLevels = List(15) { 0f }
    }

    fun acceptDictationTranscript(transcript: String = dictationTranscript) {
        val mergedDraft = mergeSpeechTranscriptIntoDraft(text, transcript)
        if (mergedDraft.isNotBlank()) onTextChanged(mergedDraft)
        speechSoundFeedback.playStop()
        stopDictationCapture()
        clearDictationSession()
    }

    fun enhanceTranscript(
        transcript: String,
        sessionId: Int,
    ) {
        if (!speechSettings.enhancementEnabled || speechEnhancementClient == null || transcript.isBlank()) {
            acceptDictationTranscript(transcript)
            return
        }
        dictationState = SpeechDictationDisplayState.ENHANCING_COLLAPSED
        enhancementJob?.cancel()
        enhancementHapticJob?.cancel()
        enhancementHapticJob =
            scope.launch {
                while (sessionId == dictationSessionId && dictationState == SpeechDictationDisplayState.ENHANCING_COLLAPSED) {
                    context.performSpeechEnhancementHaptic(speechSettings.enhancementHapticPattern)
                    delay(speechEnhancementHapticRepeatDelayMillis(speechSettings.enhancementHapticPattern))
                }
            }
        enhancementJob =
            scope.launch {
                runCatching {
                    val prompt = speechSettings.resolvedPrompt(SpeechSettingsStore.defaultPrompt(context))
                    val contextLines = if (speechSettings.includeVisibleTerminalContext) visibleTerminalLines() else emptyList()
                    val clipboardText = if (speechSettings.includeClipboardContext) context.currentClipboardText() else ""
                    val request = speechPromptRenderer.render(prompt, transcript, contextLines, clipboardText, speechSettings.customVocabulary)
                    SpeechEnhancer(speechEnhancementClient, timeoutMillis = speechSettings.enhancementTimeoutSeconds * 1_000L).enhanceOrRaw(request)
                }.fold(
                    onSuccess = { result ->
                        if (sessionId != dictationSessionId) return@fold
                        enhancementHapticJob?.cancel()
                        enhancementHapticJob = null
                        if (result.timedOut) {
                            Toast.makeText(context, "Enhancement timed out: ${result.errorMessage.orEmpty()}", Toast.LENGTH_LONG).show()
                            dictationTranscript = transcript
                            dictationState = SpeechDictationDisplayState.ENHANCEMENT_TIMED_OUT
                        } else {
                            if (result.failedOpen) {
                                Toast.makeText(context, "Enhancement failed: ${result.errorMessage ?: "Empty response"}", Toast.LENGTH_LONG).show()
                                dictationTranscript = transcript
                                dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
                            } else if (speechSettings.autoSubmitAfterEnhancement) {
                                val cleanText = result.text.trim()
                                if (cleanText.isNotBlank() && onSubmit(cleanText)) {
                                    speechSoundFeedback.playStop()
                                    stopDictationCapture()
                                    clearDictationSession()
                                } else {
                                    acceptDictationTranscript(result.text)
                                }
                            } else {
                                acceptDictationTranscript(result.text)
                            }
                        }
                    },
                    onFailure = {
                        if (sessionId != dictationSessionId) return@fold
                        enhancementHapticJob?.cancel()
                        enhancementHapticJob = null
                        Toast.makeText(context, "Enhancement failed: ${it.message ?: it::class.java.simpleName}", Toast.LENGTH_LONG).show()
                        acceptDictationTranscript(transcript)
                    },
                )
            }
    }

    fun transcribeDictationAudio() {
        finalTranscriptionJob?.cancel()
        val sessionId = dictationSessionId
        finalTranscriptionJob =
            scope.launch {
                if (sessionId != dictationSessionId) return@launch
                val realtimeSession = realtimeTranscriptionSession
                if (realtimeSession == null) {
                    dictationTranscript = "Realtime transcription unavailable."
                    dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
                    return@launch
                }
                val transcript = runCatching { realtimeSession.finish() }.getOrDefault("").trim()
                if (sessionId != dictationSessionId) return@launch
                if (transcript.isBlank()) {
                    val error = realtimeSession.lastError()
                    dictationTranscript = if (error.isBlank()) "No speech detected." else "Realtime transcription failed: ${error.take(180)}"
                    dictationState = if (error.isBlank()) SpeechDictationDisplayState.NO_SPEECH else SpeechDictationDisplayState.ENHANCEMENT_FAILED
                } else {
                    dictationRawTranscript = transcript
                    dictationTranscript = transcript
                    enhanceTranscript(transcript, sessionId)
                }
            }
    }

    fun startAudioCapture(sessionId: Int) {
        speechAudioCapture.start(
            onFrame = { frame ->
                if (sessionId != dictationSessionId) return@start
                if (!dictationPaused) realtimeTranscriptionSession?.append(frame.samples, speechAudioCapture.sampleRate)
                scope.launch {
                    val visualMeter = speechWaveformVisualLevel(frame.meter)
                    dictationMeter = if (dictationPaused) 0f else visualMeter
                    dictationWaveformLevels = dictationWaveformLevels.drop(1) + if (dictationPaused) 0f else visualMeter
                    if (!dictationPaused && frame.speechDetected && dictationState == SpeechDictationDisplayState.RECORDING_EMPTY) dictationState = SpeechDictationDisplayState.RECORDING_WITH_SPEECH
                }
            },
            onFailure = { failure ->
                scope.launch {
                    dictationTranscript =
                        when (failure) {
                            SpeechAudioCaptureFailure.PermissionDenied -> "Microphone permission denied."
                            SpeechAudioCaptureFailure.InitializationFailed -> "Microphone unavailable."
                            SpeechAudioCaptureFailure.SilencedBySystem -> "Microphone capture was silenced by Android."
                            is SpeechAudioCaptureFailure.ReadFailed -> "Microphone capture failed."
                        }
                    dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
                    speechSoundFeedback.playFailure()
                    stopDictationCapture()
                }
            },
        )
    }

    fun startDictationCapture() {
        val transcriptionEndpoints = SpeechSettingsStore.providers(context).endpointsForSelected(OpenAiProviderTask.Transcription, speechSettings.realtimeTranscriptionProviderId).ifEmpty { speechSettings.realtimeTranscriptionBaseUrl.openAiBaseUrlAliases() }
        if (transcriptionEndpoints.isEmpty()) {
            dictating = true
            dictationTranscript = "Configure realtime transcription endpoint first."
            dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
            speechSoundFeedback.playFailure()
            return
        }
        speechSoundFeedback.playStart()
        dictationSessionId++
        dictationStartedAt = SystemClock.elapsedRealtime()
        firstPartialAt = null
        dictationState = SpeechDictationDisplayState.RECORDING_EMPTY
        dictationTranscript = ""
        dictationRawTranscript = ""
        dictationMeter = 0f
        dictationPaused = false
        finalTranscriptionJob?.cancel()
        finalTranscriptionJob = null
        enhancementJob?.cancel()
        enhancementJob = null
        dictationWaveformLevels = List(15) { 0f }
        dictating = true
        val sessionId = dictationSessionId
        val endpoint = OpenAiProviderEndpointResolver.activeBaseUrl(OpenAiProviderTask.Transcription, transcriptionEndpoints.joinToString("\n"))
        val apiKey = SpeechSettingsStore.apiKeyForEndpoint(context, endpoint)
        val sessionKey = "$endpoint\n$apiKey"
        val existingSession = realtimeTranscriptionSession
        val session =
            if (existingSession != null && realtimeTranscriptionSessionKey == sessionKey) {
                existingSession
            } else {
                existingSession?.let { oldSession -> scope.launch { oldSession.close() } }
                RealtimeSpeechTranscriptionSession(speechSettings, apiKey) { transcript ->
                    scope.launch {
                        if (dictating && transcript.isNotBlank()) {
                            if (firstPartialAt == null) firstPartialAt = SystemClock.elapsedRealtime()
                            dictationTranscript = transcript
                        }
                    }
                }.also {
                    realtimeTranscriptionSession = it
                    realtimeTranscriptionSessionKey = sessionKey
                }
            }
        session.beginUtterance()
        scope.launch {
            runCatching { session.start() }
                .onSuccess {
                    if (sessionId != dictationSessionId) return@onSuccess
                    startAudioCapture(sessionId)
                }.onFailure {
                    if (sessionId == dictationSessionId) {
                        dictationTranscript = "Realtime transcription unavailable."
                        dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
                        speechSoundFeedback.playFailure()
                        stopDictationCapture()
                    }
                }
        }
    }
    val audioPermissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                startDictationCapture()
            } else {
                dictationTranscript = "Microphone permission denied."
                dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
                dictating = true
            }
        }

    fun requestDictationCapture() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startDictationCapture() else audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }
    LaunchedEffect(startDictationRequest) {
        if (startDictationRequest > 0 && !dictating) requestDictationCapture()
    }
    DisposableEffect(speechAudioCapture) {
        onDispose {
            finalTranscriptionJob?.cancel()
            enhancementJob?.cancel()
            enhancementHapticJob?.cancel()
            realtimeTranscriptionSession?.let { scope.launch { it.close() } }
            realtimeTranscriptionSession = null
            realtimeTranscriptionSessionKey = ""
            speechAudioCapture.stopAsync()
        }
    }
    if (dictating) {
        DictationInputSurface(
            tokens = tokens,
            displayState = dictationState,
            transcript = dictationTranscript,
            meter = dictationMeter,
            waveformLevels = dictationWaveformLevels,
            recordingStartedAt = dictationStartedAt,
            paused = dictationPaused,
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
                        speechSoundFeedback.playCancel()
                        stopDictationCapture()
                        clearDictationSession()
                    }
                    SpeechDictationAction.STOP_RECORDING -> {
                        dictationPaused = false
                        dictationState = SpeechDictationDisplayState.TRANSCRIBING
                        speechSoundFeedback.playStop()
                        scope.launch {
                            stopDictationCaptureAndDrainFrames()
                            transcribeDictationAudio()
                        }
                    }
                    SpeechDictationAction.PAUSE_RECORDING -> {
                        dictationPaused = true
                        speechSoundFeedback.playStop()
                    }
                    SpeechDictationAction.RESUME_RECORDING -> {
                        dictationPaused = false
                        speechSoundFeedback.playStart()
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
            onAttach = {
                hapticClick()
                onAttach()
            },
            onClose = onClose,
            onClear = onClear,
            canClear = text.isNotBlank() || attachments.isNotEmpty(),
            onMic = {
                hapticClick()
                requestDictationCapture()
            },
            sendIcon = if (text.isBlank()) R.drawable.ic_feather_corner_down_left else R.drawable.ic_feather_arrow_up,
            sendAccent = text.isNotBlank(),
            onSend = { if (text.isBlank()) onReturn() else submitText() },
        )
    }
    if (expandedEditor) FullscreenChatEditor(text, tokens, onTextChanged, { expandedEditor = false })
    selectedAttachmentIndex?.let { index ->
        attachments.getOrNull(index)?.let { attachment ->
            AttachmentDetailsDialog(attachment, tokens, { selectedAttachmentIndex = null }, {
                onRemoveAttachment(index)
                selectedAttachmentIndex = null
            }, {
                onReplaceAttachment(index)
                selectedAttachmentIndex = null
            }) { onCaptionAttachment(index, it) }
        } ?: run { selectedAttachmentIndex = null }
    }
}

private fun Context.currentClipboardText(): String =
    runCatching {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.primaryClip
            ?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)
            ?.coerceToText(this)
            ?.toString()
            .orEmpty()
    }.getOrDefault("").take(4_000)

fun speechEnhancementHapticRepeatDelayMillis(patternId: String): Long = TerminalHapticPatterns.option(patternId).timings.sum() + 900L

@Suppress("DEPRECATION")
internal fun Context.performSpeechEnhancementHaptic(patternId: String) {
    val enabled = getSharedPreferences("app", Context.MODE_PRIVATE).getBoolean("haptic_feedback", true)
    if (!enabled) return
    val pattern = TerminalHapticPatterns.option(patternId)
    if (pattern.id == "none") return
    val vibrator = if (Build.VERSION.SDK_INT >= 31) getSystemService(VibratorManager::class.java).defaultVibrator else getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    if (!vibrator.hasVibrator()) return
    if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(pattern.timings, pattern.amplitudes, -1)) else vibrator.vibrate(pattern.timings, -1)
}

fun selectFinalSpeechTranscript(
    finalTranscript: String,
    liveTranscript: String,
    sampleCount: Int = 0,
    sampleRate: Int = 16_000,
): String {
    val finalClean = finalTranscript.trim()
    val liveClean = liveTranscript.trim()
    if (finalClean.isNotBlank()) return finalClean
    return liveClean
}

fun mergeSpeechTranscriptIntoDraft(
    draft: String,
    transcript: String,
): String {
    val cleanTranscript = transcript.trim()
    if (cleanTranscript.isBlank()) return draft
    if (draft.isBlank()) return cleanTranscript
    val separator = if (draft.endsWith("\n") || draft.endsWith(" ")) "" else " "
    return draft + separator + cleanTranscript
}

internal fun SpeechSettingsValues.toAudioCaptureConfig(): SpeechAudioCaptureConfig {
    val threshold =
        when (vadSensitivity.coerceIn(0, 4)) {
            0 -> 0.024f
            1 -> 0.018f
            2 -> 0.012f
            3 -> 0.008f
            else -> 0.005f
        }
    return SpeechAudioCaptureConfig(sampleRate = 24_000, silenceThreshold = threshold, peakThreshold = threshold * 3.75f)
}

@Composable
private fun ChatModeDock(
    tokens: UiTokens,
    modifier: Modifier,
    attachmentVisible: Boolean,
    content: @Composable ColumnScope.() -> Unit,
) {
    val contentHeight = if (attachmentVisible) 214.dp else 144.dp
    Column(
        modifier
            .fillMaxWidth()
            .imePadding()
            .wrapContentHeight()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.Bottom,
    ) {
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
private fun ChatDraftField(
    text: String,
    tokens: UiTokens,
    attachments: List<ChatImageAttachment>,
    onExpand: () -> Unit,
    onAttachment: (Int) -> Unit,
    onRemoveAttachment: (Int) -> Unit,
    onTextChanged: (String) -> Unit,
) {
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
        val inputHeight =
            when {
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
            if (showExpand) {
                Icon(
                    painterResource(R.drawable.ic_feather_maximize_2),
                    null,
                    tint = tokens.secondary,
                    modifier =
                        Modifier
                            .align(Alignment.TopEnd)
                            .size(20.dp)
                            .clickable {
                                hapticClick()
                                onExpand()
                            }.padding(2.dp),
                )
            }
        }
    }
}

@Composable
private fun FullscreenChatEditor(
    text: String,
    tokens: UiTokens,
    onTextChanged: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(tokens.background).imePadding()) {
            BasicTextField(
                value = text,
                onValueChange = onTextChanged,
                textStyle = TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace, lineHeight = 23.sp),
                visualTransformation = MarkdownEditorVisualTransformation(tokens),
                cursorBrush = SolidColor(tokens.accent),
                modifier = Modifier.fillMaxSize().padding(horizontal = 22.dp, vertical = 72.dp),
                decorationBox = { inner ->
                    if (text.isBlank()) Text("Type message...", color = tokens.secondary, fontSize = bodySize(), fontFamily = FontFamily.Monospace)
                    inner()
                },
            )
            Box(
                Modifier.align(Alignment.TopEnd).padding(top = 28.dp, end = 22.dp).size(44.dp).clickable {
                    hapticClick()
                    onDismiss()
                },
                contentAlignment = Alignment.Center,
            ) {
                Icon(painterResource(R.drawable.ic_feather_minimize_2), null, tint = tokens.text, modifier = Modifier.size(20.dp))
            }
        }
    }
}

private class MarkdownEditorVisualTransformation(
    private val tokens: UiTokens,
) : VisualTransformation {
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

    private fun applyLineStyles(
        builder: AnnotatedString.Builder,
        source: String,
        offset: Int,
        line: String,
    ) {
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

private fun applyMarkdownContinuation(
    previous: String,
    next: String,
): String {
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
private fun AttachmentPreview(
    attachment: ChatImageAttachment,
    tokens: UiTokens,
    modifier: Modifier,
    onOpen: () -> Unit,
    onRemove: () -> Unit,
) {
    Box(
        modifier.size(72.dp).clip(RoundedCornerShape(18.dp)).background(tokens.background).border(BorderStroke(0.6.dp, tokens.separator), RoundedCornerShape(18.dp)).clickable {
            hapticClick()
            onOpen()
        },
        contentAlignment = Alignment.Center,
    ) {
        AsyncImage(model = attachment.uri, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        if (attachment.caption.isNotBlank()) {
            Text(
                "Aa",
                color = Color.White,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                modifier =
                    Modifier
                        .align(Alignment.BottomStart)
                        .padding(5.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(Color.Black.copy(alpha = 0.56f))
                        .padding(horizontal = 5.dp, vertical = 2.dp),
            )
        }
        Box(
            Modifier.align(Alignment.TopEnd).size(26.dp).clip(CircleShape).background(tokens.surfaceHigh).clickable {
                hapticClick()
                onRemove()
            },
            contentAlignment = Alignment.Center,
        ) {
            Icon(painterResource(R.drawable.ic_feather_x), null, tint = tokens.text, modifier = Modifier.size(15.dp))
        }
    }
}

@Composable
private fun AttachmentDetailsDialog(
    attachment: ChatImageAttachment,
    tokens: UiTokens,
    onDismiss: () -> Unit,
    onRemove: () -> Unit,
    onReplace: () -> Unit,
    onCaption: (String) -> Unit,
) {
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
                BasicTextField(
                    value = caption,
                    onValueChange = {
                        caption = it
                        onCaption(it)
                    },
                    textStyle = TextStyle(color = tokens.text, fontSize = bodySize(), lineHeight = 22.sp),
                    cursorBrush = SolidColor(tokens.accent),
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .background(tokens.surfaceHigh)
                            .padding(14.dp),
                    decorationBox = { inner ->
                        if (caption.isBlank()) Text("Caption...", color = tokens.secondary, fontSize = bodySize())
                        inner()
                    },
                )
            }
        },
        confirmButton = { TextButton(onClick = onReplace) { Text("Replace", color = tokens.accent) } },
        dismissButton = {
            Row {
                TextButton(onClick = onRemove) { Text("Remove", color = Color(0xffff5c7a)) }
                TextButton(onClick = onDismiss) { Text("Done", color = tokens.text) }
            }
        },
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatActionRail(
    tokens: UiTokens,
    onAttach: () -> Unit,
    onClose: () -> Unit,
    onClear: () -> Unit,
    canClear: Boolean,
    onMic: () -> Unit,
    sendIcon: Int,
    sendAccent: Boolean,
    onSend: () -> Unit,
) {
    var clearArmed by remember { mutableStateOf(false) }
    LaunchedEffect(canClear) { if (!canClear) clearArmed = false }
    Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
        ChatRoundAction(R.drawable.ic_feather_plus, tokens.text, Color.Transparent, onClick = onAttach)
        Spacer(Modifier.width(10.dp))
        ChatRoundAction(
            if (clearArmed) R.drawable.ic_feather_trash_2 else R.drawable.ic_feather_x,
            if (clearArmed) Color(0xffff5c7a) else tokens.text,
            Color.Transparent,
            onLongClick =
                if (canClear) {
                    (
                        {
                            hapticClick()
                            clearArmed = true
                        }
                    )
                } else {
                    null
                },
        ) {
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
fun DictationInputSurface(
    tokens: UiTokens,
    displayState: SpeechDictationDisplayState,
    transcript: String,
    modifier: Modifier = Modifier,
    meter: Float = 0f,
    waveformLevels: List<Float> = List(15) { 0f },
    recordingStartedAt: Long = 0L,
    paused: Boolean = false,
    onAction: (SpeechDictationAction) -> Unit,
) {
    val contract = SpeechDictationUxContract.contractFor(displayState)
    val scrollState = rememberScrollState()
    LaunchedEffect(transcript) { scrollState.animateScrollTo(scrollState.maxValue) }
    val hasTranscript = transcript.isNotBlank()
    val processingState = displayState in setOf(SpeechDictationDisplayState.TRANSCRIBING, SpeechDictationDisplayState.ENHANCING_COLLAPSED)
    val showTranscript = hasTranscript && !processingState
    val visibleActions = SpeechDictationUxContract.visibleActionsFor(displayState)
    val recording = displayState in setOf(SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationDisplayState.RECORDING_WITH_SPEECH)
    var dragX by remember { mutableStateOf(0f) }
    var dragY by remember { mutableStateOf(0f) }
    val swipeThreshold = with(androidx.compose.ui.platform.LocalDensity.current) { 86.dp.toPx() }
    val dragModifier =
        if (recording) {
            Modifier.pointerInput(displayState) {
                detectDragGestures(
                    onDragStart = {
                        dragX = 0f
                        dragY = 0f
                    },
                    onDragEnd = {
                        val cancelProgress = (-dragX / swipeThreshold).coerceIn(0f, 1f)
                        val finishProgress = (-dragY / swipeThreshold).coerceIn(0f, 1f)
                        when {
                            cancelProgress >= 1f && cancelProgress >= finishProgress -> onAction(SpeechDictationAction.CANCEL)
                            finishProgress >= 1f -> onAction(SpeechDictationAction.STOP_RECORDING)
                        }
                        dragX = 0f
                        dragY = 0f
                    },
                    onDragCancel = {
                        dragX = 0f
                        dragY = 0f
                    },
                    onDrag = { change, dragAmount ->
                        change.consume()
                        dragX += dragAmount.x
                        dragY += dragAmount.y
                    },
                )
            }
        } else {
            Modifier
        }
    val cancelProgress = (-dragX / swipeThreshold).coerceIn(0f, 1f)
    val finishProgress = (-dragY / swipeThreshold).coerceIn(0f, 1f)
    Column(
        modifier
            .fillMaxWidth()
            .imePadding()
            .wrapContentHeight()
            .padding(horizontal = 8.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (showTranscript) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 18.dp, vertical = 8.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(tokens.surfaceHigh)
                    .border(BorderStroke(0.7.dp, tokens.separator), RoundedCornerShape(18.dp))
                    .height(82.dp)
                    .padding(horizontal = 14.dp, vertical = 10.dp)
                    .verticalScroll(scrollState),
            ) {
                Text(transcript, color = tokens.text.copy(alpha = 0.88f), fontSize = 13.sp, lineHeight = 18.sp)
            }
        }
        Row(
            Modifier
                .fillMaxWidth()
                .height(72.dp)
                .shadow(8.dp, RoundedCornerShape(36.dp), ambientColor = Color.Black.copy(alpha = 0.16f), spotColor = Color.Black.copy(alpha = 0.16f))
                .clip(RoundedCornerShape(36.dp))
                .background(tokens.surfaceHigh)
                .border(BorderStroke(0.7.dp, tokens.separator), RoundedCornerShape(36.dp))
                .animateContentSize()
                .then(dragModifier)
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.width(92.dp), contentAlignment = Alignment.CenterStart) {
                if (recording && cancelProgress > 0.08f) {
                    DictationTrashProgress(cancelProgress, tokens)
                } else if (recording) {
                    RecordingTimerCompact(recordingStartedAt, paused, tokens)
                } else {
                    DictationMiniSideButton(visibleActions.secondary.firstOrNull { it == SpeechDictationAction.START_ENHANCEMENT || it == SpeechDictationAction.RETRY_ENHANCEMENT }, tokens, onAction)
                }
            }
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                when {
                    recording && cancelProgress > 0.08f -> ShimmerHintText("Swipe to discard", cancelProgress, tokens)
                    recording && finishProgress > 0.08f -> ShimmerHintText("Release to finish", finishProgress, tokens)
                    displayState == SpeechDictationDisplayState.TRANSCRIBING -> TranscribingStatus(tokens)
                    displayState == SpeechDictationDisplayState.ENHANCING_COLLAPSED -> WhimsicalStatus(tokens)
                    recording && paused -> PausedStatus(recordingStartedAt, tokens)
                    recording -> DictationWaveform(active = true, meter = meter, levels = waveformLevels.takeLast(5), color = tokens.accent)
                    else -> DictationStaticWaveform(tokens)
                }
            }
            Row(Modifier.width(74.dp), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                if (recording) {
                    DictationMiniSideButton(if (paused) SpeechDictationAction.RESUME_RECORDING else SpeechDictationAction.PAUSE_RECORDING, tokens, onAction)
                } else {
                    DictationPrimaryAction(visibleActions.primary, tokens, onAction)
                }
            }
        }
        if (recording) DictationSwipeHints(tokens)
        DictationSecondaryActions(visibleActions.secondary.filterNot { it == SpeechDictationAction.START_ENHANCEMENT || it == SpeechDictationAction.RETRY_ENHANCEMENT || it == SpeechDictationAction.CANCEL || it == SpeechDictationAction.PAUSE_RECORDING || it == SpeechDictationAction.RESUME_RECORDING }, tokens, onAction)
    }
}

@Composable
private fun RecordingTimerCompact(
    recordingStartedAt: Long,
    paused: Boolean,
    tokens: UiTokens,
) {
    var now by remember { mutableStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(recordingStartedAt) {
        while (recordingStartedAt > 0L) {
            now = SystemClock.elapsedRealtime()
            delay(200)
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically, modifier = if (paused) Modifier.animateAlphaLoop() else Modifier) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(Color(0xffff4f5f)))
        Text(formatDictationElapsed(now - recordingStartedAt), color = Color(0xffff4f5f), fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

@Composable
private fun PausedStatus(
    recordingStartedAt: Long,
    tokens: UiTokens,
) {
    var now by remember { mutableStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(recordingStartedAt) {
        while (recordingStartedAt > 0L) {
            now = SystemClock.elapsedRealtime()
            delay(250)
        }
    }
    Text(formatDictationElapsed(now - recordingStartedAt), color = Color(0xffffd600), fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.animateAlphaLoop())
}

@Composable
private fun DictationTrashProgress(
    progress: Float,
    tokens: UiTokens,
) {
    val scale = 1f + progress.coerceIn(0f, 1f) * 0.28f
    Icon(
        painterResource(R.drawable.ic_feather_trash_2),
        null,
        tint = Color(0xffff5c7a),
        modifier =
            Modifier.size(25.dp).graphicsLayer {
                scaleX = scale
                scaleY = scale
            },
    )
}

@Composable
private fun ShimmerHintText(
    text: String,
    progress: Float,
    tokens: UiTokens,
) {
    ShimmerText(text, tokens.accent, progress, 13)
}

@Composable
private fun TranscribingStatus(tokens: UiTokens) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        DictationAsciiSpinner(tokens.accent)
        ShimmerText("Transcribing...", tokens.accent, 1f, 13)
    }
}

@Composable
private fun WhimsicalStatus(tokens: UiTokens) {
    val words =
        remember {
            listOf(
                "Polishing",
                "Refining",
                "Synthesizing",
                "De-umm-ing",
                "Structuring",
                "Articulating",
                "Grammarizing",
                "Decrypting",
                "Unscrambling",
                "Enhancing",
                "Harmonizing",
                "Orchestrating",
                "Decoding",
                "Calibrating",
                "Clarifying",
                "Perfecting",
                "Stylizing",
                "Distilling",
                "Untangling",
                "Crystallizing",
                "Brewing",
                "Curating",
                "Deciphering",
                "Elevating",
                "Forging",
                "Marinating",
                "Percolating",
                "Sculpting",
                "Whispering",
                "Thinking",
            )
        }
    var word by remember { mutableStateOf(words.random()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(2500)
            word = words.random()
        }
    }
    val haptic = LocalHapticFeedback.current
    LaunchedEffect(word) { haptic.performHapticFeedback(HapticFeedbackType.LongPress) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        DictationAsciiSpinner(tokens.accent)
        ShimmerText(word, tokens.accent, 1f, 13)
    }
}

@Composable
private fun DictationAsciiSpinner(color: Color) {
    val glyphs = remember { listOf("·", "✻", "✽", "✶", "✳", "✢") }
    var index by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(200)
            index = (index + 1) % glyphs.size
        }
    }
    Text(glyphs[index], color = color, fontSize = 20.sp, fontWeight = FontWeight.Bold)
}

@Composable
private fun ShimmerText(
    text: String,
    color: Color,
    progress: Float,
    fontSizeSp: Int,
) {
    val infiniteTransition = rememberInfiniteTransition(label = "DictationShimmer")
    val shimmerOffset by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(animation = tween(1000, easing = LinearEasing), repeatMode = RepeatMode.Restart),
        label = "DictationShimmerOffset",
    )
    val brush =
        Brush.linearGradient(
            colors = listOf(color.copy(alpha = 0.55f), color, color.copy(alpha = 0.55f)),
            start = Offset(shimmerOffset * 500f - 100f, 0f),
            end = Offset(shimmerOffset * 500f + 100f, 0f),
        )
    Text(text, style = TextStyle(brush = brush, fontSize = fontSizeSp.sp, fontWeight = FontWeight.Bold), maxLines = 1, modifier = Modifier.graphicsLayer { alpha = 0.7f + progress.coerceIn(0f, 1f) * 0.3f })
}

private fun Modifier.animateAlphaLoop(): Modifier =
    composed {
        val infiniteTransition = rememberInfiniteTransition(label = "DictationAlphaLoop")
        val alpha by infiniteTransition.animateFloat(
            initialValue = 0.3f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(animation = tween(800, easing = LinearEasing), repeatMode = RepeatMode.Reverse),
            label = "DictationAlpha",
        )
        graphicsLayer { this.alpha = alpha }
    }

@Composable
private fun DictationSwipeHints(tokens: UiTokens) {
    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("← cancel", color = tokens.secondary.copy(alpha = 0.72f), fontSize = 11.sp)
        Text("↑ finish", color = tokens.secondary.copy(alpha = 0.72f), fontSize = 11.sp)
    }
}

private fun formatDictationElapsed(elapsedMillis: Long): String {
    val safeMillis = elapsedMillis.coerceAtLeast(0L)
    val totalSeconds = safeMillis / 1_000L
    return "%d:%02d".format(totalSeconds / 60L, totalSeconds % 60L)
}

@Composable
private fun DictationProcessingStatus(
    label: String,
    tokens: UiTokens,
) {
    val transition = rememberInfiniteTransition(label = "speech-enhancement-spinner")
    val rotation by transition.animateFloat(0f, 360f, infiniteRepeatable(tween(900), RepeatMode.Restart), label = "speech-enhancement-spinner-rotation")
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(R.drawable.ic_feather_loader), null, tint = tokens.accent.copy(alpha = 0.9f), modifier = Modifier.size(14.dp).graphicsLayer { rotationZ = rotation })
            Text(label, color = tokens.text.copy(alpha = 0.9f), fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1)
        }
    }
}

@Composable
private fun DictationMiniSideButton(
    action: SpeechDictationAction?,
    tokens: UiTokens,
    onAction: (SpeechDictationAction) -> Unit,
) {
    Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
        if (action != null) {
            Icon(
                painterResource(action.secondaryIcon()),
                null,
                tint = tokens.text.copy(alpha = 0.7f),
                modifier =
                    Modifier.size(14.dp).clickable {
                        hapticClick()
                        onAction(action)
                    },
            )
        }
    }
}

@Composable
private fun DictationWaveform(
    active: Boolean,
    meter: Float,
    levels: List<Float>,
    color: Color,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(15) { index ->
            val weight = 1f - kotlin.math.abs(index - 7) / 8f
            val level = (levels.getOrNull(index) ?: meter).coerceIn(0f, 1f)
            val height = if (active) 4.dp + (24.dp * level.powForWaveform() * (0.7f + weight * 0.3f)) else 4.dp
            Box(
                Modifier
                    .width(3.dp)
                    .height(height.coerceAtLeast(4.dp))
                    .clip(RoundedCornerShape(3.dp))
                    .background(color.copy(alpha = if (active) 0.85f else 0.5f)),
            )
        }
    }
}

@Composable
private fun DictationStaticWaveform(tokens: UiTokens) {
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(15) {
            Box(
                Modifier
                    .width(3.dp)
                    .height(4.dp)
                    .clip(RoundedCornerShape(3.dp))
                    .background(tokens.secondary.copy(alpha = 0.5f)),
            )
        }
    }
}

private fun Float.powForWaveform(): Float = this.toDouble().pow(0.7).toFloat()

fun speechWaveformVisualLevel(meter: Float): Float = (meter.coerceAtLeast(0f) * 18f).coerceIn(0f, 1f).powForWaveform()

@Composable
private fun DictationPrimaryAction(
    action: SpeechDictationAction?,
    tokens: UiTokens,
    onAction: (SpeechDictationAction) -> Unit,
) {
    if (action == null) {
        Spacer(Modifier.size(48.dp))
        return
    }
    val icon =
        when (action) {
            SpeechDictationAction.START_RECORDING -> R.drawable.ic_feather_mic
            SpeechDictationAction.STOP_RECORDING -> R.drawable.ic_feather_send
            SpeechDictationAction.RETRY_ENHANCEMENT -> R.drawable.ic_feather_rotate_ccw
            SpeechDictationAction.SEND_RAW, SpeechDictationAction.SEND_ENHANCED -> R.drawable.ic_feather_arrow_up
            else -> R.drawable.ic_feather_check
        }
    Box(
        Modifier.size(22.dp).semantics { contentDescription = action.accessibilityLabel() }.clickable {
            hapticClick()
            onAction(action)
        },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(22.dp).clip(CircleShape).background(if (action == SpeechDictationAction.STOP_RECORDING) Color(0xfff04452) else Color(0xff4c4c59)), contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), null, tint = Color.White, modifier = Modifier.size(12.dp))
        }
    }
}

private fun SpeechDictationAction.accessibilityLabel(): String =
    when (this) {
        SpeechDictationAction.START_RECORDING -> "Retry voice input"
        SpeechDictationAction.STOP_RECORDING -> "Finish voice input"
        SpeechDictationAction.SEND_RAW -> "Send transcript"
        SpeechDictationAction.SEND_ENHANCED -> "Send enhanced transcript"
        else -> secondaryLabel()
    }

private fun SpeechDictationAction.secondaryLabel(): String =
    when (this) {
        SpeechDictationAction.START_ENHANCEMENT -> "Enhance"
        SpeechDictationAction.RETRY_ENHANCEMENT -> "Retry"
        SpeechDictationAction.SEND_RAW -> "Original"
        SpeechDictationAction.CANCEL -> "Cancel"
        else -> name.lowercase().replace('_', ' ')
    }

private fun SpeechDictationAction.secondaryIcon(): Int =
    when (this) {
        SpeechDictationAction.START_ENHANCEMENT -> R.drawable.ic_feather_zap
        SpeechDictationAction.RETRY_ENHANCEMENT -> R.drawable.ic_feather_rotate_ccw
        SpeechDictationAction.SEND_RAW -> R.drawable.ic_feather_arrow_up
        SpeechDictationAction.CANCEL -> R.drawable.ic_feather_x
        SpeechDictationAction.PAUSE_RECORDING -> R.drawable.ic_feather_pause
        SpeechDictationAction.RESUME_RECORDING -> R.drawable.ic_feather_play
        else -> R.drawable.ic_feather_circle
    }

@Composable
private fun DictationSecondaryActions(
    actions: List<SpeechDictationAction>,
    tokens: UiTokens,
    onAction: (SpeechDictationAction) -> Unit,
) {
    if (actions.isEmpty()) return
    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        actions.forEach { action ->
            DictationIconAction(action.secondaryLabel(), action.secondaryIcon(), tokens) { onAction(action) }
        }
    }
}

@Composable
private fun DictationIconAction(
    label: String,
    icon: Int,
    tokens: UiTokens,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .height(44.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(tokens.surfaceHigh)
            .semantics { contentDescription = label }
            .clickable {
                hapticClick()
                onClick()
            }.padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(icon), null, tint = tokens.text, modifier = Modifier.size(17.dp))
        Text(label, color = tokens.text, fontSize = 13.sp, maxLines = 1)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatRoundAction(
    icon: Int,
    color: Color,
    background: Color,
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .size(44.dp)
            .clip(CircleShape)
            .background(background)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(icon), null, tint = color, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun ChatSendAction(
    icon: Int,
    accent: Boolean,
    tokens: UiTokens,
    onSend: () -> Unit,
) {
    val tint = if (accent) tokens.accent else tokens.text
    Box(
        Modifier.size(44.dp).clip(CircleShape).clickable {
            hapticClick()
            onSend()
        },
        contentAlignment = Alignment.Center,
    ) {
        Crossfade(icon, label = "chat-send-icon") { targetIcon ->
            Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
                Icon(painterResource(targetIcon), null, tint = tint, modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
fun SheetScrim(
    onDismiss: () -> Unit,
    alpha: Float = 0.34f,
) {
    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = alpha)).clickable {
            hapticClick()
            onDismiss()
        },
    )
}

@Composable
fun ColumnScope.SheetHandle(
    tokens: UiTokens,
    onClick: (() -> Unit)? = null,
    dragModifier: Modifier = Modifier,
) {
    val modifier =
        if (onClick == null) {
            Modifier.fillMaxWidth().height(18.dp)
        } else {
            Modifier.fillMaxWidth().height(28.dp).then(dragModifier).clickable {
                hapticClick()
                onClick()
            }
        }
    Box(modifier, contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .width(44.dp)
                .height(4.dp)
                .clip(CircleShape)
                .background(tokens.separator),
        )
    }
}

fun Modifier.alignBottomSheet(
    tokens: UiTokens,
    expanded: Boolean = false,
    clipContent: Boolean = true,
): Modifier {
    val base = fillMaxWidth()
    if (!clipContent) return base.background(tokens.background)
    return base.clip(RoundedCornerShape(topStart = if (expanded) 0.dp else 24.dp, topEnd = if (expanded) 0.dp else 24.dp)).background(tokens.background)
}

fun LazyListScope.HomeSection(
    title: String,
    tokens: UiTokens,
    trailing: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    item {
        Row(Modifier.fillMaxWidth().padding(start = spacingLarge(), end = spacingLarge(), top = 20.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, color = tokens.secondary, fontSize = sectionSize(), letterSpacing = 0.6.sp, modifier = Modifier.weight(1f))
            if (trailing != null) Text(trailing, color = tokens.accent, fontSize = sectionSize())
        }
        Column(Modifier.padding(horizontal = spacingLarge())) { content() }
    }
}
