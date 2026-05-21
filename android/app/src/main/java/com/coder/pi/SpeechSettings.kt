package com.coder.pi

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.IOException
import java.security.GeneralSecurityException

data class SpeechSettingsValues(
    val localTranscriptionEnabled: Boolean = true,
    val selectedSpeechModelId: String = "parakeet-tdt-i8-stateful",
    val enhancementEnabled: Boolean = false,
    val includeVisibleTerminalContext: Boolean = true,
    val vadSensitivity: Int = 2,
    val soundFeedbackEnabled: Boolean = true,
    val keepModelWarmEnabled: Boolean = true,
    val keepModelWarmMinutes: Int = 15,
    val accelerator: String = SpeechAcceleratorMode.Auto.id,
    val pauseModelDownloadsOnMeteredNetwork: Boolean = true,
    val promptOverride: String = "",
    val enhancementProvider: String = SpeechEnhancementProvider.OpenAiCompatible.id,
    val enhancementBaseUrl: String = "https://api.openai.com/v1",
    val enhancementModel: String = "gpt-4o-mini",
) {
    fun resolvedPrompt(defaultPrompt: String): String = promptOverride.trim().ifBlank { defaultPrompt }
}

object SpeechSettingsStore {
    private const val preferencesName = "terminal"
    private const val localTranscriptionKey = "speech.local_transcription_enabled"
    private const val selectedModelKey = "speech.selected_model"
    private const val enhancementKey = "speech.enhancement_enabled"
    private const val includeContextKey = "speech.include_visible_terminal_context"
    private const val vadSensitivityKey = "speech.vad_sensitivity"
    private const val soundFeedbackEnabledKey = "speech.sound_feedback_enabled"
    private const val keepModelWarmEnabledKey = "speech.keep_model_warm_enabled"
    private const val keepModelWarmMinutesKey = "speech.keep_model_warm_minutes"
    private const val acceleratorKey = "speech.accelerator"
    private const val pauseDownloadsOnMeteredKey = "speech.pause_model_downloads_on_metered"
    private const val promptOverrideKey = "speech.prompt_override"
    private const val enhancementProviderKey = "speech.enhancement_provider"
    private const val enhancementBaseUrlKey = "speech.enhancement_base_url"
    private const val enhancementModelKey = "speech.enhancement_model"
    private const val securePreferencesName = "speech_secure"
    private const val enhancementApiKeyKey = "speech.enhancement_api_key"

    fun values(context: Context): SpeechSettingsValues {
        val preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
        return SpeechSettingsValues(
            localTranscriptionEnabled = preferences.getBoolean(localTranscriptionKey, true),
            selectedSpeechModelId = preferences.getString(selectedModelKey, "parakeet-tdt-i8-stateful").orEmpty().ifBlank { "parakeet-tdt-i8-stateful" },
            enhancementEnabled = preferences.getBoolean(enhancementKey, false),
            includeVisibleTerminalContext = preferences.getBoolean(includeContextKey, true),
            vadSensitivity = preferences.getInt(vadSensitivityKey, 2).coerceIn(0, 4),
            soundFeedbackEnabled = preferences.getBoolean(soundFeedbackEnabledKey, true),
            keepModelWarmEnabled = preferences.getBoolean(keepModelWarmEnabledKey, true),
            keepModelWarmMinutes = preferences.getInt(keepModelWarmMinutesKey, 15).coerceIn(1, 60),
            accelerator = preferences.getString(acceleratorKey, SpeechAcceleratorMode.Auto.id).orEmpty().ifBlank { SpeechAcceleratorMode.Auto.id },
            pauseModelDownloadsOnMeteredNetwork = preferences.getBoolean(pauseDownloadsOnMeteredKey, true),
            promptOverride = preferences.getString(promptOverrideKey, "").orEmpty(),
            enhancementProvider = preferences.getString(enhancementProviderKey, SpeechEnhancementProvider.OpenAiCompatible.id).orEmpty().ifBlank { SpeechEnhancementProvider.OpenAiCompatible.id },
            enhancementBaseUrl = preferences.getString(enhancementBaseUrlKey, "https://api.openai.com/v1").orEmpty().ifBlank { "https://api.openai.com/v1" },
            enhancementModel = preferences.getString(enhancementModelKey, "gpt-4o-mini").orEmpty().ifBlank { "gpt-4o-mini" },
        )
    }

    fun registerChangeListener(context: Context, listener: SharedPreferences.OnSharedPreferenceChangeListener): SharedPreferences {
        val preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
        preferences.registerOnSharedPreferenceChangeListener(listener)
        return preferences
    }

    fun setLocalTranscriptionEnabled(context: Context, enabled: Boolean) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(localTranscriptionKey, enabled) }

    fun setSelectedSpeechModelId(context: Context, modelId: String) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(selectedModelKey, modelId) }

    fun setEnhancementEnabled(context: Context, enabled: Boolean) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(enhancementKey, enabled) }

    fun setIncludeVisibleTerminalContext(context: Context, enabled: Boolean) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(includeContextKey, enabled) }

    fun setVadSensitivity(context: Context, sensitivity: Int) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putInt(vadSensitivityKey, sensitivity.coerceIn(0, 4)) }

    fun setSoundFeedbackEnabled(context: Context, enabled: Boolean) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(soundFeedbackEnabledKey, enabled) }

    fun setKeepModelWarmEnabled(context: Context, enabled: Boolean) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(keepModelWarmEnabledKey, enabled) }

    fun setKeepModelWarmMinutes(context: Context, minutes: Int) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putInt(keepModelWarmMinutesKey, minutes.coerceIn(1, 60)) }

    fun setAccelerator(context: Context, accelerator: String) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(acceleratorKey, SpeechAcceleratorMode.byId(accelerator).id) }

    fun setPauseModelDownloadsOnMeteredNetwork(context: Context, enabled: Boolean) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(pauseDownloadsOnMeteredKey, enabled) }

    fun setPromptOverride(context: Context, prompt: String) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(promptOverrideKey, prompt.take(8_000)) }

    fun setEnhancementProvider(context: Context, provider: String) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(enhancementProviderKey, SpeechEnhancementProvider.byId(provider).id) }

    fun setEnhancementBaseUrl(context: Context, baseUrl: String) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(enhancementBaseUrlKey, baseUrl.trim().trimEnd('/').take(300)) }

    fun setEnhancementModel(context: Context, model: String) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(enhancementModelKey, model.trim().take(120)) }

    fun enhancementApiKey(context: Context): String = securePreferences(context).getString(enhancementApiKeyKey, "").orEmpty()

    fun setEnhancementApiKey(context: Context, apiKey: String) = securePreferences(context).edit { putString(enhancementApiKeyKey, apiKey.trim()) }

    fun defaultPrompt(context: Context): String = context.resources.openRawResource(R.raw.speech_enhancement_prompt).bufferedReader().use { it.readText() }.trim()
}

enum class SpeechEnhancementProvider(val id: String, val label: String) {
    OpenAiCompatible("openai", "OpenAI Compatible"),
    Gemini("gemini", "Gemini"),
    Disabled("disabled", "Disabled");

    companion object {
        val all = listOf(OpenAiCompatible, Gemini, Disabled)
        fun byId(id: String): SpeechEnhancementProvider = all.firstOrNull { it.id == id } ?: OpenAiCompatible
    }
}

private fun securePreferences(context: Context): SharedPreferences {
    return try {
        createSpeechSecurePreferences(context)
    } catch (error: Exception) {
        if (error !is GeneralSecurityException && error !is IOException && error !is SecurityException && error !is IllegalStateException) throw error
        context.deleteSharedPreferences("speech_secure")
        createSpeechSecurePreferences(context)
    }
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

enum class SpeechAcceleratorMode(val id: String, val label: String) {
    Auto("auto", "Auto"),
    Cpu("cpu", "CPU"),
    Gpu("gpu", "GPU"),
    Npu("npu", "NPU"),
    None("none", "None");

    companion object {
        val all = listOf(Auto, Cpu, Gpu, Npu, None)
        fun byId(id: String): SpeechAcceleratorMode = all.firstOrNull { it.id == id } ?: Auto
    }
}
