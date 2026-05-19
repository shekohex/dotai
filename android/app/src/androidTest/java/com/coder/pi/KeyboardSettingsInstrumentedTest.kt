package com.coder.pi

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.view.KeyEvent
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
        check(device.hasObject(By.text("Auto-hide Toolbar"))) { "Auto-hide Toolbar toggle missing" }
        check(device.hasObject(By.text("Option as Meta"))) { "Option as Meta toggle missing" }
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

    @Test
    fun commandKeyShortcutTriggersApplicationAction() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val terminalView = CoderTerminalView(context)
        var triggeredShortcut: String? = null
        terminalView.onApplicationShortcut = { shortcutId -> triggeredShortcut = shortcutId; true }

        val handled = terminalView.onKeyDown(KeyEvent.KEYCODE_K, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_K, 0, KeyEvent.META_META_ON))

        check(handled) { "Application shortcut key was not handled" }
        check(triggeredShortcut == "show_shortcuts") { "Cmd+K did not trigger show_shortcuts action" }
    }

    @Test
    fun terminalControlKeyDoesNotTriggerApplicationAction() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val terminalView = CoderTerminalView(context)
        var triggeredShortcut: String? = null
        terminalView.onApplicationShortcut = { shortcutId -> triggeredShortcut = shortcutId; true }

        val handled = terminalView.onKeyDown(KeyEvent.KEYCODE_K, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_K, 0, KeyEvent.META_CTRL_ON))

        check(handled) { "Terminal control key was not handled" }
        check(triggeredShortcut == null) { "Ctrl+K incorrectly triggered application shortcut" }
    }

    @Test
    fun optionAsMetaPreferenceTogglesTerminalAltMetaHandling() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val terminalView = CoderTerminalView(context)

        terminalView.setOptionAsMetaEnabled(false)
        check(terminalMetaStateForOptionAsMeta(KeyEvent.META_ALT_ON, terminalView.optionAsMetaEnabled()) == 0) { "Disabled Option as Meta kept Alt meta" }

        terminalView.setOptionAsMetaEnabled(true)
        check(terminalMetaStateForOptionAsMeta(KeyEvent.META_ALT_ON, terminalView.optionAsMetaEnabled()) == KeyEvent.META_ALT_ON) { "Enabled Option as Meta stripped Alt meta" }
    }

    @Test
    fun autoHideToolbarPreferenceControlsHardwareToolbarVisibility() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val terminalView = CoderTerminalView(context)

        terminalView.setAutoHideToolbarEnabled(true)
        check(terminalToolbarHiddenForHardwareKeyboard(terminalView.autoHideToolbarEnabled(), true, false, false)) { "Enabled auto-hide did not hide idle hardware toolbar" }
        check(!terminalToolbarHiddenForHardwareKeyboard(terminalView.autoHideToolbarEnabled(), true, true, false)) { "Auto-hide hid selection toolbar" }

        terminalView.setAutoHideToolbarEnabled(false)
        check(!terminalToolbarHiddenForHardwareKeyboard(terminalView.autoHideToolbarEnabled(), true, false, false)) { "Disabled auto-hide hid toolbar" }
    }

    @Test
    fun pasteShortcutRoutesImageClipboardToImageHandler() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val terminalView = CoderTerminalView(context)
        val imageUri = Uri.parse("content://com.coder.pi.test/image.png")
        var pastedImageUri: Uri? = null
        terminalView.onClipboardImagePaste = { uri -> pastedImageUri = uri; true }

        val handled = terminalView.pasteClip(ClipData("Image", arrayOf("image/png"), ClipData.Item(imageUri)))

        check(handled) { "Image paste shortcut was not handled" }
        check(pastedImageUri == imageUri) { "Image paste shortcut did not route clipboard image" }
    }

    private fun captureDeviceScreenshot(device: UiDevice, name: String) {
        val directory = File("/data/local/tmp/pi-test-screenshots")
        device.executeShellCommand("mkdir -p ${directory.absolutePath}")
        device.takeScreenshot(File(directory, name))
    }
}
