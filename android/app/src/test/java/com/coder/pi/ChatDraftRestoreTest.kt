package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Test

class ChatDraftRestoreTest {
    @Test
    fun restoreReplacesBlankDraft() {
        assertEquals("hello", appendRestoredChatDraft("", "hello"))
    }

    @Test
    fun restoreAppendsToExistingDraft() {
        assertEquals("new\n\nold", appendRestoredChatDraft("new", "old"))
    }

    @Test
    fun restoreTrimsBoundaryWhitespace() {
        assertEquals("new\n\nold", appendRestoredChatDraft("new\n", "\nold"))
    }

    @Test
    fun newAgentEventAcceptsPendingSubmit() {
        assertEquals(true, observedAgentEventAcceptsPendingSubmit(PendingChatSubmitStash("hello", 4), "agent.progress", 5))
    }

    @Test
    fun oldAgentEventDoesNotAcceptPendingSubmit() {
        assertEquals(false, observedAgentEventAcceptsPendingSubmit(PendingChatSubmitStash("hello", 4), "agent.progress", 4))
    }

    @Test
    fun missingSequenceAcceptsPendingSubmit() {
        assertEquals(true, observedAgentEventAcceptsPendingSubmit(PendingChatSubmitStash("hello", 4), "agent.progress", null))
    }

    @Test
    fun inputEventAcceptsPendingSubmitWithoutNewSequence() {
        assertEquals(true, observedAgentEventAcceptsPendingSubmit(PendingChatSubmitStash("hello", 4), "agent.input", 4))
    }
}
