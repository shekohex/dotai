package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechDictationStateTest {
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
    fun invalidTransitionsThrow() {
        val invalidPairs = SpeechDictationDisplayState.entries.flatMap { state ->
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
