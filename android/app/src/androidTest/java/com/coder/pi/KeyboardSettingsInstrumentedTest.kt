package com.coder.pi

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class KeyboardSettingsInstrumentedTest {
    @Before
    fun returnToStableLauncherState() {
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressHome()
    }

    @Test
    fun applicationShortcutsAreListed() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/keyboard"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("APPLICATION SHORTCUTS")), 10_000)) { "Application shortcuts section missing" }
        check(device.hasObject(By.text("Show Shortcuts"))) { "Show Shortcuts row missing" }
        check(device.hasObject(By.text("Cmd+K"))) { "Show Shortcuts chord missing" }
        check(device.hasObject(By.text("Switch Session"))) { "Switch Session row missing" }
        check(device.hasObject(By.text("Cmd+J"))) { "Switch Session chord missing" }
        device.swipe(device.displayWidth / 2, device.displayHeight - 260, device.displayWidth / 2, 620, 12)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.text("New Connection")), 10_000)) { "New Connection row missing" }
        check(device.hasObject(By.text("Cmd+N"))) { "New Connection chord missing" }
        check(device.hasObject(By.text("Close Session"))) { "Close Session row missing" }
        check(device.hasObject(By.text("Paste"))) { "Paste row missing" }
        check(device.hasObject(By.text("Cmd+V"))) { "Paste chord missing" }
        captureDeviceScreenshot(device, "keyboard-application-shortcuts.png")
    }

    private fun captureDeviceScreenshot(device: UiDevice, name: String) {
        val directory = File("/data/local/tmp/pi-test-screenshots")
        device.executeShellCommand("mkdir -p ${directory.absolutePath}")
        device.takeScreenshot(File(directory, name))
    }
}
