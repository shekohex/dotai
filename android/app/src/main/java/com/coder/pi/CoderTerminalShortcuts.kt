package com.coder.pi

import android.view.KeyEvent

data class TerminalShortcut(val label: String, val sequence: String)

data class ShortcutRowDefinition(val sequence: String, val hint: String)

val defaultToolbarSlots = listOf("esc", "ctrl", "tab", "dpad", "copy", "shift", "alt", "paste", "undo", "chat", "keyboard")

data class ToolbarSlotDefinition(val id: String, val label: String, val removable: Boolean = true)

val toolbarSlotDefinitions = listOf(
    ToolbarSlotDefinition("esc", "Esc", false),
    ToolbarSlotDefinition("ctrl", "Ctrl", false),
    ToolbarSlotDefinition("tab", "Tab", false),
    ToolbarSlotDefinition("dpad", "D-pad", false),
    ToolbarSlotDefinition("copy", "Copy"),
    ToolbarSlotDefinition("shift", "Shift"),
    ToolbarSlotDefinition("alt", "Alt"),
    ToolbarSlotDefinition("paste", "Paste"),
    ToolbarSlotDefinition("undo", "Undo"),
    ToolbarSlotDefinition("chat", "Chat"),
    ToolbarSlotDefinition("keyboard", "Keyboard", false),
)

fun toolbarSlotLabel(id: String): String = toolbarSlotDefinitions.firstOrNull { it.id == id }?.label ?: id

fun normalizeToolbarOrder(value: String?): List<String> {
    val rawSaved = value.orEmpty().split(",").filter { it.isNotBlank() }
    val saved = rawSaved.map { if (it == "theme") "undo" else it }
    if (rawSaved.isNotEmpty() && "dpad" !in saved && (rawSaved.contains("empty") || rawSaved.contains("theme"))) return defaultToolbarSlots
    return (saved + defaultToolbarSlots).distinct().filter { slot -> defaultToolbarSlots.contains(slot) }
}

fun moveToolbarSlot(order: List<String>, slot: String, delta: Int): List<String> {
    val index = order.indexOf(slot)
    if (index < 0) return order
    val nextIndex = (index + delta).coerceIn(0, order.lastIndex)
    if (index == nextIndex) return order
    return order.toMutableList().also {
        it.removeAt(index)
        it.add(nextIndex, slot)
    }
}

fun terminalSessionKey(identity: TerminalIdentity): String = listOf(identity.baseUrl, identity.userId, identity.workspaceId, identity.agentId, identity.command).joinToString("|")

fun tmuxPrefixPreview(index: Int): String = when (index.coerceIn(0, 2)) {
    1 -> "^ a"
    2 -> "^ Space"
    else -> "^ b"
}

fun tmuxPrefixSequence(index: Int): String = when (index.coerceIn(0, 2)) {
    1 -> "\u0001"
    2 -> "\u0000"
    else -> "\u0002"
}

fun tmuxShortcutRows(prefixIndex: Int, startWindowFromOne: Boolean): List<ShortcutRowDefinition> {
    val prefix = tmuxPrefixPreview(prefixIndex)
    val firstWindow = if (startWindowFromOne) "1" else "0"
    return listOf(
        ShortcutRowDefinition("$prefix,c", "new win"),
        ShortcutRowDefinition("$prefix,n", "next"),
        ShortcutRowDefinition("$prefix,p", "prev"),
        ShortcutRowDefinition("$prefix,d", "detach"),
        ShortcutRowDefinition("$prefix,w", "windows"),
        ShortcutRowDefinition("$prefix,z", "zoom"),
        ShortcutRowDefinition("$prefix,x", "kill"),
        ShortcutRowDefinition("$prefix,$firstWindow", "first win"),
    )
}

fun shortcutPreview(ctrl: Boolean, opt: Boolean, shift: Boolean, key: String, customText: String): String {
    val modifiers = listOfNotNull(if (ctrl) "^" else null, if (opt) "⌥" else null, if (shift) "⇧" else null).joinToString("")
    return (modifiers + " " + customText.ifBlank { key }).trim()
}

fun shortcutSequence(ctrl: Boolean, opt: Boolean, shift: Boolean, key: String, customText: String): String {
    val base = customText.ifBlank {
        when (key) {
            "Esc" -> "\u001b"
            "Tab" -> "\t"
            "Enter" -> "\n"
            "⌫" -> "\u007f"
            "↑" -> "\u001b[A"
            "↓" -> "\u001b[B"
            "→" -> "\u001b[C"
            "←" -> "\u001b[D"
            "Home" -> "\u001b[H"
            "End" -> "\u001b[F"
            "PgUp" -> "\u001b[5~"
            "PgDn" -> "\u001b[6~"
            else -> ""
        }
    }
    return buildString {
        if (opt) append('\u001b')
        if (ctrl && base.length == 1) append(controlSequence(base.first())) else append(if (shift && base.length == 1) base.uppercase() else base)
    }
}

fun isShortcutInputValid(ctrl: Boolean, opt: Boolean, shift: Boolean, key: String, customText: String): Boolean = shortcutSequence(ctrl, opt, shift, key, customText).isNotEmpty()

fun hardwareShortcutLabel(keyCode: Int): String? {
    return when (keyCode) {
        KeyEvent.KEYCODE_ESCAPE -> "Esc"
        KeyEvent.KEYCODE_TAB -> "Tab"
        KeyEvent.KEYCODE_ENTER -> "Enter"
        KeyEvent.KEYCODE_DEL -> "⌫"
        KeyEvent.KEYCODE_DPAD_UP -> "↑"
        KeyEvent.KEYCODE_DPAD_DOWN -> "↓"
        KeyEvent.KEYCODE_DPAD_LEFT -> "←"
        KeyEvent.KEYCODE_DPAD_RIGHT -> "→"
        KeyEvent.KEYCODE_MOVE_HOME -> "Home"
        KeyEvent.KEYCODE_MOVE_END -> "End"
        KeyEvent.KEYCODE_PAGE_UP -> "PgUp"
        KeyEvent.KEYCODE_PAGE_DOWN -> "PgDn"
        else -> null
    }
}

fun terminalRemoteKeyBytes(keyCode: Int, unicodeChar: Int): ByteArray? {
    return when (keyCode) {
        KeyEvent.KEYCODE_ENTER -> byteArrayOf(13)
        KeyEvent.KEYCODE_DEL -> byteArrayOf(127.toByte())
        KeyEvent.KEYCODE_TAB -> byteArrayOf(9)
        KeyEvent.KEYCODE_ESCAPE -> byteArrayOf(27)
        KeyEvent.KEYCODE_DPAD_UP -> byteArrayOf(27, 91, 65)
        KeyEvent.KEYCODE_DPAD_DOWN -> byteArrayOf(27, 91, 66)
        KeyEvent.KEYCODE_DPAD_RIGHT -> byteArrayOf(27, 91, 67)
        KeyEvent.KEYCODE_DPAD_LEFT -> byteArrayOf(27, 91, 68)
        else -> if (unicodeChar > 0) unicodeChar.toChar().toString().toByteArray(Charsets.UTF_8) else null
    }
}

fun terminalModifiedKeyBytes(keyCode: Int, unicodeChar: Int, metaState: Int): ByteArray? {
    if ((metaState and KeyEvent.META_CTRL_ON) != 0) {
        terminalControlByte(keyCode)?.let {
            return (if ((metaState and KeyEvent.META_ALT_ON) != 0) byteArrayOf(0x1b) else byteArrayOf()) + byteArrayOf(it)
        }
    }
    val nextUnicodeChar = if ((metaState and KeyEvent.META_SHIFT_ON) != 0 && unicodeChar > 0) unicodeChar.toChar().uppercaseChar().code else unicodeChar
    val bytes = terminalRemoteKeyBytes(keyCode, nextUnicodeChar) ?: return null
    return (if ((metaState and KeyEvent.META_ALT_ON) != 0) byteArrayOf(0x1b) else byteArrayOf()) + bytes
}

fun terminalControlByte(char: Char): Byte? {
    return when (char) {
        in 'a'..'z' -> ((char.uppercaseChar().code - '@'.code) and 0x1f).toByte()
        in 'A'..'Z' -> ((char.code - '@'.code) and 0x1f).toByte()
        '@', ' ' -> 0x00
        '[' -> 0x1b
        '\\' -> 0x1c
        ']' -> 0x1d
        '^' -> 0x1e
        '_', '/' -> 0x1f
        '?' -> 0x7f.toByte()
        else -> null
    }
}

fun terminalControlByte(keyCode: Int): Byte? {
    return when (keyCode) {
        in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> ((keyCode - KeyEvent.KEYCODE_A + 1) and 0x1f).toByte()
        KeyEvent.KEYCODE_SPACE -> 0x00
        KeyEvent.KEYCODE_LEFT_BRACKET -> 0x1b
        KeyEvent.KEYCODE_BACKSLASH -> 0x1c
        KeyEvent.KEYCODE_RIGHT_BRACKET -> 0x1d
        KeyEvent.KEYCODE_6 -> 0x1e
        KeyEvent.KEYCODE_MINUS, KeyEvent.KEYCODE_SLASH -> 0x1f
        KeyEvent.KEYCODE_DEL -> 0x7f.toByte()
        else -> null
    }
}

fun terminalShiftedChar(char: Char): Char {
    return when (char) {
        in 'a'..'z' -> char.uppercaseChar()
        '1' -> '!'
        '2' -> '@'
        '3' -> '#'
        '4' -> '$'
        '5' -> '%'
        '6' -> '^'
        '7' -> '&'
        '8' -> '*'
        '9' -> '('
        '0' -> ')'
        '`' -> '~'
        '-' -> '_'
        '=' -> '+'
        '[' -> '{'
        ']' -> '}'
        '\\' -> '|'
        ';' -> ':'
        '\'' -> '"'
        ',' -> '<'
        '.' -> '>'
        '/' -> '?'
        else -> char
    }
}

private fun controlSequence(char: Char): Char {
    return when (char) {
        in 'a'..'z' -> ((char.uppercaseChar().code - '@'.code) and 0x1f).toChar()
        in 'A'..'Z' -> ((char.code - '@'.code) and 0x1f).toChar()
        else -> char
    }
}
