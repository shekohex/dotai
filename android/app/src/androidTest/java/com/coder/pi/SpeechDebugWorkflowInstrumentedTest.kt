package com.coder.pi

import android.content.Intent
import android.app.Instrumentation
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
        openSpeechState(context, instrumentation, "RECORDING_EMPTY")
        check(device.wait(Until.hasObject(By.desc("Finish voice input")), 10_000)) { "Recording finish action missing" }

        openSpeechState(context, instrumentation, "RECORDING_WITH_SPEECH")
        check(device.wait(Until.hasObject(By.desc("Finish voice input")), 10_000)) { "Speech-detected finish action missing" }
        check(device.wait(Until.hasObject(By.textContains("failing gradle task")), 10_000)) { "Partial transcript missing" }

        openSpeechState(context, instrumentation, "TRANSCRIBING")
        check(device.wait(Until.hasObject(By.desc("Cancel")), 10_000)) { "Transcribing cancel action missing" }

        openSpeechState(context, instrumentation, "TRANSCRIPT_READY")
        check(device.wait(Until.hasObject(By.textContains("failing Gradle task")), 10_000)) { "Transcript ready text missing" }
        captureSpeechScreenshot(device, instrumentation, "transcript-ready")

        openSpeechState(context, instrumentation, "ENHANCING_COLLAPSED")
        check(device.wait(Until.hasObject(By.desc("Original")), 10_000)) { "Enhancing original action missing" }

        openSpeechState(context, instrumentation, "ENHANCEMENT_FAILED")
        check(device.wait(Until.hasObject(By.desc("Retry")), 10_000)) { "Enhancement retry action missing" }
        check(device.wait(Until.hasObject(By.desc("Send transcript")), 10_000)) { "Send original action missing" }
        captureSpeechScreenshot(device, instrumentation, "enhancement-failed")

        openSpeechState(context, instrumentation, "ENHANCED_READY")
        check(device.wait(Until.hasObject(By.desc("Send enhanced transcript")), 10_000)) { "Enhanced send action missing" }
        check(device.wait(Until.hasObject(By.textContains("visible terminal output")), 10_000)) { "Enhanced transcript missing" }
        captureSpeechScreenshot(device, instrumentation, "enhanced-ready")

        openSpeechState(context, instrumentation, "SUBMITTED")
        check(device.wait(Until.hasObject(By.text("Reset")), 10_000)) { "Submitted reset action missing" }
    }

    private fun openSpeechState(context: android.content.Context, instrumentation: Instrumentation, state: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://debug/speech?state=$state"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        context.startActivity(intent)
        instrumentation.waitForIdleSync()
    }

    private fun captureSpeechScreenshot(device: UiDevice, instrumentation: Instrumentation, name: String) {
        val directory = File(instrumentation.context.getExternalFilesDir(null), "speech-debug")
        directory.mkdirs()
        device.takeScreenshot(File(directory, "$name.png"))
    }
}
