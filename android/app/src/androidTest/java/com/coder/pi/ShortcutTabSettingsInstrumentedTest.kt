package com.coder.pi

import android.content.Intent
import android.net.Uri
import androidx.core.content.edit
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
class ShortcutTabSettingsInstrumentedTest {
    @Before
    fun returnToStableLauncherState() {
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressHome()
    }

    @Test
    fun tappingPanelTabOpensTabConfiguration() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutDetailPrefs(context)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("PANEL TABS")), 10_000)) { "Shortcuts overview did not load" }
        val favoritesRow = device.findObjects(By.text("Favorites")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Favorites tab missing")
        favoritesRow.click()

        check(device.wait(Until.hasObject(By.text("ACTIVE")), 10_000)) { "Favorites detail did not open" }
        check(device.hasObject(By.text("No active shortcuts"))) { "Favorites empty state missing" }
        check(device.hasObject(By.text("+  Add Shortcut"))) { "Add Shortcut action missing" }
        check(device.hasObject(By.text("↻  Reset"))) { "Reset action missing" }
    }

    @Test
    fun tmuxTabShowsActiveAndInactiveShortcutSections() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutDetailPrefs(context)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("PANEL TABS")), 10_000)) { "Shortcuts overview did not load" }
        val tmuxRow = device.findObjects(By.text("Tmux")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Tmux tab missing")
        tmuxRow.click()

        check(device.wait(Until.hasObject(By.text("ACTIVE")), 10_000)) { "Tmux detail did not open" }
        check(device.hasObject(By.text("new win"))) { "Active tmux shortcut missing" }
        device.swipe(device.displayWidth / 2, device.displayHeight - 260, device.displayWidth / 2, 620, 12)
        instrumentation.waitForIdleSync()
        check(device.hasObject(By.text("INACTIVE"))) { "Inactive section missing" }
    }

    @Test
    fun activeShortcutCanBeDisabledAndPersists() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutDetailPrefs(context)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("PANEL TABS")), 10_000)) { "Shortcuts overview did not load" }
        val tmuxRow = device.findObjects(By.text("Tmux")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Tmux tab missing")
        tmuxRow.click()

        check(device.wait(Until.hasObject(By.desc("Disable new win shortcut")), 10_000)) { "Disable shortcut control missing" }
        device.findObject(By.desc("Disable new win shortcut"))?.click() ?: error("Disable shortcut control missing")
        instrumentation.waitForIdleSync()
        device.swipe(device.displayWidth / 2, device.displayHeight - 260, device.displayWidth / 2, 620, 12)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Enable new win shortcut")), 10_000)) { "Disabled shortcut did not move inactive" }

        context.startActivity(intent)
        instrumentation.waitForIdleSync()
        val tmuxRowAgain = device.findObjects(By.text("Tmux")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Tmux tab missing after relaunch")
        tmuxRowAgain.click()
        device.swipe(device.displayWidth / 2, device.displayHeight - 260, device.displayWidth / 2, 620, 12)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Enable new win shortcut")), 10_000)) { "Disabled shortcut did not persist" }
        captureDeviceScreenshot(device, "shortcuts-disable-row.png")
    }

    @Test
    fun inactiveShortcutCanBeEnabledAgain() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutDetailPrefs(context)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("PANEL TABS")), 10_000)) { "Shortcuts overview did not load" }
        val tmuxRow = device.findObjects(By.text("Tmux")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Tmux tab missing")
        tmuxRow.click()

        check(device.wait(Until.hasObject(By.desc("Disable new win shortcut")), 10_000)) { "Disable shortcut control missing" }
        device.findObject(By.desc("Disable new win shortcut"))?.click() ?: error("Disable shortcut control missing")
        instrumentation.waitForIdleSync()
        device.swipe(device.displayWidth / 2, device.displayHeight - 260, device.displayWidth / 2, 620, 12)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Enable new win shortcut")), 10_000)) { "Disabled shortcut did not move inactive" }
        device.findObject(By.desc("Enable new win shortcut"))?.click() ?: error("Enable shortcut control missing")
        instrumentation.waitForIdleSync()

        context.startActivity(intent)
        instrumentation.waitForIdleSync()
        val tmuxRowAgain = device.findObjects(By.text("Tmux")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Tmux tab missing after relaunch")
        tmuxRowAgain.click()
        check(device.wait(Until.hasObject(By.desc("Disable new win shortcut")), 10_000)) { "Enabled shortcut did not persist" }
        captureDeviceScreenshot(device, "shortcuts-enable-row.png")
    }

    @Test
    fun inactiveCustomShortcutCanBeDeleted() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        context.getSharedPreferences("terminal", 0).edit { putString("toolbar.shortcuts", "demo\t/gsd:progress") }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("PANEL TABS")), 10_000)) { "Shortcuts overview did not load" }
        val favoritesRow = device.findObjects(By.text("Favorites")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Favorites tab missing")
        favoritesRow.click()

        check(device.wait(Until.hasObject(By.desc("Disable demo shortcut")), 10_000)) { "Custom shortcut disable control missing" }
        device.findObject(By.desc("Disable demo shortcut"))?.click() ?: error("Custom shortcut disable control missing")
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Delete demo shortcut")), 10_000)) { "Custom shortcut delete control missing" }
        device.findObject(By.desc("Delete demo shortcut"))?.click() ?: error("Custom shortcut delete control missing")
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.text("No active shortcuts")), 10_000)) { "Custom shortcut was not deleted" }

        context.startActivity(intent)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.text("PANEL TABS")), 10_000)) { "Shortcuts overview did not reload" }
        val favoritesRowAgain = device.findObjects(By.text("Favorites")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Favorites tab missing after relaunch")
        device.click(favoritesRowAgain.visibleBounds.centerX(), favoritesRowAgain.visibleBounds.centerY())
        check(device.wait(Until.hasObject(By.text("No active shortcuts")), 10_000)) { "Deleted custom shortcut reappeared" }
        captureDeviceScreenshot(device, "shortcuts-delete-custom-row.png")
    }

    @Test
    fun activeShortcutsCanBeReordered() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutDetailPrefs(context)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("PANEL TABS")), 10_000)) { "Shortcuts overview did not load" }
        val tmuxRow = device.findObjects(By.text("Tmux")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Tmux tab missing")
        tmuxRow.click()

        check(device.wait(Until.hasObject(By.desc("Move new win shortcut")), 10_000)) { "Shortcut drag handle missing" }
        val handle = device.findObject(By.desc("Move new win shortcut")) ?: error("Shortcut drag handle missing")
        handle.click()
        instrumentation.waitForIdleSync()
        val tmuxRows = tmuxShortcutRows(0, true)
        val savedOrder = context.getSharedPreferences("terminal", 0).getString("shortcuts.row.tmux.order", "").orEmpty()
        check(savedOrder.indexOf(shortcutRowId(tmuxRows[1])) < savedOrder.indexOf(shortcutRowId(tmuxRows[0]))) { "Shortcut order did not change" }

        context.startActivity(intent)
        instrumentation.waitForIdleSync()
        val tmuxRowAgain = device.findObjects(By.text("Tmux")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Tmux tab missing after relaunch")
        tmuxRowAgain.click()
        check(device.wait(Until.hasObject(By.desc("Move next shortcut")), 10_000)) { "Persisted next shortcut missing" }
        check(device.hasObject(By.desc("Move new win shortcut"))) { "Persisted new win shortcut missing" }
        captureDeviceScreenshot(device, "shortcuts-reorder-rows.png")
    }

    @Test
    fun tmuxPrefixSelectorUpdatesEffectivePreview() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutDetailPrefs(context)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("PANEL TABS")), 10_000)) { "Shortcuts overview did not load" }
        val tmuxRow = device.findObjects(By.text("Tmux")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Tmux tab missing")
        tmuxRow.click()

        check(device.wait(Until.hasObject(By.text("Prefix Key")), 10_000)) { "Tmux prefix setting missing" }
        check(device.hasObject(By.text("Ctrl+B"))) { "Ctrl+B option missing" }
        check(device.hasObject(By.text("Ctrl+Space"))) { "Ctrl+Space option missing" }
        val ctrlA = device.findObject(By.text("Ctrl+A")) ?: error("Ctrl+A option missing")
        if (!device.hasObject(By.text("^ a"))) {
            device.click(ctrlA.visibleBounds.centerX(), ctrlA.visibleBounds.centerY())
            check(device.wait(Until.hasObject(By.text("^ a")), 10_000)) { "Tmux prefix preview did not update" }
        }
        check(device.hasObject(By.text("^ a"))) { "Tmux prefix preview did not update" }
        check(device.wait(Until.hasObject(By.text("^ a,c")), 10_000)) { "Tmux shortcut rows did not use selected prefix" }
        captureDeviceScreenshot(device, "shortcuts-tmux-prefix.png")
    }

    @Test
    fun tmuxStartWindowFromOneToggleIsAvailable() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutDetailPrefs(context)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("PANEL TABS")), 10_000)) { "Shortcuts overview did not load" }
        val tmuxRow = device.findObjects(By.text("Tmux")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Tmux tab missing")
        tmuxRow.click()

        check(device.wait(Until.hasObject(By.text("Start window from 1")), 10_000)) { "Start window toggle missing" }
        device.findObject(By.text("Start window from 1"))?.click() ?: error("Start window toggle label missing")
        instrumentation.waitForIdleSync()
        check(device.hasObject(By.text("Start window from 1"))) { "Start window toggle disappeared" }
        captureDeviceScreenshot(device, "shortcuts-tmux-start-window.png")
    }

    private fun captureDeviceScreenshot(device: UiDevice, name: String) {
        val directory = File("/data/local/tmp/pi-test-screenshots")
        device.executeShellCommand("mkdir -p ${directory.absolutePath}")
        device.takeScreenshot(File(directory, name))
    }

    private fun resetShortcutDetailPrefs(context: android.content.Context) {
        context.getSharedPreferences("terminal", 0).edit {
            putInt("shortcuts.tmux_prefix", 0)
            putBoolean("shortcuts.tmux_start_window_from_one", true)
            remove("shortcuts.row.tmux.order")
            defaultShortcutRowsForReset("Tmux").forEach { remove(shortcutRowPreferenceKey("tmux", it)) }
        }
    }
}
