package com.coder.pi

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.MessageDigest

data class SpeechSettingsValues(
    val enhancementEnabled: Boolean = false,
    val autoSubmitAfterEnhancement: Boolean = false,
    val includeVisibleTerminalContext: Boolean = true,
    val vadSensitivity: Int = 2,
    val promptOverride: String = "",
    val enhancementProvider: String = SpeechEnhancementProvider.OpenAiCompatible.id,
    val enhancementBaseUrl: String = defaultOpenAiCompatibleEndpoints(),
    val enhancementModel: String = "gpt-4o-mini",
    val realtimeTranscriptionBaseUrl: String = defaultOpenAiCompatibleEndpoints(),
    val realtimeTranscriptionModel: String = "gpt-realtime-whisper",
    val realtimeTranscriptionLanguage: String = "en",
    val realtimeTranscriptionProviderId: String = "",
    val enhancementProviderId: String = "",
    val enhancementTimeoutSeconds: Int = 30,
    val enhancementHapticPattern: String = TerminalHapticPatterns.defaultProgressPatternId,
    val includeClipboardContext: Boolean = false,
    val customVocabulary: String = "",
) {
    fun resolvedPrompt(defaultPrompt: String): String = promptOverride.trim().ifBlank { defaultPrompt }
}

object SpeechSettingsStore {
    private const val preferencesName = "terminal"
    private val providersJson =
        Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }
    private const val speechProvidersKey = "speech.providers"
    private const val enhancementKey = "speech.enhancement_enabled"
    private const val autoSubmitAfterEnhancementKey = "speech.auto_submit_after_enhancement"
    private const val includeContextKey = "speech.include_visible_terminal_context"
    private const val vadSensitivityKey = "speech.vad_sensitivity"
    private const val promptOverrideKey = "speech.prompt_override"
    private const val enhancementProviderKey = "speech.enhancement_provider"
    private const val enhancementBaseUrlKey = "speech.enhancement_base_url"
    private const val enhancementModelKey = "speech.enhancement_model"
    private const val realtimeTranscriptionBaseUrlKey = "speech.realtime_transcription_base_url"
    private const val realtimeTranscriptionModelKey = "speech.realtime_transcription_model"
    private const val realtimeTranscriptionLanguageKey = "speech.realtime_transcription_language"
    private const val realtimeTranscriptionProviderIdKey = "speech.realtime_transcription_provider_id"
    private const val enhancementProviderIdKey = "speech.enhancement_provider_id"
    private const val enhancementTimeoutSecondsKey = "speech.enhancement_timeout_seconds"
    private const val enhancementHapticPatternKey = "speech.enhancement_haptic_pattern"
    private const val includeClipboardContextKey = "speech.include_clipboard_context"
    private const val customVocabularyKey = "speech.custom_vocabulary"
    private const val securePreferencesName = "speech_secure"
    private const val enhancementApiKeyKey = "speech.enhancement_api_key"

    fun values(context: Context): SpeechSettingsValues {
        val preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
        return SpeechSettingsValues(
            enhancementEnabled = preferences.getBoolean(enhancementKey, false),
            autoSubmitAfterEnhancement = preferences.getBoolean(autoSubmitAfterEnhancementKey, false),
            includeVisibleTerminalContext = preferences.getBoolean(includeContextKey, true),
            vadSensitivity = preferences.getInt(vadSensitivityKey, 2).coerceIn(0, 4),
            promptOverride = preferences.getString(promptOverrideKey, "").orEmpty(),
            enhancementProvider = preferences.getString(enhancementProviderKey, SpeechEnhancementProvider.OpenAiCompatible.id).orEmpty().ifBlank { SpeechEnhancementProvider.OpenAiCompatible.id },
            enhancementBaseUrl = preferences.getString(enhancementBaseUrlKey, defaultOpenAiCompatibleEndpoints()).orEmpty().ifBlank { defaultOpenAiCompatibleEndpoints() },
            enhancementModel = preferences.getString(enhancementModelKey, "gpt-4o-mini").orEmpty().ifBlank { "gpt-4o-mini" },
            realtimeTranscriptionBaseUrl = preferences.getString(realtimeTranscriptionBaseUrlKey, defaultOpenAiCompatibleEndpoints()).orEmpty().ifBlank { defaultOpenAiCompatibleEndpoints() },
            realtimeTranscriptionModel = preferences.getString(realtimeTranscriptionModelKey, "gpt-realtime-whisper").orEmpty().ifBlank { "gpt-realtime-whisper" },
            realtimeTranscriptionLanguage = preferences.getString(realtimeTranscriptionLanguageKey, "en").orEmpty().ifBlank { "en" },
            realtimeTranscriptionProviderId = preferences.getString(realtimeTranscriptionProviderIdKey, "").orEmpty(),
            enhancementProviderId = preferences.getString(enhancementProviderIdKey, "").orEmpty(),
            enhancementTimeoutSeconds = preferences.getInt(enhancementTimeoutSecondsKey, 30).coerceIn(3, 60),
            enhancementHapticPattern = TerminalHapticPatterns.option(preferences.getString(enhancementHapticPatternKey, TerminalHapticPatterns.defaultProgressPatternId).orEmpty()).id,
            includeClipboardContext = preferences.getBoolean(includeClipboardContextKey, false),
            customVocabulary = preferences.getString(customVocabularyKey, "").orEmpty(),
        )
    }

    fun registerChangeListener(
        context: Context,
        listener: SharedPreferences.OnSharedPreferenceChangeListener,
    ): SharedPreferences {
        val preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
        preferences.registerOnSharedPreferenceChangeListener(listener)
        return preferences
    }

    fun setEnhancementEnabled(
        context: Context,
        enabled: Boolean,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(enhancementKey, enabled) }

    fun setAutoSubmitAfterEnhancement(
        context: Context,
        enabled: Boolean,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(autoSubmitAfterEnhancementKey, enabled) }

    fun setIncludeVisibleTerminalContext(
        context: Context,
        enabled: Boolean,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(includeContextKey, enabled) }

    fun setVadSensitivity(
        context: Context,
        sensitivity: Int,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putInt(vadSensitivityKey, sensitivity.coerceIn(0, 4)) }

    fun setPromptOverride(
        context: Context,
        prompt: String,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(promptOverrideKey, prompt.take(8_000)) }

    fun setEnhancementProvider(
        context: Context,
        provider: String,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(enhancementProviderKey, SpeechEnhancementProvider.byId(provider).id) }

    fun setEnhancementBaseUrl(
        context: Context,
        baseUrl: String,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(enhancementBaseUrlKey, baseUrl.openAiBaseUrlAliases().joinToString("\n")) }

    fun setEnhancementModel(
        context: Context,
        model: String,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(enhancementModelKey, model.trim().take(120)) }

    fun setRealtimeTranscriptionBaseUrl(
        context: Context,
        baseUrl: String,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(realtimeTranscriptionBaseUrlKey, baseUrl.openAiBaseUrlAliases().joinToString("\n")) }

    fun setRealtimeTranscriptionModel(
        context: Context,
        model: String,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(realtimeTranscriptionModelKey, model.trim().take(120)) }

    fun setRealtimeTranscriptionLanguage(
        context: Context,
        language: String,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(realtimeTranscriptionLanguageKey, language.trim().take(12)) }

    fun setRealtimeTranscriptionProviderId(
        context: Context,
        providerId: String,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(realtimeTranscriptionProviderIdKey, providerId) }

    fun setEnhancementProviderId(
        context: Context,
        providerId: String,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(enhancementProviderIdKey, providerId) }

    fun providers(context: Context): List<SpeechProviderConfig> {
        val raw = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).getString(speechProvidersKey, "").orEmpty()
        val saved = runCatching { providersJson.decodeFromString<List<SpeechProviderConfig>>(raw) }.getOrDefault(emptyList())
        if (saved.isNotEmpty()) return saved.sortedBy { it.order }
        val values = values(context)
        val aliases = (values.realtimeTranscriptionBaseUrl.openAiBaseUrlAliases() + values.enhancementBaseUrl.openAiBaseUrlAliases()).distinct()
        return listOf(
            SpeechProviderConfig(id = "litellm-default", name = "LiteLLM", aliases = aliases.ifEmpty { defaultOpenAiCompatibleEndpoints().openAiBaseUrlAliases() }, capability = SpeechProviderCapability.Both.id, order = 0),
            SpeechProviderConfig(id = "speaches-default", name = "Speaches", aliases = defaultSpeachesEndpoints().openAiBaseUrlAliases(), capability = SpeechProviderCapability.Transcription.id, order = 1),
        )
    }

    fun saveProviders(
        context: Context,
        providers: List<SpeechProviderConfig>,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit {
        putString(speechProvidersKey, providers.mapIndexed { index, provider -> provider.copy(order = index) }.let(providersJson::encodeToString))
        putString(realtimeTranscriptionBaseUrlKey, providers.endpointsFor(OpenAiProviderTask.Transcription).joinToString("\n"))
        putString(enhancementBaseUrlKey, providers.endpointsFor(OpenAiProviderTask.Enhancement).joinToString("\n"))
    }

    fun setEnhancementTimeoutSeconds(
        context: Context,
        seconds: Int,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putInt(enhancementTimeoutSecondsKey, seconds.coerceIn(3, 60)) }

    fun setEnhancementHapticPattern(
        context: Context,
        pattern: String,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(enhancementHapticPatternKey, TerminalHapticPatterns.option(pattern).id) }

    fun setIncludeClipboardContext(
        context: Context,
        enabled: Boolean,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(includeClipboardContextKey, enabled) }

    fun setCustomVocabulary(
        context: Context,
        vocabulary: String,
    ) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit {
        putString(
            customVocabularyKey,
            vocabulary
                .lines()
                .map(String::trim)
                .filter(String::isNotBlank)
                .distinct()
                .take(200)
                .joinToString("\n"),
        )
    }

    fun enhancementApiKey(context: Context): String = securePreferences(context).getString(enhancementApiKeyKey, "").orEmpty()

    fun setEnhancementApiKey(
        context: Context,
        apiKey: String,
    ) = securePreferences(context).edit { putString(enhancementApiKeyKey, apiKey.trim()) }

    fun apiKeyForEndpoint(
        context: Context,
        endpoint: String,
    ): String {
        providers(context).firstOrNull { provider -> endpoint in provider.aliases }?.let { provider ->
            val providerKey = apiKeyForProvider(context, provider.id)
            if (providerKey.isNotBlank()) return providerKey
        }
        return enhancementApiKey(context)
    }

    fun apiKeyForProvider(
        context: Context,
        providerId: String,
    ): String = securePreferences(context).getString(providerApiKeyKey(providerId), "").orEmpty()

    fun setApiKeyForProvider(
        context: Context,
        providerId: String,
        apiKey: String,
    ) = securePreferences(context).edit { putString(providerApiKeyKey(providerId), apiKey.trim()) }

    fun hasApiKeyForProvider(
        context: Context,
        providerId: String,
    ): Boolean = apiKeyForProvider(context, providerId).isNotBlank()

    private fun providerApiKeyKey(providerId: String): String = "speech.provider_api_key." + providerId.sha256Hex()

    fun defaultPrompt(context: Context): String =
        context.resources
            .openRawResource(R.raw.vibe_coding)
            .bufferedReader()
            .use { it.readText() }
            .trim()
}

@Serializable
data class SpeechProviderConfig(
    val id: String,
    val name: String,
    val aliases: List<String>,
    val capability: String,
    val order: Int,
)

enum class SpeechProviderCapability(
    val id: String,
    val label: String,
) {
    Transcription("transcription", "Transcription"),
    Enhancement("enhancement", "Enhancement"),
    Both("both", "Both"),
    ;

    companion object {
        val all = listOf(Transcription, Enhancement, Both)

        fun byId(id: String): SpeechProviderCapability = all.firstOrNull { it.id == id } ?: Both
    }
}

fun List<SpeechProviderConfig>.endpointsFor(task: OpenAiProviderTask): List<String> =
    sortedBy { it.order }
        .filter { provider ->
            val capability = SpeechProviderCapability.byId(provider.capability)
            capability == SpeechProviderCapability.Both || (task == OpenAiProviderTask.Transcription && capability == SpeechProviderCapability.Transcription) || (task == OpenAiProviderTask.Enhancement && capability == SpeechProviderCapability.Enhancement)
        }.flatMap { it.aliases }
        .map { it.trim().trimEnd('/') }
        .filter { it.isNotBlank() }
        .distinct()

fun List<SpeechProviderConfig>.providersForTask(task: OpenAiProviderTask): List<SpeechProviderConfig> =
    sortedBy { it.order }.filter { provider ->
        val capability = SpeechProviderCapability.byId(provider.capability)
        capability == SpeechProviderCapability.Both ||
            (task == OpenAiProviderTask.Transcription && capability == SpeechProviderCapability.Transcription) ||
            (task == OpenAiProviderTask.Enhancement && capability == SpeechProviderCapability.Enhancement)
    }

fun List<SpeechProviderConfig>.providerForTask(
    task: OpenAiProviderTask,
    providerId: String,
): SpeechProviderConfig? = providersForTask(task).let { capable -> capable.firstOrNull { it.id == providerId } ?: capable.firstOrNull() }

fun List<SpeechProviderConfig>.endpointsForSelected(
    task: OpenAiProviderTask,
    providerId: String,
): List<String> =
    providerForTask(task, providerId)
        ?.aliases
        ?.map { it.trim().trimEnd('/') }
        ?.filter { it.isNotBlank() }
        ?.distinct()
        .orEmpty()

enum class SpeechEnhancementProvider(
    val id: String,
    val label: String,
) {
    OpenAiCompatible("openai", "OpenAI Compatible"),
    Gemini("gemini", "Gemini"),
    Disabled("disabled", "Disabled"),
    ;

    companion object {
        val all = listOf(OpenAiCompatible, Gemini, Disabled)

        fun byId(id: String): SpeechEnhancementProvider = all.firstOrNull { it.id == id } ?: OpenAiCompatible
    }
}

private fun securePreferences(context: Context): SharedPreferences =
    try {
        createSpeechSecurePreferences(context)
    } catch (error: Exception) {
        if (error !is GeneralSecurityException && error !is IOException && error !is SecurityException && error !is IllegalStateException) throw error
        context.deleteSharedPreferences("speech_secure")
        createSpeechSecurePreferences(context)
    }

private fun createSpeechSecurePreferences(context: Context): SharedPreferences {
    val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
    return EncryptedSharedPreferences.create(
        context,
        "speech_secure",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
}

fun String.openAiBaseUrlAliases(): List<String> =
    lines()
        .flatMap { it.split(',') }
        .map { it.trim().trimEnd('/') }
        .filter { it.isNotBlank() && it.isAllowedOpenAiCompatibleEndpoint() }
        .distinct()

private fun String.isAllowedOpenAiCompatibleEndpoint(): Boolean {
    val value = trim()
    if (value.startsWith("https://", ignoreCase = true)) return true
    if (!value.startsWith("http://", ignoreCase = true)) return false
    val host = value.removePrefix("http://").substringBefore('/').substringBefore(':')
    if (host == "localhost" || host == "127.0.0.1") return true
    val parts = host.split('.').mapNotNull { it.toIntOrNull() }
    if (parts.size != 4) return false
    if (parts[0] == 192 && parts[1] == 168 && parts[2] in 0..1) return true
    return parts[0] == 100 && parts[1] in 64..127
}

fun defaultOpenAiCompatibleEndpoints(): String =
    listOf(
        "http://192.168.1.116:4000/v1",
        "http://100.100.1.116:4000/v1",
        "https://ai-gateway.0iq.xyz/v1",
    ).joinToString("\n")

fun defaultSpeachesEndpoints(): String =
    listOf(
        "http://192.168.1.120:3001/v1",
        "http://100.100.1.120:3001/v1",
        "https://voice.0iq.xyz/v1",
    ).joinToString("\n")

private fun String.sha256Hex(): String = MessageDigest.getInstance("SHA-256").digest(trim().lowercase().toByteArray()).joinToString("") { "%02x".format(it) }
