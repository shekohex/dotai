package com.coder.pi

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalEndpointProxyTest {
    @Test
    fun attachEndpointMovesRemoteInputToNewEndpoint() {
        val first = FakeTerminalEndpoint()
        val second = FakeTerminalEndpoint()
        val proxy = TerminalEndpointProxy(first)
        val sent = mutableListOf<ByteArray>()

        proxy.attachRemote { sent.add(it) }
        proxy.attachEndpoint(second)
        first.sendToRemote(byteArrayOf(1))
        second.sendToRemote(byteArrayOf(2))

        assertEquals(1, sent.size)
        assertArrayEquals(byteArrayOf(2), sent.single())
        assertNull(first.remoteInput)
    }

    @Test
    fun attachedEndpointUsesLatestRemoteInput() {
        val first = FakeTerminalEndpoint()
        val second = FakeTerminalEndpoint()
        val proxy = TerminalEndpointProxy(first)
        val firstSent = mutableListOf<ByteArray>()
        val secondSent = mutableListOf<ByteArray>()

        proxy.attachRemote { firstSent.add(it) }
        proxy.attachEndpoint(second)
        proxy.attachRemote { secondSent.add(it) }
        second.sendToRemote(byteArrayOf(5))

        assertEquals(emptyList<List<Byte>>(), firstSent.map { it.toList() })
        assertEquals(listOf(listOf(5.toByte())), secondSent.map { it.toList() })
    }

    @Test
    fun feedRemoteOutputTargetsCurrentEndpointOnly() {
        val first = FakeTerminalEndpoint()
        val second = FakeTerminalEndpoint()
        val proxy = TerminalEndpointProxy(first)

        proxy.feedRemoteOutput(byteArrayOf(1))
        proxy.attachEndpoint(second)
        proxy.feedRemoteOutput(byteArrayOf(2))

        assertEquals(listOf(listOf(1.toByte())), first.outputs.map { it.toList() })
        assertEquals(listOf(listOf(2.toByte())), second.outputs.map { it.toList() })
    }

    @Test
    fun detachEndpointStopsDetachedEndpointOnly() {
        val first = FakeTerminalEndpoint()
        val second = FakeTerminalEndpoint()
        val proxy = TerminalEndpointProxy(first)
        val sent = mutableListOf<ByteArray>()

        proxy.attachRemote { sent.add(it) }
        proxy.attachEndpoint(second)
        proxy.detachEndpoint(first)
        second.sendToRemote(byteArrayOf(3))
        proxy.detachEndpoint(second)
        second.sendToRemote(byteArrayOf(4))

        assertEquals(listOf(listOf(3.toByte())), sent.map { it.toList() })
        assertNull(second.remoteInput)
    }

    private class FakeTerminalEndpoint : CoderTerminalEndpoint {
        override var onTerminalSizeChanged: ((Int, Int) -> Unit)? = null
        var remoteInput: ((ByteArray) -> Unit)? = null
        val outputs = mutableListOf<ByteArray>()

        override fun terminalColumns(): Int = 80

        override fun terminalRows(): Int = 24

        override fun attachRemote(input: (ByteArray) -> Unit) {
            remoteInput = input
        }

        override fun detachRemote() {
            remoteInput = null
        }

        override fun feedRemoteOutput(bytes: ByteArray) {
            outputs.add(bytes)
        }

        override fun sendInput(bytes: ByteArray) {
            remoteInput?.invoke(bytes)
        }

        fun sendToRemote(bytes: ByteArray) {
            remoteInput?.invoke(bytes)
        }
    }
}
