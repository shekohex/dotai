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
    fun vadMarksPauseWithoutFinalizingAfterTrailingSilence() {
        val segmenter = SpeechVadSegmenter(SpeechAudioCaptureConfig(silenceThreshold = 0.01f, speechStartFrames = 1, trailingSilenceMillis = 60, frameMillis = 20))
        val silence = FloatArray(320) { 0f }
        val speech = FloatArray(320) { 0.08f }

        assertTrue(segmenter.accept(speech).speechDetected)
        assertFalse(segmenter.accept(silence).finalized)
        assertFalse(segmenter.accept(silence).speechPaused)
        assertFalse(segmenter.accept(silence).finalized)
        val paused = segmenter.accept(silence)
        assertTrue(paused.speechPaused)
        assertFalse(paused.finalized)
    }

    @Test
    fun vadResumesAfterPauseWhenSpeechReturns() {
        val segmenter = SpeechVadSegmenter(SpeechAudioCaptureConfig(silenceThreshold = 0.01f, speechStartFrames = 1, trailingSilenceMillis = 40, frameMillis = 20))
        val silence = FloatArray(320) { 0f }
        val speech = FloatArray(320) { 0.08f }

        assertTrue(segmenter.accept(speech).voiceActive)
        assertTrue(segmenter.accept(silence).speechDetected)
        assertTrue(segmenter.accept(silence).speechPaused)
        val resumed = segmenter.accept(speech)
        assertTrue(resumed.speechDetected)
        assertTrue(resumed.voiceActive)
        assertFalse(resumed.speechPaused)
    }

    @Test
    fun vadZerosSilentFramesLikeLiteRtSample() {
        val segmenter = SpeechVadSegmenter(SpeechAudioCaptureConfig(silenceThreshold = 0.01f, speechStartFrames = 1))
        val quietNoise = FloatArray(320) { 0.005f }

        val frame = segmenter.accept(quietNoise)

        assertFalse(frame.voiceActive)
        assertTrue(frame.samples.all { it == 0f })
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
