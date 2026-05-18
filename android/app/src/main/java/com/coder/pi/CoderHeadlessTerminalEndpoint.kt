package com.coder.pi

import android.content.Context

class CoderHeadlessTerminalEndpoint(
    context: Context,
    private val notificationContext: TerminalNotificationContext,
    existingEngine: TerminalEngine? = null,
    private val ownsEngine: Boolean = existingEngine == null,
) : CoderTerminalEndpoint {
    internal val engine = existingEngine ?: TerminalEngine()
    private val router = TerminalNotificationRouter(context.applicationContext, notificationContext)
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
        val update = engine.feed(bytes)
        update.oscEvents.forEach { router.handleOscEvent(it, update.title) }
    }

    override fun sendInput(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        remoteInput?.invoke(bytes)
    }

    fun dispose(disposeEngine: Boolean = ownsEngine) {
        if (disposeEngine) engine.dispose()
    }
}
