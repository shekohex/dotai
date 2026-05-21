package com.coder.pi

class LiveSpeechTranscriptMerger(
    private val confirmationsNeeded: Int = 3,
    private val minWordsToConfirm: Int = 5,
) {
    private var confirmedWords: List<String> = emptyList()
    private var hypothesisWords: List<String> = emptyList()
    private var previousHypothesisWords: List<String> = emptyList()
    private var consecutiveAgreementCount = 0

    fun reset() {
        confirmedWords = emptyList()
        hypothesisWords = emptyList()
        previousHypothesisWords = emptyList()
        consecutiveAgreementCount = 0
    }

    fun merge(chunkText: String): String {
        val chunkWords = chunkText.splitWords()
        if (chunkWords.isEmpty()) return fullText()
        val nextHypothesis = alignedHypothesis(chunkWords)
        updateAgreement(nextHypothesis)
        hypothesisWords = nextHypothesis
        previousHypothesisWords = nextHypothesis
        return fullText()
    }

    private fun alignedHypothesis(chunkWords: List<String>): List<String> {
        if (hypothesisWords.isEmpty()) return chunkWords
        val replacementStart = bestReplacementStart(hypothesisWords, chunkWords)
        return if (replacementStart != null) hypothesisWords.take(replacementStart) + chunkWords else hypothesisWords + chunkWords
    }

    private fun updateAgreement(nextHypothesis: List<String>) {
        if (previousHypothesisWords.isEmpty()) return
        val commonPrefixLength = commonPrefixLength(previousHypothesisWords, nextHypothesis)
        if (commonPrefixLength < minWordsToConfirm) {
            consecutiveAgreementCount = 0
            return
        }
        consecutiveAgreementCount++
        if (consecutiveAgreementCount < confirmationsNeeded) return
        val confirmCount = (commonPrefixLength - minWordsToConfirm + 1).coerceAtLeast(0)
        if (confirmCount == 0) return
        val newlyConfirmed = nextHypothesis.take(confirmCount)
        confirmedWords = confirmedWords + newlyConfirmed
        hypothesisWords = nextHypothesis.drop(confirmCount)
        previousHypothesisWords = hypothesisWords
        consecutiveAgreementCount = 0
    }

    private fun fullText(): String = (confirmedWords + hypothesisWords).joinToString(" ").trim()
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

private fun commonPrefixLength(left: List<String>, right: List<String>): Int {
    val max = minOf(left.size, right.size)
    var count = 0
    while (count < max && left[count].normalizedForOverlap().matchesLiveWord(right[count].normalizedForOverlap())) count++
    return count
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
