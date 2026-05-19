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
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://settings/shortcuts"), context, MainActivity::class.java)
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
}
