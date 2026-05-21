package com.coder.pi

import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

data class SpeechEnhancementPromptConfig(
    val maxContextLines: Int = 40,
    val maxContextChars: Int = 4_000,
    val maxTranscriptChars: Int = 2_000,
)

data class SpeechEnhancementRequest(
    val prompt: String,
    val transcript: String,
    val context: String,
)

data class SpeechEnhancementResult(
    val text: String,
    val enhanced: Boolean,
    val failedOpen: Boolean,
)

interface SpeechEnhancementClient {
    suspend fun enhance(request: SpeechEnhancementRequest): String
}

class SpeechEnhancementPromptRenderer(private val config: SpeechEnhancementPromptConfig = SpeechEnhancementPromptConfig()) {
    fun render(template: String, transcript: String, visibleTerminalLines: List<String>): SpeechEnhancementRequest {
        val safeTranscript = transcript.trim().take(config.maxTranscriptChars)
        val safeContext = visibleTerminalLines
            .map(::redact)
            .map(String::trimEnd)
            .filter(String::isNotBlank)
            .takeLast(config.maxContextLines)
            .joinToString("\n")
            .take(config.maxContextChars)
        val prompt = template
            .replace("<TRANSCRIPT>", safeTranscript)
            .replace("<CONTEXT>", safeContext)
        return SpeechEnhancementRequest(prompt = prompt, transcript = safeTranscript, context = safeContext)
    }

    private fun redact(value: String): String {
        return value
            .replace(Regex("Bearer\\s+[A-Za-z0-9._~+/=-]+", RegexOption.IGNORE_CASE), "Bearer <redacted>")
            .replace(Regex("(api[_-]?key|token|secret|password)=([^\\s&]+)", RegexOption.IGNORE_CASE), "$1=<redacted>")
            .replace(Regex("([?&](?:key|api_key|token|secret|password))=([^\\s&]+)", RegexOption.IGNORE_CASE), "$1=<redacted>")
    }
}

class SpeechEnhancer(private val client: SpeechEnhancementClient, private val timeoutMillis: Long = 8_000L, private val retries: Int = 1) {
    suspend fun enhanceOrRaw(request: SpeechEnhancementRequest): SpeechEnhancementResult {
        repeat(retries + 1) { attempt ->
            val result = runCatching { withTimeout(timeoutMillis) { client.enhance(request).trim() } }
            val enhanced = result.getOrNull().orEmpty()
            if (enhanced.isNotBlank()) return SpeechEnhancementResult(enhanced, enhanced = true, failedOpen = false)
            val failure = result.exceptionOrNull()
            if (failure is TimeoutCancellationException || attempt == retries) return SpeechEnhancementResult(request.transcript, enhanced = false, failedOpen = true)
        }
        return SpeechEnhancementResult(request.transcript, enhanced = false, failedOpen = true)
    }
}

class OpenAiCompatibleSpeechEnhancementClient(private val complete: suspend (String) -> String) : SpeechEnhancementClient {
    override suspend fun enhance(request: SpeechEnhancementRequest): String = complete(request.prompt)
}

class GeminiSpeechEnhancementClient(private val complete: suspend (String) -> String) : SpeechEnhancementClient {
    override suspend fun enhance(request: SpeechEnhancementRequest): String = complete(request.prompt)
}
