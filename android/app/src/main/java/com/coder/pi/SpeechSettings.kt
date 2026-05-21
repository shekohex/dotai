package com.coder.pi

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

data class SpeechSettingsValues(
    val localTranscriptionEnabled: Boolean = true,
    val selectedSpeechModelId: String = "parakeet-tdt-i8-stateful",
    val enhancementEnabled: Boolean = false,
    val includeVisibleTerminalContext: Boolean = true,
    val vadSensitivity: Int = 2,
    val keepModelWarmEnabled: Boolean = false,
    val keepModelWarmMinutes: Int = 15,
    val accelerator: String = SpeechAcceleratorMode.Auto.id,
    val pauseModelDownloadsOnMeteredNetwork: Boolean = true,
    val promptOverride: String = "",
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
    private const val keepModelWarmEnabledKey = "speech.keep_model_warm_enabled"
    private const val keepModelWarmMinutesKey = "speech.keep_model_warm_minutes"
    private const val acceleratorKey = "speech.accelerator"
    private const val pauseDownloadsOnMeteredKey = "speech.pause_model_downloads_on_metered"
    private const val promptOverrideKey = "speech.prompt_override"

    fun values(context: Context): SpeechSettingsValues {
        val preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
        return SpeechSettingsValues(
            localTranscriptionEnabled = preferences.getBoolean(localTranscriptionKey, true),
            selectedSpeechModelId = preferences.getString(selectedModelKey, "parakeet-tdt-i8-stateful").orEmpty().ifBlank { "parakeet-tdt-i8-stateful" },
            enhancementEnabled = preferences.getBoolean(enhancementKey, false),
            includeVisibleTerminalContext = preferences.getBoolean(includeContextKey, true),
            vadSensitivity = preferences.getInt(vadSensitivityKey, 2).coerceIn(0, 4),
            keepModelWarmEnabled = preferences.getBoolean(keepModelWarmEnabledKey, false),
            keepModelWarmMinutes = preferences.getInt(keepModelWarmMinutesKey, 15).coerceIn(1, 60),
            accelerator = preferences.getString(acceleratorKey, SpeechAcceleratorMode.Auto.id).orEmpty().ifBlank { SpeechAcceleratorMode.Auto.id },
            pauseModelDownloadsOnMeteredNetwork = preferences.getBoolean(pauseDownloadsOnMeteredKey, true),
            promptOverride = preferences.getString(promptOverrideKey, "").orEmpty(),
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

    fun setKeepModelWarmEnabled(context: Context, enabled: Boolean) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(keepModelWarmEnabledKey, enabled) }

    fun setKeepModelWarmMinutes(context: Context, minutes: Int) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putInt(keepModelWarmMinutesKey, minutes.coerceIn(1, 60)) }

    fun setAccelerator(context: Context, accelerator: String) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(acceleratorKey, SpeechAcceleratorMode.byId(accelerator).id) }

    fun setPauseModelDownloadsOnMeteredNetwork(context: Context, enabled: Boolean) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(pauseDownloadsOnMeteredKey, enabled) }

    fun setPromptOverride(context: Context, prompt: String) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(promptOverrideKey, prompt.take(8_000)) }

    fun defaultPrompt(context: Context): String = context.resources.openRawResource(R.raw.speech_enhancement_prompt).bufferedReader().use { it.readText() }.trim()
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
