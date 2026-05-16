package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class CoderSessionStoreTest {
    @Test
    fun activeTerminalKeySeparatesCommandsForSameAgent() {
        val shellKey = CoderSessionStore.activeTerminalKey("state", "agent", "bash")
        val tmuxKey = CoderSessionStore.activeTerminalKey("state", "agent", "tmux attach -t main")

        assertNotEquals(shellKey, tmuxKey)
    }

    @Test
    fun activeTerminalKeyStableForSameTarget() {
        assertEquals(
            CoderSessionStore.activeTerminalKey("state", "agent", "bash"),
            CoderSessionStore.activeTerminalKey("state", "agent", "bash"),
        )
    }

    @Test
    fun activeTerminalMetadataCarriesPreviewWithoutChangingIdentity() {
        val metadata = CoderActiveTerminalMetadata("https://coder.example", "user", "workspace", "pi", "agent", "main", "bash", "reconnect", 1L, "line 1\nline 2")

        assertEquals("line 1\nline 2", metadata.preview)
        assertEquals("workspace", metadata.workspaceId)
        assertEquals("agent", metadata.agentId)
        assertEquals("bash", metadata.command)
    }

    @Test
    fun safePreviewTextRedactsSensitiveFragments() {
        val preview = CoderSessionStore.safePreviewText("token=abc password=hunter2 https://coder.example/path Coder-Session-Token=secret")

        assertEquals("token=<hidden> password=<hidden> <url> Coder-Session-Token=<hidden>", preview)
    }

    @Test
    fun safeDebugLogMessageRedactsSensitiveFragments() {
        val log = CoderSessionStore.safeDebugLogMessage("failed wss://coder.example/path?reconnect=abc command=bash token=secret")

        assertEquals("failed <url> command=<hidden> token=<hidden>", log)
    }
}
