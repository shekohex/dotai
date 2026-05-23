package com.coder.pi

import java.net.URLEncoder

object RealtimeTranscriptionUrlBuilder {
    fun url(
        settings: SpeechSettingsValues,
        apiKey: String,
    ): String {
        val base = OpenAiProviderEndpointResolver.activeBaseUrl(OpenAiProviderTask.Transcription, settings.realtimeTranscriptionBaseUrl).removeSuffix("/v1")
        val websocketBase = base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
        val model = settings.realtimeTranscriptionModel.urlEncoded()
        val language = settings.realtimeTranscriptionLanguage.trim().urlEncoded()
        val key = apiKey.takeIf { it.isNotBlank() }?.let { "&api_key=${it.urlEncoded()}" }.orEmpty()
        return "$websocketBase/v1/realtime?intent=transcription&model=$model&transcription_model=$model&language=$language$key"
    }
}

private fun String.urlEncoded(): String = URLEncoder.encode(this, Charsets.UTF_8.name())
