package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechTranscriberTest {
    @Test
    fun parakeetInt8ArtifactMatchesLfsMetadata() {
        val artifact = ParakeetModelArtifacts.int8

        assertEquals("parakeet_tdt_0.6b_v3_5s_i8.tflite", artifact.fileName)
        assertEquals("f25e5972fe72048f67272e26d4badfe19d876e0fa19027cb2c6c0e0fc4da692b", artifact.sha256)
        assertEquals(614_437_424L, artifact.sizeBytes)
        assertTrue(artifact.url.contains("huggingface.co/litert-community/parakeet-tdt-0.6b-v3"))
    }

    @Test
    fun overlapMergeRemovesRepeatedWindowText() {
        val merged = SpeechTranscriptOverlapMerger.merge(
            "open settings and explain the failing gradle task",
            "the failing gradle task with visible terminal context",
        )

        assertEquals("open settings and explain the failing gradle task with visible terminal context", merged)
    }

    @Test
    fun overlapMergeKeepsDistinctText() {
        val merged = SpeechTranscriptOverlapMerger.merge("open settings", "explain gradle")

        assertEquals("open settings explain gradle", merged)
    }

    @Test
    fun featureExtractorProducesParakeetInputShape() {
        val config = ParakeetFeatureConfig()
        val features = ParakeetFeatureExtractor(config).extract(FloatArray(config.inputSamples) { 0.02f }, config.sampleRate)

        assertEquals(128 * 500, features.size)
    }

    @Test
    fun tokenizerDecodesSentencePieceMarker() {
        val tokenizer = ParakeetTokenizer(mapOf(1 to "▁hello", 2 to "▁world"))

        assertEquals("hello world", tokenizer.decode(listOf(1, 2)))
    }
}
