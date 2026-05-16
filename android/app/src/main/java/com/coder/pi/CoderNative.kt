package com.coder.pi

class CoderNative {
    external fun nativeInit(cols: Int, rows: Int, cellWidth: Int, cellHeight: Int): Long
    external fun nativeDispose(handle: Long)
    external fun nativeSurfaceCreated(handle: Long)
    external fun nativeSetFont(handle: Long, bytes: ByteArray)
    external fun nativeSetTheme(handle: Long, foreground: Int, background: Int, cursor: Int, cursorText: Int, palette: IntArray)
    external fun nativeSetTextOptions(handle: Long, ligatures: Boolean, cursorBlink: Boolean, cursorMode: Int)
    external fun nativeSetRefreshRate(handle: Long, refreshRate: Float)
    external fun nativeSurfaceChanged(handle: Long, width: Int, height: Int, cellWidth: Int, cellHeight: Int)
    external fun nativeDrawFrame(handle: Long)
    external fun nativeWrite(handle: Long, bytes: ByteArray)
    external fun nativeFeed(handle: Long, bytes: ByteArray)
    external fun nativeTextInput(handle: Long, text: String)
    external fun nativeKeyEvent(handle: Long, keyCode: Int, unicodeChar: Int, metaState: Int)
    external fun nativeScroll(handle: Long, rowDelta: Int)
    external fun nativeMouseTracking(handle: Long): Boolean
    external fun nativeSnapshotText(handle: Long): Array<String>

    companion object {
        init {
            System.loadLibrary("coder-terminal")
        }
    }
}
