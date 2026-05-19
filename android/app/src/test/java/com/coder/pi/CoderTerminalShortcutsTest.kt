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
    fun applicationShortcutsListGlobalNavigationChords() {
        assertEquals(
            listOf("Show Shortcuts", "Switch Session", "Open Switcher", "New Connection", "Close Session", "Paste"),
            applicationShortcutDefinitions.map { it.title },
        )
        assertEquals(listOf("Cmd+K", "Cmd+J", "Cmd+O", "Cmd+N", "Cmd+W", "Cmd+V"), applicationShortcutDefinitions.map { it.chord })
    }

    @Test
    fun applicationShortcutResolverRequiresCommandModifier() {
        assertEquals("show_shortcuts", applicationShortcutIdForKey(KeyEvent.KEYCODE_K, KeyEvent.META_META_ON))
        assertEquals("paste", applicationShortcutIdForKey(KeyEvent.KEYCODE_V, KeyEvent.META_META_ON))
        assertEquals(null, applicationShortcutIdForKey(KeyEvent.KEYCODE_K, 0))
        assertEquals(null, applicationShortcutIdForKey(KeyEvent.KEYCODE_K, KeyEvent.META_CTRL_ON))
        assertEquals(null, applicationShortcutIdForKey(KeyEvent.KEYCODE_V, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON))
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
    fun piShortcutRowsIncludeBundledAgentCommands() {
        val rows = defaultShortcutRowsForReset("Pi")

        assertEquals(15, rows.size)
        assertEquals(
            listOf(
                "/gsd:new-project",
                "/gsd:new-milestone",
                "/gsd:plan-phase",
                "/gsd:execute-phase",
                "/gsd:validate-phase",
                "/gsd:secure-phase",
                "/gsd:verify-work",
                "/gsd:complete-milestone",
                "/gsd:milestone-summary",
                "/gsd:progress",
                "/gsd:debug",
                "/plannotator-review",
                "/plannotator-annotate",
                "/plannotator-archive",
                "/plannotator-last",
            ),
            rows.map { it.sequence },
        )
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
        assertEquals("echo hi", shortcutSequence(false, false, false, "", "echo hi"))
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
        assertArrayEquals(byteArrayOf(11), terminalModifiedKeyBytes(KeyEvent.KEYCODE_K, 'k'.code, KeyEvent.META_CTRL_ON))
        assertArrayEquals(byteArrayOf(27, 3), terminalModifiedKeyBytes(KeyEvent.KEYCODE_C, 'c'.code, KeyEvent.META_CTRL_ON or KeyEvent.META_ALT_ON))
        assertArrayEquals("A".toByteArray(), terminalModifiedKeyBytes(KeyEvent.KEYCODE_A, 'a'.code, KeyEvent.META_SHIFT_ON))
        assertArrayEquals(byteArrayOf(27, 9), terminalModifiedKeyBytes(KeyEvent.KEYCODE_TAB, 0, KeyEvent.META_ALT_ON))
    }

    @Test
    fun optionAsMetaStripsHardwareAltWhenDisabled() {
        assertEquals(KeyEvent.META_ALT_ON, terminalMetaStateForOptionAsMeta(KeyEvent.META_ALT_ON, true))
        assertEquals(0, terminalMetaStateForOptionAsMeta(KeyEvent.META_ALT_ON, false))
        assertEquals(KeyEvent.META_SHIFT_ON, terminalMetaStateForOptionAsMeta(KeyEvent.META_ALT_ON or KeyEvent.META_SHIFT_ON, false))
    }

    @Test
    fun autoHideToolbarRequiresHardwareKeyboardAndIdleTerminal() {
        assertEquals(true, terminalToolbarHiddenForHardwareKeyboard(true, true, false, false))
        assertEquals(false, terminalToolbarHiddenForHardwareKeyboard(false, true, false, false))
        assertEquals(false, terminalToolbarHiddenForHardwareKeyboard(true, false, false, false))
        assertEquals(false, terminalToolbarHiddenForHardwareKeyboard(true, true, true, false))
        assertEquals(false, terminalToolbarHiddenForHardwareKeyboard(true, true, false, true))
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
