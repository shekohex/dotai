package com.coder.pi

import android.content.Context
import android.media.MediaPlayer

class SpeechSoundFeedback(
    private val context: Context,
) {
    fun playStart() = playSelected() ?: play(R.raw.speech_recstart, 0.4f)

    fun playStop() = playSelected() ?: play(R.raw.speech_recstop, 0.4f)

    fun playCancel() = play(R.raw.speech_esc, 0.3f)

    fun playFailure() = play(R.raw.speech_esc, 0.3f)

    private fun playSelected(): Unit? {
        val settings = SpeechSettingsStore.values(context)
        val uri = TerminalNotificationSounds.uri(context, settings.soundFeedbackSoundId) ?: return null
        val player = MediaPlayer.create(context.applicationContext, uri) ?: return null
        player.setVolume(0.35f, 0.35f)
        player.setOnCompletionListener { it.release() }
        player.setOnErrorListener { mediaPlayer, _, _ ->
            mediaPlayer.release()
            true
        }
        player.start()
        return Unit
    }

    private fun play(
        resourceId: Int,
        volume: Float,
    ) {
        val player = MediaPlayer.create(context.applicationContext, resourceId) ?: return
        player.setVolume(volume, volume)
        player.setOnCompletionListener { it.release() }
        player.setOnErrorListener { mediaPlayer, _, _ ->
            mediaPlayer.release()
            true
        }
        player.start()
    }
}
