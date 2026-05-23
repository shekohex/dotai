package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechProviderSettingsTest {
    @Test
    fun endpointsForSelectedUsesOnlySelectedProvider() {
        val providers =
            listOf(
                SpeechProviderConfig("litellm", "LiteLLM", listOf("https://litellm.example/v1"), SpeechProviderCapability.Both.id, 0),
                SpeechProviderConfig("speaches", "Speaches", listOf("https://voice.example/v1"), SpeechProviderCapability.Transcription.id, 1),
            )

        assertEquals(listOf("https://voice.example/v1"), providers.endpointsForSelected(OpenAiProviderTask.Transcription, "speaches"))
    }

    @Test
    fun enhancementProvidersExcludeTranscriptionOnlyProviders() {
        val providers =
            listOf(
                SpeechProviderConfig("speaches", "Speaches", listOf("https://voice.example/v1"), SpeechProviderCapability.Transcription.id, 0),
                SpeechProviderConfig("litellm", "LiteLLM", listOf("https://litellm.example/v1"), SpeechProviderCapability.Both.id, 1),
            )

        assertEquals(listOf("litellm"), providers.providersForTask(OpenAiProviderTask.Enhancement).map { it.id })
    }

    @Test
    fun defaultProvidersIncludeLitellmAndSpeachesEndpoints() {
        assertTrue(defaultOpenAiCompatibleEndpoints().openAiBaseUrlAliases().contains("http://192.168.1.116:4000/v1"))
        assertTrue(defaultSpeachesEndpoints().openAiBaseUrlAliases().contains("http://192.168.1.120:3001/v1"))
    }

    @Test
    fun cleartextFilteringAllowsLanAndTailscaleOnly() {
        val aliases =
            """
            http://192.168.1.120:3001/v1
            http://192.168.2.120:3001/v1
            http://100.100.1.120:3001/v1
            http://public.example/v1
            https://public.example/v1
            """.trimIndent().openAiBaseUrlAliases()

        assertTrue("http://192.168.1.120:3001/v1" in aliases)
        assertTrue("http://100.100.1.120:3001/v1" in aliases)
        assertTrue("https://public.example/v1" in aliases)
        assertFalse("http://192.168.2.120:3001/v1" in aliases)
        assertFalse("http://public.example/v1" in aliases)
    }
}
