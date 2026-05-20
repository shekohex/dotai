package com.coder.pi

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

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

    @Test
    fun coderApiCloseRunsExactlyOnce() {
        val closeCount = AtomicInteger(0)
        val api = CoderApi("https://coder.example", "token") { closeCount.incrementAndGet() }

        api.close()
        api.close()

        assertEquals(1, closeCount.get())
    }
}
