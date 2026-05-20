package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalAccessibilityTest {
    @Test
    fun accessibleLinesPreserveOriginalRowsWithLeadingBlanks() {
        val lines = terminalAccessibleLines(listOf("", "first", "second"), 3)

        assertEquals(listOf(TerminalAccessibleLine(1, "first"), TerminalAccessibleLine(2, "second")), lines)
    }

    @Test
    fun accessibleLinesPreserveOriginalRowsWithInterspersedBlanks() {
        val lines = terminalAccessibleLines(listOf("top", "", "middle   ", "", "bottom"), 5)

        assertEquals(listOf(TerminalAccessibleLine(0, "top"), TerminalAccessibleLine(2, "middle"), TerminalAccessibleLine(4, "bottom")), lines)
    }
}
