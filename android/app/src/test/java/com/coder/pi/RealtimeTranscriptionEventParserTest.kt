package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Test

class RealtimeTranscriptionEventParserTest {
    @Test
    fun completedEventsAppendTranscriptSegments() {
        val accumulator = RealtimeTranscriptionAccumulator()

        assertEquals("hello", accumulator.appendCompleted(" hello "))
        assertEquals("hello world", accumulator.appendCompleted("world"))
    }

    @Test
    fun completedEventReplacesPendingDeltaInsteadOfDuplicatingIt() {
        val accumulator = RealtimeTranscriptionAccumulator()

        assertEquals("hello wor", accumulator.appendDelta("hello wor"))
        assertEquals("hello world", accumulator.appendCompleted("hello world"))
    }
}
