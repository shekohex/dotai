package com.coder.pi

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechAudioCaptureTest {
    @Test
    fun vadStartsAfterConsecutiveSpeechFrames() {
        val segmenter = SpeechVadSegmenter(SpeechAudioCaptureConfig(silenceThreshold = 0.01f, speechStartFrames = 3))
        val silence = FloatArray(320) { 0f }
        val speech = FloatArray(320) { 0.08f }

        assertFalse(segmenter.accept(silence).speechDetected)
        assertFalse(segmenter.accept(speech).speechDetected)
        assertFalse(segmenter.accept(speech).speechDetected)
        assertTrue(segmenter.accept(speech).speechDetected)
    }

    @Test
    fun vadDoesNotFinalizeAfterTrailingSilence() {
        val segmenter = SpeechVadSegmenter(SpeechAudioCaptureConfig(silenceThreshold = 0.01f, speechStartFrames = 1, trailingSilenceMillis = 60, frameMillis = 20))
        val silence = FloatArray(320) { 0f }
        val speech = FloatArray(320) { 0.08f }

        assertTrue(segmenter.accept(speech).speechDetected)
        assertFalse(segmenter.accept(silence).finalized)
        assertFalse(segmenter.accept(silence).finalized)
        assertFalse(segmenter.accept(silence).finalized)
    }

    @Test
    fun meterSmoothsAndResets() {
        val segmenter = SpeechVadSegmenter(SpeechAudioCaptureConfig(silenceThreshold = 0.01f))
        val speech = FloatArray(320) { 0.5f }

        val firstMeter = segmenter.accept(speech).meter
        val secondMeter = segmenter.accept(speech).meter
        segmenter.reset()
        val resetMeter = segmenter.accept(FloatArray(320)).meter

        assertTrue(firstMeter in 0f..1f)
        assertTrue(secondMeter > firstMeter)
        assertTrue(resetMeter < firstMeter)
    }

    @Test
    fun silencedFrameNeverStartsSpeechAndReportsSilenced() {
        val segmenter = SpeechVadSegmenter(SpeechAudioCaptureConfig(silenceThreshold = 0.01f, speechStartFrames = 1))
        val frame = segmenter.accept(FloatArray(320) { 0.5f }, silenced = true)

        assertFalse(frame.speechDetected)
        assertTrue(frame.silenced)
    }
}
