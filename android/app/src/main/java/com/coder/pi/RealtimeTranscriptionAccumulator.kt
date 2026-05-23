package com.coder.pi

class RealtimeTranscriptionAccumulator {
    private var completedTranscript: String = ""
    private var partialTranscript: String = ""

    var transcript: String = ""
        private set

    fun appendCompleted(segment: String): String {
        val text = segment.trim()
        if (text.isBlank()) return rebuildTranscript()
        completedTranscript = listOf(completedTranscript.trim(), text).filter { it.isNotBlank() }.joinToString(" ")
        partialTranscript = ""
        rebuildTranscript()
        return transcript
    }

    fun appendDelta(delta: String): String {
        if (delta.isBlank()) return transcript
        partialTranscript += delta
        rebuildTranscript()
        return transcript
    }

    fun reset() {
        completedTranscript = ""
        partialTranscript = ""
        transcript = ""
    }

    private fun rebuildTranscript(): String {
        transcript = listOf(completedTranscript.trim(), partialTranscript.trim()).filter { it.isNotBlank() }.joinToString(" ")
        return transcript
    }
}
