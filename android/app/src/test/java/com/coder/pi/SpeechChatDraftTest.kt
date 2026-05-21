package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Test

class SpeechChatDraftTest {
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
