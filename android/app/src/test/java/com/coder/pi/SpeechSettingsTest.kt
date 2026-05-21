package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SpeechSettingsTest {
    @Test
    fun defaultsPreferLocalTranscriptionAndVisibleContext() {
        val values = SpeechSettingsValues()

        assertTrue(values.localTranscriptionEnabled)
        assertFalse(values.enhancementEnabled)
        assertTrue(values.includeVisibleTerminalContext)
        assertEquals(2, values.vadSensitivity)
        assertEquals("Improve me", values.resolvedPrompt("Improve me"))
    }

    @Test
    fun promptOverrideReplacesDefaultWhenNonBlank() {
        val values = SpeechSettingsValues(promptOverride = "Use terse terminal wording")

        assertEquals("Use terse terminal wording", values.resolvedPrompt("Default prompt"))
    }

    @Test
    fun blankPromptOverrideFallsBackToDefault() {
        val values = SpeechSettingsValues(promptOverride = "  \n  ")

        assertEquals("Default prompt", values.resolvedPrompt("Default prompt"))
    }

    @Test
    fun bundledPromptContainsTranscriptAndContextPlaceholders() {
        val promptFile = listOf(
            File("src/main/res/raw/speech_enhancement_prompt.txt"),
            File("app/src/main/res/raw/speech_enhancement_prompt.txt"),
        ).first { it.exists() }
        val prompt = promptFile.readText()

        assertTrue(prompt.contains("<TRANSCRIPT>"))
        assertTrue(prompt.contains("<CONTEXT>"))
        assertTrue(prompt.contains("visible terminal context", ignoreCase = true))
    }
}
