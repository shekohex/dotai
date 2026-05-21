package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Test

class SpeechChatDraftTest {
    @Test
    fun finalSpeechUsesFinalTranscriptWhenPresent() {
        assertEquals("Open settings.", selectFinalSpeechTranscript(" Open settings. ", "open"))
    }

    @Test
    fun longFinalSpeechPreservesLiveTranscriptWhenPresent() {
        assertEquals("Open settings and explain gradle", selectFinalSpeechTranscript("Open settings", "Open settings and explain gradle", sampleCount = 16_000 * 8, sampleRate = 16_000))
    }

    @Test
    fun finalSpeechFallsBackToLivePartialWhenFinalIsBlank() {
        assertEquals("Open settings and line", selectFinalSpeechTranscript("  ", " Open settings and line "))
    }

    @Test
    fun finalSpeechIsBlankOnlyWhenFinalAndLiveAreBlank() {
        assertEquals("", selectFinalSpeechTranscript("  ", "\n"))
    }

    @Test
    fun acceptedSpeechReplacesBlankDraft() {
        assertEquals("open settings", mergeSpeechTranscriptIntoDraft("", " open settings "))
    }

    @Test
    fun acceptedSpeechAppendsToExistingDraftWithSpace() {
        assertEquals("please open settings", mergeSpeechTranscriptIntoDraft("please", "open settings"))
    }

    @Test
    fun acceptedSpeechPreservesMultilineFormatting() {
        assertEquals("tasks:\nopen settings", mergeSpeechTranscriptIntoDraft("tasks:\n", "open settings"))
    }

    @Test
    fun blankAcceptedSpeechDoesNotAlterDraft() {
        assertEquals("existing", mergeSpeechTranscriptIntoDraft("existing", "  \n"))
    }
}
