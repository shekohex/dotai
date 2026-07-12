package com.coder.pi

import android.content.Context
import android.net.Uri
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.core.content.edit
import java.io.File
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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
    val boldFile: File? = null,
    val semiBoldFile: File? = null,
    val italicFile: File? = null,
    val boldItalicFile: File? = null,
)

data class CoderDownloadableFontFace(
    val fileName: String,
    val url: String,
    val sha256: String,
)

data class CoderDownloadableFont(
    val key: String,
    val name: String,
    val subtitle: String,
    val faces: List<CoderDownloadableFontFace>,
)

object CoderFonts {
    private const val defaultFontKey = "jetbrains"
    private const val defaultUiFontKey = "jetbrains"

    fun builtInOptions(): List<CoderFontOption> =
        listOf(
            CoderFontOption("jetbrains", "JetBrains Mono", "Ghostty embedded default", resourceId = R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_regular, boldResourceId = R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_bold, semiBoldResourceId = R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_semi_bold, italicResourceId = R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_italic, boldItalicResourceId = R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_bold_italic),
            CoderFontOption("maple", "Maple Mono", "Nerd Font", resourceId = R.font.maple_mono_normal_maple_mono_normal_nf_regular, boldResourceId = R.font.maple_mono_normal_maple_mono_normal_nf_bold, semiBoldResourceId = R.font.maple_mono_normal_maple_mono_normal_nf_semi_bold, italicResourceId = R.font.maple_mono_normal_maple_mono_normal_nf_italic, boldItalicResourceId = R.font.maple_mono_normal_maple_mono_normal_nf_bold_italic),
        )

    fun downloadableOptions(): List<CoderDownloadableFont> =
        listOf(
            CoderDownloadableFont(
                key = "iosevka",
                name = "Iosevka",
                subtitle = "Nerd Font Mono · 66.6 MB · 5 faces",
                faces =
                    listOf(
                        downloadableFace("regular.ttf", "Iosevka/IosevkaNerdFontMono-Regular.ttf", "208be07f3155b7f1d0b33deaff4d675ae1fa1f59fb7d660b39279e21bcecf06a"),
                        downloadableFace("bold.ttf", "Iosevka/IosevkaNerdFontMono-Bold.ttf", "1b3db498468f655d9043ebbc1e29b5f822f415dc5817af9dc0e42843d0a4ed53"),
                        downloadableFace("semibold.ttf", "Iosevka/IosevkaNerdFontMono-SemiBold.ttf", "84b0cd84b5294d8f499937be61785bcf3db269d3a1db8bd933e511c1f4eb20c0"),
                        downloadableFace("italic.ttf", "Iosevka/IosevkaNerdFontMono-Italic.ttf", "013bc2aae933f17596ee1975575d240c6cb47c11421b81993188bef6d5bd37d5"),
                        downloadableFace("bolditalic.ttf", "Iosevka/IosevkaNerdFontMono-BoldItalic.ttf", "c533c954b90bc04abe2b672056cf232bd4d6f14bf7d3e8c78ef0f670585964b0"),
                    ),
            ),
            CoderDownloadableFont(
                key = "ibm_plex",
                name = "IBM Plex Mono",
                subtitle = "Blex Nerd Font Mono · 11.8 MB · 5 faces",
                faces =
                    listOf(
                        downloadableFace("regular.ttf", "IBMPlexMono/Mono/BlexMonoNerdFontMono-Regular.ttf", "f9892505b7cd6e9d29f9ba0924da73df023714adf6dbe6d8f920d47b8930fcef"),
                        downloadableFace("bold.ttf", "IBMPlexMono/Mono/BlexMonoNerdFontMono-Bold.ttf", "565b42d837b5121627d57cfd57338be32254c58a1b770468c3380b1f78de2aa4"),
                        downloadableFace("semibold.ttf", "IBMPlexMono/Mono/BlexMonoNerdFontMono-SemiBold.ttf", "60a312cc1d45560fcd1cd978b73b324fc7f2c971e85a8355802834fddb7dfe69"),
                        downloadableFace("italic.ttf", "IBMPlexMono/Mono/BlexMonoNerdFontMono-Italic.ttf", "d7d5547a0e4497ea7001290290731a455b9a859281fa509c4ff41a0df36bdd24"),
                        downloadableFace("bolditalic.ttf", "IBMPlexMono/Mono/BlexMonoNerdFontMono-BoldItalic.ttf", "a5ab684a844ba62bcbdb0d7d0f75325396d2a78affea717fb533ac3a3a22f976"),
                    ),
            ),
        )

    fun curatedOptions(): List<CoderFontOption> =
        listOf(
            CoderFontOption("ioskeley", "Ioskeley", "Curated font · v2.0.0-beta.1", pro = true),
            CoderFontOption("dejavu", "DejaVu Sans Mono", "Curated font · v2.37", pro = true),
            CoderFontOption("noto_jp", "Noto Sans JP", "CJK fallback · v2.004", pro = true),
            CoderFontOption("noto_sc", "Noto Sans SC", "CJK fallback · v2.004", pro = true),
            CoderFontOption("noto_tc", "Noto Sans TC", "CJK fallback · v2.004", pro = true),
        )

    fun importedOptions(context: Context): List<CoderFontOption> {
        val directory = importDirectory(context)
        return directory
            .listFiles()
            ?.filter { it.isFile && supportedExtension(it.name) }
            ?.sortedBy { it.name.lowercase() }
            ?.map { file -> CoderFontOption("imported:${file.name}", file.nameWithoutExtension, "Imported from Files", file = file) }
            ?: emptyList()
    }

    fun downloadedOptions(context: Context): List<CoderFontOption> =
        downloadableOptions().mapNotNull { option ->
            downloadedFontDirectory(context, option.key).takeIf { directory -> option.faces.all { directory.resolve(it.fileName).isFile } }?.let { directory ->
                CoderFontOption(
                    key = option.key,
                    name = option.name,
                    subtitle = "Downloaded",
                    file = directory.resolve("regular.ttf"),
                    boldFile = directory.resolve("bold.ttf"),
                    semiBoldFile = directory.resolve("semibold.ttf"),
                    italicFile = directory.resolve("italic.ttf"),
                    boldItalicFile = directory.resolve("bolditalic.ttf"),
                )
            }
        }

    fun allOptions(context: Context): List<CoderFontOption> = builtInOptions() + downloadedOptions(context) + importedOptions(context) + curatedOptions()

    fun isDownloaded(
        context: Context,
        key: String,
    ): Boolean = downloadableOptions().firstOrNull { it.key == key }?.let { option -> option.faces.all { downloadedFontDirectory(context, key).resolve(it.fileName).isFile } } == true

    suspend fun download(
        context: Context,
        option: CoderDownloadableFont,
        onProgress: (Int) -> Unit = {},
    ): CoderFontOption =
        withContext(Dispatchers.IO) {
            val target = downloadedFontDirectory(context, option.key)
            val temporary = File(target.parentFile, "${target.name}.download")
            target.parentFile?.mkdirs()
            temporary.deleteRecursively()
            temporary.mkdirs()
            try {
                option.faces.forEachIndexed { index, face ->
                    val output = temporary.resolve(face.fileName)
                    downloadFontFace(face, output) { faceProgress ->
                        onProgress(((index * 100) + faceProgress) / option.faces.size)
                    }
                }
                target.deleteRecursively()
                check(temporary.renameTo(target)) { "Could not install downloaded font" }
                onProgress(100)
                downloadedOptions(context).first { it.key == option.key }
            } catch (error: Throwable) {
                temporary.deleteRecursively()
                throw error
            }
        }

    fun deleteDownload(
        context: Context,
        key: String,
    ): Boolean {
        val deleted = downloadedFontDirectory(context, key).deleteRecursively()
        if (selectedKey(context) == key) setSelected(context, defaultFontKey)
        if (selectedUiKey(context) == key) setSelectedUi(context, defaultUiFontKey)
        return deleted
    }

    fun selectedKey(context: Context): String = context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getString("fontFamily", defaultFontKey) ?: defaultFontKey

    fun selectedName(context: Context): String {
        val key = selectedKey(context)
        return allOptions(context).firstOrNull { it.key == key }?.name ?: "JetBrains Mono"
    }

    fun setSelected(
        context: Context,
        key: String,
    ) {
        context.getSharedPreferences("terminal", Context.MODE_PRIVATE).edit { putString("fontFamily", key) }
        if (uiMatchesTerminal(context)) setSelectedUi(context, key)
    }

    fun selectedUiKey(context: Context): String = context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getString("uiFontFamily", defaultUiFontKey) ?: defaultUiFontKey

    fun selectedUiName(context: Context): String {
        val key = selectedUiKey(context)
        return builtInOptions().firstOrNull { it.key == key }?.name ?: "JetBrains Mono"
    }

    fun setSelectedUi(
        context: Context,
        key: String,
    ) {
        context.getSharedPreferences("terminal", Context.MODE_PRIVATE).edit { putString("uiFontFamily", key) }
    }

    fun uiMatchesTerminal(context: Context): Boolean = context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getBoolean("matchUiTerminalFont", true)

    fun setUiMatchesTerminal(
        context: Context,
        enabled: Boolean,
    ) {
        context.getSharedPreferences("terminal", Context.MODE_PRIVATE).edit { putBoolean("matchUiTerminalFont", enabled) }
        if (enabled) setSelectedUi(context, selectedKey(context))
    }

    fun uiFontFamily(
        context: Context,
        key: String = selectedUiKey(context),
    ): FontFamily {
        val option = builtInOptions().firstOrNull { it.key == key } ?: builtInOptions().first()
        return fontFamily(option)
    }

    private fun fontFamily(option: CoderFontOption): FontFamily {
        val fonts =
            buildList {
                option.resourceId?.let { add(Font(it, FontWeight.Normal, FontStyle.Normal)) }
                option.boldResourceId?.let { add(Font(it, FontWeight.Bold, FontStyle.Normal)) }
                option.semiBoldResourceId?.let { add(Font(it, FontWeight.SemiBold, FontStyle.Normal)) }
                option.italicResourceId?.let { add(Font(it, FontWeight.Normal, FontStyle.Italic)) }
                option.boldItalicResourceId?.let { add(Font(it, FontWeight.Bold, FontStyle.Italic)) }
            }
        return if (fonts.isEmpty()) FontFamily.Monospace else FontFamily(fonts)
    }

    fun bytes(
        context: Context,
        key: String = selectedKey(context),
    ): ByteArray {
        val option = allOptions(context).firstOrNull { it.key == key } ?: builtInOptions().first()
        option.file?.let { return it.readBytes() }
        val resourceId = option.resourceId ?: R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_regular
        return context.resources.openRawResource(resourceId).use { it.readBytes() }
    }

    fun styleBytes(
        context: Context,
        key: String = selectedKey(context),
    ): CoderFontBytes {
        val option = allOptions(context).firstOrNull { it.key == key } ?: builtInOptions().first()

        fun readResource(resourceId: Int?): ByteArray? = resourceId?.let { context.resources.openRawResource(it).use { input -> input.readBytes() } }
        val fallback = readResource(R.font.jet_brains_mono_jet_brains_mono_nerd_font_mono_regular)
        option.file?.let { regularFile ->
            return CoderFontBytes(
                regularFile.readBytes(),
                (option.boldFile ?: option.semiBoldFile)?.takeIf(File::isFile)?.readBytes(),
                option.italicFile?.takeIf(File::isFile)?.readBytes(),
                option.boldItalicFile?.takeIf(File::isFile)?.readBytes(),
                fallback,
            )
        }
        val regular = readResource(option.resourceId) ?: bytes(context, key)
        return CoderFontBytes(regular, readResource(option.boldResourceId ?: option.semiBoldResourceId), readResource(option.italicResourceId), readResource(option.boldItalicResourceId), fallback)
    }

    fun importFont(
        context: Context,
        uri: Uri,
    ): CoderFontOption? {
        val name =
            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
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

    private fun importDirectory(context: Context): File = File(context.filesDir, "fonts").apply { mkdirs() }

    private fun downloadedFontDirectory(
        context: Context,
        key: String,
    ): File = File(File(context.filesDir, "downloaded-fonts"), key)

    private fun supportedExtension(name: String): Boolean {
        val ext = name.substringAfterLast('.', "").lowercase()
        return ext in setOf("ttf", "otf", "ttc", "otc")
    }
}

private fun downloadableFace(
    fileName: String,
    repositoryPath: String,
    sha256: String,
): CoderDownloadableFontFace =
    CoderDownloadableFontFace(
        fileName = fileName,
        url = "https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/$repositoryPath",
        sha256 = sha256,
    )

private fun downloadFontFace(
    face: CoderDownloadableFontFace,
    output: File,
    onProgress: (Int) -> Unit,
) {
    val connection = URL(face.url).openConnection().apply { connectTimeout = 15_000; readTimeout = 30_000 }
    val total = connection.contentLengthLong
    connection.getInputStream().use { input ->
        output.outputStream().use { destination ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var downloaded = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                destination.write(buffer, 0, count)
                downloaded += count
                if (total > 0) onProgress(((downloaded * 100L) / total).toInt().coerceIn(0, 100))
            }
        }
    }
    check(output.sha256() == face.sha256) { "Downloaded font checksum mismatch for ${face.fileName}" }
}

private fun File.sha256(): String {
    val digest = MessageDigest.getInstance("SHA-256")
    inputStream().use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
    }
    return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
}

data class CoderFontBytes(
    val regular: ByteArray,
    val bold: ByteArray?,
    val italic: ByteArray?,
    val boldItalic: ByteArray?,
    val fallback: ByteArray?,
)
