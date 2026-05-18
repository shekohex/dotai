package com.coder.pi

class TerminalEndpointProxy(initialEndpoint: CoderTerminalEndpoint) : CoderTerminalEndpoint {
    private val lock = Any()
    private var endpoint = initialEndpoint
    private var remoteInput: ((ByteArray) -> Unit)? = null

    override var onTerminalSizeChanged: ((Int, Int) -> Unit)? = null
        set(value) {
            field = value
            synchronized(lock) { endpoint.onTerminalSizeChanged = value }
        }

    fun attachEndpoint(nextEndpoint: CoderTerminalEndpoint): CoderTerminalEndpoint {
        return synchronized(lock) {
            val previous = endpoint
            previous.detachRemote()
            previous.onTerminalSizeChanged = null
            endpoint = nextEndpoint
            nextEndpoint.attachRemote { bytes -> remoteInput?.invoke(bytes) }
            nextEndpoint.onTerminalSizeChanged = onTerminalSizeChanged
            previous
        }
    }

    fun detachEndpoint(endpointToDetach: CoderTerminalEndpoint) {
        synchronized(lock) {
            if (endpoint !== endpointToDetach) return
            endpoint.detachRemote()
            endpoint.onTerminalSizeChanged = null
        }
    }

    fun currentEndpoint(): CoderTerminalEndpoint = synchronized(lock) { endpoint }

    override fun terminalColumns(): Int = synchronized(lock) { endpoint.terminalColumns() }

    override fun terminalRows(): Int = synchronized(lock) { endpoint.terminalRows() }

    override fun attachRemote(input: (ByteArray) -> Unit) {
        synchronized(lock) {
            remoteInput = input
            endpoint.attachRemote { bytes -> remoteInput?.invoke(bytes) }
        }
    }

    override fun detachRemote() {
        synchronized(lock) {
            remoteInput = null
            endpoint.detachRemote()
        }
    }

    override fun feedRemoteOutput(bytes: ByteArray) {
        synchronized(lock) { endpoint.feedRemoteOutput(bytes) }
    }

    override fun sendInput(bytes: ByteArray) {
        synchronized(lock) { remoteInput?.invoke(bytes) ?: endpoint.sendInput(bytes) }
    }
}
