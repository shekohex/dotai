import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction
import java.net.URI
import java.util.Locale
import java.util.zip.ZipInputStream

abstract class VendorTerminalFontsTask : DefaultTask() {
    @get:Input
    abstract val fontArchives: ListProperty<String>

    @get:InputDirectory
    @get:Optional
    abstract val archiveDirectory: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun vendorFonts() {
        val archiveDir = archiveDirectory.get().asFile
        val outputDir = outputDirectory.get().dir("font").asFile
        archiveDir.mkdirs()
        outputDir.deleteRecursively()
        outputDir.mkdirs()
        fontArchives.get().forEach { spec ->
            val parts = spec.split('|')
            val family = parts[0]
            val url = parts[1]
            val includes = parts[2].split(',').toSet()
            val archive = archiveDir.resolve("$family.zip")
            if (!archive.exists()) {
                URI(url).toURL().openStream().use { input -> archive.outputStream().use(input::copyTo) }
            }
            ZipInputStream(archive.inputStream()).use { zip ->
                generateSequence { zip.nextEntry }.forEach { entry ->
                    val entryName = entry.name.substringAfterLast('/')
                    if (!entry.isDirectory && entryName in includes) {
                        val extension = entryName.substringAfterLast('.', "ttf").lowercase(Locale.US)
                        val baseName = entryName.substringBeforeLast('.')
                        val target = outputDir.resolve("${resourceFontName(family)}_${resourceFontName(baseName)}.$extension")
                        target.outputStream().use(zip::copyTo)
                    }
                    zip.closeEntry()
                }
            }
        }
    }

    private fun resourceFontName(name: String): String = name
        .replace(Regex("[^A-Za-z0-9]+"), "_")
        .replace(Regex("([a-z])([A-Z])"), "$1_$2")
        .trim('_')
        .lowercase(Locale.US)
}
