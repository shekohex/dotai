package com.coder.pi

import org.junit.Assert.assertTrue
import org.junit.Test

class DebugRenderPlaygroundTest {
    @Test
    fun debugRenderPlaygroundIncludesPiAndLegacyOscSmokeFrames() {
        val bytes = debugRenderPlaygroundBytes("Test").toString(Charsets.UTF_8)

        assertTrue(bytes.contains("\u001b]6767;pi;1;hello;"))
        assertTrue(bytes.contains("\u001b]6767;pi;1;agent.run;"))
        assertTrue(bytes.contains("\u001b]6767;pi;1;agent.progress;"))
        assertTrue(bytes.contains("\u001b]6767;pi;1;agent.tool;"))
        assertTrue(bytes.contains("\u001b]6767;pi;1;agent.alert;"))
        assertTrue(bytes.contains("\u001b]9;OSC notification smoke"))
        assertTrue(bytes.contains("\u001b]9;4;1;42"))
        assertTrue(bytes.contains("\u001b]52;c;"))
        assertTrue(bytes.contains("\u001b]777;notify;OSC 777 smoke;Legacy notification path"))
    }

    @Test
    fun debugRenderPlaygroundPiSmokeFramesDecodeAsTypedEvents() {
        val bytes = debugRenderPlaygroundBytes("Test").toString(Charsets.UTF_8)
        val frames = Regex("\\u001B]6767;pi;1;([^;]+);([^\\u001B\\u0007]+)").findAll(bytes).map { match ->
            parseTerminalOscEvent("pi\t1\t${match.groupValues[1]}\t${match.groupValues[2]}")
        }.toList()

        assertTrue(frames.any { it is TerminalOscEvent.Pi && it.eventName == "hello" })
        assertTrue(frames.any { it is TerminalOscEvent.Pi && it.eventName == "agent.run" && it.envelope.data["state"].toString() == "\"running\"" })
        assertTrue(frames.any { it is TerminalOscEvent.Pi && it.eventName == "agent.progress" && it.envelope.data["state"].toString() == "\"active\"" })
        assertTrue(frames.any { it is TerminalOscEvent.Pi && it.eventName == "agent.tool" && it.envelope.data["state"].toString() == "\"complete\"" })
        assertTrue(frames.any { it is TerminalOscEvent.Pi && it.eventName == "agent.alert" })
        assertTrue(frames.any { it is TerminalOscEvent.Pi && it.eventName == "agent.progress" && it.envelope.data["state"].toString() == "\"clear\"" })
    }
}
