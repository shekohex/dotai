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
        val replacementStart = bestReplacementStart(currentWords, nextWords)
        mergedText = if (replacementStart != null) {
            (currentWords.take(replacementStart) + nextWords).joinToString(" ")
        } else {
            listOf(current, next).joinToString(" ")
        }
        return mergedText
    }
}

private fun String.splitWords(): List<String> = trim().split(Regex("\\s+")).filter { it.isNotBlank() }

private fun bestReplacementStart(previous: List<String>, next: List<String>): Int? {
    val normalizedPrevious = previous.map { it.normalizedForOverlap() }
    val normalizedNext = next.map { it.normalizedForOverlap() }
    val minOverlap = minOf(2, normalizedNext.size, normalizedPrevious.size)
    for (start in normalizedPrevious.indices.reversed()) {
        val overlap = minOf(normalizedPrevious.size - start, normalizedNext.size)
        if (overlap < minOverlap) continue
        var matches = 0
        for (index in 0 until overlap) {
            if (normalizedPrevious[start + index].matchesLiveWord(normalizedNext[index])) matches++
        }
        if (matches >= minOverlap && matches.toFloat() / overlap >= 0.55f) return start
    }
    return null
}

private fun String.normalizedForOverlap(): String = lowercase().trim { !it.isLetterOrDigit() }

private fun String.matchesLiveWord(other: String): Boolean {
    if (this == other) return true
    if (isBlank() || other.isBlank()) return false
    val maxLength = maxOf(length, other.length)
    if (maxLength < 5) return false
    return levenshteinDistance(other) <= 2
}

private fun String.levenshteinDistance(other: String): Int {
    val previous = IntArray(other.length + 1) { it }
    val current = IntArray(other.length + 1)
    for (leftIndex in indices) {
        current[0] = leftIndex + 1
        for (rightIndex in other.indices) {
            val cost = if (this[leftIndex] == other[rightIndex]) 0 else 1
            current[rightIndex + 1] = minOf(current[rightIndex] + 1, previous[rightIndex + 1] + 1, previous[rightIndex] + cost)
        }
        for (index in previous.indices) previous[index] = current[index]
    }
    return previous[other.length]
}
