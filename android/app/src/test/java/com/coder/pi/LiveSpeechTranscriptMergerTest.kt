package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Test

class LiveSpeechTranscriptMergerTest {
    @Test
    fun mergesOverlappingChunksWithoutDuplicatingWords() {
        val merger = LiveSpeechTranscriptMerger()

        assertEquals("open the settings panel", merger.merge("open the settings panel"))
        assertEquals("open the settings panel and run gradle", merger.merge("settings panel and run gradle"))
    }

    @Test
    fun replacesUnconfirmedTailWhenChunkAutocorrectsWords() {
        val merger = LiveSpeechTranscriptMerger()

        assertEquals("open the seting pannel", merger.merge("open the seting pannel"))
        assertEquals("open the setting panel now", merger.merge("setting panel now"))
    }

    @Test
    fun appendsWhenNoOverlapExists() {
        val merger = LiveSpeechTranscriptMerger()

        assertEquals("hello world", merger.merge("hello world"))
        assertEquals("hello world run tests", merger.merge("run tests"))
    }

    @Test
    fun ignoresBlankChunk() {
        val merger = LiveSpeechTranscriptMerger()

        assertEquals("hello", merger.merge("hello"))
        assertEquals("hello", merger.merge("   "))
    }

    @Test
    fun confirmedPrefixIsNotDuplicatedAfterRepeatedAgreement() {
        val merger = LiveSpeechTranscriptMerger(confirmationsNeeded = 2, minWordsToConfirm = 3)

        assertEquals("open settings and explain gradle", merger.merge("open settings and explain gradle"))
        assertEquals("open settings and explain gradle", merger.merge("open settings and explain gradle"))
        assertEquals("open settings and explain gradle task", merger.merge("explain gradle task"))
    }

    @Test
    fun repeatedFullChunkAfterConfirmationDoesNotDuplicateConfirmedPrefix() {
        val merger = LiveSpeechTranscriptMerger(confirmationsNeeded = 2, minWordsToConfirm = 3)

        assertEquals("one two three four five six seven eight.", merger.merge("one two three four five six seven eight."))
        assertEquals("one two three four five six seven eight.", merger.merge("one two three four five six seven eight."))
        assertEquals("one two three four five six seven eight.", merger.merge("one two three four five six seven eight."))
    }
}
