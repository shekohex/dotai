package com.coder.pi

import android.content.Context
import android.media.MediaPlayer

class SpeechSoundFeedback(
    private val context: Context,
) {
    fun playStart() = play(R.raw.speech_recstart, 0.4f)

    fun playStop() = play(R.raw.speech_recstop, 0.4f)

    fun playCancel() = play(R.raw.speech_esc, 0.3f)

    fun playFailure() = play(R.raw.speech_esc, 0.3f)

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
