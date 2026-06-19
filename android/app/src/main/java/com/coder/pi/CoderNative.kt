package com.coder.pi

class CoderNative {
    external fun nativeInitTerminal(
        cols: Int,
        rows: Int,
        cellWidth: Int,
        cellHeight: Int,
    ): Long

    external fun nativeDisposeTerminal(handle: Long)

    external fun nativeInitRenderer(): Long

    external fun nativeDisposeRenderer(handle: Long)

    external fun nativeRendererSurfaceCreated(rendererHandle: Long)

    external fun nativeRendererSetFont(
        rendererHandle: Long,
        bytes: ByteArray,
    )

    external fun nativeRendererSetFontStyles(
        rendererHandle: Long,
        regular: ByteArray,
        bold: ByteArray?,
        italic: ByteArray?,
        boldItalic: ByteArray?,
        fallback: ByteArray?,
    )

    external fun nativeRendererSetShaderCacheDir(
        rendererHandle: Long,
        path: String,
    )

    external fun nativeSetTerminalTheme(
        terminalHandle: Long,
        foreground: Int,
        background: Int,
        cursor: Int,
        selectionForeground: Int,
        selectionBackground: Int,
        palette: IntArray,
    )

    external fun nativeRendererSetTheme(
        rendererHandle: Long,
        background: Int,
        cursor: Int,
        cursorText: Int,
    )

    external fun nativeRendererSetTextOptions(
        rendererHandle: Long,
        ligatures: Boolean,
        contextualAlternates: Boolean,
        slashedZero: Boolean,
        stylisticSet1: Boolean,
        stylisticSet2: Boolean,
        characterVariant1: Boolean,
        boldFontStyle: Boolean,
        cursorBlink: Boolean,
        cursorMode: Int,
    )

    external fun nativeRendererSetRefreshRate(
        rendererHandle: Long,
        refreshRate: Float,
    )

    external fun nativeRendererSurfaceChanged(
        terminalHandle: Long,
        rendererHandle: Long,
        width: Int,
        height: Int,
        cellWidth: Int,
        cellHeight: Int,
        fontPixelSize: Int,
    )

    external fun nativeRendererDrawFrame(
        terminalHandle: Long,
        rendererHandle: Long,
    )

    external fun nativeWrite(
        handle: Long,
        bytes: ByteArray,
    )

    external fun nativePaste(
        handle: Long,
        bytes: ByteArray,
    ): ByteArray

    external fun nativeFocusEvent(
        handle: Long,
        focused: Boolean,
    ): ByteArray

    external fun nativeFeed(
        handle: Long,
        bytes: ByteArray,
    )

    external fun nativeTextInput(
        handle: Long,
        text: String,
    )

    external fun nativeSetPreedit(
        handle: Long,
        text: String,
    )

    external fun nativeKeyEvent(
        handle: Long,
        keyCode: Int,
        unicodeChar: Int,
        metaState: Int,
    )

    external fun nativeScroll(
        handle: Long,
        rowDelta: Int,
    )

    external fun nativeScrollInput(
        handle: Long,
        rowDelta: Int,
        x: Float,
        y: Float,
    ): ByteArray

    external fun nativeMouseTracking(handle: Long): Boolean

    external fun nativeMouseEvent(
        handle: Long,
        action: Int,
        x: Float,
        y: Float,
        button: Int,
        metaState: Int,
    ): ByteArray

    external fun nativeScreenPositionFromViewport(
        handle: Long,
        row: Int,
        col: Int,
    ): IntArray

    external fun nativeSetSelection(
        handle: Long,
        active: Boolean,
        startRow: Int,
        startCol: Int,
        endRow: Int,
        endCol: Int,
    )

    external fun nativeCopySelection(handle: Long): String

    external fun nativeTitle(handle: Long): String

    external fun nativePwd(handle: Long): String

    external fun nativeBellCount(handle: Long): Long

    external fun nativeHyperlinkUriAt(
        handle: Long,
        row: Int,
        col: Int,
    ): String

    external fun nativeConsumeOscEvents(handle: Long): Array<String>

    external fun nativeSelectedText(
        handle: Long,
        startRow: Int,
        startCol: Int,
        endRow: Int,
        endCol: Int,
    ): String

    external fun nativeSnapshotText(handle: Long): Array<String>

    external fun nativeCursorPosition(handle: Long): IntArray

    companion object {
        init {
            System.loadLibrary("coder-terminal")
        }
    }
}
