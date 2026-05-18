package com.coder.pi

class TerminalEngine(
    private val columns: Int = 80,
    private val rows: Int = 24,
    cellWidth: Int = 18,
    cellHeight: Int = 36,
) {
    private val native = CoderNative()
    private val lock = Any()
    private var handle = native.nativeInit(columns, rows, cellWidth, cellHeight)

    fun feed(bytes: ByteArray): TerminalEngineUpdate {
        if (bytes.isEmpty()) return TerminalEngineUpdate(emptyList(), title())
        return synchronized(lock) {
            if (handle == 0L) return@synchronized TerminalEngineUpdate(emptyList(), "")
            native.nativeFeed(handle, bytes)
            TerminalEngineUpdate(native.nativeConsumeOscEvents(handle).toList(), native.nativeTitle(handle))
        }
    }

    fun title(): String = synchronized(lock) { if (handle == 0L) "" else native.nativeTitle(handle) }

    fun dispose() {
        synchronized(lock) {
            if (handle != 0L) native.nativeDispose(handle)
            handle = 0L
        }
    }
}

data class TerminalEngineUpdate(val oscEvents: List<String>, val title: String)
