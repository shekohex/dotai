package com.coder.pi

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechEnhancementTest {
    private val template = "Clean up transcript."

    @Test
    fun rendererBuildsVoiceInkStyleSystemAndUserPrompts() {
        val request = SpeechEnhancementPromptRenderer().render(template, "open settings", listOf("gradle failed", "build log"))

        assertEquals("\n<TRANSCRIPT>\nopen settings\n</TRANSCRIPT>", request.userPrompt)
        assertTrue(request.systemPrompt.startsWith("Clean up transcript."))
        assertTrue(request.systemPrompt.contains("<CONTEXT_INFORMATION>\ngradle failed\nbuild log\n</CONTEXT_INFORMATION>"))
    }

    @Test
    fun rendererDoesNotReplacePlaceholdersInsideSystemPrompt() {
        val request = SpeechEnhancementPromptRenderer().render("Clean <TRANSCRIPT> using <CONTEXT_INFORMATION>", "run tests", listOf("SpeechEnhancementTest failed"))

        assertTrue(request.systemPrompt.contains("Clean <TRANSCRIPT> using <CONTEXT_INFORMATION>"))
        assertTrue(request.userPrompt.contains("run tests"))
        assertTrue(request.systemPrompt.contains("<CONTEXT_INFORMATION>\nSpeechEnhancementTest failed\n</CONTEXT_INFORMATION>"))
    }

    @Test
    fun rendererAddsClipboardAndCustomVocabularySections() {
        val request = SpeechEnhancementPromptRenderer().render(template, "run litert", emptyList(), "clipboard term", "LiteRT\nParakeet")

        assertTrue(request.systemPrompt.contains("<CLIPBOARD_CONTEXT>\nclipboard term\n</CLIPBOARD_CONTEXT>"))
        assertTrue(request.systemPrompt.contains("<CUSTOM_VOCABULARY>\nImportant Vocabulary: LiteRT, Parakeet\n</CUSTOM_VOCABULARY>"))
    }

    @Test
    fun rendererBoundsContextLinesAndChars() {
        val request = SpeechEnhancementPromptRenderer(SpeechEnhancementPromptConfig(maxContextLines = 2, maxContextChars = 12)).render(template, "hello", listOf("one", "two", "three very long"))

        assertFalse(request.context.contains("one"))
        assertEquals("two\nthree ve", request.context)
    }

    @Test
    fun defaultRendererUsesExpandedBounds() {
        val request = SpeechEnhancementPromptRenderer().render(template, "x".repeat(5_000), List(100) { "line-$it" })

        assertEquals(4_000, request.transcript.length)
        assertFalse(request.context.contains("line-0"))
        assertTrue(request.context.contains("line-99"))
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
    fun enhancerRetriesOnceAndReturnsEnhancedText() =
        runBlocking {
            var calls = 0
            val enhancer =
                SpeechEnhancer(
                    OpenAiCompatibleSpeechEnhancementClient {
                        calls++
                        if (calls == 1) error("transient") else "enhanced text"
                    },
                )

            val result = enhancer.enhanceOrRaw(SpeechEnhancementRequest("prompt", "raw text", "context"))

            assertEquals("enhanced text", result.text)
            assertTrue(result.enhanced)
            assertEquals(2, calls)
        }

    @Test
    fun enhancerFailsOpenToRawTranscriptOnTimeout() =
        runBlocking {
            val enhancer =
                SpeechEnhancer(
                    OpenAiCompatibleSpeechEnhancementClient {
                        delay(100)
                        "late"
                    },
                    timeoutMillis = 1,
                    retries = 0,
                )

            val result = enhancer.enhanceOrRaw(SpeechEnhancementRequest("prompt", "raw text", "context"))

            assertEquals("raw text", result.text)
            assertFalse(result.enhanced)
            assertTrue(result.failedOpen)
            assertTrue(result.timedOut)
        }
}
