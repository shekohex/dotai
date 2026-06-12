package com.coder.pi

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import androidx.annotation.RawRes
import androidx.core.content.edit

enum class CoderThemeMode { SYSTEM, LIGHT, DARK }

data class CoderThemeOption(
    val name: String,
    val mode: CoderThemeMode,
    @param:RawRes val resourceId: Int,
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
    val darkOptions =
        listOf(
            CoderThemeOption("Dracula", CoderThemeMode.DARK, R.raw.dracula, listOf(0x282a36, 0xf8f8f2, 0xff5555, 0x50fa7b, 0xbd93f9)),
            CoderThemeOption("Nord", CoderThemeMode.DARK, R.raw.nord, listOf(0x2e3440, 0xd8dee9, 0xbf616a, 0xa3be8c, 0x81a1c1)),
            CoderThemeOption("Solarized Dark", CoderThemeMode.DARK, R.raw.solarized_dark, listOf(0x002b36, 0x839496, 0xdc322f, 0x859900, 0x268bd2)),
            CoderThemeOption("Gruvbox", CoderThemeMode.DARK, R.raw.gruvbox_dark, listOf(0x282828, 0xebdbb2, 0xcc241d, 0xd79921, 0x689d6a)),
            CoderThemeOption("Catppuccin Mocha", CoderThemeMode.DARK, R.raw.catppuccin_mocha, listOf(0x1e1e2e, 0xcdd6f4, 0xf38ba8, 0xa6e3a1, 0x89b4fa)),
            CoderThemeOption("Catppuccin Frappe", CoderThemeMode.DARK, R.raw.catppuccin_frappe, listOf(0x303446, 0xc6d0f5, 0xe78284, 0xa6d189, 0x8caaee)),
            CoderThemeOption("Catppuccin Macchiato", CoderThemeMode.DARK, R.raw.catppuccin_macchiato, listOf(0x24273a, 0xcad3f5, 0xed8796, 0xa6da95, 0x8aadf4)),
            CoderThemeOption("TokyoNight Night", CoderThemeMode.DARK, R.raw.tokyonight_night, listOf(0x1a1b26, 0xc0caf5, 0xf7768e, 0x9ece6a, 0x7aa2f7)),
            CoderThemeOption("TokyoNight Storm", CoderThemeMode.DARK, R.raw.tokyonight_storm, listOf(0x24283b, 0xc0caf5, 0xf7768e, 0x9ece6a, 0x7aa2f7)),
            CoderThemeOption("Kanagawa Wave", CoderThemeMode.DARK, R.raw.kanagawa_wave, listOf(0x1f1f28, 0xdcd7ba, 0xc34043, 0x76946a, 0x7e9cd8)),
            CoderThemeOption("Kanagawa Dragon", CoderThemeMode.DARK, R.raw.kanagawa_dragon, listOf(0x181616, 0xc5c9c5, 0xc4746e, 0x8a9a7b, 0x8ba4b0)),
            CoderThemeOption("Everforest Dark Soft", CoderThemeMode.DARK, R.raw.everforest_dark_soft, listOf(0x293136, 0xd3c6aa, 0xe67e80, 0xa7c080, 0x7fbbb3)),
            CoderThemeOption("Ayu Mirage", CoderThemeMode.DARK, R.raw.ayu_mirage, listOf(0x1f2430, 0xcccac2, 0xed8274, 0x87d96c, 0x6dcbfa)),
            CoderThemeOption("One Half Dark", CoderThemeMode.DARK, R.raw.one_half_dark, listOf(0x282c34, 0xdcdfe4, 0xe06c75, 0x98c379, 0x61afef)),
            CoderThemeOption("Monokai Pro", CoderThemeMode.DARK, R.raw.monokai_pro, listOf(0x2d2a2e, 0xfcfcfa, 0xff6188, 0xa9dc76, 0xfc9867)),
            CoderThemeOption("Night Owl", CoderThemeMode.DARK, R.raw.night_owl, listOf(0x011627, 0xd6deeb, 0xef5350, 0x22da6e, 0x82aaff)),
            CoderThemeOption("Material Ocean", CoderThemeMode.DARK, R.raw.material_ocean, listOf(0x0f111a, 0x8f93a2, 0xff5370, 0xc3e88d, 0x82aaff)),
            CoderThemeOption("GitHub Dark Default", CoderThemeMode.DARK, R.raw.github_dark_default, listOf(0x0d1117, 0xe6edf3, 0xff7b72, 0x3fb950, 0x58a6ff)),
            CoderThemeOption("Rosé Pine Moon", CoderThemeMode.DARK, R.raw.rose_pine_moon, listOf(0x232136, 0xe0def4, 0xeb6f92, 0x3e8fb0, 0x9ccfd8)),
        )

    val lightOptions =
        listOf(
            CoderThemeOption("Solarized Light", CoderThemeMode.LIGHT, R.raw.solarized_light, listOf(0xfdf6e3, 0x586e75, 0xdc322f, 0x859900, 0x268bd2)),
            CoderThemeOption("Catppuccin Latte", CoderThemeMode.LIGHT, R.raw.catppuccin_latte, listOf(0xeff1f5, 0x4c4f69, 0xd20f39, 0x40a02b, 0x1e66f5)),
            CoderThemeOption("GitHub Light", CoderThemeMode.LIGHT, R.raw.github_light, listOf(0xffffff, 0x24292f, 0xcf222e, 0x116329, 0x0969da)),
            CoderThemeOption("Rosé Pine Dawn", CoderThemeMode.LIGHT, R.raw.rose_pine_dawn, listOf(0xfffaf3, 0x575279, 0xb4637a, 0x286983, 0x56949f)),
            CoderThemeOption("Everforest Light Soft", CoderThemeMode.LIGHT, R.raw.everforest_light_soft, listOf(0xe5dfc5, 0x5c6a72, 0xe67e80, 0x8da666, 0x72aea6)),
            CoderThemeOption("Ayu Light", CoderThemeMode.LIGHT, R.raw.ayu_light, listOf(0xf8f9fa, 0x5c6166, 0xea6c6d, 0x6cbf43, 0x3199e1)),
            CoderThemeOption("One Half Light", CoderThemeMode.LIGHT, R.raw.one_half_light, listOf(0xfafafa, 0x383a42, 0xe45649, 0x50a14f, 0x0184bc)),
        )

    val allOptions = darkOptions + lightOptions

    private val defaultPalette =
        intArrayOf(
            0x000000,
            0xcc0403,
            0x19cb00,
            0xcecb00,
            0x0d73cc,
            0xcb1ed1,
            0x0dcdcd,
            0xdddddd,
            0x767676,
            0xf2201f,
            0x23fd00,
            0xfffd00,
            0x1a8fff,
            0xfd28ff,
            0x14ffff,
            0xffffff,
        )

    fun mode(context: Context): CoderThemeMode =
        when (context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getString("themeMode", "system")) {
            "light" -> CoderThemeMode.LIGHT
            "dark" -> CoderThemeMode.DARK
            else -> CoderThemeMode.SYSTEM
        }

    fun setMode(
        context: Context,
        mode: CoderThemeMode,
    ) {
        val value =
            when (mode) {
                CoderThemeMode.SYSTEM -> "system"
                CoderThemeMode.LIGHT -> "light"
                CoderThemeMode.DARK -> "dark"
            }
        context.getSharedPreferences("terminal", Context.MODE_PRIVATE).edit { putString("themeMode", value) }
    }

    fun selectedThemeName(context: Context): String =
        context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getString("themeName", null) ?: when (resolvedMode(context)) {
            CoderThemeMode.LIGHT -> "Solarized Light"
            CoderThemeMode.DARK -> "Dracula"
            CoderThemeMode.SYSTEM -> "Dracula"
        }

    fun selectedOption(context: Context): CoderThemeOption {
        val selectedName = selectedThemeName(context)
        return allOptions.firstOrNull { it.name == selectedName } ?: when (resolvedMode(context)) {
            CoderThemeMode.LIGHT -> lightOptions.first()
            CoderThemeMode.DARK -> darkOptions.first()
            CoderThemeMode.SYSTEM -> darkOptions.first()
        }
    }

    fun setSelectedTheme(
        context: Context,
        option: CoderThemeOption,
    ) {
        setMode(context, option.mode)
        context.getSharedPreferences("terminal", Context.MODE_PRIVATE).edit { putString("themeName", option.name) }
    }

    fun nextMode(context: Context): CoderThemeMode {
        val next =
            when (mode(context)) {
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

    fun modeLabel(context: Context): String =
        when (mode(context)) {
            CoderThemeMode.SYSTEM -> "SYS"
            CoderThemeMode.LIGHT -> "LGT"
            CoderThemeMode.DARK -> "DRK"
        }

    private fun resolvedMode(context: Context): CoderThemeMode {
        val selectedMode = mode(context)
        if (selectedMode != CoderThemeMode.SYSTEM) return selectedMode
        val night = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return if (night == Configuration.UI_MODE_NIGHT_YES) CoderThemeMode.DARK else CoderThemeMode.LIGHT
    }

    private fun load(
        context: Context,
        @RawRes resourceId: Int,
        name: String,
    ): CoderTheme {
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

    private fun parsePalette(
        value: String,
        palette: IntArray,
    ) {
        val parts = value.split("=", limit = 2)
        if (parts.size != 2) return
        val index = parts[0].trim().toIntOrNull() ?: return
        if (index !in palette.indices) return
        palette[index] = parseColor(parts[1].trim(), palette[index])
    }

    private fun parseColor(
        value: String,
        fallback: Int,
    ): Int {
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

    private fun cubeColor(value: Int): Int = if (value == 0) 0 else 55 + value * 40
}
