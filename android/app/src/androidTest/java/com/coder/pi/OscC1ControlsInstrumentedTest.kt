package com.coder.pi

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OscC1ControlsInstrumentedTest {
    private val native = CoderNative()
    private var handle = 0L

    @Before
    fun setUp() {
        handle = native.nativeInitTerminal(80, 24, 8, 16)
    }

    @After
    fun tearDown() {
        if (handle != 0L) native.nativeDisposeTerminal(handle)
        handle = 0L
    }

    @Test
    fun c1OscStartCompletesOscNotificationWhenTerminatedByBel() {
        native.nativeFeed(handle, byteArrayOf(0x9d.toByte(), '9'.code.toByte(), ';'.code.toByte(), 'b'.code.toByte(), 'e'.code.toByte(), 'l'.code.toByte(), 0x07))

        assertArrayEquals(arrayOf("notification\t\tbel"), native.nativeConsumeOscEvents(handle))
    }

    @Test
    fun c1StringTerminatorCompletesOscNotification() {
        native.nativeFeed(handle, byteArrayOf(0x9d.toByte(), '9'.code.toByte(), ';'.code.toByte(), 'h'.code.toByte(), 'i'.code.toByte(), 0x9c.toByte()))

        assertArrayEquals(arrayOf("notification\t\thi"), native.nativeConsumeOscEvents(handle))
    }

    @Test
    fun c1StringTerminatorCompletesOscAfterPendingEscape() {
        native.nativeFeed(handle, byteArrayOf(0x9d.toByte(), '9'.code.toByte(), ';'.code.toByte(), 'e'.code.toByte(), 's'.code.toByte(), 'c'.code.toByte(), 0x1b, 0x9c.toByte()))

        assertArrayEquals(arrayOf("notification\t\tesc"), native.nativeConsumeOscEvents(handle))
    }
}
