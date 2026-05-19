package com.coder.pi

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShortcutEditorInstrumentedTest {
    @Before
    fun returnToStableLauncherState() {
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressHome()
    }

    @Test
    fun newShortcutSaveIsDisabledUntilShortcutIsValid() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts/add"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("MODIFIERS")), 10_000)) { "New Shortcut editor did not load" }

        val disabledSave = device.findObject(By.desc("Save")) ?: error("Save button missing")
        disabledSave.click()
        instrumentation.waitForIdleSync()
        check(device.hasObject(By.text("MODIFIERS"))) { "Invalid save should not leave editor" }

        device.findObject(By.text("Tab"))?.click() ?: error("Tab key button missing")
        instrumentation.waitForIdleSync()

        val enabledSave = device.findObject(By.desc("Save")) ?: error("Save button missing after selecting key")
        enabledSave.click()
        instrumentation.waitForIdleSync()
        check(device.wait(Until.gone(By.text("MODIFIERS")), 10_000)) { "Valid save should leave editor" }
    }
}
