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
class ShortcutsOverviewInstrumentedTest {
    @Before
    fun returnToStableLauncherState() {
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressHome()
    }

    @Test
    fun shortcutsOverviewShowsPreviewTabsAndSettings() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutOverviewPrefs(context)
        val intent =
            Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("Shortcuts")), 10_000)) { "Shortcuts overview did not load" }
        check(device.hasObject(By.text("Long-press Ctrl to open the shortcuts bar. Tap Ctrl to close."))) { "Usage guidance missing" }
        check(device.hasObject(By.text("PANEL TABS"))) { "Panel tabs section missing" }
        check(device.hasObject(By.text("Favorites"))) { "Favorites tab missing" }
        check(device.hasObject(By.text("Tmux"))) { "Tmux tab missing" }
        check(device.hasObject(By.text("Ctrl"))) { "Ctrl tab missing" }
        check(device.hasObject(By.text("Pi"))) { "Pi tab missing" }
        check(device.hasObject(By.text("Tap − to hide, + to show. Drag to reorder. Tap a row to configure shortcuts."))) { "Panel tab guidance missing" }
    }

    @Test
    fun hideTabTitlesToggleUpdatesPreview() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutOverviewPrefs(context)
        val intent =
            Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 4 Favorites Tmux Ctrl Pi with titles")), 10_000)) { "Titled shortcut preview missing" }
        device.swipe(device.displayWidth / 2, device.displayHeight - 260, device.displayWidth / 2, 620, 12)
        instrumentation.waitForIdleSync()
        device.findObject(By.text("Hide Title on Tabs"))?.click() ?: error("Hide Title on Tabs setting missing")
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 4 Favorites Tmux Ctrl Pi icon only")), 10_000)) { "Icon-only shortcut preview missing" }

        context.startActivity(intent)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 4 Favorites Tmux Ctrl Pi icon only")), 10_000)) { "Icon-only shortcut preview did not persist" }
    }

    @Test
    fun panelTabToggleHidesTabFromPreviewAndPersists() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutOverviewPrefs(context)
        val intent =
            Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 4 Favorites Tmux Ctrl Pi with titles")), 10_000)) { "All active tabs preview missing" }
        device.findObject(By.desc("Hide Tmux tab"))?.click() ?: error("Tmux tab hide control missing")
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 3 Favorites Ctrl Pi with titles")), 10_000)) { "Preview did not hide disabled tab" }
        check(device.wait(Until.hasObject(By.text("INACTIVE TABS")), 10_000)) { "Inactive tabs section missing" }

        context.startActivity(intent)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 3 Favorites Ctrl Pi with titles")), 10_000)) { "Disabled tab did not persist" }
        device.findObject(By.desc("Show Tmux tab"))?.click() ?: error("Tmux tab show control missing")
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 4 Favorites Tmux Ctrl Pi with titles")), 10_000)) { "Preview did not restore enabled tab" }
    }

    @Test
    fun panelTabDragReordersPreviewAndPersists() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutOverviewPrefs(context)
        val intent =
            Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 4 Favorites Tmux Ctrl Pi with titles")), 10_000)) { "Default tab order missing" }
        val handle = device.findObject(By.desc("Move Tmux tab")) ?: error("Tmux drag handle missing")
        val bounds = handle.visibleBounds
        device.swipe(bounds.centerX(), bounds.centerY(), bounds.centerX(), bounds.centerY() + 140, 12)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 4 Favorites Ctrl Tmux Pi with titles")), 10_000)) { "Preview did not reorder tabs" }

        context.startActivity(intent)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 4 Favorites Ctrl Tmux Pi with titles")), 10_000)) { "Tab order did not persist" }
    }

    @Test
    fun resetRestoresShortcutOverviewDefaults() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        context.getSharedPreferences("terminal", 0).edit {
            putBoolean("shortcuts.hide_tab_titles", true)
            putBoolean("shortcuts.uploads_panel", false)
            putString("shortcuts.tab.order", "ctrl,tmux,favorites,pi")
            putBoolean(shortcutTabPreferenceKey("tmux"), false)
            putString("toolbar.shortcuts", "demo\t/gsd:progress")
        }
        val intent =
            Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.desc("Shortcut preview uploads hidden")), 10_000)) { "Mutated uploads state missing" }
        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 3 Ctrl Favorites Pi icon only")), 10_000)) { "Mutated tab state missing" }
        device.findObject(By.desc("Reset shortcuts"))?.click() ?: error("Reset shortcuts control missing")
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Shortcut preview uploads shown")), 10_000)) { "Uploads default not restored" }
        check(device.wait(Until.hasObject(By.desc("Shortcut preview active tabs 4 Favorites Tmux Ctrl Pi with titles")), 10_000)) { "Tab defaults not restored" }
        check(device.hasObject(By.text("0 shortcuts"))) { "Custom shortcuts were not cleared" }
    }

    @Test
    fun showUploadsPanelToggleUpdatesPreview() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        resetShortcutOverviewPrefs(context)
        val intent =
            Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.desc("Shortcut preview uploads shown")), 10_000)) { "Uploads preview missing" }
        device.swipe(device.displayWidth / 2, device.displayHeight - 260, device.displayWidth / 2, 620, 12)
        instrumentation.waitForIdleSync()
        device.findObject(By.text("Show Uploads Panel"))?.click() ?: error("Show Uploads Panel setting missing")
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Shortcut preview uploads hidden")), 10_000)) { "Uploads preview did not hide" }

        context.startActivity(intent)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Shortcut preview uploads hidden")), 10_000)) { "Uploads preview hidden state did not persist" }
    }

    @Test
    fun shortcutTogglesRenderAcrossLightAndDarkThemes() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        listOf("Solarized Light" to "shortcuts-toggles-solarized-light.png", "Dracula" to "shortcuts-toggles-dracula-dark.png").forEach { (themeName, screenshotName) ->
            val theme = CoderThemes.allOptions.first { it.name == themeName }
            CoderThemes.setSelectedTheme(context, theme)
            context.getSharedPreferences("terminal", 0).edit {
                putBoolean("shortcuts.uploads_panel", true)
                putBoolean("shortcuts.hide_tab_titles", false)
            }
            val intent =
                Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

            context.startActivity(intent)
            instrumentation.waitForIdleSync()

            check(device.wait(Until.hasObject(By.desc("Shortcut preview uploads shown")), 10_000)) { "$themeName shortcuts preview missing" }
            device.swipe(device.displayWidth / 2, device.displayHeight - 260, device.displayWidth / 2, 620, 12)
            instrumentation.waitForIdleSync()
            check(device.wait(Until.hasObject(By.text("Show Uploads Panel")), 10_000)) { "$themeName uploads toggle missing" }
            captureDeviceScreenshot(device, screenshotName)
        }
    }

    private fun captureDeviceScreenshot(
        device: UiDevice,
        name: String,
    ) {
        val directory = File("/data/local/tmp/pi-test-screenshots")
        device.executeShellCommand("mkdir -p ${directory.absolutePath}")
        device.takeScreenshot(File(directory, name))
    }

    private fun resetShortcutOverviewPrefs(context: android.content.Context) {
        context.getSharedPreferences("terminal", 0).edit {
            putBoolean("shortcuts.hide_tab_titles", false)
            putBoolean("shortcuts.uploads_panel", true)
            putString("shortcuts.tab.order", defaultShortcutTabOrder.joinToString(","))
            listOf("favorites", "tmux", "ctrl", "pi").forEach { putBoolean(shortcutTabPreferenceKey(it), true) }
        }
    }
}
