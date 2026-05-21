package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class SpeechPrivacyAuditTest {
    @Test
    fun metricsContainNoRawSpeechFields() {
        val fieldNames = SpeechMetrics::class.java.declaredFields.map { it.name.lowercase() }

        assertFalse(fieldNames.any { it.contains("audio") || it.contains("transcript") || it.contains("prompt") || it.contains("context") || it.contains("token") })
    }

    @Test
    fun metricsSanitizerBoundsNegativeDurations() {
        val sanitized = SpeechMetricsSanitizer.sanitize(SpeechMetrics(modelLoadMillis = -1, chunkMillis = -2, vadSegmentCount = -3, enhancementMillis = -4, failureKind = SpeechFailureKind.MODEL_MISSING))

        assertEquals(0, sanitized.modelLoadMillis)
        assertEquals(0, sanitized.chunkMillis)
        assertEquals(0, sanitized.vadSegmentCount)
        assertEquals(0, sanitized.enhancementMillis)
        assertEquals(SpeechFailureKind.MODEL_MISSING, sanitized.failureKind)
    }
}
