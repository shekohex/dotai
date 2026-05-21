import java.net.URI
import java.util.Locale
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
}

val downloadedFontArchives = layout.projectDirectory.dir("src/main/fontArchives")
val generatedFontResources = layout.buildDirectory.dir("generated/res/vendorFonts")
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use(::load)
}

data class TerminalFontArchive(val family: String, val url: String, val includes: List<String>)

val terminalFonts = listOf(
    TerminalFontArchive(
        "IBMPlexMono",
        "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/IBMPlexMono.zip",
        listOf("BlexMonoNerdFontMono-Regular.ttf", "BlexMonoNerdFontMono-Bold.ttf", "BlexMonoNerdFontMono-SemiBold.ttf", "BlexMonoNerdFontMono-Italic.ttf", "BlexMonoNerdFontMono-BoldItalic.ttf"),
    ),
    TerminalFontArchive(
        "Iosevka",
        "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/Iosevka.zip",
        listOf("IosevkaNerdFontMono-Regular.ttf", "IosevkaNerdFontMono-Bold.ttf", "IosevkaNerdFontMono-SemiBold.ttf", "IosevkaNerdFontMono-Italic.ttf", "IosevkaNerdFontMono-BoldItalic.ttf"),
    ),
    TerminalFontArchive(
        "JetBrainsMono",
        "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/JetBrainsMono.zip",
        listOf("JetBrainsMonoNerdFontMono-Regular.ttf", "JetBrainsMonoNerdFontMono-Bold.ttf", "JetBrainsMonoNerdFontMono-SemiBold.ttf", "JetBrainsMonoNerdFontMono-Italic.ttf", "JetBrainsMonoNerdFontMono-BoldItalic.ttf"),
    ),
    TerminalFontArchive(
        "MapleMonoNormal",
        "https://github.com/subframe7536/maple-font/releases/download/v7.9/MapleMonoNormal-NF-unhinted.zip",
        listOf("MapleMonoNormal-NF-Regular.ttf", "MapleMonoNormal-NF-Bold.ttf", "MapleMonoNormal-NF-SemiBold.ttf", "MapleMonoNormal-NF-Italic.ttf", "MapleMonoNormal-NF-BoldItalic.ttf"),
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
                include(font.includes)
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
    }

    signingConfigs {
        create("release") {
            storeFile = file(localProperties.getProperty("releaseStoreFile", "${System.getProperty("user.home")}/.config/android/keystore.jks"))
            storePassword = localProperties.getProperty("releaseStorePassword")
            keyAlias = localProperties.getProperty("releaseKeyAlias", "upload")
            keyPassword = localProperties.getProperty("releaseKeyPassword", localProperties.getProperty("releaseStorePassword"))
        }
    }

    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
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
        compose = true
    }
    packaging {
        jniLibs {
            useLegacyPackaging = false
        }
    }
    sourceSets {
        getByName("main").res.directories.add(generatedFontResources.get().asFile.absolutePath)
    }
}

tasks.named("preBuild") {
    dependsOn(vendorTerminalFonts)
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.security.crypto)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.material)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.client.content.negotiation)
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.websockets)
    implementation(libs.ktor.serialization.kotlinx.json)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.coil.compose)
    implementation(libs.coil.svg)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.litert)
    debugImplementation(libs.androidx.compose.ui.tooling)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.uiautomator)
}
