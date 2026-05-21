package com.coder.pi

import android.content.Context
import androidx.core.content.edit

enum class TerminalAlertFeedbackState(val id: String, val label: String, val defaultSoundId: String, val defaultHapticId: String) {
    SUCCESS("success", "Idle / Success", "yup-01", TerminalHapticPatterns.defaultSuccessPatternId),
    SUBMIT("submit", "Message Submitted", "bip-bop-01", "double_tap"),
    ATTENTION("attention", "Attention Required", "alert-01", TerminalHapticPatterns.defaultAttentionPatternId),
    INTERRUPTED("interrupted", "Interrupted", "nope-03", "heavy"),
    ERROR("error", "Error", "nope-01", TerminalHapticPatterns.defaultErrorPatternId),
}

object TerminalAlertFeedback {
    fun stateFor(kind: String, severity: String): TerminalAlertFeedbackState = when {
        kind == "input" -> TerminalAlertFeedbackState.SUBMIT
        else -> stateForSeverity(severity)
    }

    fun stateForSeverity(severity: String): TerminalAlertFeedbackState = when (severity.lowercase()) {
        "success" -> TerminalAlertFeedbackState.SUCCESS
        "error" -> TerminalAlertFeedbackState.ERROR
        else -> TerminalAlertFeedbackState.ATTENTION
    }

    fun soundId(context: Context, state: TerminalAlertFeedbackState): String = TerminalNotificationSounds.option(preferences(context).getString(soundKey(state), state.defaultSoundId).orEmpty()).id

    fun hapticId(context: Context, state: TerminalAlertFeedbackState): String = TerminalHapticPatterns.option(preferences(context).getString(hapticKey(state), state.defaultHapticId).orEmpty()).id

    fun setSoundId(context: Context, state: TerminalAlertFeedbackState, soundId: String) {
        preferences(context).edit { putString(soundKey(state), TerminalNotificationSounds.option(soundId).id) }
    }

    fun setHapticId(context: Context, state: TerminalAlertFeedbackState, hapticId: String) {
        preferences(context).edit { putString(hapticKey(state), TerminalHapticPatterns.option(hapticId).id) }
    }

    fun channelSuffix(context: Context, state: TerminalAlertFeedbackState): String = "${state.id}.${TerminalNotificationSounds.channelSuffix(soundId(context, state))}.${hapticId(context, state)}"

    private fun preferences(context: Context) = context.getSharedPreferences("terminal", Context.MODE_PRIVATE)
    private fun soundKey(state: TerminalAlertFeedbackState): String = "osc.notifications.${state.id}.sound"
    private fun hapticKey(state: TerminalAlertFeedbackState): String = "osc.notifications.${state.id}.haptic"
}
