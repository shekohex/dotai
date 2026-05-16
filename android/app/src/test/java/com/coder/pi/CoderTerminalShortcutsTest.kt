package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import android.view.KeyEvent
import org.junit.Test

class CoderTerminalShortcutsTest {
    @Test
    fun normalizeToolbarOrderKeepsKnownSlotsAndAppendsMissingDefaults() {
        val order = normalizeToolbarOrder("keyboard,ctrl,unknown,tab")

        assertEquals(listOf("keyboard", "ctrl", "tab", "shift", "alt", "esc", "empty", "paste", "theme", "chat"), order)
    }

    @Test
    fun moveToolbarSlotMovesWithinBounds() {
        val order = listOf("ctrl", "esc", "tab")

        assertEquals(listOf("esc", "ctrl", "tab"), moveToolbarSlot(order, "ctrl", 1))
        assertEquals(listOf("ctrl", "esc", "tab"), moveToolbarSlot(order, "ctrl", -1))
        assertEquals(listOf("ctrl", "esc", "tab"), moveToolbarSlot(order, "tab", 1))
    }

    @Test
    fun shortcutSequenceBuildsSpecialKeys() {
        assertEquals("\u001b", shortcutSequence(false, false, false, "Esc", ""))
        assertEquals("\t", shortcutSequence(false, false, false, "Tab", ""))
        assertEquals("\u001b[A", shortcutSequence(false, false, false, "↑", ""))
    }

    @Test
    fun shortcutSequenceAppliesControlAltAndShift() {
        assertEquals("\u0003", shortcutSequence(true, false, false, "", "c"))
        assertEquals("\u001bc", shortcutSequence(false, true, false, "", "c"))
        assertEquals("C", shortcutSequence(false, false, true, "", "c"))
    }

    @Test
    fun remoteKeyBytesMapTerminalControls() {
        assertArrayEquals(byteArrayOf(13), terminalRemoteKeyBytes(KeyEvent.KEYCODE_ENTER, 0))
        assertArrayEquals(byteArrayOf(127.toByte()), terminalRemoteKeyBytes(KeyEvent.KEYCODE_DEL, 0))
        assertArrayEquals(byteArrayOf(27, 91, 65), terminalRemoteKeyBytes(KeyEvent.KEYCODE_DPAD_UP, 0))
    }

    @Test
    fun terminalControlBytesMapLettersAndSymbols() {
        assertEquals(3.toByte(), terminalControlByte('c'))
        assertEquals(27.toByte(), terminalControlByte('['))
        assertEquals(0x7f.toByte(), terminalControlByte('?'))
        assertEquals(3.toByte(), terminalControlByte(KeyEvent.KEYCODE_C))
    }

    @Test
    fun shiftedCharsMapCommonTerminalInput() {
        assertEquals('A', terminalShiftedChar('a'))
        assertEquals('!', terminalShiftedChar('1'))
        assertEquals('|', terminalShiftedChar('\\'))
    }
}
