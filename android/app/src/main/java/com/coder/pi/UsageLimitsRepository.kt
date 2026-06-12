package com.coder.pi

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.request.forms.FormDataContent
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.Parameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant

private const val codexUsageUrl = "https://chatgpt.com/backend-api/wham/usage"
private const val codexRefreshUrl = "https://auth.openai.com/oauth/token"
private const val codexClientId = "app_EMoamEEZ73f0CkXaXp7hrann"
private const val googleLoadCodeAssistUrl = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
private const val googleQuotaUrl = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"
private const val googleTokenUrl = "https://oauth2.googleapis.com/token"
private const val googleProjectsUrl = "https://cloudresourcemanager.googleapis.com/v1/projects"
private const val zaiSubscriptionUrl = "https://api.z.ai/api/biz/subscription/list"
private const val zaiQuotaUrl = "https://api.z.ai/api/monitor/usage/quota/limit"

class UsageLimitsRepository(
    private val store: UsageLimitsCredentialStore,
) {
    private val httpClient = HttpClient(OkHttp)

    fun cachedSnapshots(): List<UsageProviderSnapshot> =
        providers
            .filter { provider -> store.providerEnabled(provider.id) }
            .mapNotNull { provider -> readCachedSnapshot(provider) }

    suspend fun cliproxyAccounts(providerId: String): List<UsageProviderAccount> =
        withContext(Dispatchers.IO) {
            val apiKey = store.cliproxyApiKey()
            if (apiKey.isBlank()) return@withContext emptyList()
            val aliases = providerAliases(providerId)
            for (baseUrl in store.cliproxyBaseUrls()) {
                runCatching {
                    val accounts =
                        withTimeout(1_500) {
                            fetchCliproxyAuthFiles(baseUrl, apiKey)
                                .filter { file -> file.provider in aliases && !file.disabled && !file.unavailable }
                                .map { file -> UsageProviderAccount(providerId, file.name, file.email ?: file.name) }
                        }
                    if (accounts.isNotEmpty()) return@withContext accounts
                }
            }
            emptyList()
        }

    suspend fun fetchAll(): List<UsageProviderSnapshot> =
        withContext(Dispatchers.IO) {
            providers
                .filter { provider -> store.providerEnabled(provider.id) }
                .map { provider ->
                    async { fetchProvider(provider) }
                }.awaitAll()
        }

    private suspend fun fetchProvider(provider: UsageProviderDefinition): UsageProviderSnapshot =
        try {
            val snapshot = providerRegistry.firstOrNull { it.definition.id == provider.id }?.fetch(this) ?: unsupported(provider, "Provider is not implemented yet.")
            if (snapshot.error == null) writeCachedSnapshot(snapshot)
            snapshot
        } catch (error: Exception) {
            readCachedSnapshot(provider) ?: unsupported(provider, error.message ?: error::class.java.simpleName)
        }

    suspend fun fetchCodex(provider: UsageProviderDefinition): UsageProviderSnapshot {
        val credential = resolveCliproxyAuthFile(provider.id, listOf("codex", "openai-codex"))?.codexCredential() ?: throw IllegalStateException("Configure CLIProxyAPI with Codex auth file.")
        var response = fetchCodexUsage(credential.accessToken, credential.accountId)
        if (response.status.value == 401 && credential.refreshToken?.isNotBlank() == true) {
            val refreshed = refreshCodexToken(credential.refreshToken)
            response = fetchCodexUsage(refreshed.first, refreshed.second ?: credential.accountId)
        }
        val root = parseObject(response.checkedBody("Codex usage"))
        val rateLimit = root.obj("rate_limit")
        return UsageProviderSnapshot(
            provider = provider,
            plan = root.string("plan_type"),
            accountLabel = credential.accountLabel,
            sourceLabel = "cliproxy",
            metrics =
                listOfNotNull(
                    codexMetric("Session", rateLimit?.obj("primary_window"), response.headers["x-codex-primary-used-percent"]?.toDoubleOrNull(), 5L * 60L * 60L * 1000L),
                    codexMetric("Weekly", rateLimit?.obj("secondary_window"), response.headers["x-codex-secondary-used-percent"]?.toDoubleOrNull(), 7L * 24L * 60L * 60L * 1000L),
                ),
            textLines = emptyList(),
            fetchedAtMillis = System.currentTimeMillis(),
        )
    }

    private suspend fun fetchCodexUsage(
        accessToken: String,
        accountId: String,
    ) = httpClient.get(codexUsageUrl) {
        header("Authorization", "Bearer $accessToken")
        header("Accept", "application/json")
        header("User-Agent", "pi")
        header("chatgpt-account-id", accountId)
    }

    private suspend fun refreshCodexToken(refreshToken: String): Pair<String, String?> {
        val response =
            httpClient.post(codexRefreshUrl) {
                setBody(
                    FormDataContent(
                        Parameters.build {
                            append("grant_type", "refresh_token")
                            append("client_id", codexClientId)
                            append("refresh_token", refreshToken)
                        },
                    ),
                )
            }
        val body = parseObject(response.checkedBody("Codex refresh"))
        val accessToken = body.string("access_token") ?: throw IllegalStateException("Codex refresh returned no access token.")
        return accessToken to accessToken.extractCodexAccountId()
    }

    suspend fun fetchGoogle(provider: UsageProviderDefinition): UsageProviderSnapshot {
        val authFile = resolveCliproxyAuthFile(provider.id, listOf("google", "gemini", "gemini-cli", "google-gemini-cli")) ?: throw IllegalStateException("Configure CLIProxyAPI with Gemini auth file.")
        val credential = authFile.googleCredential()
        var accessToken = credential.accessToken ?: refreshGoogleToken(credential)
        var loadCodeAssist = postGoogleJson(googleLoadCodeAssistUrl, accessToken, "{\"metadata\":{\"ideType\":\"IDE_UNSPECIFIED\",\"platform\":\"PLATFORM_UNSPECIFIED\",\"pluginType\":\"GEMINI\",\"duetProject\":\"default\"}}")
        if (loadCodeAssist.status.value in listOf(401, 403) && credential.refreshToken?.isNotBlank() == true) {
            accessToken = refreshGoogleToken(credential)
            loadCodeAssist = postGoogleJson(googleLoadCodeAssistUrl, accessToken, "{\"metadata\":{\"ideType\":\"IDE_UNSPECIFIED\",\"platform\":\"PLATFORM_UNSPECIFIED\",\"pluginType\":\"GEMINI\",\"duetProject\":\"default\"}}")
        }
        val loadData = if (loadCodeAssist.status.value in 200..299) parseObject(loadCodeAssist.bodyAsText()) else JsonObject(emptyMap())
        val projectId = loadData.readGoogleProjectId() ?: discoverGoogleProjectId(accessToken)
        val quotaBody = projectId?.let { "{\"project\":\"$it\"}" } ?: "{}"
        var quotaResponse = postGoogleJson(googleQuotaUrl, accessToken, quotaBody)
        if (quotaResponse.status.value in listOf(401, 403) && credential.refreshToken?.isNotBlank() == true) {
            accessToken = refreshGoogleToken(credential)
            quotaResponse = postGoogleJson(googleQuotaUrl, accessToken, quotaBody)
        }
        val quota = parseElement(quotaResponse.checkedBody("Gemini quota"))
        return UsageProviderSnapshot(
            provider = provider,
            plan = loadData.deepString(listOf("tier", "userTier", "subscriptionTier")),
            accountLabel = credential.accountLabel,
            sourceLabel = "cliproxy",
            metrics = googleMetrics(quota),
            textLines = emptyList(),
            fetchedAtMillis = System.currentTimeMillis(),
        )
    }

    private suspend fun postGoogleJson(
        url: String,
        accessToken: String,
        body: String,
    ) = httpClient.post(url) {
        header("Authorization", "Bearer $accessToken")
        header("Accept", "application/json")
        header("Content-Type", "application/json")
        setBody(body)
    }

    private suspend fun discoverGoogleProjectId(accessToken: String): String? =
        runCatching {
            val response =
                httpClient.get(googleProjectsUrl) {
                    header("Authorization", "Bearer $accessToken")
                    header("Accept", "application/json")
                }
            if (response.status.value !in 200..299) return@runCatching null
            val projects = parseObject(response.bodyAsText())["projects"] as? JsonArray ?: return@runCatching null
            projects.firstNotNullOfOrNull { entry ->
                val project = entry as? JsonObject ?: return@firstNotNullOfOrNull null
                val projectId = project.string("projectId") ?: return@firstNotNullOfOrNull null
                val labels = project.obj("labels")
                projectId.takeIf { it.startsWith("gen-lang-client") || labels?.containsKey("generative-language") == true }
            }
        }.getOrNull()

    suspend fun fetchZai(provider: UsageProviderDefinition): UsageProviderSnapshot {
        val apiKey = store.providerApiKey(provider.id).trim()
        if (apiKey.isBlank()) throw IllegalStateException("Configure Z.ai API key.")
        val credential = ZaiCredential(apiKey, null, "direct")
        val subscriptionResponse =
            httpClient.get(zaiSubscriptionUrl) {
                header("Authorization", "Bearer ${credential.apiKey}")
                header("Accept", "application/json")
            }
        val quotaResponse =
            httpClient.get(zaiQuotaUrl) {
                header("Authorization", "Bearer ${credential.apiKey}")
                header("Accept", "application/json")
            }
        val subscription = runCatching { parseObject(subscriptionResponse.checkedBody("Z.ai subscription")) }.getOrNull()
        val quota = parseObject(quotaResponse.checkedBody("Z.ai quota"))
        return UsageProviderSnapshot(
            provider = provider,
            plan = subscription?.zaiPlan(),
            accountLabel = credential.accountLabel,
            sourceLabel = credential.sourceLabel,
            metrics = quota.zaiMetrics(),
            textLines = emptyList(),
            fetchedAtMillis = System.currentTimeMillis(),
        )
    }

    private fun codexMetric(
        label: String,
        window: JsonObject?,
        headerUsedPercent: Double?,
        periodDurationMillis: Long,
    ): UsageMetricSnapshot? {
        val used = headerUsedPercent ?: window?.number("used_percent") ?: return null
        return UsageMetricSnapshot(label, used.coerceIn(0.0, 100.0), 100.0, window?.resetInstant(), periodDurationMillis)
    }

    private fun googleMetrics(quota: JsonElement): List<UsageMetricSnapshot> {
        val buckets = quota.collectQuotaBuckets()

        fun bucket(pool: String): GoogleQuotaBucket? =
            buckets
                .filter { bucket -> bucket.name.contains("gemini", true) && bucket.name.contains(pool, true) }
                .minByOrNull { it.leftPercent }
        return listOfNotNull(
            bucket("pro")?.toMetric("Pro 24h"),
            bucket("flash")?.toMetric("Flash 24h"),
        )
    }

    private suspend fun refreshGoogleToken(credential: GoogleCredential): String {
        val refreshToken = credential.refreshToken ?: throw IllegalStateException("Gemini auth file has no access or refresh token.")
        val clientId = credential.clientId ?: throw IllegalStateException("Gemini auth file has no OAuth client id.")
        val clientSecret = credential.clientSecret ?: throw IllegalStateException("Gemini auth file has no OAuth client secret.")
        val response =
            httpClient.post(googleTokenUrl) {
                setBody(
                    FormDataContent(
                        Parameters.build {
                            append("client_id", clientId)
                            append("client_secret", clientSecret)
                            append("refresh_token", refreshToken)
                            append("grant_type", "refresh_token")
                        },
                    ),
                )
            }
        return parseObject(response.checkedBody("Gemini token refresh")).string("access_token") ?: throw IllegalStateException("Gemini token refresh returned no access token.")
    }

    private suspend fun resolveCliproxyAuthFile(
        providerId: String,
        providerAliases: List<String>,
    ): JsonObject? {
        val apiKey = store.cliproxyApiKey()
        if (apiKey.isBlank()) return null
        var lastError: String? = null
        for (baseUrl in store.cliproxyBaseUrls()) {
            try {
                val files = withTimeout(1_500) { fetchCliproxyAuthFiles(baseUrl, apiKey) }
                val selected = store.selectedAccountFile(providerId)
                val candidates = files.filter { file -> file.provider in providerAliases && !file.disabled && !file.unavailable }
                val file = candidates.firstOrNull { it.name == selected } ?: candidates.firstOrNull()
                val name = file?.name ?: continue
                return withTimeout(1_500) {
                    val download =
                        httpClient.get("$baseUrl/v0/management/auth-files/download?name=${urlEncode(name)}") {
                            header("Authorization", "Bearer $apiKey")
                            header("Accept", "application/json")
                        }
                    parseObject(download.checkedBody("CLIProxy auth-file download"))
                }
            } catch (error: Exception) {
                lastError = error.message ?: error::class.java.simpleName
            }
        }
        if (lastError != null) throw IllegalStateException("CLIProxyAPI unavailable: $lastError")
        return null
    }

    private suspend fun fetchCliproxyAuthFiles(
        baseUrl: String,
        apiKey: String,
    ): List<CliproxyAuthFile> {
        val response =
            httpClient.get("$baseUrl/v0/management/auth-files") {
                header("Authorization", "Bearer $apiKey")
                header("Accept", "application/json")
            }
        val payload = parseElement(response.checkedBody("CLIProxy auth-files"))
        val authFiles =
            if (payload is JsonArray) {
                usageJson.decodeFromJsonElement<List<CliproxyAuthFileDto>>(payload)
            } else {
                usageJson.decodeFromJsonElement<CliproxyAuthFilesPayload>(payload).files
            }
        return authFiles.mapNotNull { file ->
            val name = file.name?.trim().orEmpty()
            if (name.isBlank()) return@mapNotNull null
            CliproxyAuthFile(name, (file.provider ?: file.type).orEmpty().lowercase(), file.email ?: file.account ?: file.username, file.disabled == true, file.unavailable == true)
        }
    }

    private fun providerAliases(providerId: String): List<String> =
        when (providerId) {
            "codex" -> listOf("codex", "openai-codex")
            "google" -> listOf("google", "gemini", "gemini-cli", "google-gemini-cli")
            else -> listOf(providerId)
        }

    private fun unsupported(
        provider: UsageProviderDefinition,
        error: String,
    ) = UsageProviderSnapshot(provider, null, null, "unavailable", emptyList(), emptyList(), System.currentTimeMillis(), error)

    private fun readCachedSnapshot(provider: UsageProviderDefinition): UsageProviderSnapshot? =
        runCatching {
            val file = store.cacheFile(provider.id)
            if (!file.exists()) return@runCatching null
            val root = parseObject(file.readText())
            val cachedAt = root.number("cachedAtMillis")?.toLong() ?: return@runCatching null
            UsageProviderSnapshot(
                provider = provider,
                plan = root.string("plan"),
                accountLabel = root.string("accountLabel"),
                sourceLabel = root.string("sourceLabel").orEmpty(),
                metrics =
                    (root["metrics"] as? JsonArray)
                        ?.mapNotNull { metric ->
                            val item = metric as? JsonObject ?: return@mapNotNull null
                            UsageMetricSnapshot(
                                item.string("label") ?: return@mapNotNull null,
                                item.number("used") ?: return@mapNotNull null,
                                item.number("limit") ?: return@mapNotNull null,
                                item.string("resetsAt"),
                                item.number("periodDurationMillis")?.toLong(),
                            )
                        }.orEmpty(),
                textLines =
                    (root["textLines"] as? JsonArray)
                        ?.mapNotNull { line ->
                            val item = line as? JsonObject ?: return@mapNotNull null
                            UsageTextLine(item.string("label") ?: return@mapNotNull null, item.string("value") ?: return@mapNotNull null)
                        }.orEmpty(),
                fetchedAtMillis = root.number("fetchedAtMillis")?.toLong() ?: cachedAt,
            )
        }.getOrNull()

    private fun writeCachedSnapshot(snapshot: UsageProviderSnapshot) {
        runCatching {
            val root =
                buildJsonObject {
                    put("cachedAtMillis", JsonPrimitive(System.currentTimeMillis()))
                    put("fetchedAtMillis", JsonPrimitive(snapshot.fetchedAtMillis))
                    snapshot.plan?.let { put("plan", JsonPrimitive(it)) }
                    snapshot.accountLabel?.let { put("accountLabel", JsonPrimitive(it)) }
                    put("sourceLabel", JsonPrimitive(snapshot.sourceLabel))
                    put(
                        "metrics",
                        buildJsonArray {
                            snapshot.metrics.forEach { metric ->
                                add(
                                    buildJsonObject {
                                        put("label", JsonPrimitive(metric.label))
                                        put("used", JsonPrimitive(metric.used))
                                        put("limit", JsonPrimitive(metric.limit))
                                        metric.resetsAt?.let { put("resetsAt", JsonPrimitive(it)) }
                                        metric.periodDurationMillis?.let { put("periodDurationMillis", JsonPrimitive(it)) }
                                    },
                                )
                            }
                        },
                    )
                    put(
                        "textLines",
                        buildJsonArray {
                            snapshot.textLines.forEach { line ->
                                add(
                                    buildJsonObject {
                                        put("label", JsonPrimitive(line.label))
                                        put("value", JsonPrimitive(line.value))
                                    },
                                )
                            }
                        },
                    )
                }
            store.cacheFile(snapshot.provider.id).writeText(root.toString())
        }
    }

    companion object {
        private val codexDefinition = UsageProviderDefinition("codex", "Codex", R.raw.usage_codex, "◎", R.drawable.ic_feather_terminal, "Codex OAuth via CLIProxyAPI", "", "Codex usage uses CLIProxyAPI auth files exported from your Codex CLI login.")
        private val googleDefinition = UsageProviderDefinition("google", "Gemini", R.raw.usage_google, "✦", R.drawable.ic_feather_globe, "Gemini OAuth via CLIProxyAPI", "", "Gemini usage uses CLIProxyAPI auth files from Gemini CLI OAuth.")
        private val zaiDefinition = UsageProviderDefinition("zai", "Z.ai", R.raw.usage_zai, "Z", R.drawable.ic_feather_cpu, "API key", "", "Z.ai usage requires a Z.ai API key.")

        val providerRegistry: List<UsageLimitProvider> =
            listOf(
                object : UsageLimitProvider {
                    override val definition = codexDefinition

                    override suspend fun fetch(repository: UsageLimitsRepository) = repository.fetchCodex(definition)
                },
                object : UsageLimitProvider {
                    override val definition = googleDefinition

                    override suspend fun fetch(repository: UsageLimitsRepository) = repository.fetchGoogle(definition)
                },
                object : UsageLimitProvider {
                    override val definition = zaiDefinition

                    override suspend fun fetch(repository: UsageLimitsRepository) = repository.fetchZai(definition)
                },
            )
        val providers: List<UsageProviderDefinition> = providerRegistry.map { it.definition }
    }
}

private data class CodexCredential(
    val accessToken: String,
    val accountId: String,
    val refreshToken: String?,
    val accountLabel: String?,
)

private data class GoogleCredential(
    val accessToken: String?,
    val refreshToken: String?,
    val clientId: String?,
    val clientSecret: String?,
    val accountLabel: String?,
)

private data class ZaiCredential(
    val apiKey: String,
    val accountLabel: String?,
    val sourceLabel: String,
)

private data class CliproxyAuthFile(
    val name: String,
    val provider: String,
    val email: String?,
    val disabled: Boolean,
    val unavailable: Boolean,
)

@Serializable
private data class CliproxyAuthFilesPayload(
    val files: List<CliproxyAuthFileDto> = emptyList(),
)

@Serializable
private data class CliproxyAuthFileDto(
    val name: String? = null,
    val provider: String? = null,
    val type: String? = null,
    val email: String? = null,
    val account: String? = null,
    val username: String? = null,
    val disabled: Boolean? = null,
    val unavailable: Boolean? = null,
)

private data class GoogleQuotaBucket(
    val name: String,
    val used: Double,
    val limit: Double,
    val resetsAt: String?,
) {
    val leftPercent: Double = 100.0 - ((used / limit) * 100.0)

    fun toMetric(label: String) = UsageMetricSnapshot(label, used, limit.takeIf { it > 0 } ?: 100.0, resetsAt, 24L * 60L * 60L * 1000L)
}

private fun JsonObject.codexCredential(): CodexCredential {
    val tokens = obj("tokens")
    val accessToken = string("access_token") ?: string("accessToken") ?: tokens?.string("access_token") ?: tokens?.string("accessToken") ?: throw IllegalStateException("Codex auth file missing access token.")
    val refreshToken = string("refresh_token") ?: string("refreshToken") ?: tokens?.string("refresh_token") ?: tokens?.string("refreshToken")
    val accountId = string("account_id") ?: string("accountId") ?: tokens?.string("account_id") ?: tokens?.string("accountId") ?: accessToken.extractCodexAccountId() ?: throw IllegalStateException("Codex auth file missing account id.")
    val accountLabel = string("email") ?: string("accountLabel")
    return CodexCredential(accessToken, accountId, refreshToken, accountLabel)
}

private fun JsonObject.googleCredential(): GoogleCredential =
    GoogleCredential(
        readDeepString(listOf("access_token", "accessToken", "token.access_token", "token.accessToken", "tokens.access_token", "tokens.accessToken", "credentials.access_token", "credentials.accessToken", "google.access_token", "google.accessToken", "gemini.access_token", "gemini.accessToken", "oauth.access_token", "oauth.accessToken", "data.access_token", "data.accessToken")),
        readDeepString(listOf("refresh_token", "refreshToken", "token.refresh_token", "token.refreshToken", "tokens.refresh_token", "tokens.refreshToken", "credentials.refresh_token", "credentials.refreshToken", "google.refresh_token", "google.refreshToken", "gemini.refresh_token", "gemini.refreshToken", "oauth.refresh_token", "oauth.refreshToken", "data.refresh_token", "data.refreshToken")),
        readDeepString(listOf("client_id", "clientId", "token.client_id", "token.clientId", "credentials.client_id", "credentials.clientId", "google.client_id", "google.clientId", "gemini.client_id", "gemini.clientId", "oauth.client_id", "oauth.clientId", "data.client_id", "data.clientId")),
        readDeepString(listOf("client_secret", "clientSecret", "token.client_secret", "token.clientSecret", "credentials.client_secret", "credentials.clientSecret", "google.client_secret", "google.clientSecret", "gemini.client_secret", "gemini.clientSecret", "oauth.client_secret", "oauth.clientSecret", "data.client_secret", "data.clientSecret")),
        readDeepString(listOf("email", "accountLabel", "user.email", "profile.email", "data.email")),
    )

private fun JsonObject.zaiPlan(): String? {
    val data = this["data"] as? JsonArray ?: return null
    return data.firstOrNull()?.jsonObject?.string("productName")
}

private fun JsonObject.zaiMetrics(): List<UsageMetricSnapshot> {
    val limits = zaiLimits()
    val tokenLimits = limits.filter { it.type == "TOKENS_LIMIT" || it.name == "TOKENS_LIMIT" }

    fun tokenLimit(unit: Int): ZaiLimit? = tokenLimits.firstOrNull { it.unit == unit } ?: tokenLimits.firstOrNull { it.unit == null }
    return listOfNotNull(
        tokenLimit(3)?.toMetric("Session", 5L * 60L * 60L * 1000L),
        tokenLimit(6)?.takeIf { it != tokenLimit(3) }?.toMetric("Weekly", 7L * 24L * 60L * 60L * 1000L),
        limits.firstOrNull { it.name.contains("web", true) || it.type.contains("web", true) }?.toMetric("Web Searches", 7L * 24L * 60L * 60L * 1000L),
    )
}

private data class ZaiLimit(
    val name: String,
    val type: String,
    val unit: Int?,
    val usedPercent: Double,
    val resetsAt: String?,
) {
    fun toMetric(
        label: String,
        periodDurationMillis: Long,
    ) = UsageMetricSnapshot(label, usedPercent.coerceIn(0.0, 100.0), 100.0, resetsAt, periodDurationMillis)
}

private fun JsonObject.zaiLimits(): List<ZaiLimit> {
    val result = mutableListOf<ZaiLimit>()

    fun walk(element: JsonElement) {
        when (element) {
            is JsonObject -> {
                val percentage = element.number("percentage") ?: element.number("usedPercent") ?: element.number("used_percent")
                if (percentage != null) {
                    result +=
                        ZaiLimit(
                            element.string("name").orEmpty(),
                            element.string("type").orEmpty(),
                            element.number("unit")?.toInt(),
                            percentage,
                            element.number("nextResetTime")?.let { epoch -> Instant.ofEpochMilli(if (epoch > 10_000_000_000) epoch.toLong() else (epoch * 1000).toLong()).toString() } ?: element.string("resetsAt") ?: element.string("resetAt"),
                        )
                }
                element.values.forEach(::walk)
            }
            is JsonArray -> element.forEach(::walk)
            else -> Unit
        }
    }
    walk(this)
    return result
}

private fun JsonElement.collectQuotaBuckets(): List<GoogleQuotaBucket> {
    val result = mutableListOf<GoogleQuotaBucket>()

    fun walk(
        element: JsonElement,
        label: String?,
    ) {
        when (element) {
            is JsonObject -> {
                val remainingFraction = element.number("remainingFraction")
                if (remainingFraction != null) {
                    val modelId = element.string("modelId") ?: element.string("model_id") ?: label.orEmpty()
                    val usedPercent = (1.0 - remainingFraction.coerceIn(0.0, 1.0)) * 100.0
                    result += GoogleQuotaBucket(modelId, usedPercent.coerceIn(0.0, 100.0), 100.0, element.string("resetTime") ?: element.string("reset_time"))
                }
                element.forEach { (key, value) -> walk(value, key) }
            }
            is JsonArray -> element.forEach { walk(it, label) }
            else -> Unit
        }
    }
    walk(this, null)
    return result.distinctBy { it.name + it.limit + it.used }
}

private fun JsonObject.collectNumbers(keys: List<String>): List<Double> {
    val values = mutableListOf<Double>()

    fun walk(element: JsonElement) {
        when (element) {
            is JsonObject -> element.forEach { (key, value) -> if (key in keys) value.jsonPrimitive.doubleOrNull?.let(values::add) else walk(value) }
            is JsonArray -> element.forEach(::walk)
            else -> Unit
        }
    }
    walk(this)
    return values
}

private fun JsonObject.deepString(keys: List<String>): String? {
    fun walk(element: JsonElement): String? =
        when (element) {
            is JsonObject -> keys.firstNotNullOfOrNull { key -> element.string(key) } ?: element.values.firstNotNullOfOrNull(::walk)
            is JsonArray -> element.firstNotNullOfOrNull(::walk)
            else -> null
        }
    return walk(this)
}

private fun JsonObject.readDeepString(paths: List<String>): String? {
    for (path in paths) {
        var current: JsonElement? = this
        for (segment in path.split('.')) {
            current = (current as? JsonObject)?.get(segment)
        }
        val value = (current as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
        if (value != null) return value
    }
    return null
}

private fun JsonObject.readGoogleProjectId(): String? {
    val direct = this["cloudaicompanionProject"]
    if (direct is JsonPrimitive) return direct.contentOrNull?.takeIf { it.isNotBlank() }
    if (direct is JsonObject) direct.string("id")?.let { return it }
    return deepString(listOf("cloudaicompanionProject"))
}

private suspend fun HttpResponse.checkedBody(label: String): String {
    val body = bodyAsText()
    if (status.value !in 200..299) {
        throw IllegalStateException("$label failed: HTTP ${status.value}${body.takeIf { it.isNotBlank() }?.let { ": ${it.take(240)}" }.orEmpty()}")
    }
    return body
}

private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotBlank() }

private fun JsonObject.number(key: String): Double? = (this[key] as? JsonPrimitive)?.let { primitive -> primitive.doubleOrNull ?: primitive.contentOrNull?.toDoubleOrNull() }

private fun JsonObject.bool(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull ?: false

private val usageJson = Json { ignoreUnknownKeys = true }

private fun parseElement(text: String): JsonElement = usageJson.parseToJsonElement(text)

private fun parseObject(text: String): JsonObject = parseElement(text).jsonObject

private fun JsonObject.resetInstant(): String? {
    number("reset_after_seconds")?.let { return Instant.now().plusSeconds(it.toLong()).toString() }
    number("reset_after")?.let { return Instant.now().plusSeconds(it.toLong()).toString() }
    number("reset_at")?.let { epoch -> return Instant.ofEpochSecond(if (epoch > 10_000_000_000) (epoch / 1000).toLong() else epoch.toLong()).toString() }
    string("resets_at")?.let { return it }
    string("reset_at")?.let { return it }
    return null
}

private fun String.extractCodexAccountId(): String? =
    split('.').getOrNull(1)?.let { payload ->
        runCatching {
            val decoded =
                android.util.Base64
                    .decode(payload, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
                    .decodeToString()
            parseObject(decoded).obj("https://api.openai.com/auth")?.string("chatgpt_account_id")
        }.getOrNull()
    }
