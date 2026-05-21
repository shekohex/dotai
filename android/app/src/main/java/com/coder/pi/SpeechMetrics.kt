package com.coder.pi

data class SpeechMetrics(
    val modelLoadMillis: Long = 0,
    val chunkMillis: Long = 0,
    val vadSegmentCount: Int = 0,
    val enhancementMillis: Long = 0,
    val failureKind: SpeechFailureKind? = null,
)

enum class SpeechFailureKind {
    PERMISSION_DENIED,
    CAPTURE_SILENCED,
    NETWORK_FAILURE,
    MODEL_MISSING,
    LOW_MEMORY,
    RUNTIME_UNAVAILABLE,
    TIMEOUT,
    CANCELED,
}

object SpeechMetricsSanitizer {
    fun sanitize(metrics: SpeechMetrics): SpeechMetrics = metrics.copy(
        modelLoadMillis = metrics.modelLoadMillis.coerceAtLeast(0),
        chunkMillis = metrics.chunkMillis.coerceAtLeast(0),
        vadSegmentCount = metrics.vadSegmentCount.coerceAtLeast(0),
        enhancementMillis = metrics.enhancementMillis.coerceAtLeast(0),
    )
}
