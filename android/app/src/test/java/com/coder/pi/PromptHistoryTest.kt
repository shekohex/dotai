package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Test

class PromptHistoryTest {
    @Test
    fun newestDuplicateReplacesOlderEntryAndRetentionApplies() {
        val existing =
            listOf(
                PromptHistoryEntry("old-a", "same", 1, "workspace", terminalId = "terminal"),
                PromptHistoryEntry("b", "different", 2),
                PromptHistoryEntry("c", "third", 3),
            )

        val result = prependPromptHistory(existing, PromptHistoryEntry("new-a", "same", 4, "workspace", terminalId = "terminal"), 2)

        assertEquals(listOf("new-a", "b"), result.map { it.id })
    }

    @Test
    fun filterSupportsTextWorkspaceAndTerminal() {
        val entries =
            listOf(
                PromptHistoryEntry("a", "Fix speech input", 1, "one", "Alpha", "terminal-a"),
                PromptHistoryEntry("b", "Run tests", 2, "two", "Beta", "terminal-b"),
            )

        assertEquals(listOf("a"), filterPromptHistory(entries, "speech").map { it.id })
        assertEquals(listOf("b"), filterPromptHistory(entries, "Beta").map { it.id })
        assertEquals(listOf("a"), filterPromptHistory(entries, "", workspaceId = "one").map { it.id })
        assertEquals(listOf("b"), filterPromptHistory(entries, "", terminalId = "terminal-b").map { it.id })
    }
}
