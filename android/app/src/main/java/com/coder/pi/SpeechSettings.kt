package com.coder.pi

import android.content.Context
import androidx.core.content.edit

data class SpeechSettingsValues(
    val localTranscriptionEnabled: Boolean = true,
    val selectedSpeechModelId: String = "parakeet-tdt-i8-stateful",
    val enhancementEnabled: Boolean = false,
    val includeVisibleTerminalContext: Boolean = true,
    val vadSensitivity: Int = 2,
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
    private const val promptOverrideKey = "speech.prompt_override"

    fun values(context: Context): SpeechSettingsValues {
        val preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
        return SpeechSettingsValues(
            localTranscriptionEnabled = preferences.getBoolean(localTranscriptionKey, true),
            selectedSpeechModelId = preferences.getString(selectedModelKey, "parakeet-tdt-i8-stateful").orEmpty().ifBlank { "parakeet-tdt-i8-stateful" },
            enhancementEnabled = preferences.getBoolean(enhancementKey, false),
            includeVisibleTerminalContext = preferences.getBoolean(includeContextKey, true),
            vadSensitivity = preferences.getInt(vadSensitivityKey, 2).coerceIn(0, 4),
            promptOverride = preferences.getString(promptOverrideKey, "").orEmpty(),
        )
    }

    fun setLocalTranscriptionEnabled(context: Context, enabled: Boolean) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(localTranscriptionKey, enabled) }

    fun setSelectedSpeechModelId(context: Context, modelId: String) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(selectedModelKey, modelId) }

    fun setEnhancementEnabled(context: Context, enabled: Boolean) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(enhancementKey, enabled) }

    fun setIncludeVisibleTerminalContext(context: Context, enabled: Boolean) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putBoolean(includeContextKey, enabled) }

    fun setVadSensitivity(context: Context, sensitivity: Int) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putInt(vadSensitivityKey, sensitivity.coerceIn(0, 4)) }

    fun setPromptOverride(context: Context, prompt: String) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit { putString(promptOverrideKey, prompt.take(8_000)) }

    fun defaultPrompt(context: Context): String = context.resources.openRawResource(R.raw.speech_enhancement_prompt).bufferedReader().use { it.readText() }.trim()
}
