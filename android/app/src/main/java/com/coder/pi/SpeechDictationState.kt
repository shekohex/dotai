package com.coder.pi

enum class SpeechDictationDisplayState {
    IDLE,
    RECORDING_EMPTY,
    RECORDING_WITH_SPEECH,
    TRANSCRIBING,
    TRANSCRIPT_READY,
    ENHANCING_COLLAPSED,
    ENHANCEMENT_TIMED_OUT,
    ENHANCEMENT_FAILED,
    ENHANCED_READY,
    SUBMITTED,
    CANCELED,
}

enum class SpeechDictationPipelineState {
    PERMISSION,
    CAPTURE,
    VAD,
    STT,
    ENHANCEMENT,
    SEND,
    COMPLETE,
}

enum class SpeechDictationAction {
    REQUEST_PERMISSION,
    START_RECORDING,
    DETECT_SPEECH,
    STOP_RECORDING,
    COMPLETE_TRANSCRIPTION,
    START_ENHANCEMENT,
    TIME_OUT_ENHANCEMENT,
    FAIL_ENHANCEMENT,
    RETRY_ENHANCEMENT,
    COMPLETE_ENHANCEMENT,
    SEND_RAW,
    SEND_ENHANCED,
    CANCEL,
    RESET,
}

data class SpeechDictationFixtureText(
    val partialTranscript: String = "open settings and explain the failing gradle task",
    val finalTranscript: String = "Open settings and explain the failing Gradle task.",
    val enhancedTranscript: String = "Open Settings and explain why the Gradle task is failing, using the visible terminal output as context.",
)

data class SpeechDictationAccessibility(
    val label: String,
    val testId: String,
)

data class SpeechDictationStateContract(
    val displayState: SpeechDictationDisplayState,
    val pipelineStates: Set<SpeechDictationPipelineState>,
    val canEdit: Boolean,
    val canCancel: Boolean,
    val canRetry: Boolean,
    val canSendRaw: Boolean,
    val canSendEnhanced: Boolean,
    val canAutoSend: Boolean,
    val expanded: Boolean,
    val transitionMillis: Int,
    val accessibility: SpeechDictationAccessibility,
)

data class SpeechDictationVisibleActions(
    val primary: SpeechDictationAction?,
    val secondary: List<SpeechDictationAction>,
)

object SpeechDictationUxContract {
    val fixtures = SpeechDictationFixtureText()

    private val contracts = mapOf(
        SpeechDictationDisplayState.IDLE to SpeechDictationStateContract(SpeechDictationDisplayState.IDLE, setOf(SpeechDictationPipelineState.PERMISSION), true, false, false, false, false, false, false, 180, SpeechDictationAccessibility("Start voice input", "speech_idle")),
        SpeechDictationDisplayState.RECORDING_EMPTY to SpeechDictationStateContract(SpeechDictationDisplayState.RECORDING_EMPTY, setOf(SpeechDictationPipelineState.CAPTURE, SpeechDictationPipelineState.VAD), false, true, false, false, false, false, false, 300, SpeechDictationAccessibility("Listening", "speech_recording_empty")),
        SpeechDictationDisplayState.RECORDING_WITH_SPEECH to SpeechDictationStateContract(SpeechDictationDisplayState.RECORDING_WITH_SPEECH, setOf(SpeechDictationPipelineState.CAPTURE, SpeechDictationPipelineState.VAD), false, true, false, false, false, false, true, 300, SpeechDictationAccessibility("Listening with speech detected", "speech_recording_with_speech")),
        SpeechDictationDisplayState.TRANSCRIBING to SpeechDictationStateContract(SpeechDictationDisplayState.TRANSCRIBING, setOf(SpeechDictationPipelineState.STT), false, true, false, false, false, false, true, 220, SpeechDictationAccessibility("Transcribing", "speech_transcribing")),
        SpeechDictationDisplayState.TRANSCRIPT_READY to SpeechDictationStateContract(SpeechDictationDisplayState.TRANSCRIPT_READY, setOf(SpeechDictationPipelineState.STT), true, true, false, true, false, true, true, 220, SpeechDictationAccessibility("Transcript ready", "speech_transcript_ready")),
        SpeechDictationDisplayState.ENHANCING_COLLAPSED to SpeechDictationStateContract(SpeechDictationDisplayState.ENHANCING_COLLAPSED, setOf(SpeechDictationPipelineState.ENHANCEMENT), false, true, false, true, false, false, false, 300, SpeechDictationAccessibility("Enhancing transcript", "speech_enhancing_collapsed")),
        SpeechDictationDisplayState.ENHANCEMENT_TIMED_OUT to SpeechDictationStateContract(SpeechDictationDisplayState.ENHANCEMENT_TIMED_OUT, setOf(SpeechDictationPipelineState.ENHANCEMENT), true, true, true, true, false, false, true, 220, SpeechDictationAccessibility("Enhancement timed out", "speech_enhancement_timed_out")),
        SpeechDictationDisplayState.ENHANCEMENT_FAILED to SpeechDictationStateContract(SpeechDictationDisplayState.ENHANCEMENT_FAILED, setOf(SpeechDictationPipelineState.ENHANCEMENT), true, true, true, true, false, false, true, 220, SpeechDictationAccessibility("Enhancement failed", "speech_enhancement_failed")),
        SpeechDictationDisplayState.ENHANCED_READY to SpeechDictationStateContract(SpeechDictationDisplayState.ENHANCED_READY, setOf(SpeechDictationPipelineState.ENHANCEMENT), true, true, false, true, true, true, true, 220, SpeechDictationAccessibility("Enhanced transcript ready", "speech_enhanced_ready")),
        SpeechDictationDisplayState.SUBMITTED to SpeechDictationStateContract(SpeechDictationDisplayState.SUBMITTED, setOf(SpeechDictationPipelineState.SEND, SpeechDictationPipelineState.COMPLETE), false, false, false, false, false, false, false, 180, SpeechDictationAccessibility("Voice input submitted", "speech_submitted")),
        SpeechDictationDisplayState.CANCELED to SpeechDictationStateContract(SpeechDictationDisplayState.CANCELED, setOf(SpeechDictationPipelineState.COMPLETE), false, false, false, false, false, false, false, 180, SpeechDictationAccessibility("Voice input canceled", "speech_canceled")),
    )

    private val visibleActions = mapOf(
        SpeechDictationDisplayState.IDLE to SpeechDictationVisibleActions(null, emptyList()),
        SpeechDictationDisplayState.RECORDING_EMPTY to SpeechDictationVisibleActions(SpeechDictationAction.STOP_RECORDING, listOf(SpeechDictationAction.CANCEL)),
        SpeechDictationDisplayState.RECORDING_WITH_SPEECH to SpeechDictationVisibleActions(SpeechDictationAction.STOP_RECORDING, listOf(SpeechDictationAction.CANCEL)),
        SpeechDictationDisplayState.TRANSCRIBING to SpeechDictationVisibleActions(null, listOf(SpeechDictationAction.CANCEL)),
        SpeechDictationDisplayState.TRANSCRIPT_READY to SpeechDictationVisibleActions(SpeechDictationAction.SEND_RAW, listOf(SpeechDictationAction.START_ENHANCEMENT, SpeechDictationAction.CANCEL)),
        SpeechDictationDisplayState.ENHANCING_COLLAPSED to SpeechDictationVisibleActions(null, listOf(SpeechDictationAction.SEND_RAW, SpeechDictationAction.CANCEL)),
        SpeechDictationDisplayState.ENHANCEMENT_TIMED_OUT to SpeechDictationVisibleActions(SpeechDictationAction.SEND_RAW, listOf(SpeechDictationAction.RETRY_ENHANCEMENT, SpeechDictationAction.CANCEL)),
        SpeechDictationDisplayState.ENHANCEMENT_FAILED to SpeechDictationVisibleActions(SpeechDictationAction.SEND_RAW, listOf(SpeechDictationAction.RETRY_ENHANCEMENT, SpeechDictationAction.CANCEL)),
        SpeechDictationDisplayState.ENHANCED_READY to SpeechDictationVisibleActions(SpeechDictationAction.SEND_ENHANCED, listOf(SpeechDictationAction.SEND_RAW, SpeechDictationAction.CANCEL)),
        SpeechDictationDisplayState.SUBMITTED to SpeechDictationVisibleActions(null, emptyList()),
        SpeechDictationDisplayState.CANCELED to SpeechDictationVisibleActions(null, emptyList()),
    )

    private val transitions = mapOf(
        SpeechDictationDisplayState.IDLE to mapOf(SpeechDictationAction.REQUEST_PERMISSION to SpeechDictationDisplayState.IDLE, SpeechDictationAction.START_RECORDING to SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
        SpeechDictationDisplayState.RECORDING_EMPTY to mapOf(SpeechDictationAction.DETECT_SPEECH to SpeechDictationDisplayState.RECORDING_WITH_SPEECH, SpeechDictationAction.STOP_RECORDING to SpeechDictationDisplayState.TRANSCRIBING, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
        SpeechDictationDisplayState.RECORDING_WITH_SPEECH to mapOf(SpeechDictationAction.STOP_RECORDING to SpeechDictationDisplayState.TRANSCRIBING, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
        SpeechDictationDisplayState.TRANSCRIBING to mapOf(SpeechDictationAction.COMPLETE_TRANSCRIPTION to SpeechDictationDisplayState.TRANSCRIPT_READY, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
        SpeechDictationDisplayState.TRANSCRIPT_READY to mapOf(SpeechDictationAction.START_ENHANCEMENT to SpeechDictationDisplayState.ENHANCING_COLLAPSED, SpeechDictationAction.SEND_RAW to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
        SpeechDictationDisplayState.ENHANCING_COLLAPSED to mapOf(SpeechDictationAction.TIME_OUT_ENHANCEMENT to SpeechDictationDisplayState.ENHANCEMENT_TIMED_OUT, SpeechDictationAction.FAIL_ENHANCEMENT to SpeechDictationDisplayState.ENHANCEMENT_FAILED, SpeechDictationAction.COMPLETE_ENHANCEMENT to SpeechDictationDisplayState.ENHANCED_READY, SpeechDictationAction.SEND_RAW to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
        SpeechDictationDisplayState.ENHANCEMENT_TIMED_OUT to mapOf(SpeechDictationAction.RETRY_ENHANCEMENT to SpeechDictationDisplayState.ENHANCING_COLLAPSED, SpeechDictationAction.SEND_RAW to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
        SpeechDictationDisplayState.ENHANCEMENT_FAILED to mapOf(SpeechDictationAction.RETRY_ENHANCEMENT to SpeechDictationDisplayState.ENHANCING_COLLAPSED, SpeechDictationAction.SEND_RAW to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
        SpeechDictationDisplayState.ENHANCED_READY to mapOf(SpeechDictationAction.SEND_RAW to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.SEND_ENHANCED to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
        SpeechDictationDisplayState.SUBMITTED to mapOf(SpeechDictationAction.RESET to SpeechDictationDisplayState.IDLE),
        SpeechDictationDisplayState.CANCELED to mapOf(SpeechDictationAction.RESET to SpeechDictationDisplayState.IDLE),
    )

    fun contractFor(displayState: SpeechDictationDisplayState): SpeechDictationStateContract = contracts.getValue(displayState)

    fun transition(displayState: SpeechDictationDisplayState, action: SpeechDictationAction): SpeechDictationDisplayState = transitions[displayState]?.get(action) ?: error("Invalid speech dictation transition: $displayState + $action")

    fun allowedActions(displayState: SpeechDictationDisplayState): Set<SpeechDictationAction> = transitions[displayState].orEmpty().keys

    fun visibleActionsFor(displayState: SpeechDictationDisplayState): SpeechDictationVisibleActions = visibleActions.getValue(displayState)
}
