package com.coder.pi

import android.content.Intent
import android.net.Uri
import android.view.KeyEvent
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
        context.getSharedPreferences("terminal", 0).edit().remove("toolbar.shortcuts").apply()
        val device = UiDevice.getInstance(instrumentation)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts/add"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("MODIFIERS")), 10_000)) { "New Shortcut editor did not load" }

        val disabledSave = device.findObject(By.desc("Save")) ?: error("Save button missing")
        captureDeviceScreenshot(device, "shortcuts-invalid-save-disabled.png")
        disabledSave.click()
        instrumentation.waitForIdleSync()
        check(device.hasObject(By.text("MODIFIERS"))) { "Invalid save should not leave editor" }
        val invalidSaved = context.getSharedPreferences("terminal", 0).getString("toolbar.shortcuts", "").orEmpty()
        check(invalidSaved.isEmpty()) { "Invalid save persisted shortcut" }

        device.findObject(By.text("Tab"))?.click() ?: error("Tab key button missing")
        instrumentation.waitForIdleSync()

        val enabledSave = device.findObject(By.desc("Save")) ?: error("Save button missing after selecting key")
        enabledSave.click()
        instrumentation.waitForIdleSync()
        check(device.wait(Until.gone(By.text("MODIFIERS")), 10_000)) { "Valid save should leave editor" }
    }

    @Test
    fun shortcutPreviewUpdatesWhileEditing() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts/add"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("MODIFIERS")), 10_000)) { "New Shortcut editor did not load" }
        device.findObject(By.text("^ Ctrl"))?.click() ?: error("Ctrl modifier missing")
        device.findObject(By.text("⇧ Shift"))?.click() ?: error("Shift modifier missing")
        device.findObject(By.text("Tab"))?.click() ?: error("Tab key button missing")
        check(device.wait(Until.hasObject(By.desc("Shortcut editor preview ^⇧ Tab")), 10_000)) { "Key preview did not update" }

        device.click(device.displayWidth / 2, (device.displayHeight * 0.63f).toInt())
        Thread.sleep(500)
        typeShortcutCommand(device, "b,c")
        Thread.sleep(500)
        check(device.wait(Until.hasObject(By.desc("Shortcut editor preview ^⇧ b,c")), 10_000)) { "Text preview did not update" }
        captureDeviceScreenshot(device, "shortcuts-editor-preview.png")
    }

    @Test
    fun visualModifierAndSpecialKeySelectionCanCreateShortcut() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        context.getSharedPreferences("terminal", 0).edit().remove("toolbar.shortcuts").apply()
        val device = UiDevice.getInstance(instrumentation)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts/add"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("MODIFIERS")), 10_000)) { "New Shortcut editor did not load" }
        check(device.hasObject(By.desc("⇧ Shift modifier not selected"))) { "Shift modifier state missing" }
        check(device.hasObject(By.desc("Tab key not selected"))) { "Tab key state missing" }
        device.findObject(By.text("⇧ Shift"))?.click() ?: error("Shift modifier missing")
        device.findObject(By.text("Tab"))?.click() ?: error("Tab key button missing")
        check(device.wait(Until.hasObject(By.desc("⇧ Shift modifier selected")), 10_000)) { "Shift modifier did not select" }
        check(device.wait(Until.hasObject(By.desc("Tab key selected")), 10_000)) { "Tab key did not select" }
        check(device.wait(Until.hasObject(By.desc("Shortcut editor preview ⇧ Tab")), 10_000)) { "Visual key preview did not update" }
        captureDeviceScreenshot(device, "shortcuts-visual-key-selection.png")

        device.findObject(By.desc("Save"))?.click() ?: error("Save button missing")
        check(device.wait(Until.gone(By.text("MODIFIERS")), 10_000)) { "Save did not leave editor" }
        val saved = context.getSharedPreferences("terminal", 0).getString("toolbar.shortcuts", "").orEmpty()
        check(saved.contains("⇧ Tab\t\u001b[Z")) { "Visual Shift+Tab shortcut did not persist terminal bytes" }
    }

    @Test
    fun customTextCanBeEnteredManually() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        context.getSharedPreferences("terminal", 0).edit().remove("toolbar.shortcuts").apply()
        val device = UiDevice.getInstance(instrumentation)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts/add"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("MODIFIERS")), 10_000)) { "New Shortcut editor did not load" }
        check(device.hasObject(By.desc("Shortcut command"))) { "Shortcut command field missing" }
        device.click(device.displayWidth / 2, (device.displayHeight * 0.63f).toInt())
        Thread.sleep(500)
        typeShortcutCommand(device, "echo hi")
        Thread.sleep(500)
        check(device.wait(Until.hasObject(By.desc("Shortcut editor preview echo hi")), 10_000)) { "Custom text preview did not update" }
        captureDeviceScreenshot(device, "shortcuts-custom-text.png")

        device.pressBack()
        check(device.wait(Until.hasObject(By.text("New Shortcut")), 10_000)) { "Shortcut editor closed before save" }
        device.findObject(By.desc("Save"))?.click() ?: error("Save button missing")
        check(device.wait(Until.gone(By.text("MODIFIERS")), 10_000)) { "Save did not leave editor" }
        val saved = context.getSharedPreferences("terminal", 0).getString("toolbar.shortcuts", "").orEmpty()
        check(saved.contains("echo hi\techo hi")) { "Custom text shortcut did not persist unchanged" }
    }

    @Test
    fun optionalHintLabelsSavedShortcut() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        context.getSharedPreferences("terminal", 0).edit().remove("toolbar.shortcuts").apply()
        val device = UiDevice.getInstance(instrumentation)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts/add"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("MODIFIERS")), 10_000)) { "New Shortcut editor did not load" }
        device.click(device.displayWidth / 2, (device.displayHeight * 0.63f).toInt())
        Thread.sleep(500)
        typeShortcutCommand(device, "echo hi")
        Thread.sleep(500)
        device.pressBack()
        check(device.wait(Until.hasObject(By.text("New Shortcut")), 10_000)) { "Shortcut editor closed before hint entry" }
        device.click(device.displayWidth / 2, (device.displayHeight * 0.75f).toInt())
        Thread.sleep(500)
        typeShortcutCommand(device, "submit")
        Thread.sleep(500)
        check(device.wait(Until.hasObject(By.text("submit")), 10_000)) { "Hint text was not entered" }
        captureDeviceScreenshot(device, "shortcuts-optional-hint.png")

        device.pressBack()
        check(device.wait(Until.hasObject(By.text("New Shortcut")), 10_000)) { "Shortcut editor closed before save" }
        device.findObject(By.desc("Save"))?.click() ?: error("Save button missing")
        check(device.wait(Until.gone(By.text("MODIFIERS")), 10_000)) { "Save did not leave editor" }
        val saved = context.getSharedPreferences("terminal", 0).getString("toolbar.shortcuts", "").orEmpty()
        check(saved.contains("submit\techo hi")) { "Hint label did not persist for shortcut" }
    }

    private fun typeShortcutCommand(device: UiDevice, text: String) {
        text.forEach { char ->
            when (char) {
                ' ' -> device.pressKeyCode(KeyEvent.KEYCODE_SPACE)
                ',' -> device.pressKeyCode(KeyEvent.KEYCODE_COMMA)
                else -> device.pressKeyCode(KeyEvent.keyCodeFromString("KEYCODE_${char.uppercaseChar()}"))
            }
        }
    }

    private fun captureDeviceScreenshot(device: UiDevice, name: String) {
        val directory = java.io.File("/data/local/tmp/pi-test-screenshots")
        device.executeShellCommand("mkdir -p ${directory.absolutePath}")
        device.takeScreenshot(java.io.File(directory, name))
    }
}
