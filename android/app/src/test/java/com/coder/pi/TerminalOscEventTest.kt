package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
    fun ignoresWarpCliAgentNotification() {
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("notification\twarp://cli-agent\t{\"agent\":\"pi\"}"))
    }

    @Test
    fun parsesProgressEvent() {
        assertEquals(TerminalOscEvent.Progress("1", "42"), parseTerminalOscEvent("progress\t1\t42"))
    }

    @Test
    fun decodesValidPiOscEnvelope() {
        val payload = "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50Iiwic2Vzc2lvbklkIjoic2Vzc2lvbi0xIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6MSwiZGF0YSI6eyJzdGF0ZSI6InJ1bm5pbmcifX0"
        val event = parseTerminalOscEvent("pi\t1\tagent.run\t$payload")

        assertTrue(event is TerminalOscEvent.Pi)
        val pi = event as TerminalOscEvent.Pi
        assertEquals(1, pi.version)
        assertEquals("agent.run", pi.eventName)
        assertEquals("evt-1", pi.envelope.id)
        assertEquals(1779200000000L, pi.envelope.ts)
        assertEquals("agent", pi.envelope.source)
        assertEquals("session-1", pi.envelope.sessionId)
        assertEquals("/workspace", pi.envelope.cwd)
        assertEquals(1L, pi.envelope.seq)
    }

    @Test
    fun decodesAgentEncoderHelloFixture() {
        val payload = "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50Iiwic2Vzc2lvbklkIjoic2Vzc2lvbi0xIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6MSwiZGF0YSI6eyJwcm90b2NvbCI6MSwiZXh0ZW5zaW9uIjoicGktb3NjIiwidmVyc2lvbiI6MX19"
        val event = parseTerminalOscEvent("pi\t1\thello\t$payload")

        assertTrue(event is TerminalOscEvent.Pi)
        val pi = event as TerminalOscEvent.Pi
        assertEquals("hello", pi.eventName)
        assertEquals("evt-1", pi.envelope.id)
        assertEquals("session-1", pi.envelope.sessionId)
        assertEquals("1", pi.envelope.data["version"].toString())
    }

    @Test
    fun decodesGoalProgressFixture() {
        val payload = "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50Iiwic2Vzc2lvbklkIjoic2Vzc2lvbi0xIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6MSwiZGF0YSI6eyJzdGF0ZSI6ImFjdGl2ZSIsImVsYXBzZWRTZWNvbmRzIjo2NX19"
        val event = parseTerminalOscEvent("pi\t1\tagent.progress\t$payload")

        assertTrue(event is TerminalOscEvent.Pi)
        val pi = event as TerminalOscEvent.Pi
        assertEquals(
            "active",
            pi.envelope.data["state"]
                ?.toString()
                ?.trim('"'),
        )
        assertEquals("65", pi.envelope.data["elapsedSeconds"].toString())
    }

    @Test
    fun dropsInvalidPiOscFrames() {
        val valid = "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50IiwiZGF0YSI6eyJzdGF0ZSI6InJ1bm5pbmcifX0"
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t2\tagent.run\t$valid"))
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t1\tagent.unknown\t$valid"))
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t1\tagent.run\tnot+base64url"))
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t1\tagent.run\te30"))
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t1\tagent.run\t${"a".repeat(8193)}"))
    }

    @Test
    fun dropsInvalidPiOscPayloadShape() {
        val missingState = "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50IiwiZGF0YSI6e319"
        val wrongSource = "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6InRlc3QiLCJkYXRhIjp7InN0YXRlIjoicnVubmluZyJ9fQ"
        val numericId = "eyJpZCI6MSwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50IiwiZGF0YSI6eyJzdGF0ZSI6InJ1bm5pbmcifX0"
        val numericSessionId = "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50Iiwic2Vzc2lvbklkIjoxLCJkYXRhIjp7InN0YXRlIjoicnVubmluZyJ9fQ"
        val stringSeq = "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50Iiwic2VxIjoiMSIsImRhdGEiOnsic3RhdGUiOiJydW5uaW5nIn19"
        val extraRoot = "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50IiwiZXh0cmEiOnRydWUsImRhdGEiOnsic3RhdGUiOiJydW5uaW5nIn19"
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t1\tagent.run\t$missingState"))
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t1\tagent.run\t$wrongSource"))
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t1\tagent.run\t$numericId"))
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t1\tagent.run\t$numericSessionId"))
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t1\tagent.run\t$stringSeq"))
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t1\tagent.run\t$extraRoot"))
    }

    @Test
    fun acceptsBlankOptionalPiOscEnvelopeFields() {
        val payload = "eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50Iiwic2Vzc2lvbklkIjoiIiwiY3dkIjoiIiwiZGF0YSI6eyJzdGF0ZSI6InJ1bm5pbmcifX0"
        val event = parseTerminalOscEvent("pi\t1\tagent.run\t$payload")

        assertTrue(event is TerminalOscEvent.Pi)
        val pi = event as TerminalOscEvent.Pi
        assertEquals("", pi.envelope.sessionId)
        assertEquals("", pi.envelope.cwd)
    }

    @Test
    fun dropsInvalidPiOscUtf8() {
        assertEquals(TerminalOscEvent.Ignored, parseTerminalOscEvent("pi\t1\tagent.run\t${"eyJpZCI6Iv8ifQ"}"))
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
