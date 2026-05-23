package com.coder.pi

import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

class RealtimeTranscriptionEventHandler(
    private val onTranscript: (String) -> Unit,
) {
    private val accumulator = RealtimeTranscriptionAccumulator()
    private var errorMessage = ""

    val transcript: String get() = accumulator.transcript
    val lastError: String get() = errorMessage

    fun handle(
        root: JsonObject,
        finalTranscript: CompletableDeferred<String>,
    ) {
        when (val type = root["type"]?.jsonPrimitive?.contentOrNull.orEmpty()) {
            "conversation.item.input_audio_transcription.delta" -> appendDelta(root["delta"]?.jsonPrimitive?.contentOrNull.orEmpty())
            "conversation.item.input_audio_transcription.completed" -> appendCompleted(root["transcript"]?.jsonPrimitive?.contentOrNull.orEmpty(), finalTranscript)
            "input_audio_buffer.speech_stopped" -> Unit
            "error" -> handleError(root, finalTranscript)
            else -> handleLooseTranscriptEvent(root, type, finalTranscript)
        }
    }

    private fun appendDelta(delta: String) {
        if (delta.isBlank()) return
        accumulator.appendDelta(delta)
        onTranscript(accumulator.transcript)
    }

    private fun appendCompleted(
        transcript: String,
        finalTranscript: CompletableDeferred<String>,
    ) {
        val text = accumulator.appendCompleted(transcript)
        if (text.isBlank()) return
        onTranscript(text)
        if (!finalTranscript.isCompleted) finalTranscript.complete(text)
    }

    private fun handleError(
        root: JsonObject,
        finalTranscript: CompletableDeferred<String>,
    ) {
        errorMessage = root.toString()
        Log.e(LogTag, "error=$errorMessage")
        if (!errorMessage.contains("already exists", ignoreCase = true) && !finalTranscript.isCompleted) finalTranscript.complete("")
    }

    private fun handleLooseTranscriptEvent(
        root: JsonObject,
        type: String,
        finalTranscript: CompletableDeferred<String>,
    ) {
        val delta = root["delta"]?.jsonPrimitive?.contentOrNull.orEmpty()
        if (delta.isNotBlank() && type.contains("transcription", ignoreCase = true)) {
            appendDelta(delta)
            return
        }
        val transcript = root["transcript"]?.jsonPrimitive?.contentOrNull.orEmpty()
        if (transcript.isNotBlank() && type.contains("transcription", ignoreCase = true)) {
            if (type.contains("completed", ignoreCase = true) || type.contains("done", ignoreCase = true)) appendCompleted(transcript, finalTranscript) else onTranscript(transcript)
        }
    }

    companion object {
        const val LogTag = "RealtimeSpeech"
    }

    fun reset() {
        accumulator.reset()
        errorMessage = ""
    }
}
