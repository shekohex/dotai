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
}
