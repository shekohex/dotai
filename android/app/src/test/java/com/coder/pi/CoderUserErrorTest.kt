package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CoderUserErrorTest {
    @Test
    fun safeUserErrorHidesSensitiveValues() {
        val error = safeUserError(IllegalStateException("failed https://coder.example?token=abc&command=bash Coder-Session-Token=secret"), "fallback")

        assertFalse(error.contains("abc"))
        assertFalse(error.contains("secret"))
        assertFalse(error.contains("https://coder.example"))
        assertTrue(error.contains("<hidden>") || error.contains("<url>"))
    }

    @Test
    fun safeUserErrorUsesFallbackForBlankMessage() {
        assertEquals("Could not load workspaces", safeUserError(RuntimeException(), "Could not load workspaces"))
    }
}
