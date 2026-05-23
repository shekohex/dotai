package com.coder.pi

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.isSuccess
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

data class OpenAiModelCard(
    val id: String,
    val ownedBy: String = "",
    val created: Long = 0L,
)

object OpenAiModelDiscoveryCache {
    private const val TtlMillis = 5 * 60 * 1_000L
    private val entries = mutableMapOf<String, Pair<Long, List<OpenAiModelCard>>>()

    suspend fun models(
        httpClient: HttpClient,
        baseUrls: List<String>,
        apiKeyForEndpoint: (String) -> String,
        forceRefresh: Boolean = false,
    ): Result<List<OpenAiModelCard>> =
        withContext(Dispatchers.IO) {
            val key = baseUrls.joinToString("|") { it + ":" + apiKeyForEndpoint(it).hashCode() }
            val now = System.currentTimeMillis()
            if (!forceRefresh) entries[key]?.let { (loadedAt, models) -> if (now - loadedAt < TtlMillis) return@withContext Result.success(models) }
            var lastError: Throwable? = null
            baseUrls.forEach { baseUrl ->
                runCatching { fetchModels(httpClient, baseUrl, apiKeyForEndpoint(baseUrl)) }
                    .onSuccess { models ->
                        entries[key] = now to models
                        return@withContext Result.success(models)
                    }.onFailure { lastError = it }
            }
            Result.failure(lastError ?: IllegalStateException("No provider endpoint configured"))
        }

    suspend fun models(
        httpClient: HttpClient,
        baseUrls: List<String>,
        apiKey: String,
        forceRefresh: Boolean = false,
    ): Result<List<OpenAiModelCard>> = models(httpClient, baseUrls, { apiKey }, forceRefresh)

    private suspend fun fetchModels(
        httpClient: HttpClient,
        baseUrl: String,
        apiKey: String,
    ): List<OpenAiModelCard> {
        val response: HttpResponse = httpClient.get(baseUrl.trimEnd('/') + "/models") { if (apiKey.isNotBlank()) bearerAuth(apiKey) }
        val body = response.body<String>()
        if (!response.status.isSuccess()) throw IllegalStateException("HTTP ${response.status.value}: ${response.status.description}")
        return Json { ignoreUnknownKeys = true }
            .decodeFromString<ModelsResponse>(body)
            .data
            .map { OpenAiModelCard(it.id, it.ownedBy.orEmpty(), it.created ?: 0L) }
            .sortedBy { it.id }
    }
}

@Serializable
private data class ModelsResponse(
    val data: List<ModelItem> = emptyList(),
)

@Serializable
private data class ModelItem(
    val id: String,
    @SerialName("owned_by") val ownedBy: String? = null,
    val created: Long? = null,
)
