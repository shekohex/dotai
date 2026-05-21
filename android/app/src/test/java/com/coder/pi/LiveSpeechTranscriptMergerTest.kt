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
}
