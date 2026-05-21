package com.coder.pi

import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import android.Manifest
import android.net.Uri
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
import kotlinx.coroutines.withContext

data class ChatImageAttachment(val uri: Uri, val caption: String = "")

@Composable
fun ChatInputBar(tokens: UiTokens, text: String, onTextChanged: (String) -> Unit, modifier: Modifier = Modifier, attachments: List<ChatImageAttachment> = emptyList(), onAttach: () -> Unit = {}, onRemoveAttachment: (Int) -> Unit = {}, onReplaceAttachment: (Int) -> Unit = {}, onCaptionAttachment: (Int, String) -> Unit = { _, _ -> }, visibleTerminalLines: () -> List<String> = { emptyList() }, speechEnhancementClient: SpeechEnhancementClient? = null, onClear: () -> Unit, onSubmit: (String) -> Unit, onReturn: () -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val speechSettings = remember(context) { SpeechSettingsStore.values(context) }
    val speechAudioCapture = remember(context, speechSettings.vadSensitivity) { SpeechAudioCapture(context, speechSettings.toAudioCaptureConfig()) }
    val speechTranscriber = remember(context, speechSettings.selectedSpeechModelId) { LiteRtParakeetTranscriber(ParakeetModelCache(context, ParakeetModelArtifacts.byId(speechSettings.selectedSpeechModelId)), ParakeetTokenizerCache(context)) }
    val speechPromptRenderer = remember { SpeechEnhancementPromptRenderer() }
    var dictating by remember { mutableStateOf(false) }
    var dictationState by remember { mutableStateOf(SpeechDictationDisplayState.IDLE) }
    var dictationTranscript by remember { mutableStateOf("") }
    var dictationMeter by remember { mutableStateOf(0f) }
    val dictationAudioFrames = remember { mutableListOf<FloatArray>() }
    var partialTranscriptionJob by remember { mutableStateOf<Job?>(null) }
    var liveChunkEndSample by remember { mutableIntStateOf(16_000) }
    val liveTranscriptMerger = remember { LiveSpeechTranscriptMerger() }
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
    fun submitDictationTranscript() {
        val mergedDraft = mergeSpeechTranscriptIntoDraft(text, dictationTranscript)
        if (mergedDraft.isNotBlank()) onSubmit(mergedDraft)
        onTextChanged("")
        stopDictationCapture()
        dictating = false
        dictationState = SpeechDictationDisplayState.IDLE
        dictationTranscript = ""
        dictationAudioFrames.clear()
        partialTranscriptionJob?.cancel()
        partialTranscriptionJob = null
        liveChunkEndSample = speechAudioCapture.sampleRate
        liveTranscriptMerger.reset()
    }
    fun enhanceTranscript(transcript: String) {
        if (!speechSettings.enhancementEnabled || speechEnhancementClient == null || transcript.isBlank()) {
            dictationState = SpeechDictationDisplayState.TRANSCRIPT_READY
            return
        }
        dictationState = SpeechDictationDisplayState.ENHANCING_COLLAPSED
        scope.launch {
            runCatching {
                val prompt = speechSettings.resolvedPrompt(SpeechSettingsStore.defaultPrompt(context))
                val contextLines = if (speechSettings.includeVisibleTerminalContext) visibleTerminalLines() else emptyList()
                val request = speechPromptRenderer.render(prompt, transcript, contextLines)
                SpeechEnhancer(speechEnhancementClient).enhanceOrRaw(request)
            }.fold(
                onSuccess = { result ->
                    dictationTranscript = result.text
                    dictationState = if (result.enhanced) SpeechDictationDisplayState.ENHANCED_READY else SpeechDictationDisplayState.TRANSCRIPT_READY
                },
                onFailure = {
                    dictationTranscript = transcript
                    dictationState = SpeechDictationDisplayState.TRANSCRIPT_READY
                },
            )
        }
    }
    fun transcribeDictationAudio(frames: List<FloatArray> = dictationAudioFrames.toList()) {
        partialTranscriptionJob?.cancel()
        partialTranscriptionJob = null
        scope.launch {
            val samples = withContext(Dispatchers.Default) { frames.flattenToFloatArray() }
            if (!speechSettings.localTranscriptionEnabled || samples.isEmpty()) {
                dictationTranscript = "Speech transcription unavailable."
                dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
                return@launch
            }
            val result = speechTranscriber.transcribe(samples, speechAudioCapture.sampleRate)
            result.fold(
                onSuccess = {
                    dictationTranscript = it.text
                    enhanceTranscript(it.text)
                },
                onFailure = {
                    dictationTranscript = "Speech transcription unavailable."
                    dictationState = SpeechDictationDisplayState.ENHANCEMENT_FAILED
                },
            )
        }
    }
    fun maybeTranscribePartialAudio() {
        if (!speechSettings.localTranscriptionEnabled) return
        if (partialTranscriptionJob?.isActive == true) return
        val totalSamples = dictationAudioFrames.totalSampleCount()
        if (totalSamples < liveChunkEndSample) return
        val chunkEndSample = liveChunkEndSample
        val snapshot = dictationAudioFrames.sliceSampleWindow(chunkEndSample - speechAudioCapture.sampleRate * 5, chunkEndSample, speechAudioCapture.sampleRate * 5)
        liveChunkEndSample += speechAudioCapture.sampleRate
        partialTranscriptionJob = scope.launch {
            try {
                val result = speechTranscriber.transcribe(snapshot, speechAudioCapture.sampleRate)
                result.getOrNull()?.text?.trim()?.takeIf { it.isNotBlank() }?.let { partialText ->
                    if (dictationState in setOf(SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationDisplayState.RECORDING_WITH_SPEECH)) dictationTranscript = liveTranscriptMerger.merge(partialText)
                }
            } finally {
                partialTranscriptionJob = null
                maybeTranscribePartialAudio()
            }
        }
    }
    fun startDictationCapture() {
        dictationState = SpeechDictationDisplayState.RECORDING_EMPTY
        dictationTranscript = ""
        dictationMeter = 0f
        dictationAudioFrames.clear()
        partialTranscriptionJob?.cancel()
        partialTranscriptionJob = null
        liveChunkEndSample = speechAudioCapture.sampleRate
        liveTranscriptMerger.reset()
        dictating = true
        speechAudioCapture.start(
            onFrame = { frame ->
                scope.launch {
                    dictationAudioFrames.add(frame.samples.copyOf())
                    dictationMeter = frame.meter
                    if (frame.speechDetected && dictationState == SpeechDictationDisplayState.RECORDING_EMPTY) dictationState = SpeechDictationDisplayState.RECORDING_WITH_SPEECH
                    if (frame.speechDetected) maybeTranscribePartialAudio()
                    if (frame.finalized && dictationState in setOf(SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationDisplayState.RECORDING_WITH_SPEECH)) {
                        dictationState = SpeechDictationDisplayState.TRANSCRIBING
                        stopDictationCapture()
                        transcribeDictationAudio(dictationAudioFrames.toList())
                    }
                }
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
    DisposableEffect(Unit) { onDispose { partialTranscriptionJob?.cancel(); speechAudioCapture.stopAsync(); speechTranscriber.close() } }
    if (dictating) {
        DictationInputSurface(
            tokens = tokens,
            displayState = dictationState,
            transcript = dictationTranscript,
            meter = dictationMeter,
            modifier = modifier,
            onAction = { action ->
                val nextState = SpeechDictationUxContract.transition(dictationState, action)
                dictationState = nextState
                when (action) {
                    SpeechDictationAction.DETECT_SPEECH -> dictationTranscript = SpeechDictationUxContract.fixtures.partialTranscript
                    SpeechDictationAction.COMPLETE_TRANSCRIPTION -> dictationTranscript = SpeechDictationUxContract.fixtures.finalTranscript
                    SpeechDictationAction.COMPLETE_ENHANCEMENT -> dictationTranscript = SpeechDictationUxContract.fixtures.enhancedTranscript
                    SpeechDictationAction.SEND_RAW, SpeechDictationAction.SEND_ENHANCED -> submitDictationTranscript()
                    SpeechDictationAction.CANCEL, SpeechDictationAction.RESET -> {
                        stopDictationCapture()
                        dictating = false
                        dictationState = SpeechDictationDisplayState.IDLE
                        dictationTranscript = ""
                        dictationAudioFrames.clear()
                        partialTranscriptionJob?.cancel()
                        partialTranscriptionJob = null
                        liveChunkEndSample = speechAudioCapture.sampleRate
                        liveTranscriptMerger.reset()
                    }
                    SpeechDictationAction.STOP_RECORDING -> {
                        stopDictationCapture()
                        transcribeDictationAudio()
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
    return SpeechAudioCaptureConfig(silenceThreshold = threshold)
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
fun DictationInputSurface(tokens: UiTokens, displayState: SpeechDictationDisplayState, transcript: String, modifier: Modifier = Modifier, meter: Float = 0f, onAction: (SpeechDictationAction) -> Unit) {
    val contract = SpeechDictationUxContract.contractFor(displayState)
    val scrollState = rememberScrollState()
    LaunchedEffect(transcript) { scrollState.animateScrollTo(scrollState.maxValue) }
    Column(modifier.fillMaxWidth().imePadding().wrapContentHeight().padding(horizontal = 18.dp, vertical = 12.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth().height(76.dp).clip(RoundedCornerShape(38.dp)).background(tokens.surfaceHigh).border(BorderStroke(0.7.dp, tokens.separator), RoundedCornerShape(38.dp)).padding(start = 22.dp, end = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            DictationWaveform(active = displayState in setOf(SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationDisplayState.RECORDING_WITH_SPEECH, SpeechDictationDisplayState.TRANSCRIBING, SpeechDictationDisplayState.ENHANCING_COLLAPSED), meter = meter)
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f)) {
                Text(contract.accessibility.label, color = tokens.text, fontSize = 20.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(contract.accessibility.testId, color = tokens.secondary, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            DictationPrimaryAction(displayState, contract, tokens, onAction)
        }
        if (contract.expanded && transcript.isNotBlank()) {
            Column(Modifier.fillMaxWidth().height(86.dp).clip(RoundedCornerShape(22.dp)).background(tokens.surface).border(BorderStroke(0.7.dp, tokens.separator), RoundedCornerShape(22.dp)).padding(14.dp).verticalScroll(scrollState)) {
                Text(transcript, color = tokens.text, fontSize = 17.sp)
            }
        }
        DictationSecondaryActions(displayState, contract, tokens, onAction)
    }
}

@Composable
private fun DictationWaveform(active: Boolean, meter: Float) {
    val transition = rememberInfiniteTransition(label = "dictation-waveform")
    val phase by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(850), RepeatMode.Reverse), label = "dictation-waveform-phase")
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(15) { index ->
            val weight = 1f - kotlin.math.abs(index - 7) / 8f
            val meterBoost = meter.coerceIn(0f, 1f)
            val animatedHeight = if (active) 8.dp + (22.dp * (((phase + index * 0.09f) % 1f) * 0.45f + meterBoost) * weight).coerceAtMost(30.dp) else 8.dp + 10.dp * weight
            Box(Modifier.width(4.dp).height(animatedHeight).clip(RoundedCornerShape(6.dp)).background(Color(0xfff04452)))
        }
    }
}

@Composable
private fun DictationPrimaryAction(displayState: SpeechDictationDisplayState, contract: SpeechDictationStateContract, tokens: UiTokens, onAction: (SpeechDictationAction) -> Unit) {
    val action = when (displayState) {
        SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationDisplayState.RECORDING_WITH_SPEECH -> SpeechDictationAction.STOP_RECORDING
        SpeechDictationDisplayState.TRANSCRIBING -> SpeechDictationAction.COMPLETE_TRANSCRIPTION
        SpeechDictationDisplayState.TRANSCRIPT_READY -> SpeechDictationAction.SEND_RAW
        SpeechDictationDisplayState.ENHANCING_COLLAPSED -> SpeechDictationAction.SEND_RAW
        SpeechDictationDisplayState.ENHANCEMENT_TIMED_OUT, SpeechDictationDisplayState.ENHANCEMENT_FAILED -> SpeechDictationAction.RETRY_ENHANCEMENT
        SpeechDictationDisplayState.ENHANCED_READY -> SpeechDictationAction.SEND_ENHANCED
        else -> SpeechDictationAction.CANCEL
    }
    val icon = when (action) {
        SpeechDictationAction.STOP_RECORDING -> R.drawable.ic_feather_pause
        SpeechDictationAction.RETRY_ENHANCEMENT -> R.drawable.ic_feather_rotate_ccw
        SpeechDictationAction.SEND_RAW, SpeechDictationAction.SEND_ENHANCED -> R.drawable.ic_feather_arrow_up
        else -> R.drawable.ic_feather_check
    }
    val enabled = action in SpeechDictationUxContract.allowedActions(displayState)
    Box(Modifier.size(58.dp).clip(CircleShape).background(if (enabled) Color(0xfff04452) else tokens.separator).clickable(enabled = enabled) { hapticClick(); onAction(action) }, contentAlignment = Alignment.Center) {
        Icon(painterResource(icon), null, tint = Color.White, modifier = Modifier.size(26.dp))
    }
}

@Composable
private fun DictationSecondaryActions(displayState: SpeechDictationDisplayState, contract: SpeechDictationStateContract, tokens: UiTokens, onAction: (SpeechDictationAction) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (SpeechDictationAction.STOP_RECORDING in SpeechDictationUxContract.allowedActions(displayState)) DictationTextAction("Stop", tokens) { onAction(SpeechDictationAction.STOP_RECORDING) }
        if (SpeechDictationAction.DETECT_SPEECH in SpeechDictationUxContract.allowedActions(displayState)) DictationTextAction("Add speech", tokens) { onAction(SpeechDictationAction.DETECT_SPEECH) }
        if (SpeechDictationAction.COMPLETE_TRANSCRIPTION in SpeechDictationUxContract.allowedActions(displayState)) DictationTextAction("Transcript", tokens) { onAction(SpeechDictationAction.COMPLETE_TRANSCRIPTION) }
        if (SpeechDictationAction.START_ENHANCEMENT in SpeechDictationUxContract.allowedActions(displayState)) DictationTextAction("Enhance", tokens) { onAction(SpeechDictationAction.START_ENHANCEMENT) }
        if (SpeechDictationAction.TIME_OUT_ENHANCEMENT in SpeechDictationUxContract.allowedActions(displayState)) DictationTextAction("Timeout", tokens) { onAction(SpeechDictationAction.TIME_OUT_ENHANCEMENT) }
        if (SpeechDictationAction.FAIL_ENHANCEMENT in SpeechDictationUxContract.allowedActions(displayState)) DictationTextAction("Fail", tokens) { onAction(SpeechDictationAction.FAIL_ENHANCEMENT) }
        if (SpeechDictationAction.COMPLETE_ENHANCEMENT in SpeechDictationUxContract.allowedActions(displayState)) DictationTextAction("Done", tokens) { onAction(SpeechDictationAction.COMPLETE_ENHANCEMENT) }
        Spacer(Modifier.weight(1f))
        if (contract.canSendEnhanced) DictationTextAction("Send enhanced", tokens) { onAction(SpeechDictationAction.SEND_ENHANCED) }
        if (contract.canSendRaw && displayState != SpeechDictationDisplayState.TRANSCRIPT_READY) DictationTextAction("Send as-is", tokens) { onAction(SpeechDictationAction.SEND_RAW) }
        if (contract.canCancel) DictationTextAction("Cancel", tokens) { onAction(SpeechDictationAction.CANCEL) }
    }
}

@Composable
private fun DictationTextAction(label: String, tokens: UiTokens, onClick: () -> Unit) {
    Box(Modifier.height(36.dp).clip(RoundedCornerShape(18.dp)).background(tokens.surfaceHigh).clickable { hapticClick(); onClick() }.padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
        Text(label, color = tokens.text, fontSize = 12.sp, maxLines = 1)
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
