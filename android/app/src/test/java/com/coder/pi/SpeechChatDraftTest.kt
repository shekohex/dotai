package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechChatDraftTest {
    @Test
    fun finalSpeechUsesFinalTranscriptWhenPresent() {
        assertEquals("Open settings.", selectFinalSpeechTranscript(" Open settings. ", "open"))
    }

    @Test
    fun longFinalSpeechUsesFinalTranscriptWhenPresent() {
        assertEquals("Open settings", selectFinalSpeechTranscript("Open settings", "Open settings and explain gradle", sampleCount = 16_000 * 8, sampleRate = 16_000))
    }

    @Test
    fun finalSpeechChunksStayWithinFiveSecondModelWindow() {
        val chunks = finalSpeechChunks(FloatArray(16_000 * 8), 16_000)

        assertEquals(3, chunks.size)
        chunks.forEach { chunk -> assertTrue(chunk.size <= 16_000 * 5) }
    }

    @Test
    fun liveSpeechWindowUsesFourSecondsPlusOneSecondSilence() {
        assertEquals(16_000 * 4, liveSpeechWindowSamples(16_000))
        assertEquals(16_000, liveSpeechTrailingSilenceSamples(16_000))
    }

    @Test
    fun liveSpeechPassAdvancesByHalfSecond() {
        assertEquals(16_000 + 8_000, nextLiveSpeechPassSample(16_000, 16_000))
    }

    @Test
    fun earlyLiveSpeechWindowPreservesPrePadding() {
        assertEquals(-48_000, liveSpeechWindowStartSample(16_000, 16_000))
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

    @Test
    fun waveformVisualLevelBoostsQuietSpeechMeters() {
        assertTrue(speechWaveformVisualLevel(0.02f) > 0.4f)
        assertEquals(1f, speechWaveformVisualLevel(1f), 0.0f)
    }

    @Test
    fun enhancementHapticLoopWaitsAfterHeartbeatPattern() {
        val heartbeatPattern = TerminalHapticPatterns.option("heartbeat")

        assertEquals(heartbeatPattern.timings.sum() + 900L, speechEnhancementHapticRepeatDelayMillis("heartbeat"))
    }
}
