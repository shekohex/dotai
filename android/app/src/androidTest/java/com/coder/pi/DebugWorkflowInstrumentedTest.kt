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
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressHome()
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

    private fun shell(command: String): String {
        return ParcelFileDescriptor.AutoCloseInputStream(InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command))
            .bufferedReader()
            .use { it.readText() }
    }
}
