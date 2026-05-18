package com.coder.pi

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DebugWorkflowInstrumentedTest {
    @Test
    fun debugRenderDeepLinkShowsOscDebugSurface() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pi://debug/render"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        context.startActivity(intent)
        instrumentation.waitForIdleSync()

        device.wait(Until.hasObject(By.text("DotAI OSC Maple Mono")), 5_000)
        device.wait(Until.hasObject(By.text("file://coder.example/home/coder/dotai")), 5_000)
        device.findObject(By.text("DotAI OSC Maple Mono"))?.let { check(it.visibleBounds.width() > 0) }
            ?: error("Debug render title missing")
        device.findObject(By.text("file://coder.example/home/coder/dotai"))?.let { check(it.visibleBounds.width() > 0) }
            ?: error("Debug render URI missing")
    }
}
