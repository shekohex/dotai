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
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        check(device.wait(Until.hasObject(By.text("PANEL TABS")), 10_000)) { "Shortcuts overview did not load" }
        val tmuxRow = device.findObjects(By.text("Tmux")).maxByOrNull { it.visibleBounds.centerY() } ?: error("Tmux tab missing")
        tmuxRow.click()

        check(device.wait(Until.hasObject(By.text("ACTIVE")), 10_000)) { "Tmux detail did not open" }
        check(device.hasObject(By.text("new win"))) { "Active tmux shortcut missing" }
        check(device.hasObject(By.text("INACTIVE"))) { "Inactive section missing" }
        check(device.hasObject(By.text("windows"))) { "Inactive tmux shortcut missing" }
    }
}
