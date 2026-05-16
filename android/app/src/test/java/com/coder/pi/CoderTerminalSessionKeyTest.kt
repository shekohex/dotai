package com.coder.pi

import org.junit.Assert.assertNotEquals
import org.junit.Test

class CoderTerminalSessionKeyTest {
    @Test
    fun terminalSessionKeySeparatesWorkspacesForSameAgentAndCommand() {
        val first = TerminalIdentity("https://coder.example", "user", "workspace-a", "agent", "bash")
        val second = TerminalIdentity("https://coder.example", "user", "workspace-b", "agent", "bash")

        assertNotEquals(terminalSessionKey(first), terminalSessionKey(second))
    }

    @Test
    fun terminalSessionKeySeparatesUsersForSameWorkspaceAgentAndCommand() {
        val first = TerminalIdentity("https://coder.example", "user-a", "workspace", "agent", "bash")
        val second = TerminalIdentity("https://coder.example", "user-b", "workspace", "agent", "bash")

        assertNotEquals(terminalSessionKey(first), terminalSessionKey(second))
    }
}
