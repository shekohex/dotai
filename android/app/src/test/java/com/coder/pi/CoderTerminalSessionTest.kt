package com.coder.pi

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CoderTerminalSessionTest {
    @Test
    fun safeTerminalErrorHidesSensitiveConnectionData() {
        val error = CoderTerminalSession.safeTerminalError(
            IllegalStateException("failed https://coder.example?token=abc&reconnect=def&command=bash Coder-Session-Token=secret"),
        )

        assertFalse(error.contains("abc"))
        assertFalse(error.contains("def"))
        assertFalse(error.contains("secret"))
        assertFalse(error.contains("https://coder.example"))
        assertTrue(error.contains("<hidden>") || error.contains("<url>"))
    }
}
