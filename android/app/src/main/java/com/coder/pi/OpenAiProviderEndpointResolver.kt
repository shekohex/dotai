package com.coder.pi

import android.content.Context
import io.ktor.client.HttpClient
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.isSuccess
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

enum class OpenAiProviderTask { Transcription, Enhancement }

data class OpenAiProviderEndpointState(
    val healthy: Boolean = false,
    val baseUrl: String = "",
    val checkedPath: String = "",
    val error: String = "",
)

object OpenAiProviderEndpointResolver {
    private const val ProbeTimeoutMillis = 1_000L
    private const val ReadinessPath = "/health/readiness"
    private val states = mutableMapOf<OpenAiProviderTask, OpenAiProviderEndpointState>()
    private val refreshMutex = Mutex()

    @Synchronized
    fun activeBaseUrl(
        task: OpenAiProviderTask,
        configuredBaseUrls: String,
    ): String = states[task]?.baseUrl?.takeIf { it.isNotBlank() } ?: configuredBaseUrls.openAiBaseUrlAliases().firstOrNull().orEmpty()

    @Synchronized
    fun state(task: OpenAiProviderTask): OpenAiProviderEndpointState = states[task] ?: OpenAiProviderEndpointState()

    suspend fun refresh(
        context: Context,
        httpClient: HttpClient,
    ) = refreshMutex.withLock {
        val settings = SpeechSettingsStore.values(context)
        val providers = SpeechSettingsStore.providers(context)
        refreshTask(httpClient, OpenAiProviderTask.Transcription, providers.endpointsForSelected(OpenAiProviderTask.Transcription, settings.realtimeTranscriptionProviderId).ifEmpty { settings.realtimeTranscriptionBaseUrl.openAiBaseUrlAliases() }) { SpeechSettingsStore.apiKeyForEndpoint(context, it) }
        refreshTask(httpClient, OpenAiProviderTask.Enhancement, providers.endpointsForSelected(OpenAiProviderTask.Enhancement, settings.enhancementProviderId).ifEmpty { settings.enhancementBaseUrl.openAiBaseUrlAliases() }) { SpeechSettingsStore.apiKeyForEndpoint(context, it) }
    }

    suspend fun refreshTask(
        httpClient: HttpClient,
        task: OpenAiProviderTask,
        aliases: List<String>,
        apiKeyForEndpoint: (String) -> String,
    ) = withContext(Dispatchers.IO) {
        var lastError = "No endpoint configured"
        aliases.forEach { baseUrl ->
            val result = probe(httpClient, baseUrl, apiKeyForEndpoint(baseUrl))
            if (result.healthy) {
                setState(task, result.copy(baseUrl = baseUrl))
                return@withContext
            }
            lastError = result.error
        }
        setState(task, OpenAiProviderEndpointState(error = lastError))
    }

    private suspend fun probe(
        httpClient: HttpClient,
        baseUrl: String,
        apiKey: String,
    ): OpenAiProviderEndpointState {
        val origin = baseUrl.trimEnd('/').removeSuffix("/v1")
        val readiness = request(httpClient, origin + ReadinessPath, apiKey)
        if (readiness?.status?.value in setOf(401, 403) || readiness?.status?.isSuccess() == true) return OpenAiProviderEndpointState(healthy = true, checkedPath = ReadinessPath)
        val modelsPath = "/models"
        val models = request(httpClient, baseUrl.trimEnd('/') + modelsPath, apiKey)
        if (models?.status?.value in setOf(401, 403) || models?.status?.isSuccess() == true) return OpenAiProviderEndpointState(healthy = true, checkedPath = modelsPath)
        return OpenAiProviderEndpointState(error = "$baseUrl $modelsPath -> ${models?.status?.value ?: "unreachable"}")
    }

    private suspend fun request(
        httpClient: HttpClient,
        url: String,
        apiKey: String,
    ): HttpResponse? =
        runCatching {
            withTimeout(ProbeTimeoutMillis) { httpClient.get(url) { if (apiKey.isNotBlank()) bearerAuth(apiKey) } }
        }.getOrNull()

    @Synchronized
    private fun setState(
        task: OpenAiProviderTask,
        state: OpenAiProviderEndpointState,
    ) {
        states[task] = state
    }
}
