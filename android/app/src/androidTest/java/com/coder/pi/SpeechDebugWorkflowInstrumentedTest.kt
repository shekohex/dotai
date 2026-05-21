package com.coder.pi

import android.content.Intent
import android.net.Uri
import androidx.core.content.edit
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class SpeechDebugWorkflowInstrumentedTest {
    @Before
    fun returnToStableLauncherState() {
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressHome()
    }

    @Test
    fun debugSpeechDeepLinkDrivesTranscriptEnhancementFailureAndSuccess() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        context.getSharedPreferences("terminal", 0).edit { putBoolean("chat_auto_send", true) }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://debug/speech"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("Speech UX")), 10_000)) { "Speech debug screen did not load" }
        tapText(device, "Start")
        check(device.wait(Until.hasObject(By.text("Listening")), 10_000)) { "Recording state missing" }
        captureSpeechScreenshot(device, context, "recording")

        tapText(device, "Partial")
        check(device.wait(Until.hasObject(By.text("Listening with speech detected")), 10_000)) { "Speech-detected state missing" }
        check(device.wait(Until.hasObject(By.textContains("failing gradle task")), 10_000)) { "Partial transcript missing" }

        tapText(device, "Finalize")
        check(device.wait(Until.hasObject(By.text("Transcribing")), 10_000)) { "Transcribing state missing" }
        tapText(device, "Transcript")
        check(device.wait(Until.hasObject(By.text("Transcript ready")), 10_000)) { "Transcript ready state missing" }
        captureSpeechScreenshot(device, context, "transcript-ready")

        tapText(device, "Enhance")
        check(device.wait(Until.hasObject(By.text("Enhancing transcript")), 10_000)) { "Enhancing state missing" }
        tapText(device, "Fail")
        check(device.wait(Until.hasObject(By.text("Enhancement failed")), 10_000)) { "Enhancement failure state missing" }
        check(device.wait(Until.hasObject(By.text("Send as-is")), 10_000)) { "Send as-is action missing" }
        captureSpeechScreenshot(device, context, "enhancement-failed")
        tapText(device, "Retry")
        check(device.wait(Until.hasObject(By.text("Enhancing transcript")), 10_000)) { "Retry did not return to enhancing" }

        tapText(device, "Complete")
        check(device.wait(Until.hasObject(By.text("Enhanced transcript ready")), 10_000)) { "Enhanced ready state missing" }
        check(device.wait(Until.hasObject(By.textContains("visible terminal output")), 10_000)) { "Enhanced transcript missing" }
        captureSpeechScreenshot(device, context, "enhanced-ready")
        tapText(device, "Submit Enhanced")
        check(device.wait(Until.hasObject(By.text("Voice input submitted")), 10_000)) { "Submitted state missing" }
    }

    private fun tapText(device: UiDevice, text: String) {
        val node = device.wait(Until.findObject(By.text(text)), 10_000) ?: error("Missing UI text: $text")
        node.click()
    }

    private fun captureSpeechScreenshot(device: UiDevice, context: android.content.Context, name: String) {
        val directory = File(context.getExternalFilesDir(null), "speech-debug")
        directory.mkdirs()
        check(device.takeScreenshot(File(directory, "$name.png"))) { "Failed to capture $name screenshot" }
    }
}
