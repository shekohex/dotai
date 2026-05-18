package com.coder.pi

import android.content.Context

class CoderHeadlessTerminalEndpoint(
    context: Context,
    private val notificationContext: TerminalNotificationContext,
) : CoderTerminalEndpoint {
    private val native = CoderNative()
    private val router = TerminalNotificationRouter(context.applicationContext, notificationContext)
    private val lock = Any()
    private var handle = native.nativeInit(80, 24, 18, 36)
    private var remoteInput: ((ByteArray) -> Unit)? = null
    override var onTerminalSizeChanged: ((Int, Int) -> Unit)? = null

    override fun terminalColumns(): Int = 80

    override fun terminalRows(): Int = 24

    override fun attachRemote(input: (ByteArray) -> Unit) {
        remoteInput = input
    }

    override fun detachRemote() {
        remoteInput = null
    }

    override fun feedRemoteOutput(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        synchronized(lock) {
            if (handle == 0L) return
            native.nativeFeed(handle, bytes)
            native.nativeConsumeOscEvents(handle).forEach { router.handleOscEvent(it, native.nativeTitle(handle)) }
        }
    }

    override fun sendInput(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        remoteInput?.invoke(bytes)
    }

    fun dispose() {
        synchronized(lock) {
            if (handle != 0L) native.nativeDispose(handle)
            handle = 0L
        }
    }
}
