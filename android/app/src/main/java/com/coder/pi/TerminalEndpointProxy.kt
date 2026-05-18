package com.coder.pi

class TerminalEndpointProxy(initialEndpoint: CoderTerminalEndpoint) : CoderTerminalEndpoint {
    private val lock = Any()
    private var endpoint = initialEndpoint
    private var remoteInput: ((ByteArray) -> Unit)? = null

    override var onTerminalSizeChanged: ((Int, Int) -> Unit)? = null
        set(value) {
            field = value
            val currentEndpoint = synchronized(lock) { endpoint }
            currentEndpoint.onTerminalSizeChanged = value
        }

    fun attachEndpoint(nextEndpoint: CoderTerminalEndpoint): CoderTerminalEndpoint {
        val input = synchronized(lock) { remoteInput }
        val previous = synchronized(lock) {
            val previous = endpoint
            endpoint = nextEndpoint
            previous
        }
        previous.detachRemote()
        previous.onTerminalSizeChanged = null
        nextEndpoint.attachRemote { bytes -> input?.invoke(bytes) }
        nextEndpoint.onTerminalSizeChanged = onTerminalSizeChanged
        return previous
    }

    fun detachEndpoint(endpointToDetach: CoderTerminalEndpoint) {
        val shouldDetach = synchronized(lock) { endpoint === endpointToDetach }
        if (!shouldDetach) return
        endpointToDetach.detachRemote()
        endpointToDetach.onTerminalSizeChanged = null
    }

    fun currentEndpoint(): CoderTerminalEndpoint = synchronized(lock) { endpoint }

    override fun terminalColumns(): Int = synchronized(lock) { endpoint.terminalColumns() }

    override fun terminalRows(): Int = synchronized(lock) { endpoint.terminalRows() }

    override fun attachRemote(input: (ByteArray) -> Unit) {
        val currentEndpoint = synchronized(lock) {
            remoteInput = input
            endpoint
        }
        currentEndpoint.attachRemote { bytes -> synchronized(lock) { remoteInput }?.invoke(bytes) }
    }

    override fun detachRemote() {
        val currentEndpoint = synchronized(lock) {
            remoteInput = null
            endpoint
        }
        currentEndpoint.detachRemote()
    }

    override fun feedRemoteOutput(bytes: ByteArray) {
        val currentEndpoint = synchronized(lock) { endpoint }
        currentEndpoint.feedRemoteOutput(bytes)
    }

    override fun sendInput(bytes: ByteArray) {
        val input = synchronized(lock) { remoteInput }
        input?.invoke(bytes) ?: synchronized(lock) { endpoint }.sendInput(bytes)
    }
}
