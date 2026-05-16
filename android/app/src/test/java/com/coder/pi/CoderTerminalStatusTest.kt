package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CoderTerminalStatusTest {
    @Test
    fun knownStatusMapsFromWireName() {
        assertEquals(TerminalConnectionStatus.Connected, terminalStatusFromWireName("connected"))
        assertEquals(TerminalConnectionStatus.Reconnecting, terminalStatusFromWireName("reconnecting"))
    }

    @Test
    fun unknownStatusFallsBackToDisconnected() {
        assertEquals(TerminalConnectionStatus.Disconnected, terminalStatusFromWireName("unknown"))
    }

    @Test
    fun recoverableStatusOnlyIncludesFailedAndDisconnected() {
        assertTrue(terminalStatusIsRecoverable("failed"))
        assertTrue(terminalStatusIsRecoverable("disconnected"))
        assertFalse(terminalStatusIsRecoverable("connected"))
        assertFalse(terminalStatusIsRecoverable("reconnecting"))
    }
}
