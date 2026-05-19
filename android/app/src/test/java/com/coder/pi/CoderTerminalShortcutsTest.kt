package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import android.view.KeyEvent
import org.junit.Test

class CoderTerminalShortcutsTest {
    @Test
    fun normalizeToolbarOrderKeepsKnownSlotsAndAppendsMissingDefaults() {
        val order = normalizeToolbarOrder("keyboard,ctrl,unknown,tab")

        assertEquals(listOf("keyboard", "ctrl", "tab", "esc", "dpad", "copy", "shift", "alt", "paste", "undo", "chat"), order)
    }

    @Test
    fun normalizeToolbarOrderMigratesLegacyDefaultOrder() {
        val order = normalizeToolbarOrder("esc,tab,ctrl,empty,paste,theme,chat,keyboard")

        assertEquals(defaultToolbarSlots, order)
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
    fun shortcutPreviewReflectsModifiersKeysAndText() {
        assertEquals("Tab", shortcutPreview(false, false, false, "Tab", ""))
        assertEquals("^⇧ Tab", shortcutPreview(true, false, true, "Tab", ""))
        assertEquals("^ b,c", shortcutPreview(true, false, false, "", "b,c"))
    }

    @Test
    fun shortcutInputValidityRequiresTerminalOutput() {
        assertEquals(false, isShortcutInputValid(false, false, false, "", ""))
        assertEquals(false, isShortcutInputValid(true, false, false, "", ""))
        assertEquals(true, isShortcutInputValid(false, false, false, "Tab", ""))
        assertEquals(true, isShortcutInputValid(false, false, false, "", "/gsd:progress"))
    }

    @Test
    fun defaultShortcutTabsApplyActiveLookup() {
        val tabs = defaultShortcutTabs(2) { it != "tmux" }

        assertEquals(listOf("favorites", "tmux", "ctrl", "pi"), tabs.map { it.id })
        assertEquals("2 shortcuts", tabs.first().subtitle)
        assertEquals(false, tabs.first { it.id == "tmux" }.active)
        assertEquals(true, tabs.first { it.id == "ctrl" }.active)
    }

    @Test
    fun shortcutTabOrderNormalizesAndMovesKnownTabs() {
        assertEquals(listOf("tmux", "favorites", "ctrl", "pi"), normalizeShortcutTabOrder("tmux,favorites,unknown"))
        assertEquals(listOf("favorites", "ctrl", "tmux", "pi"), moveShortcutTab(defaultShortcutTabOrder, "tmux", 1))
        assertEquals(defaultShortcutTabOrder, moveShortcutTab(defaultShortcutTabOrder, "favorites", -1))
    }

    @Test
    fun shortcutTabPreferenceKeysAreStable() {
        assertEquals("shortcuts.tab.tmux.active", shortcutTabPreferenceKey("tmux"))
        assertEquals(listOf("favorites", "tmux", "ctrl", "pi"), defaultShortcutTabOrder)
    }

    @Test
    fun shortcutRowPreferenceKeyIncludesTabAndSequence() {
        assertEquals("shortcuts.row.tmux.${"^ b,c".hashCode()}.active", shortcutRowPreferenceKey("tmux", ShortcutRowDefinition("^ b,c", "new win")))
    }

    @Test
    fun shortcutRowOrderNormalizesAndMoves() {
        val rows = tmuxShortcutRows(0, true).take(3)
        val ids = rows.map(::shortcutRowId)

        assertEquals(listOf(ids[1], ids[0], ids[2]), normalizeShortcutRowOrder("${ids[1]},${ids[0]}", rows))
        assertEquals(listOf(ids[1], ids[0], ids[2]), moveShortcutRow(ids, ids[0], 1))
    }

    @Test
    fun shortcutRowDefinitionsCanRepresentCustomShortcuts() {
        val shortcut = TerminalShortcut("demo", "/gsd:progress")

        assertEquals(ShortcutRowDefinition("/gsd:progress", "demo"), ShortcutRowDefinition(shortcut.sequence, shortcut.label))
    }

    @Test
    fun tmuxShortcutRowsFollowPrefixAndWindowNumbering() {
        assertEquals("^ b,c", tmuxShortcutRows(0, true).first().sequence)
        assertEquals("^ a,c", tmuxShortcutRows(1, true).first().sequence)
        assertEquals("^ Space,c", tmuxShortcutRows(2, true).first().sequence)
        assertEquals("^ b,1", tmuxShortcutRows(0, true).last().sequence)
        assertEquals("^ b,0", tmuxShortcutRows(0, false).last().sequence)
    }

    @Test
    fun tmuxPrefixSequenceMapsConfiguredPrefixBytes() {
        assertEquals("\u0002", tmuxPrefixSequence(0))
        assertEquals("\u0001", tmuxPrefixSequence(1))
        assertEquals("\u0000", tmuxPrefixSequence(2))
    }

    @Test
    fun shortcutSequenceAppliesControlAltAndShift() {
        assertEquals("\u0003", shortcutSequence(true, false, false, "", "c"))
        assertEquals("\u001bc", shortcutSequence(false, true, false, "", "c"))
        assertEquals("C", shortcutSequence(false, false, true, "", "c"))
    }

    @Test
    fun shortcutSequenceBuildsMultiStepKeySequences() {
        assertEquals("\u0002c", shortcutSequence(true, false, false, "", "b,c"))
        assertEquals("\u001b[Z", shortcutSequence(false, false, true, "Tab", ""))
    }

    @Test
    fun remoteKeyBytesMapTerminalControls() {
        assertArrayEquals(byteArrayOf(13), terminalRemoteKeyBytes(KeyEvent.KEYCODE_ENTER, 0))
        assertArrayEquals(byteArrayOf(127.toByte()), terminalRemoteKeyBytes(KeyEvent.KEYCODE_DEL, 0))
        assertArrayEquals(byteArrayOf(27, 91, 65), terminalRemoteKeyBytes(KeyEvent.KEYCODE_DPAD_UP, 0))
    }

    @Test
    fun modifiedKeyBytesApplyCtrlShiftAndAlt() {
        assertArrayEquals(byteArrayOf(3), terminalModifiedKeyBytes(KeyEvent.KEYCODE_C, 'c'.code, KeyEvent.META_CTRL_ON))
        assertArrayEquals(byteArrayOf(27, 3), terminalModifiedKeyBytes(KeyEvent.KEYCODE_C, 'c'.code, KeyEvent.META_CTRL_ON or KeyEvent.META_ALT_ON))
        assertArrayEquals("A".toByteArray(), terminalModifiedKeyBytes(KeyEvent.KEYCODE_A, 'a'.code, KeyEvent.META_SHIFT_ON))
        assertArrayEquals(byteArrayOf(27, 9), terminalModifiedKeyBytes(KeyEvent.KEYCODE_TAB, 0, KeyEvent.META_ALT_ON))
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
