package com.coder.pi

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PreeditWideCellsInstrumentedTest {
    private val native = CoderNative()
    private var handle = 0L

    @Before
    fun setUp() {
        handle = native.nativeInitTerminal(8, 4, 8, 16)
    }

    @After
    fun tearDown() {
        if (handle != 0L) native.nativeDisposeTerminal(handle)
        handle = 0L
    }

    @Test
    fun cjkPreeditConsumesWideCell() {
        native.nativeSetPreedit(handle, "界a")

        assertEquals("界 a", native.nativeSnapshotText(handle).first())
    }

    @Test
    fun emojiPreeditConsumesWideCell() {
        native.nativeSetPreedit(handle, "😀a")

        assertEquals("😀 a", native.nativeSnapshotText(handle).first())
    }
}
