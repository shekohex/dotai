package com.coder.pi

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechEnhancementTest {
    private val template = "Transcript=<TRANSCRIPT>\nContext=<CONTEXT>"

    @Test
    fun rendererInjectsTranscriptAndVisibleContext() {
        val request = SpeechEnhancementPromptRenderer().render(template, "open settings", listOf("gradle failed", "build log"))

        assertTrue(request.prompt.contains("Transcript=open settings"))
        assertTrue(request.prompt.contains("gradle failed\nbuild log"))
    }

    @Test
    fun rendererBoundsContextLinesAndChars() {
        val request = SpeechEnhancementPromptRenderer(SpeechEnhancementPromptConfig(maxContextLines = 2, maxContextChars = 12)).render(template, "hello", listOf("one", "two", "three very long"))

        assertFalse(request.context.contains("one"))
        assertEquals("two\nthree ve", request.context)
    }

    @Test
    fun rendererRedactsSecrets() {
        val request = SpeechEnhancementPromptRenderer().render(template, "hello", listOf("curl -H 'Authorization: Bearer abc.def' https://x.test?token=secret&ok=1 api_key=123"))

        assertFalse(request.context.contains("abc.def"))
        assertFalse(request.context.contains("token=secret"))
        assertFalse(request.context.contains("api_key=123"))
        assertTrue(request.context.contains("Bearer <redacted>"))
    }

    @Test
    fun enhancerRetriesOnceAndReturnsEnhancedText() = runBlocking {
        var calls = 0
        val enhancer = SpeechEnhancer(OpenAiCompatibleSpeechEnhancementClient {
            calls++
            if (calls == 1) error("transient") else "enhanced text"
        })

        val result = enhancer.enhanceOrRaw(SpeechEnhancementRequest("prompt", "raw text", "context"))

        assertEquals("enhanced text", result.text)
        assertTrue(result.enhanced)
        assertEquals(2, calls)
    }

    @Test
    fun enhancerFailsOpenToRawTranscriptOnTimeout() = runBlocking {
        val enhancer = SpeechEnhancer(GeminiSpeechEnhancementClient {
            delay(100)
            "late"
        }, timeoutMillis = 1, retries = 0)

        val result = enhancer.enhanceOrRaw(SpeechEnhancementRequest("prompt", "raw text", "context"))

        assertEquals("raw text", result.text)
        assertFalse(result.enhanced)
        assertTrue(result.failedOpen)
        assertTrue(result.timedOut)
    }
}
