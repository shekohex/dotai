package com.coder.pi

class TerminalEngine(
    private val columns: Int = 80,
    private val rows: Int = 24,
    cellWidth: Int = 18,
    cellHeight: Int = 36,
) {
    internal val native = CoderNative()
    private val lock = Any()
    @Volatile internal var handle = native.nativeInit(columns, rows, cellWidth, cellHeight)

    fun feed(bytes: ByteArray): TerminalEngineUpdate {
        if (bytes.isEmpty()) return TerminalEngineUpdate(emptyList(), title())
        return synchronized(lock) {
            if (handle == 0L) return@synchronized TerminalEngineUpdate(emptyList(), "")
            native.nativeFeed(handle, bytes)
            TerminalEngineUpdate(native.nativeConsumeOscEvents(handle).toList(), native.nativeTitle(handle))
        }
    }

    fun title(): String = synchronized(lock) { if (handle == 0L) "" else native.nativeTitle(handle) }

    fun pwd(): String = synchronized(lock) { if (handle == 0L) "" else native.nativePwd(handle) }

    fun bellCount(): Long = synchronized(lock) { if (handle == 0L) 0L else native.nativeBellCount(handle) }

    fun consumeOscEvents(): List<String> = synchronized(lock) { if (handle == 0L) emptyList() else native.nativeConsumeOscEvents(handle).toList() }

    fun write(bytes: ByteArray) = synchronized(lock) { if (handle != 0L) native.nativeWrite(handle, bytes) }

    fun feedOnCurrentThread(bytes: ByteArray) = synchronized(lock) { if (handle != 0L) native.nativeFeed(handle, bytes) }

    fun dispose() {
        synchronized(lock) {
            if (handle != 0L) native.nativeDispose(handle)
            handle = 0L
        }
    }
}

data class TerminalEngineUpdate(val oscEvents: List<String>, val title: String)
