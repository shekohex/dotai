package com.coder.pi

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import androidx.annotation.RawRes

enum class CoderThemeMode { SYSTEM, LIGHT, DARK }

data class CoderThemeOption(
    val name: String,
    val mode: CoderThemeMode,
    @RawRes val resourceId: Int,
    val palette: List<Int>,
)

data class CoderTheme(
    val name: String,
    val foreground: Int,
    val background: Int,
    val cursor: Int,
    val cursorText: Int,
    val selectionForeground: Int,
    val selectionBackground: Int,
    val palette: IntArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is CoderTheme) return false
        return name == other.name && foreground == other.foreground && background == other.background && cursor == other.cursor && cursorText == other.cursorText && selectionForeground == other.selectionForeground && selectionBackground == other.selectionBackground && palette.contentEquals(other.palette)
    }

    override fun hashCode(): Int {
        var result = name.hashCode()
        result = 31 * result + foreground
        result = 31 * result + background
        result = 31 * result + cursor
        result = 31 * result + cursorText
        result = 31 * result + selectionForeground
        result = 31 * result + selectionBackground
        result = 31 * result + palette.contentHashCode()
        return result
    }
}

object CoderThemes {
    val darkOptions = listOf(
        CoderThemeOption("Moshi", CoderThemeMode.DARK, R.raw.flexoki_dark, listOf(0x100f0f, 0xcecdc3, 0xd14d41, 0x3aa99f, 0x4385be)),
        CoderThemeOption("Dracula", CoderThemeMode.DARK, R.raw.dracula, listOf(0x282a36, 0xf8f8f2, 0xff5555, 0x50fa7b, 0xbd93f9)),
        CoderThemeOption("Nord", CoderThemeMode.DARK, R.raw.nord, listOf(0x2e3440, 0xd8dee9, 0xbf616a, 0xa3be8c, 0x81a1c1)),
        CoderThemeOption("Solarized Dark", CoderThemeMode.DARK, R.raw.solarized_dark, listOf(0x002b36, 0x839496, 0xdc322f, 0x859900, 0x268bd2)),
        CoderThemeOption("Gruvbox", CoderThemeMode.DARK, R.raw.gruvbox_dark, listOf(0x282828, 0xebdbb2, 0xcc241d, 0xd79921, 0x689d6a)),
        CoderThemeOption("Catppuccin Mocha", CoderThemeMode.DARK, R.raw.catppuccin_mocha, listOf(0x1e1e2e, 0xcdd6f4, 0xf38ba8, 0xa6e3a1, 0x89b4fa)),
    )

    val lightOptions = listOf(
        CoderThemeOption("Solarized Light", CoderThemeMode.LIGHT, R.raw.solarized_light, listOf(0xfdf6e3, 0x586e75, 0xdc322f, 0x859900, 0x268bd2)),
        CoderThemeOption("Catppuccin Latte", CoderThemeMode.LIGHT, R.raw.catppuccin_latte, listOf(0xeff1f5, 0x4c4f69, 0xd20f39, 0x40a02b, 0x1e66f5)),
        CoderThemeOption("GitHub Light", CoderThemeMode.LIGHT, R.raw.github_light, listOf(0xffffff, 0x24292f, 0xcf222e, 0x116329, 0x0969da)),
        CoderThemeOption("Rosé Pine Dawn", CoderThemeMode.LIGHT, R.raw.rose_pine_dawn, listOf(0xfffaf3, 0x575279, 0xb4637a, 0x286983, 0x56949f)),
    )

    val allOptions = darkOptions + lightOptions

    private val defaultPalette = intArrayOf(
        0x000000, 0xcc0403, 0x19cb00, 0xcecb00, 0x0d73cc, 0xcb1ed1, 0x0dcdcd, 0xdddddd,
        0x767676, 0xf2201f, 0x23fd00, 0xfffd00, 0x1a8fff, 0xfd28ff, 0x14ffff, 0xffffff,
    )

    fun mode(context: Context): CoderThemeMode {
        return when (context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getString("themeMode", "system")) {
            "light" -> CoderThemeMode.LIGHT
            "dark" -> CoderThemeMode.DARK
            else -> CoderThemeMode.SYSTEM
        }
    }

    fun setMode(context: Context, mode: CoderThemeMode) {
        val value = when (mode) {
            CoderThemeMode.SYSTEM -> "system"
            CoderThemeMode.LIGHT -> "light"
            CoderThemeMode.DARK -> "dark"
        }
        context.getSharedPreferences("terminal", Context.MODE_PRIVATE).edit().putString("themeMode", value).apply()
    }

    fun selectedThemeName(context: Context): String {
        return context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getString("themeName", null) ?: when (resolvedMode(context)) {
            CoderThemeMode.LIGHT -> "Solarized Light"
            CoderThemeMode.DARK -> "Moshi"
            CoderThemeMode.SYSTEM -> "Moshi"
        }
    }

    fun selectedOption(context: Context): CoderThemeOption {
        val selectedName = selectedThemeName(context)
        return allOptions.firstOrNull { it.name == selectedName } ?: when (resolvedMode(context)) {
            CoderThemeMode.LIGHT -> lightOptions.first()
            CoderThemeMode.DARK -> darkOptions.first()
            CoderThemeMode.SYSTEM -> darkOptions.first()
        }
    }

    fun setSelectedTheme(context: Context, option: CoderThemeOption) {
        setMode(context, option.mode)
        context.getSharedPreferences("terminal", Context.MODE_PRIVATE).edit().putString("themeName", option.name).apply()
    }

    fun nextMode(context: Context): CoderThemeMode {
        val next = when (mode(context)) {
            CoderThemeMode.SYSTEM -> CoderThemeMode.LIGHT
            CoderThemeMode.LIGHT -> CoderThemeMode.DARK
            CoderThemeMode.DARK -> CoderThemeMode.SYSTEM
        }
        setMode(context, next)
        return next
    }

    fun current(context: Context): CoderTheme {
        val option = selectedOption(context)
        return load(context, option.resourceId, option.name)
    }

    fun modeLabel(context: Context): String {
        return when (mode(context)) {
            CoderThemeMode.SYSTEM -> "SYS"
            CoderThemeMode.LIGHT -> "LGT"
            CoderThemeMode.DARK -> "DRK"
        }
    }

    private fun resolvedMode(context: Context): CoderThemeMode {
        val selectedMode = mode(context)
        if (selectedMode != CoderThemeMode.SYSTEM) return selectedMode
        val night = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return if (night == Configuration.UI_MODE_NIGHT_YES) CoderThemeMode.DARK else CoderThemeMode.LIGHT
    }

    private fun load(context: Context, @RawRes resourceId: Int, name: String): CoderTheme {
        var foreground = 0xd0d0d0
        var background = 0x101014
        var cursor = 0xe5e5e5
        var cursorText = background
        var selectionForeground = background
        var selectionBackground = foreground
        val palette = IntArray(256) { index -> if (index < defaultPalette.size) defaultPalette[index] else defaultExtendedColor(index) }
        context.resources.openRawResource(resourceId).bufferedReader().useLines { lines ->
            lines.forEach { rawLine ->
                val line = rawLine.trim()
                if (line.startsWith("#")) return@forEach
                if (line.isEmpty()) return@forEach
                val parts = line.split("=", limit = 2)
                if (parts.size != 2) return@forEach
                val key = parts[0].trim()
                val value = parts[1].trim()
                when (key) {
                    "foreground" -> foreground = parseColor(value, foreground)
                    "background" -> background = parseColor(value, background)
                    "cursor-color" -> cursor = parseColor(value, cursor)
                    "cursor-text" -> cursorText = parseColor(value, cursorText)
                    "selection-foreground" -> selectionForeground = parseColor(value, selectionForeground)
                    "selection-background" -> selectionBackground = parseColor(value, selectionBackground)
                    "palette" -> parsePalette(value, palette)
                }
            }
        }
        return CoderTheme(name, foreground, background, cursor, cursorText, selectionForeground, selectionBackground, palette)
    }

    private fun parsePalette(value: String, palette: IntArray) {
        val parts = value.split("=", limit = 2)
        if (parts.size != 2) return
        val index = parts[0].trim().toIntOrNull() ?: return
        if (index !in palette.indices) return
        palette[index] = parseColor(parts[1].trim(), palette[index])
    }

    private fun parseColor(value: String, fallback: Int): Int {
        val normalized = value.removePrefix("#")
        if (normalized.length != 6) return fallback
        return normalized.toIntOrNull(16) ?: fallback
    }

    private fun defaultExtendedColor(index: Int): Int {
        if (index in 16..231) {
            val offset = index - 16
            val r = offset / 36
            val g = (offset / 6) % 6
            val b = offset % 6
            return (cubeColor(r) shl 16) or (cubeColor(g) shl 8) or cubeColor(b)
        }
        if (index in 232..255) {
            val v = 8 + (index - 232) * 10
            return (v shl 16) or (v shl 8) or v
        }
        return Color.BLACK
    }

    private fun cubeColor(value: Int): Int {
        return if (value == 0) 0 else 55 + value * 40
    }
}
