package com.coder.pi

import android.content.Context
import android.net.Uri
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import java.io.File

data class CoderFontOption(
    val key: String,
    val name: String,
    val subtitle: String,
    val pro: Boolean = false,
    val resourceId: Int? = null,
    val boldResourceId: Int? = null,
    val semiBoldResourceId: Int? = null,
    val italicResourceId: Int? = null,
    val boldItalicResourceId: Int? = null,
    val file: File? = null,
)

object CoderFonts {
    private const val defaultFontKey = "jetbrains"
    private const val defaultUiFontKey = "jetbrains"

    fun builtInOptions(): List<CoderFontOption> {
        return listOf(
            CoderFontOption("jetbrains", "JetBrains Mono", "Ghostty embedded default", resourceId = R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_regular, boldResourceId = R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_bold, semiBoldResourceId = R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_semi_bold, italicResourceId = R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_italic, boldItalicResourceId = R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_bold_italic),
            CoderFontOption("geist", "Geist Mono", "Nerd Font Mono", resourceId = R.font.geist_mono_geist_mono_nerd_font_mono_regular, boldResourceId = R.font.geist_mono_geist_mono_nerd_font_mono_bold, semiBoldResourceId = R.font.geist_mono_geist_mono_nerd_font_mono_semi_bold),
            CoderFontOption("ibm_plex", "IBM Plex Mono", "Blex Nerd Font Mono", resourceId = R.font.ibmplex_mono_blex_mono_nerd_font_mono_regular, boldResourceId = R.font.ibmplex_mono_blex_mono_nerd_font_mono_bold, semiBoldResourceId = R.font.ibmplex_mono_blex_mono_nerd_font_mono_semi_bold, italicResourceId = R.font.ibmplex_mono_blex_mono_nerd_font_mono_italic, boldItalicResourceId = R.font.ibmplex_mono_blex_mono_nerd_font_mono_bold_italic),
            CoderFontOption("iosevka", "Iosevka", "Nerd Font Mono", resourceId = R.font.iosevka_iosevka_nerd_font_mono_regular, boldResourceId = R.font.iosevka_iosevka_nerd_font_mono_bold, semiBoldResourceId = R.font.iosevka_iosevka_nerd_font_mono_semi_bold, italicResourceId = R.font.iosevka_iosevka_nerd_font_mono_italic, boldItalicResourceId = R.font.iosevka_iosevka_nerd_font_mono_bold_italic),
            CoderFontOption("maple", "Maple Mono", "Normal TTF", resourceId = R.font.maple_mono_normal_maple_mono_normal_regular, boldResourceId = R.font.maple_mono_normal_maple_mono_normal_bold, semiBoldResourceId = R.font.maple_mono_normal_maple_mono_normal_semi_bold, italicResourceId = R.font.maple_mono_normal_maple_mono_normal_italic, boldItalicResourceId = R.font.maple_mono_normal_maple_mono_normal_bold_italic),
        )
    }

    fun curatedOptions(): List<CoderFontOption> {
        return listOf(
            CoderFontOption("ioskeley", "Ioskeley", "Curated font · v2.0.0-beta.1", pro = true),
            CoderFontOption("dejavu", "DejaVu Sans Mono", "Curated font · v2.37", pro = true),
            CoderFontOption("noto_jp", "Noto Sans JP", "CJK fallback · v2.004", pro = true),
            CoderFontOption("noto_sc", "Noto Sans SC", "CJK fallback · v2.004", pro = true),
            CoderFontOption("noto_tc", "Noto Sans TC", "CJK fallback · v2.004", pro = true),
        )
    }

    fun importedOptions(context: Context): List<CoderFontOption> {
        val directory = importDirectory(context)
        return directory.listFiles()
            ?.filter { it.isFile && supportedExtension(it.name) }
            ?.sortedBy { it.name.lowercase() }
            ?.map { file -> CoderFontOption("imported:${file.name}", file.nameWithoutExtension, "Imported from Files", file = file) }
            ?: emptyList()
    }

    fun allOptions(context: Context): List<CoderFontOption> {
        return builtInOptions() + importedOptions(context) + curatedOptions()
    }

    fun selectedKey(context: Context): String {
        return context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getString("fontFamily", defaultFontKey) ?: defaultFontKey
    }

    fun selectedName(context: Context): String {
        val key = selectedKey(context)
        return allOptions(context).firstOrNull { it.key == key }?.name ?: "JetBrains Mono"
    }

    fun setSelected(context: Context, key: String) {
        context.getSharedPreferences("terminal", Context.MODE_PRIVATE).edit().putString("fontFamily", key).apply()
        if (uiMatchesTerminal(context)) setSelectedUi(context, key)
    }

    fun selectedUiKey(context: Context): String {
        return context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getString("uiFontFamily", defaultUiFontKey) ?: defaultUiFontKey
    }

    fun selectedUiName(context: Context): String {
        val key = selectedUiKey(context)
        return builtInOptions().firstOrNull { it.key == key }?.name ?: "JetBrains Mono"
    }

    fun setSelectedUi(context: Context, key: String) {
        context.getSharedPreferences("terminal", Context.MODE_PRIVATE).edit().putString("uiFontFamily", key).apply()
    }

    fun uiMatchesTerminal(context: Context): Boolean = context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getBoolean("matchUiTerminalFont", true)

    fun setUiMatchesTerminal(context: Context, enabled: Boolean) {
        context.getSharedPreferences("terminal", Context.MODE_PRIVATE).edit().putBoolean("matchUiTerminalFont", enabled).apply()
        if (enabled) setSelectedUi(context, selectedKey(context))
    }

    fun uiFontFamily(context: Context, key: String = selectedUiKey(context)): FontFamily {
        val option = builtInOptions().firstOrNull { it.key == key } ?: builtInOptions().first()
        return fontFamily(option)
    }

    private fun fontFamily(option: CoderFontOption): FontFamily {
        val fonts = buildList {
            option.resourceId?.let { add(Font(it, FontWeight.Normal, FontStyle.Normal)) }
            option.boldResourceId?.let { add(Font(it, FontWeight.Bold, FontStyle.Normal)) }
            option.semiBoldResourceId?.let { add(Font(it, FontWeight.SemiBold, FontStyle.Normal)) }
            option.italicResourceId?.let { add(Font(it, FontWeight.Normal, FontStyle.Italic)) }
            option.boldItalicResourceId?.let { add(Font(it, FontWeight.Bold, FontStyle.Italic)) }
        }
        return if (fonts.isEmpty()) FontFamily.Monospace else FontFamily(fonts)
    }

    fun bytes(context: Context, key: String = selectedKey(context)): ByteArray {
        val option = allOptions(context).firstOrNull { it.key == key } ?: builtInOptions().first()
        option.file?.let { return it.readBytes() }
        val resourceId = option.resourceId ?: R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_regular
        return context.resources.openRawResource(resourceId).use { it.readBytes() }
    }

    fun importFont(context: Context, uri: Uri): CoderFontOption? {
        val name = context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (cursor.moveToFirst() && index >= 0) cursor.getString(index) else null
        } ?: "imported-font.ttf"
        if (!supportedExtension(name)) return null
        val safeName = name.replace(Regex("[^A-Za-z0-9._-]+"), "_")
        val output = importDirectory(context).resolve(safeName)
        context.contentResolver.openInputStream(uri)?.use { input ->
            output.outputStream().use { input.copyTo(it) }
        } ?: return null
        val option = CoderFontOption("imported:${output.name}", output.nameWithoutExtension, "Imported from Files", file = output)
        setSelected(context, option.key)
        return option
    }

    private fun importDirectory(context: Context): File {
        return File(context.filesDir, "fonts").apply { mkdirs() }
    }

    private fun supportedExtension(name: String): Boolean {
        val ext = name.substringAfterLast('.', "").lowercase()
        return ext in setOf("ttf", "otf", "ttc", "otc")
    }
}
