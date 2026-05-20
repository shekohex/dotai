package com.coder.pi

import android.content.Context
import android.view.MotionEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TerminalGestureRegressionInstrumentedTest {
    private val views = mutableListOf<CoderTerminalView>()

    @After
    fun tearDown() {
        views.forEach { it.dispose() }
        views.clear()
    }

    @Test
    fun doubleTapRunsConfiguredGestureAction() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val view = terminalView(context)
        val output = mutableListOf<String>()
        view.attachRemote { output += String(it, Charsets.UTF_8) }
        view.setGestureAction("double_tap", "ctrl_c")

        instrumentation.runOnMainSync {
            view.handleTerminalTap()
            view.handleTerminalTap()
        }

        assertEquals(listOf("\u0003"), output)
    }

    @Test
    fun horizontalSwipeSendsTmuxWindowSwitch() {
        val view = terminalView(InstrumentationRegistry.getInstrumentation().targetContext)
        val output = mutableListOf<String>()
        view.attachRemote { output += String(it, Charsets.UTF_8) }
        view.setGestureAction("swipe", "switch_tmux_window")

        view.handleTerminalSwipe(-1000f, 10f)
        view.handleTerminalSwipe(1000f, 10f)

        assertEquals(listOf("\u0002n", "\u0002p"), output)
    }

    @Test
    fun mouseTrackingTapEmitsPressAndRelease() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val view = terminalView(InstrumentationRegistry.getInstrumentation().targetContext)
        val output = mutableListOf<ByteArray>()
        view.attachRemote { output += it }
        view.terminalEngine.feedOnCurrentThread("\u001b[?1000h".toByteArray())

        instrumentation.runOnMainSync {
            view.onTouchEvent(motion(MotionEvent.ACTION_DOWN, 8f, 8f))
            view.onTouchEvent(motion(MotionEvent.ACTION_UP, 8f, 8f))
        }

        assertTrue(output.size >= 2)
    }

    @Test
    fun copyModeTouchPathKeepsCopyModeActive() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val view = terminalView(InstrumentationRegistry.getInstrumentation().targetContext)
        view.setCopyModeActive(true)

        instrumentation.runOnMainSync {
            view.onTouchEvent(motion(MotionEvent.ACTION_DOWN, 8f, 8f))
            view.onTouchEvent(motion(MotionEvent.ACTION_MOVE, 16f, 16f))
            view.onTouchEvent(motion(MotionEvent.ACTION_UP, 16f, 16f))
        }

        assertTrue(view.copyModeActive())
    }

    @Test
    fun dragScrollAndPinchPathsConsumeTouchEvents() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val view = terminalView(InstrumentationRegistry.getInstrumentation().targetContext)
        view.setGestureEnabled("drag_scroll", true)
        view.setGestureAction("pinch", "adjust_font_size")

        instrumentation.runOnMainSync {
            assertTrue(view.onTouchEvent(motion(MotionEvent.ACTION_DOWN, 40f, 40f)))
            assertTrue(view.onTouchEvent(motion(MotionEvent.ACTION_MOVE, 40f, 220f)))
            assertTrue(view.onTouchEvent(motion(MotionEvent.ACTION_UP, 40f, 220f)))
            assertTrue(view.onTouchEvent(pinchMotion(MotionEvent.ACTION_POINTER_DOWN, 40f, 40f, 120f, 120f)))
            assertTrue(view.onTouchEvent(pinchMotion(MotionEvent.ACTION_MOVE, 40f, 40f, 180f, 180f)))
        }
    }

    private fun terminalView(context: Context): CoderTerminalView {
        return CoderTerminalView(context).also {
            views += it
            it.layout(0, 0, 640, 480)
            it.refreshSurface()
        }
    }

    private fun motion(action: Int, x: Float, y: Float): MotionEvent = MotionEvent.obtain(0L, android.os.SystemClock.uptimeMillis(), action, x, y, 0)

    private fun pinchMotion(action: Int, x0: Float, y0: Float, x1: Float, y1: Float): MotionEvent {
        val properties = arrayOf(MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }, MotionEvent.PointerProperties().apply { id = 1; toolType = MotionEvent.TOOL_TYPE_FINGER })
        val coords = arrayOf(MotionEvent.PointerCoords().apply { x = x0; y = y0 }, MotionEvent.PointerCoords().apply { x = x1; y = y1 })
        return MotionEvent.obtain(0L, android.os.SystemClock.uptimeMillis(), action, 2, properties, coords, 0, 0, 1f, 1f, 0, 0, 0, 0)
    }
}
