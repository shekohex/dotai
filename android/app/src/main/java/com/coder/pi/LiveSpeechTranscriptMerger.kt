package com.coder.pi

class LiveSpeechTranscriptMerger {
    private var mergedText = ""

    fun reset() {
        mergedText = ""
    }

    fun merge(chunkText: String): String {
        val current = mergedText.trim()
        val next = chunkText.trim()
        if (next.isBlank()) return current
        if (current.isBlank()) {
            mergedText = next
            return mergedText
        }
        val currentWords = current.splitWords()
        val nextWords = next.splitWords()
        val overlap = longestWordOverlap(currentWords, nextWords)
        mergedText = if (overlap > 0) {
            (currentWords + nextWords.drop(overlap)).joinToString(" ")
        } else {
            listOf(current, next).joinToString(" ")
        }
        return mergedText
    }
}

private fun String.splitWords(): List<String> = trim().split(Regex("\\s+")).filter { it.isNotBlank() }

private fun longestWordOverlap(previous: List<String>, next: List<String>): Int {
    val maxOverlap = minOf(previous.size, next.size)
    for (size in maxOverlap downTo 1) {
        val previousSuffix = previous.takeLast(size).map { it.normalizedForOverlap() }
        val nextPrefix = next.take(size).map { it.normalizedForOverlap() }
        if (previousSuffix == nextPrefix) return size
    }
    return 0
}

private fun String.normalizedForOverlap(): String = lowercase().trim { !it.isLetterOrDigit() }
