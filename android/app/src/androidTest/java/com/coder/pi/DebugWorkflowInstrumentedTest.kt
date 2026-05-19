package com.coder.pi

import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DebugWorkflowInstrumentedTest {
    @Before
    fun returnToStableLauncherState() {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        dismissClipboardEditor(device)
        device.pressBack()
        device.pressHome()
    }

    @Test
    fun debugRenderDeepLinkShowsOscDebugSurface() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://debug/render"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        device.wait(Until.hasObject(By.text("DotAI OSC Maple Mono")), 10_000)
        device.wait(Until.hasObject(By.text("file://coder.example/home/coder/dotai")), 10_000)
        device.findObject(By.text("DotAI OSC Maple Mono"))?.let { check(it.visibleBounds.width() > 0) }
            ?: error("Debug render title missing")
        device.findObject(By.text("file://coder.example/home/coder/dotai"))?.let { check(it.visibleBounds.width() > 0) }
            ?: error("Debug render URI missing")
    }

    @Test
    fun debugRenderPostsOscNotificationsWhileBackgrounded() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://debug/render"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        instrumentation.uiAutomation.executeShellCommand("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS").close()
        instrumentation.uiAutomation.executeShellCommand("cmd notification cancel-all ${context.packageName}").close()
        context.startActivity(intent)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.text("DotAI OSC Maple Mono")), 10_000)) { "Debug render did not load" }

        device.pressHome()
        Thread.sleep(6_500)
        val notifications = shell("dumpsys notification --noredact")

        check(notifications.contains("OSC notification smoke")) { "OSC alert notification missing\n$notifications" }
        check(notifications.contains("terminal_osc_progress")) { "OSC progress notification missing\n$notifications" }
    }

    @Test
    fun runtimeShortcutsPanelOpensClosesAndHidesAfterShortcutTap() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://debug/render"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        dismissClipboardEditor(device)
        context.startActivity(intent)
        instrumentation.waitForIdleSync()
        dismissClipboardEditor(device)
        Thread.sleep(1_000)
        dismissClipboardEditor(device)
        context.startActivity(intent)
        instrumentation.waitForIdleSync()
        check(device.wait(Until.hasObject(By.desc("Terminal Ctrl button")), 10_000)) { "Runtime Ctrl toolbar button missing" }
        dismissClipboardEditor(device)
        check(device.wait(Until.hasObject(By.desc("Terminal Ctrl button")), 10_000)) { "Runtime Ctrl toolbar button missing after clipboard dismissal" }

        var ctrlBounds = device.findObject(By.desc("Terminal Ctrl button")).visibleBounds
        device.executeShellCommand("input swipe ${ctrlBounds.centerX()} ${ctrlBounds.centerY()} ${ctrlBounds.centerX()} ${ctrlBounds.centerY()} 1500")

        check(device.wait(Until.hasObject(By.desc("Terminal shortcuts panel")), 10_000)) { "Runtime shortcuts panel did not open" }
        val closeBounds = device.findObject(By.desc("Terminal Ctrl button")).visibleBounds
        device.executeShellCommand("input tap ${closeBounds.centerX()} ${closeBounds.centerY()}")
        Thread.sleep(500)
        device.executeShellCommand("uiautomator dump /data/local/tmp/runtime-shortcuts-panel.xml")
        val hierarchy = device.executeShellCommand("cat /data/local/tmp/runtime-shortcuts-panel.xml")
        check(!hierarchy.contains("new win")) { "Runtime shortcuts panel did not close" }

        ctrlBounds = device.findObject(By.desc("Terminal Ctrl button")).visibleBounds
        device.executeShellCommand("input swipe ${ctrlBounds.centerX()} ${ctrlBounds.centerY()} ${ctrlBounds.centerX()} ${ctrlBounds.centerY()} 1500")
        check(device.wait(Until.hasObject(By.desc("Terminal shortcut new win")), 10_000)) { "Runtime shortcut button missing" }
        val shortcutBounds = device.wait(Until.findObject(By.desc("Terminal shortcut new win")), 2_000).visibleBounds
        device.executeShellCommand("input tap ${shortcutBounds.centerX()} ${shortcutBounds.centerY()}")
        Thread.sleep(500)
        device.executeShellCommand("uiautomator dump /data/local/tmp/runtime-shortcuts-panel-after-tap.xml")
        val afterShortcutTapHierarchy = device.executeShellCommand("cat /data/local/tmp/runtime-shortcuts-panel-after-tap.xml")
        check(!afterShortcutTapHierarchy.contains("new win")) { "Runtime shortcuts panel did not hide after shortcut tap" }
    }

    private fun shell(command: String): String {
        return ParcelFileDescriptor.AutoCloseInputStream(InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command))
            .bufferedReader()
            .use { it.readText() }
    }

    private fun dismissClipboardEditor(device: UiDevice) {
        repeat(3) {
            val doneButton = device.wait(Until.findObject(By.res("com.android.systemui:id/done_button")), 2_500) ?: device.wait(Until.findObject(By.text("Done")), 500) ?: return
            val bounds = doneButton.visibleBounds
            device.executeShellCommand("input tap ${bounds.centerX()} ${bounds.centerY()}")
            if (device.wait(Until.gone(By.text("Done")), 2_000)) return
            device.pressBack()
        }
    }
}
