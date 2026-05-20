package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalOscEventTest {
    @Test
    fun parsesClipboardEvent() {
        assertEquals(TerminalOscEvent.Clipboard("c", "SGVsbG8="), parseTerminalOscEvent("clipboard\tc\tSGVsbG8="))
    }

    @Test
    fun parsesNotificationEvent() {
        assertEquals(TerminalOscEvent.Notification("title", "body"), parseTerminalOscEvent("notification\ttitle\tbody"))
    }

    @Test
    fun parsesProgressEvent() {
        assertEquals(TerminalOscEvent.Progress("1", "42"), parseTerminalOscEvent("progress\t1\t42"))
    }

    @Test
    fun parsesPiPlaceholderEvent() {
        assertEquals(TerminalOscEvent.Pi("hello", "payload"), parseTerminalOscEvent("pi\thello\tpayload"))
    }

    @Test
    fun keepsPiPayloadBase64urlText() {
        val payload = "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50IiwiZGF0YSI6e319"
        assertEquals(TerminalOscEvent.Pi("agent.run", payload), parseTerminalOscEvent("pi\tagent.run\t$payload"))
    }

    @Test
    fun ignoresUnknownEvents() {
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("unknown\tx\ty"))
        assertEquals(emptyList<TerminalOscEvent>(), arrayOf("unknown\tx\ty").toTerminalOscEvents())
    }

    @Test
    fun preservesTabsInsideLastField() {
        assertEquals(TerminalOscEvent.Notification("title", "body\twith\ttabs"), parseTerminalOscEvent("notification\ttitle\tbody\twith\ttabs"))
    }
}
