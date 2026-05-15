import java.net.URI
import java.util.Locale

plugins {
    alias(libs.plugins.android.application)
}

val downloadedFontArchives = layout.projectDirectory.dir("src/main/fontArchives")
val generatedFontResources = layout.buildDirectory.dir("generated/res/vendorFonts")
val downloadedBusyBox = layout.projectDirectory.dir("src/main/busybox")
val generatedBusyBoxAssets = layout.buildDirectory.dir("generated/assets/busybox")
val generatedBusyBoxJniLibs = layout.buildDirectory.dir("generated/jniLibs/busybox")
val downloadedBash = layout.projectDirectory.dir("src/main/bash")
val generatedBashJniLibs = layout.buildDirectory.dir("generated/jniLibs/bash")

data class TerminalFontArchive(val family: String, val url: String, val files: List<String>)

val terminalFonts = listOf(
    TerminalFontArchive(
        "GeistMono",
        "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/GeistMono.zip",
        listOf("GeistMonoNerdFontMono-Regular.otf"),
    ),
    TerminalFontArchive(
        "JetBrainsMono",
        "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/JetBrainsMono.zip",
        listOf("JetBrainsMonoNerdFontMono-Regular.ttf"),
    ),
    TerminalFontArchive(
        "MapleMonoNormal",
        "https://github.com/subframe7536/maple-font/releases/download/v7.9/MapleMonoNormal-TTF.zip",
        listOf("MapleMonoNormal-Regular.ttf"),
    ),
)

fun resourceFontName(name: String): String = name
    .replace(Regex("[^A-Za-z0-9]+"), "_")
    .replace(Regex("([a-z])([A-Z])"), "$1_$2")
    .trim('_')
    .lowercase(Locale.US)

val vendorTerminalFonts by tasks.registering {
    outputs.dir(generatedFontResources)
    doLast {
        val archiveDir = downloadedFontArchives.asFile
        val outputDir = generatedFontResources.get().dir("font").asFile
        archiveDir.mkdirs()
        outputDir.deleteRecursively()
        outputDir.mkdirs()
        terminalFonts.forEach { font ->
            val archive = archiveDir.resolve("${font.family}.zip")
            if (!archive.exists()) {
                URI(font.url).toURL().openStream().use { input ->
                    archive.outputStream().use { output -> input.copyTo(output) }
                }
            }
            copy {
                from(zipTree(archive))
                into(outputDir)
                include(font.files.map { "**/$it" })
                eachFile {
                    val extension = name.substringAfterLast('.', "ttf").lowercase(Locale.US)
                    val baseName = name.substringBeforeLast('.')
                    name = "${resourceFontName(font.family)}_${resourceFontName(baseName)}.$extension"
                    path = name
                }
                includeEmptyDirs = false
            }
        }
    }
}

val busyBoxBinaries = listOf(
    "arm64-v8a" to "https://dl-cdn.alpinelinux.org/alpine/v3.18/main/aarch64/busybox-static-1.36.1-r7.apk",
    "x86_64" to "https://dl-cdn.alpinelinux.org/alpine/v3.18/main/x86_64/busybox-static-1.36.1-r7.apk",
)

val vendorBusyBox by tasks.registering {
    outputs.dir(generatedBusyBoxAssets)
    outputs.dir(generatedBusyBoxJniLibs)
    doLast {
        val cacheDir = downloadedBusyBox.asFile
        val outputDir = generatedBusyBoxAssets.get().asFile
        val jniOutputDir = generatedBusyBoxJniLibs.get().asFile
        cacheDir.mkdirs()
        outputDir.deleteRecursively()
        jniOutputDir.deleteRecursively()
        busyBoxBinaries.forEach { (abi, url) ->
            val cachedArchive = cacheDir.resolve("$abi/busybox-static.apk")
            val cachedBinary = cacheDir.resolve("$abi/busybox")
            cachedArchive.parentFile.mkdirs()
            if (!cachedArchive.exists()) {
                URI(url).toURL().openStream().use { input ->
                    cachedArchive.outputStream().use { output -> input.copyTo(output) }
                }
            }
            if (!cachedBinary.exists()) {
                copy {
                    from(tarTree(resources.gzip(cachedArchive)))
                    into(cachedBinary.parentFile)
                    include("bin/busybox.static")
                    eachFile {
                        path = "busybox"
                    }
                    includeEmptyDirs = false
                }
            }
            val outputBinary = outputDir.resolve("busybox/$abi/busybox")
            outputBinary.parentFile.mkdirs()
            cachedBinary.copyTo(outputBinary, overwrite = true)
            val outputJniBinary = jniOutputDir.resolve("$abi/libbusybox.so")
            outputJniBinary.parentFile.mkdirs()
            cachedBinary.copyTo(outputJniBinary, overwrite = true)
        }
    }
}

val bashBinaries = listOf(
    "arm64-v8a" to "https://github.com/robxu9/bash-static/releases/download/5.2.015-1.2.3-2/bash-linux-aarch64",
    "x86_64" to "https://github.com/robxu9/bash-static/releases/download/5.2.015-1.2.3-2/bash-linux-x86_64",
)

val vendorBash by tasks.registering {
    outputs.dir(generatedBashJniLibs)
    doLast {
        val cacheDir = downloadedBash.asFile
        val outputDir = generatedBashJniLibs.get().asFile
        cacheDir.mkdirs()
        outputDir.deleteRecursively()
        bashBinaries.forEach { (abi, url) ->
            val cachedBinary = cacheDir.resolve("$abi/bash")
            if (!cachedBinary.exists()) {
                cachedBinary.parentFile.mkdirs()
                URI(url).toURL().openStream().use { input ->
                    cachedBinary.outputStream().use { output -> input.copyTo(output) }
                }
            }
            val outputBinary = outputDir.resolve("$abi/libbash.so")
            outputBinary.parentFile.mkdirs()
            cachedBinary.copyTo(outputBinary, overwrite = true)
        }
    }
}

android {
    namespace = "com.coder.pi"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "com.coder.pi"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    buildFeatures {
        viewBinding = false
    }
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
    sourceSets {
        getByName("main").res.srcDir(layout.buildDirectory.dir("generated/res/vendorFonts").get().asFile)
        getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/assets/busybox").get().asFile)
        getByName("main").jniLibs.srcDir(layout.buildDirectory.dir("generated/jniLibs/busybox").get().asFile)
        getByName("main").jniLibs.srcDir(layout.buildDirectory.dir("generated/jniLibs/bash").get().asFile)
    }
}

tasks.named("preBuild") {
    dependsOn(vendorTerminalFonts)
    dependsOn(vendorBusyBox)
    dependsOn(vendorBash)
}

dependencies {
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.core.ktx)
    implementation(libs.material)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
}
