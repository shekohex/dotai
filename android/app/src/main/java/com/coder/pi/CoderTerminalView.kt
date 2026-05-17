package com.coder.pi

import android.animation.ValueAnimator
import android.content.Context
import android.content.ClipboardManager
import android.opengl.GLSurfaceView
import android.util.AttributeSet
import android.text.InputType
import android.view.MotionEvent
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.view.inputmethod.InputConnection
import kotlin.math.roundToInt
import androidx.core.content.edit
import androidx.core.content.getSystemService
import java.lang.ref.WeakReference

class CoderTerminalView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : GLSurfaceView(context, attrs), GLSurfaceView.Renderer {
    private val native = CoderNative()
    private var handle = 0L
    private val preferences = context.getSharedPreferences("terminal", Context.MODE_PRIVATE)
    private var cellWidth = preferences.getInt("cellWidth", 18)
    private var cellHeight = preferences.getInt("cellHeight", 36)
    private var surfaceWidth = 0
    private var surfaceHeight = 0
    private var lastTouchY = 0f
    private var accumulatedScrollY = 0f
    private var smoothScrollAnimator: ValueAnimator? = null
    private var smoothScrollPendingPixels = 0f
    private var smoothScrollGesturePixels = 0f
    private var smoothScrollVelocityPixelsPerMillis = 0f
    private var smoothScrollLastEventMillis = 0L
    private var shiftLatch = false
    private var ctrlLatch = false
    private var altLatch = false
    private var softwareKeyboardAllowed = false
    private var remoteInput: ((ByteArray) -> Unit)? = null
    private val pendingRemoteOutput = mutableListOf<ByteArray>()
    var onTerminalSizeChanged: ((Int, Int) -> Unit)? = null
    var onModifierLatchChanged: ((Boolean, Boolean, Boolean) -> Unit)? = null
    var onToolbarActionsChanged: (() -> Unit)? = null

    init {
        registerTerminalView(this)
        setEGLContextClientVersion(3)
        setRenderer(this)
        renderMode = RENDERMODE_CONTINUOUSLY
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun onSurfaceCreated(gl: javax.microedition.khronos.opengles.GL10?, config: javax.microedition.khronos.egl.EGLConfig?) {
        handle = native.nativeInit(80, 24, cellWidth, cellHeight)
        native.nativeSetShaderCacheDir(handle, context.cacheDir.resolve("shader-cache").apply { mkdirs() }.absolutePath)
        CoderFonts.styleBytes(context).let { native.nativeSetFontStyles(handle, it.regular, it.bold, it.italic, it.boldItalic) }
        applyTextOptions()
        applyTheme(CoderThemes.current(context))
        native.nativeSetRefreshRate(handle, display?.refreshRate ?: 60f)
        native.nativeSurfaceCreated(handle)
        flushPendingRemoteOutput()
    }

    override fun onSurfaceChanged(gl: javax.microedition.khronos.opengles.GL10?, width: Int, height: Int) {
        surfaceWidth = width
        surfaceHeight = height
        native.nativeSurfaceChanged(handle, width, height, cellWidth, cellHeight)
        notifyTerminalSizeChanged()
    }

    override fun onDrawFrame(gl: javax.microedition.khronos.opengles.GL10?) {
        native.nativeDrawFrame(handle)
    }

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        if (!softwareKeyboardAllowed) return null
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE
        return object : BaseInputConnection(this, false) {
            override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
                sendText(text.toString())
                return true
            }

            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    sendKey(event.keyCode, event.metaState, event.unicodeChar)
                }
                return true
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                native.nativeKeyEvent(handle, KeyEvent.KEYCODE_DEL, 0, 0)
                return true
            }
        }
    }

    override fun onCheckIsTextEditor(): Boolean {
        return softwareKeyboardAllowed
    }

    fun setSoftwareKeyboardAllowed(allowed: Boolean) {
        softwareKeyboardAllowed = allowed
    }

    override fun onGenericMotionEvent(event: MotionEvent): Boolean {
        if (!gestureEnabled("drag_scroll")) return super.onGenericMotionEvent(event)
        if (event.action == MotionEvent.ACTION_SCROLL) {
            val rows = event.getAxisValue(MotionEvent.AXIS_VSCROLL).toInt()
            if (rows != 0) scrollTerminal(-rows * 3)
            return true
        }
        return super.onGenericMotionEvent(event)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        requestFocus()
        if (!gestureEnabled("drag_scroll")) return super.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastTouchY = event.y
                accumulatedScrollY = 0f
                beginSmoothScrollGesture()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val deltaY = event.y - lastTouchY
                lastTouchY = event.y
                if (smoothScrollEnabled()) {
                    scrollPixels(deltaY)
                    return true
                }
                accumulatedScrollY += deltaY
                val rows = (accumulatedScrollY / cellHeight).toInt()
                if (rows != 0) {
                    scrollRows(-rows)
                    accumulatedScrollY -= rows * cellHeight
                }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                endSmoothScrollGesture()
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (volumeFontSizeEnabled() && keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            adjustFontSize(1)
            return true
        }
        if (volumeFontSizeEnabled() && keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            adjustFontSize(-1)
            return true
        }
        if (keyboardPasteEnabled() && keyCode == KeyEvent.KEYCODE_V && ((event.metaState and KeyEvent.META_META_ON) != 0 || ((event.metaState and KeyEvent.META_CTRL_ON) != 0 && (event.metaState and KeyEvent.META_SHIFT_ON) != 0))) {
            pasteFromClipboard()
            return true
        }
        sendKey(keyCode, event.metaState, event.unicodeChar)
        return true
    }

    fun sendText(text: String) {
        if (handle == 0L || text.isEmpty()) return
        if (ctrlLatch && text.length == 1) {
            val output = buildList {
                if (altLatch) add(0x1b.toByte())
                terminalControlByte(text.first())?.let { add(it) }
            }.toByteArray()
            if (output.isNotEmpty()) writeInput(output)
            shiftLatch = false
            ctrlLatch = false
            altLatch = false
            notifyModifierLatchChanged()
            return
        }
        val prefix = if (altLatch) byteArrayOf(0x1b) else byteArrayOf()
        val output = if (shiftLatch && text.length == 1) terminalShiftedChar(text.first()).toString() else text
        if (prefix.isNotEmpty() || remoteInput != null || output.length != 1) writeInput(prefix + output.toByteArray(Charsets.UTF_8))
        else native.nativeTextInput(handle, output)
        shiftLatch = false
        altLatch = false
        notifyModifierLatchChanged()
    }

    fun pasteFromClipboard(): Boolean {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
        if (text.isBlank()) return false
        sendText(text)
        return true
    }

    fun sendKey(keyCode: Int, metaState: Int = 0, unicodeChar: Int = 0) {
        if (handle == 0L) return
        var nextMetaState = metaState
        if (shiftLatch) nextMetaState = nextMetaState or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
        if (ctrlLatch) nextMetaState = nextMetaState or KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
        if (altLatch) nextMetaState = nextMetaState or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON
        terminalModifiedKeyBytes(keyCode, unicodeChar, nextMetaState)?.takeIf { (nextMetaState and KeyEvent.META_CTRL_ON) != 0 }?.let {
            writeInput(it)
            shiftLatch = false
            ctrlLatch = false
            altLatch = false
            notifyModifierLatchChanged()
            return
        }
        remoteInput?.let {
            val bytes = terminalModifiedKeyBytes(keyCode, unicodeChar, nextMetaState)
            if (bytes != null) {
                it(bytes)
                shiftLatch = false
                ctrlLatch = false
                altLatch = false
                notifyModifierLatchChanged()
                return
            }
        }
        native.nativeKeyEvent(handle, keyCode, unicodeChar, nextMetaState)
        shiftLatch = false
        ctrlLatch = false
        altLatch = false
        notifyModifierLatchChanged()
    }

    fun toggleShiftLatch(): Boolean {
        shiftLatch = !shiftLatch
        notifyModifierLatchChanged()
        return shiftLatch
    }

    fun toggleCtrlLatch(): Boolean {
        ctrlLatch = !ctrlLatch
        notifyModifierLatchChanged()
        return ctrlLatch
    }

    fun toggleAltLatch(): Boolean {
        altLatch = !altLatch
        notifyModifierLatchChanged()
        return altLatch
    }

    fun scrollRows(rowDelta: Int, smooth: Boolean = false) {
        if (smooth && smoothScrollEnabled()) scrollPixels(-rowDelta * cellHeight.toFloat()) else scrollTerminal(rowDelta)
    }

    fun scrollRowHeight(): Int = cellHeight.coerceAtLeast(1)

    fun beginSmoothScrollGesture() {
        smoothScrollAnimator?.cancel()
        smoothScrollAnimator = null
        smoothScrollGesturePixels = 0f
        smoothScrollVelocityPixelsPerMillis = 0f
        smoothScrollLastEventMillis = android.os.SystemClock.uptimeMillis()
    }

    fun scrollPixels(pixelDelta: Float) {
        if (pixelDelta == 0f) return
        val now = android.os.SystemClock.uptimeMillis()
        val elapsed = (now - smoothScrollLastEventMillis).coerceAtLeast(1L).toFloat()
        smoothScrollLastEventMillis = now
        smoothScrollGesturePixels += kotlin.math.abs(pixelDelta)
        val instantVelocity = pixelDelta / elapsed
        smoothScrollVelocityPixelsPerMillis = smoothScrollVelocityPixelsPerMillis * 0.72f + instantVelocity * 0.28f
        val acceleration = 1f + (smoothScrollGesturePixels / (cellHeight * 8f)).coerceIn(0f, 2.4f)
        applyScrollPixels(pixelDelta * scrollSpeedMultiplier() * acceleration)
    }

    fun endSmoothScrollGesture() {
        if (!smoothScrollEnabled()) return
        val initialVelocity = smoothScrollVelocityPixelsPerMillis * scrollSpeedMultiplier()
        if (kotlin.math.abs(initialVelocity) < 0.08f) return
        smoothScrollAnimator?.cancel()
        var lastTime = 0L
        smoothScrollAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = (320L + kotlin.math.abs(initialVelocity * 420f).toLong()).coerceIn(360L, 900L)
            addUpdateListener { animator ->
                val currentTime = animator.currentPlayTime
                val elapsed = (currentTime - lastTime).coerceAtLeast(0L).toFloat()
                lastTime = currentTime
                val progress = animator.animatedFraction
                val decay = (1f - progress) * (1f - progress)
                applyScrollPixels(initialVelocity * elapsed * decay)
            }
            start()
        }
    }

    fun setSmoothScrollEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("smooth_scroll", enabled) }
    }

    fun smoothScrollEnabled(): Boolean = preferences.getBoolean("smooth_scroll", true)

    fun setScrollSpeedPercent(value: Int) {
        preferences.edit { putInt("scroll_speed_percent", value.coerceIn(50, 300)) }
    }

    fun scrollSpeedPercent(): Int = preferences.getInt("scroll_speed_percent", 100).coerceIn(50, 300)

    private fun scrollSpeedMultiplier(): Float = scrollSpeedPercent() / 100f

    private fun applyScrollPixels(pixelDelta: Float) {
        smoothScrollPendingPixels += pixelDelta
        val rows = (smoothScrollPendingPixels / cellHeight).toInt()
        if (rows == 0) return
        scrollTerminal(-rows)
        smoothScrollPendingPixels -= rows * cellHeight
    }

    private fun scrollTerminal(rowDelta: Int) {
        if (handle == 0L || rowDelta == 0) return
        val mouseTracking = remoteInput != null && native.nativeMouseTracking(handle)
        if (!mouseTracking) native.nativeScroll(handle, rowDelta)
        remoteInput?.takeIf { mouseTracking }?.let { input ->
            val button = if (rowDelta < 0) 64 else 65
            repeat(kotlin.math.abs(rowDelta).coerceAtMost(12)) {
                input("\u001b[<${button};1;1M\u001b[<${button};1;1m".toByteArray(Charsets.UTF_8))
            }
        }
    }

    fun terminalColumns(): Int = if (cellWidth > 0) surfaceWidth / cellWidth else 0

    fun terminalRows(): Int = if (cellHeight > 0) surfaceHeight / cellHeight else 0

    fun cellAt(x: Float, y: Float): TerminalCellPosition {
        val col = if (cellWidth > 0) (x / cellWidth).toInt().coerceIn(0, (terminalColumns() - 1).coerceAtLeast(0)) else 0
        val row = if (cellHeight > 0) (y / cellHeight).toInt().coerceIn(0, (terminalRows() - 1).coerceAtLeast(0)) else 0
        return TerminalCellPosition(row, col)
    }

    fun selectedText(start: TerminalCellPosition, end: TerminalCellPosition): String {
        if (handle == 0L) return ""
        val lines = native.nativeSnapshotText(handle)
        val range = TerminalSelectionRange(start, end).normalized()
        return (range.start.row..range.end.row).joinToString("\n") { row ->
            val line = lines.getOrNull(row).orEmpty()
            val startCol = if (row == range.start.row) range.start.col else 0
            val endCol = if (row == range.end.row) range.end.col + 1 else line.length
            line.substring(startCol.coerceIn(0, line.length), endCol.coerceIn(0, line.length))
        }.trimEnd()
    }

    fun wordRangeAt(position: TerminalCellPosition): TerminalSelectionRange {
        if (handle == 0L) return TerminalSelectionRange(position, position)
        val line = native.nativeSnapshotText(handle).getOrNull(position.row).orEmpty()
        if (line.isBlank()) return TerminalSelectionRange(position, position)
        val col = position.col.coerceIn(0, (line.length - 1).coerceAtLeast(0))
        val targetCol = when {
            line.getOrNull(col)?.isTerminalWordChar() == true -> col
            col > 0 && line.getOrNull(col - 1)?.isTerminalWordChar() == true -> col - 1
            else -> col
        }
        if (line.getOrNull(targetCol)?.isTerminalWordChar() != true) return TerminalSelectionRange(position, position)
        var start = targetCol
        while (start > 0 && line[start - 1].isTerminalWordChar()) start--
        var end = targetCol
        while (end + 1 < line.length && line[end + 1].isTerminalWordChar()) end++
        return TerminalSelectionRange(TerminalCellPosition(position.row, start), TerminalCellPosition(position.row, end))
    }

    fun snapshotText(): List<String> {
        if (handle == 0L) return emptyList()
        return native.nativeSnapshotText(handle).toList()
    }

    fun setKeyboardAvoidanceOffset(offset: Int) {
        translationY = -offset.toFloat()
    }

    fun refreshSurface() {
        if (handle != 0L && width > 0 && height > 0) {
            surfaceWidth = width
            surfaceHeight = height
            queueEvent { native.nativeSurfaceChanged(handle, width, height, cellWidth, cellHeight) }
            notifyTerminalSizeChanged()
            requestRender()
        }
    }

    fun adjustFontSize(delta: Int) {
        val maxHeight = if (surfaceHeight > 0) (surfaceHeight / 8).coerceAtLeast(16) else 48
        val maxWidth = if (surfaceWidth > 0) (surfaceWidth / 20).coerceAtLeast(8) else 28
        val nextHeight = (cellHeight + delta * 2).coerceIn(16, maxHeight.coerceAtMost(64))
        val ratio = nextHeight / cellHeight.toFloat()
        cellHeight = nextHeight
        cellWidth = (cellWidth * ratio).roundToInt().coerceIn(8, maxWidth.coerceAtMost(40))
        preferences.edit { putInt("cellWidth", cellWidth).putInt("cellHeight", cellHeight) }
        if (handle != 0L && surfaceWidth > 0 && surfaceHeight > 0) {
            queueEvent { native.nativeSurfaceChanged(handle, surfaceWidth, surfaceHeight, cellWidth, cellHeight) }
            notifyTerminalSizeChanged()
        }
    }

    fun fontSizePoints(): Int {
        return (cellHeight / 2).coerceIn(8, 32)
    }

    fun setFontSizePoints(points: Int) {
        val nextHeight = (points * 2).coerceIn(16, 64)
        val nextWidth = points.coerceIn(8, 40)
        cellHeight = nextHeight
        cellWidth = nextWidth
        preferences.edit { putInt("cellWidth", cellWidth).putInt("cellHeight", cellHeight) }
        if (handle != 0L && surfaceWidth > 0 && surfaceHeight > 0) {
            queueEvent { native.nativeSurfaceChanged(handle, surfaceWidth, surfaceHeight, cellWidth, cellHeight) }
            notifyTerminalSizeChanged()
        }
    }

    fun setFontFamily(key: String) {
        CoderFonts.setSelected(context, key)
        setNativeFont(key)
    }

    fun setPreviewFontFamily(key: String) {
        setNativeFont(key)
    }

    private fun setNativeFont(key: String) {
        val bytes = CoderFonts.styleBytes(context, key)
        if (handle != 0L) queueEvent { native.nativeSetFontStyles(handle, bytes.regular, bytes.bold, bytes.italic, bytes.boldItalic) }
    }

    fun dispose() {
        unregisterTerminalView(this)
        if (handle != 0L) native.nativeDispose(handle)
        handle = 0L
    }

    fun applyTheme(theme: CoderTheme) {
        if (handle != 0L) native.nativeSetTheme(handle, theme.foreground, theme.background, theme.cursor, theme.cursorText, theme.palette)
    }

    fun setLigaturesEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("ligatures", enabled) }
        applyTextOptions()
    }

    fun ligaturesEnabled(): Boolean = preferences.getBoolean("ligatures", true)

    fun setCursorBlinkEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("cursorBlink", enabled) }
        applyTextOptions()
    }

    fun cursorBlinkEnabled(): Boolean = preferences.getBoolean("cursorBlink", true)

    fun setCursorMode(mode: Int) {
        preferences.edit { putInt("cursorMode", mode.coerceIn(0, 2)) }
        applyTextOptions()
    }

    fun cursorMode(): Int = preferences.getInt("cursorMode", 0).coerceIn(0, 2)

    fun setToolbarActionVisible(action: String, visible: Boolean) {
        preferences.edit { putBoolean("toolbar.$action", visible) }
        notifyToolbarActionsChanged()
    }

    fun toolbarActionVisible(action: String): Boolean = preferences.getBoolean("toolbar.$action", true)

    fun toolbarOrder(): List<String> = normalizeToolbarOrder(preferences.getString("toolbar.order", null))

    fun setToolbarOrder(order: List<String>) {
        preferences.edit { putString("toolbar.order", order.joinToString(",")) }
        notifyToolbarActionsChanged()
    }

    fun setGestureEnabled(gesture: String, enabled: Boolean) {
        preferences.edit { putBoolean("gesture.$gesture", enabled) }
        notifyToolbarActionsChanged()
    }

    fun gestureEnabled(gesture: String): Boolean = preferences.getBoolean("gesture.$gesture", true)

    fun setChatModeEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("chat_mode", enabled) }
        setToolbarActionVisible("chat", enabled)
    }

    fun chatModeEnabled(): Boolean = preferences.getBoolean("chat_mode", true)

    fun setAutoSendEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("auto_send", enabled) }
        notifyToolbarActionsChanged()
    }

    fun autoSendEnabled(): Boolean = preferences.getBoolean("auto_send", false)

    fun setCopyOnSelectEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("copy_on_select", enabled) }
    }

    fun copyOnSelectEnabled(): Boolean = preferences.getBoolean("copy_on_select", false)

    fun setKeyboardPasteEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("keyboard_paste", enabled) }
    }

    fun keyboardPasteEnabled(): Boolean = preferences.getBoolean("keyboard_paste", true)

    fun setVolumeFontSizeEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("volume_font_size", enabled) }
    }

    fun volumeFontSizeEnabled(): Boolean = preferences.getBoolean("volume_font_size", true)

    fun customShortcuts(): List<TerminalShortcut> {
        return preferences.getString("toolbar.shortcuts", "").orEmpty().split("\n").mapNotNull { line ->
            val parts = line.split("\t")
            if (parts.size < 2 || parts[0].isBlank() || parts[1].isBlank()) null else TerminalShortcut(parts[0], parts[1])
        }
    }

    fun addCustomShortcut(shortcut: TerminalShortcut) {
        val next = (customShortcuts() + shortcut).takeLast(8).joinToString("\n") { "${it.label}\t${it.sequence}" }
        preferences.edit { putString("toolbar.shortcuts", next) }
        notifyToolbarActionsChanged()
    }

    fun removeCustomShortcut(index: Int) {
        val next = customShortcuts().filterIndexed { itemIndex, _ -> itemIndex != index }.joinToString("\n") { "${it.label}\t${it.sequence}" }
        preferences.edit { putString("toolbar.shortcuts", next) }
        notifyToolbarActionsChanged()
    }

    fun notifyToolbarActionsChanged() {
        notifyAllTerminalToolbarsChanged()
    }

    private fun applyTextOptions() {
        if (handle != 0L) native.nativeSetTextOptions(handle, ligaturesEnabled(), cursorBlinkEnabled(), cursorMode())
    }

    fun attachRemote(input: (ByteArray) -> Unit) {
        remoteInput = input
    }

    fun detachRemote() {
        remoteInput = null
    }

    fun feedRemoteOutput(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        if (handle == 0L) {
            pendingRemoteOutput.add(bytes)
            return
        }
        queueEvent { native.nativeFeed(handle, bytes) }
    }

    private fun flushPendingRemoteOutput() {
        if (handle == 0L || pendingRemoteOutput.isEmpty()) return
        val outputs = pendingRemoteOutput.toList()
        pendingRemoteOutput.clear()
        queueEvent { outputs.forEach { native.nativeFeed(handle, it) } }
    }

    private fun writeInput(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        remoteInput?.let { it(bytes); return }
        native.nativeWrite(handle, bytes)
    }

    private fun notifyModifierLatchChanged() {
        onModifierLatchChanged?.invoke(shiftLatch, ctrlLatch, altLatch)
    }

    private fun notifyTerminalSizeChanged() {
        val columns = terminalColumns()
        val rows = terminalRows()
        if (columns > 0 && rows > 0) onTerminalSizeChanged?.invoke(columns, rows)
    }

    companion object {
        private val terminalViews = mutableListOf<WeakReference<CoderTerminalView>>()

        private fun registerTerminalView(view: CoderTerminalView) {
            terminalViews.removeAll { it.get() == null || it.get() == view }
            terminalViews.add(WeakReference(view))
        }

        private fun unregisterTerminalView(view: CoderTerminalView) {
            terminalViews.removeAll { it.get() == null || it.get() == view }
        }

        private fun notifyAllTerminalToolbarsChanged() {
            terminalViews.removeAll { it.get() == null }
            terminalViews.mapNotNull { it.get() }.forEach { it.onToolbarActionsChanged?.invoke() }
        }
    }
}

private fun Char.isTerminalWordChar(): Boolean = isLetterOrDigit() || this in setOf('_', '-', '.', '/', ':', '@')

data class TerminalCellPosition(val row: Int, val col: Int)

data class TerminalSelectionRange(val start: TerminalCellPosition, val end: TerminalCellPosition) {
    fun normalized(): TerminalSelectionRange {
        return if (start.row < end.row || (start.row == end.row && start.col <= end.col)) this else TerminalSelectionRange(end, start)
    }
}
