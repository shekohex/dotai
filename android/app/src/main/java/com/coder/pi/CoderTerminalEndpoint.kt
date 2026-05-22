package com.coder.pi

interface CoderTerminalEndpoint {
    var onTerminalSizeChanged: ((Int, Int) -> Unit)?

    fun terminalColumns(): Int

    fun terminalRows(): Int

    fun attachRemote(input: (ByteArray) -> Unit)

    fun detachRemote()

    fun feedRemoteOutput(bytes: ByteArray)

    fun sendInput(bytes: ByteArray)
}
