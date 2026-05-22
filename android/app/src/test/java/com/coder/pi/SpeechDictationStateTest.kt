package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechDictationStateTest {
    private val expectedTransitions =
        mapOf(
            SpeechDictationDisplayState.IDLE to mapOf(SpeechDictationAction.REQUEST_PERMISSION to SpeechDictationDisplayState.IDLE, SpeechDictationAction.START_RECORDING to SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
            SpeechDictationDisplayState.RECORDING_EMPTY to mapOf(SpeechDictationAction.DETECT_SPEECH to SpeechDictationDisplayState.RECORDING_WITH_SPEECH, SpeechDictationAction.STOP_RECORDING to SpeechDictationDisplayState.TRANSCRIBING, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
            SpeechDictationDisplayState.RECORDING_WITH_SPEECH to mapOf(SpeechDictationAction.STOP_RECORDING to SpeechDictationDisplayState.TRANSCRIBING, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
            SpeechDictationDisplayState.TRANSCRIBING to mapOf(SpeechDictationAction.COMPLETE_TRANSCRIPTION to SpeechDictationDisplayState.TRANSCRIPT_READY, SpeechDictationAction.COMPLETE_NO_SPEECH to SpeechDictationDisplayState.NO_SPEECH, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
            SpeechDictationDisplayState.TRANSCRIPT_READY to mapOf(SpeechDictationAction.START_ENHANCEMENT to SpeechDictationDisplayState.ENHANCING_COLLAPSED, SpeechDictationAction.SEND_RAW to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
            SpeechDictationDisplayState.ENHANCING_COLLAPSED to mapOf(SpeechDictationAction.TIME_OUT_ENHANCEMENT to SpeechDictationDisplayState.ENHANCEMENT_TIMED_OUT, SpeechDictationAction.FAIL_ENHANCEMENT to SpeechDictationDisplayState.ENHANCEMENT_FAILED, SpeechDictationAction.COMPLETE_ENHANCEMENT to SpeechDictationDisplayState.ENHANCED_READY, SpeechDictationAction.SEND_RAW to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
            SpeechDictationDisplayState.ENHANCEMENT_TIMED_OUT to mapOf(SpeechDictationAction.RETRY_ENHANCEMENT to SpeechDictationDisplayState.ENHANCING_COLLAPSED, SpeechDictationAction.SEND_RAW to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
            SpeechDictationDisplayState.ENHANCEMENT_FAILED to mapOf(SpeechDictationAction.RETRY_ENHANCEMENT to SpeechDictationDisplayState.ENHANCING_COLLAPSED, SpeechDictationAction.SEND_RAW to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
            SpeechDictationDisplayState.ENHANCED_READY to mapOf(SpeechDictationAction.SEND_RAW to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.SEND_ENHANCED to SpeechDictationDisplayState.SUBMITTED, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
            SpeechDictationDisplayState.NO_SPEECH to mapOf(SpeechDictationAction.START_RECORDING to SpeechDictationDisplayState.RECORDING_EMPTY, SpeechDictationAction.CANCEL to SpeechDictationDisplayState.CANCELED),
            SpeechDictationDisplayState.SUBMITTED to mapOf(SpeechDictationAction.RESET to SpeechDictationDisplayState.IDLE),
            SpeechDictationDisplayState.CANCELED to mapOf(SpeechDictationAction.RESET to SpeechDictationDisplayState.IDLE),
        )

    @Test
    fun everyDisplayStateHasContract() {
        SpeechDictationDisplayState.entries.forEach { state ->
            val contract = SpeechDictationUxContract.contractFor(state)

            assertEquals(state, contract.displayState)
            assertTrue(contract.accessibility.label.isNotBlank())
            assertTrue(contract.accessibility.testId.startsWith("speech_"))
            assertTrue(contract.transitionMillis in 0..300)
            assertTrue(contract.pipelineStates.isNotEmpty())
        }
    }

    @Test
    fun happyPathTransitionsToSubmitted() {
        var state = SpeechDictationDisplayState.IDLE

        state = SpeechDictationUxContract.transition(state, SpeechDictationAction.START_RECORDING)
        assertEquals(SpeechDictationDisplayState.RECORDING_EMPTY, state)

        state = SpeechDictationUxContract.transition(state, SpeechDictationAction.DETECT_SPEECH)
        assertEquals(SpeechDictationDisplayState.RECORDING_WITH_SPEECH, state)

        state = SpeechDictationUxContract.transition(state, SpeechDictationAction.STOP_RECORDING)
        assertEquals(SpeechDictationDisplayState.TRANSCRIBING, state)

        state = SpeechDictationUxContract.transition(state, SpeechDictationAction.COMPLETE_TRANSCRIPTION)
        assertEquals(SpeechDictationDisplayState.TRANSCRIPT_READY, state)

        state = SpeechDictationUxContract.transition(state, SpeechDictationAction.START_ENHANCEMENT)
        assertEquals(SpeechDictationDisplayState.ENHANCING_COLLAPSED, state)

        state = SpeechDictationUxContract.transition(state, SpeechDictationAction.COMPLETE_ENHANCEMENT)
        assertEquals(SpeechDictationDisplayState.ENHANCED_READY, state)

        state = SpeechDictationUxContract.transition(state, SpeechDictationAction.SEND_ENHANCED)
        assertEquals(SpeechDictationDisplayState.SUBMITTED, state)
    }

    @Test
    fun timeoutAndFailureCanRetryOrSendRaw() {
        val timeout = SpeechDictationUxContract.transition(SpeechDictationDisplayState.ENHANCING_COLLAPSED, SpeechDictationAction.TIME_OUT_ENHANCEMENT)
        val failure = SpeechDictationUxContract.transition(SpeechDictationDisplayState.ENHANCING_COLLAPSED, SpeechDictationAction.FAIL_ENHANCEMENT)

        assertEquals(SpeechDictationDisplayState.ENHANCING_COLLAPSED, SpeechDictationUxContract.transition(timeout, SpeechDictationAction.RETRY_ENHANCEMENT))
        assertEquals(SpeechDictationDisplayState.SUBMITTED, SpeechDictationUxContract.transition(timeout, SpeechDictationAction.SEND_RAW))
        assertEquals(SpeechDictationDisplayState.ENHANCING_COLLAPSED, SpeechDictationUxContract.transition(failure, SpeechDictationAction.RETRY_ENHANCEMENT))
        assertEquals(SpeechDictationDisplayState.SUBMITTED, SpeechDictationUxContract.transition(failure, SpeechDictationAction.SEND_RAW))
    }

    @Test
    fun everyValidTransitionTargetsExpectedState() {
        expectedTransitions.forEach { (state, transitions) ->
            assertEquals("$state allowed actions", transitions.keys, SpeechDictationUxContract.allowedActions(state))
            transitions.forEach { (action, expectedState) ->
                assertEquals("$state + $action", expectedState, SpeechDictationUxContract.transition(state, action))
            }
        }
    }

    @Test
    fun actionCapabilitiesMatchUxContract() {
        assertFalse(SpeechDictationUxContract.contractFor(SpeechDictationDisplayState.RECORDING_EMPTY).canEdit)
        assertFalse(SpeechDictationUxContract.contractFor(SpeechDictationDisplayState.TRANSCRIBING).canEdit)
        assertFalse(SpeechDictationUxContract.contractFor(SpeechDictationDisplayState.ENHANCING_COLLAPSED).canEdit)
        assertTrue(SpeechDictationUxContract.contractFor(SpeechDictationDisplayState.TRANSCRIPT_READY).canSendRaw)
        assertTrue(SpeechDictationUxContract.contractFor(SpeechDictationDisplayState.ENHANCED_READY).canSendEnhanced)
        assertTrue(SpeechDictationUxContract.contractFor(SpeechDictationDisplayState.ENHANCEMENT_FAILED).canRetry)
        assertTrue(SpeechDictationUxContract.contractFor(SpeechDictationDisplayState.ENHANCEMENT_TIMED_OUT).canRetry)
    }

    @Test
    fun visibleActionsAreAllowedAndNeverDuplicated() {
        SpeechDictationDisplayState.entries.forEach { state ->
            val visibleActions = SpeechDictationUxContract.visibleActionsFor(state)
            val visible = listOfNotNull(visibleActions.primary) + visibleActions.secondary
            val allowed = SpeechDictationUxContract.allowedActions(state)

            assertEquals("$state visible actions must be unique", visible.toSet().size, visible.size)
            visible.forEach { action -> assertTrue("$state exposes invalid $action", action in allowed) }
        }
    }

    @Test
    fun visibleActionsEncodeOnePrimaryUserFlow() {
        assertEquals(SpeechDictationAction.STOP_RECORDING, SpeechDictationUxContract.visibleActionsFor(SpeechDictationDisplayState.RECORDING_WITH_SPEECH).primary)
        assertEquals(null, SpeechDictationUxContract.visibleActionsFor(SpeechDictationDisplayState.TRANSCRIBING).primary)
        assertEquals(SpeechDictationAction.SEND_RAW, SpeechDictationUxContract.visibleActionsFor(SpeechDictationDisplayState.TRANSCRIPT_READY).primary)
        assertEquals(null, SpeechDictationUxContract.visibleActionsFor(SpeechDictationDisplayState.ENHANCING_COLLAPSED).primary)
        assertEquals(SpeechDictationAction.SEND_RAW, SpeechDictationUxContract.visibleActionsFor(SpeechDictationDisplayState.ENHANCEMENT_FAILED).primary)
        assertEquals(SpeechDictationAction.SEND_ENHANCED, SpeechDictationUxContract.visibleActionsFor(SpeechDictationDisplayState.ENHANCED_READY).primary)
        assertEquals(SpeechDictationAction.START_RECORDING, SpeechDictationUxContract.visibleActionsFor(SpeechDictationDisplayState.NO_SPEECH).primary)
        assertFalse(SpeechDictationAction.SEND_RAW in SpeechDictationUxContract.visibleActionsFor(SpeechDictationDisplayState.NO_SPEECH).secondary)
    }

    @Test
    fun invalidTransitionsThrow() {
        val invalidPairs =
            SpeechDictationDisplayState.entries.flatMap { state ->
                SpeechDictationAction.entries.filterNot { action -> action in SpeechDictationUxContract.allowedActions(state) }.map { state to it }
            }

        assertTrue(invalidPairs.isNotEmpty())
        invalidPairs.forEach { (state, action) ->
            val failed = runCatching { SpeechDictationUxContract.transition(state, action) }.isFailure
            assertTrue("$state should reject $action", failed)
        }
    }

    @Test
    fun fixtureStringsAreDeterministic() {
        val fixtures = SpeechDictationUxContract.fixtures

        assertTrue(fixtures.partialTranscript.contains("gradle", ignoreCase = true))
        assertTrue(fixtures.finalTranscript.endsWith("."))
        assertTrue(fixtures.enhancedTranscript.length > fixtures.finalTranscript.length)
    }
}
