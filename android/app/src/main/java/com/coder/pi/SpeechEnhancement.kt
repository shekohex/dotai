package com.coder.pi

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class SpeechEnhancementPromptConfig(
    val maxContextLines: Int = 80,
    val maxContextChars: Int = 8_000,
    val maxTranscriptChars: Int = 4_000,
)

data class SpeechEnhancementRequest(
    val prompt: String,
    val transcript: String,
    val context: String,
    val systemPrompt: String = prompt,
    val userPrompt: String = prompt,
)

data class SpeechEnhancementResult(
    val text: String,
    val enhanced: Boolean,
    val failedOpen: Boolean,
    val timedOut: Boolean = false,
    val errorMessage: String? = null,
)

class SpeechEnhancementHttpException(
    val statusCode: Int,
    override val message: String,
) : Exception("HTTP $statusCode: $message")

interface SpeechEnhancementClient {
    suspend fun enhance(request: SpeechEnhancementRequest): String
}

class SpeechEnhancementPromptRenderer(
    private val config: SpeechEnhancementPromptConfig = SpeechEnhancementPromptConfig(),
) {
    fun render(
        template: String,
        transcript: String,
        visibleTerminalLines: List<String>,
        clipboardContext: String = "",
        customVocabulary: String = "",
    ): SpeechEnhancementRequest {
        val safeTranscript = transcript.trim().take(config.maxTranscriptChars)
        val safeContext =
            visibleTerminalLines
                .map(::redact)
                .map(String::trimEnd)
                .filter(String::isNotBlank)
                .takeLast(config.maxContextLines)
                .joinToString("\n")
                .take(config.maxContextChars)
        val safeClipboard = redact(clipboardContext).trim().take(config.maxContextChars)
        val safeVocabulary =
            customVocabulary
                .lines()
                .map(String::trim)
                .filter(String::isNotBlank)
                .distinct()
                .take(200)
                .joinToString(", ")
                .take(config.maxContextChars)
        val terminalSection = if (safeContext.isBlank()) "" else "\n\n<CONTEXT_INFORMATION>\n$safeContext\n</CONTEXT_INFORMATION>"
        val clipboardSection = if (safeClipboard.isBlank()) "" else "\n\n<CLIPBOARD_CONTEXT>\n$safeClipboard\n</CLIPBOARD_CONTEXT>"
        val vocabularySection = if (safeVocabulary.isBlank()) "" else "\n\nThe following are important vocabulary words, proper nouns, and technical terms. When these words or similar-sounding words appear in the <TRANSCRIPT>, ensure they are spelled EXACTLY as shown below:\n<CUSTOM_VOCABULARY>\nImportant Vocabulary: $safeVocabulary\n</CUSTOM_VOCABULARY>"
        val systemPrompt = template.trim() + terminalSection + clipboardSection + vocabularySection
        val userPrompt = "\n<TRANSCRIPT>\n$safeTranscript\n</TRANSCRIPT>"
        return SpeechEnhancementRequest(prompt = "$systemPrompt\n$userPrompt", transcript = safeTranscript, context = safeContext, systemPrompt = systemPrompt, userPrompt = userPrompt)
    }

    private fun redact(value: String): String =
        value
            .replace(Regex("Bearer\\s+[A-Za-z0-9._~+/=-]+", RegexOption.IGNORE_CASE), "Bearer <redacted>")
            .replace(Regex("(api[_-]?key|token|secret|password)=([^\\s&]+)", RegexOption.IGNORE_CASE), "$1=<redacted>")
            .replace(Regex("([?&](?:key|api_key|token|secret|password))=([^\\s&]+)", RegexOption.IGNORE_CASE), "$1=<redacted>")
}

class SpeechEnhancer(
    private val client: SpeechEnhancementClient,
    private val timeoutMillis: Long = 15_000L,
    private val retries: Int = 1,
) {
    suspend fun enhanceOrRaw(request: SpeechEnhancementRequest): SpeechEnhancementResult {
        repeat(retries + 1) { attempt ->
            val result = runCatching { withTimeout(timeoutMillis) { client.enhance(request).trim() } }
            val enhanced = result.getOrNull().orEmpty()
            if (enhanced.isNotBlank()) return SpeechEnhancementResult(enhanced, enhanced = true, failedOpen = false)
            val failure = result.exceptionOrNull()
            if (failure is TimeoutCancellationException) return SpeechEnhancementResult(request.transcript, enhanced = false, failedOpen = true, timedOut = true, errorMessage = "Timed out after ${timeoutMillis / 1_000}s")
            if (attempt == retries) return SpeechEnhancementResult(request.transcript, enhanced = false, failedOpen = true, errorMessage = failure?.message ?: "Enhancement failed")
        }
        return SpeechEnhancementResult(request.transcript, enhanced = false, failedOpen = true)
    }
}

class OpenAiCompatibleSpeechEnhancementClient(
    private val complete: suspend (String) -> String,
) : SpeechEnhancementClient {
    override suspend fun enhance(request: SpeechEnhancementRequest): String = complete(request.prompt)
}

class GeminiSpeechEnhancementClient(
    private val complete: suspend (String) -> String,
) : SpeechEnhancementClient {
    override suspend fun enhance(request: SpeechEnhancementRequest): String = complete(request.prompt)
}

private val speechEnhancementJson =
    Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

class OpenAiHttpSpeechEnhancementClient(
    private val httpClient: HttpClient,
    private val baseUrl: String,
    private val apiKey: String,
    private val model: String,
) : SpeechEnhancementClient {
    override suspend fun enhance(request: SpeechEnhancementRequest): String {
        val endpoint = OpenAiProviderEndpointResolver.activeBaseUrl(OpenAiProviderTask.Enhancement, baseUrl)
        val endpointApiKey = OpenAiProviderEndpointRuntime.apiKeyForEndpoint(endpoint).ifBlank { apiKey }
        val response: HttpResponse =
            httpClient.post(endpoint.trimEnd('/') + "/chat/completions") {
                bearerAuth(endpointApiKey)
                contentType(ContentType.Application.Json)
                setBody(ChatCompletionRequest(model, listOf(ChatMessage("system", request.systemPrompt), ChatMessage("user", request.userPrompt)), enhancementTemperature(model), enhancementReasoningEffort(model)))
            }
        val body = response.body<String>()
        if (!response.status.isSuccess()) throw SpeechEnhancementHttpException(response.status.value, enhancementErrorMessage(body).ifBlank { response.status.description })
        return speechEnhancementJson
            .decodeFromString<ChatCompletionResponse>(body)
            .choices
            .firstOrNull()
            ?.message
            ?.content
            .orEmpty()
    }
}

object OpenAiProviderEndpointRuntime {
    @Volatile private var apiKeyLookup: (String) -> String = { "" }

    fun installApiKeyLookup(lookup: (String) -> String) {
        apiKeyLookup = lookup
    }

    fun apiKeyForEndpoint(endpoint: String): String = apiKeyLookup(endpoint)
}

class GeminiHttpSpeechEnhancementClient(
    private val httpClient: HttpClient,
    private val apiKey: String,
    private val model: String,
) : SpeechEnhancementClient {
    override suspend fun enhance(request: SpeechEnhancementRequest): String {
        val response: HttpResponse =
            httpClient.post("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions") {
                bearerAuth(apiKey)
                contentType(ContentType.Application.Json)
                setBody(ChatCompletionRequest(model, listOf(ChatMessage("system", request.systemPrompt), ChatMessage("user", request.userPrompt)), enhancementTemperature(model), enhancementReasoningEffort(model)))
            }
        val body = response.body<String>()
        if (!response.status.isSuccess()) throw SpeechEnhancementHttpException(response.status.value, enhancementErrorMessage(body).ifBlank { response.status.description })
        return speechEnhancementJson
            .decodeFromString<ChatCompletionResponse>(body)
            .choices
            .firstOrNull()
            ?.message
            ?.content
            .orEmpty()
    }
}

@Serializable
private data class ChatCompletionRequest(
    val model: String,
    val messages: List<ChatMessage>,
    val temperature: Double,
    @SerialName("reasoning_effort") val reasoningEffort: String? = null,
)

@Serializable
private data class ChatMessage(
    val role: String,
    val content: String,
)

@Serializable
private data class ChatCompletionResponse(
    val choices: List<ChatChoice> = emptyList(),
)

@Serializable
private data class ChatChoice(
    val message: ChatMessage? = null,
)

private fun enhancementTemperature(model: String): Double = if (model.lowercase().startsWith("gpt-5")) 1.0 else 0.3

private fun enhancementReasoningEffort(model: String): String? =
    when (model) {
        "gemini-2.5-flash", "gemini-2.5-flash-lite" -> "none"
        "gemini-3.1-pro-preview" -> "low"
        "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview" -> "minimal"
        "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2" -> "none"
        else -> null
    }

private fun enhancementErrorMessage(body: String): String =
    runCatching {
        val root = speechEnhancementJson.parseToJsonElement(body).jsonObject
        root["error"]
            ?.jsonObject
            ?.get("message")
            ?.jsonPrimitive
            ?.content
            ?: root["message"]?.jsonPrimitive?.content
            ?: body.take(180)
    }.getOrElse { body.take(180) }.trim()
