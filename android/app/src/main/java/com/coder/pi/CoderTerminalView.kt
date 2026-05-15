package com.coder.pi

import android.content.Context
import android.opengl.GLSurfaceView
import android.util.AttributeSet
import android.text.InputType
import android.view.MotionEvent
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.view.inputmethod.InputConnection
import java.io.File
import kotlin.math.roundToInt
import androidx.core.content.edit
import androidx.core.content.getSystemService

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
    private var shiftLatch = false
    private var ctrlLatch = false
    private var altLatch = false
    var onModifierLatchChanged: ((Boolean, Boolean, Boolean) -> Unit)? = null

    init {
        setEGLContextClientVersion(3)
        setRenderer(this)
        renderMode = RENDERMODE_CONTINUOUSLY
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun onSurfaceCreated(gl: javax.microedition.khronos.opengles.GL10?, config: javax.microedition.khronos.egl.EGLConfig?) {
        handle = native.nativeInit(80, 24, cellWidth, cellHeight, nativeToolPath("libbash.so"), nativeToolPath("libbusybox.so"), File(context.filesDir, "bin").absolutePath)
        native.nativeSetFont(handle, CoderFonts.bytes(context))
        applyTheme(CoderThemes.current(context))
        native.nativeSetRefreshRate(handle, display?.refreshRate ?: 60f)
        native.nativeSurfaceCreated(handle)
    }

    override fun onSurfaceChanged(gl: javax.microedition.khronos.opengles.GL10?, width: Int, height: Int) {
        surfaceWidth = width
        surfaceHeight = height
        native.nativeSurfaceChanged(handle, width, height, cellWidth, cellHeight)
    }

    override fun onDrawFrame(gl: javax.microedition.khronos.opengles.GL10?) {
        native.nativeDrawFrame(handle)
    }

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
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
        return true
    }

    override fun onGenericMotionEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_SCROLL) {
            val rows = event.getAxisValue(MotionEvent.AXIS_VSCROLL).toInt()
            if (rows != 0) native.nativeScroll(handle, -rows * 3)
            return true
        }
        return super.onGenericMotionEvent(event)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        requestFocus()
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastTouchY = event.y
                accumulatedScrollY = 0f
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                accumulatedScrollY += event.y - lastTouchY
                lastTouchY = event.y
                val rows = (accumulatedScrollY / cellHeight).toInt()
                if (rows != 0) {
                    native.nativeScroll(handle, -rows)
                    accumulatedScrollY -= rows * cellHeight
                }
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            adjustFontSize(1)
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            adjustFontSize(-1)
            return true
        }
        sendKey(keyCode, event.metaState, event.unicodeChar)
        return true
    }

    fun sendText(text: String) {
        if (handle == 0L || text.isEmpty()) return
        if (ctrlLatch && text.length == 1) {
            if (altLatch) native.nativeWrite(handle, byteArrayOf(0x1b))
            controlByte(text.first())?.let { native.nativeWrite(handle, byteArrayOf(it)) }
            shiftLatch = false
            ctrlLatch = false
            altLatch = false
            notifyModifierLatchChanged()
            return
        }
        if (altLatch) {
            native.nativeWrite(handle, byteArrayOf(0x1b))
        }
        val output = if (shiftLatch && text.length == 1) shiftedText(text.first()).toString() else text
        if (output.length == 1) native.nativeTextInput(handle, output)
        else native.nativeWrite(handle, output.toByteArray(Charsets.UTF_8))
        shiftLatch = false
        altLatch = false
        notifyModifierLatchChanged()
    }

    fun sendKey(keyCode: Int, metaState: Int = 0, unicodeChar: Int = 0) {
        if (handle == 0L) return
        var nextMetaState = metaState
        if (shiftLatch) nextMetaState = nextMetaState or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
        if (ctrlLatch) nextMetaState = nextMetaState or KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
        if (altLatch) nextMetaState = nextMetaState or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON
        if ((nextMetaState and KeyEvent.META_CTRL_ON) != 0) {
            controlByte(keyCode)?.let {
                if ((nextMetaState and KeyEvent.META_ALT_ON) != 0) native.nativeWrite(handle, byteArrayOf(0x1b))
                native.nativeWrite(handle, byteArrayOf(it))
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

    fun scrollRows(rowDelta: Int) {
        if (handle != 0L) native.nativeScroll(handle, rowDelta)
    }

    fun setKeyboardAvoidanceOffset(offset: Int) {
        translationY = -offset.toFloat()
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
        }
    }

    fun setFontFamily(key: String) {
        CoderFonts.setSelected(context, key)
        val bytes = CoderFonts.bytes(context, key)
        if (handle != 0L) queueEvent { native.nativeSetFont(handle, bytes) }
    }

    fun dispose() {
        if (handle != 0L) native.nativeDispose(handle)
        handle = 0L
    }

    fun applyTheme(theme: CoderTheme) {
        if (handle != 0L) native.nativeSetTheme(handle, theme.foreground, theme.background, theme.cursor, theme.cursorText, theme.palette)
    }

    private fun nativeToolPath(name: String): String {
        return File(context.applicationInfo.nativeLibraryDir, name).absolutePath
    }

    private fun controlByte(char: Char): Byte? {
        return when (char) {
            in 'a'..'z' -> ((char.uppercaseChar().code - '@'.code) and 0x1f).toByte()
            in 'A'..'Z' -> ((char.code - '@'.code) and 0x1f).toByte()
            '@', ' ' -> 0x00
            '[' -> 0x1b
            '\\' -> 0x1c
            ']' -> 0x1d
            '^' -> 0x1e
            '_', '/' -> 0x1f
            '?' -> 0x7f.toByte()
            else -> null
        }
    }

    private fun controlByte(keyCode: Int): Byte? {
        return when (keyCode) {
            in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> ((keyCode - KeyEvent.KEYCODE_A + 1) and 0x1f).toByte()
            KeyEvent.KEYCODE_SPACE -> 0x00
            KeyEvent.KEYCODE_LEFT_BRACKET -> 0x1b
            KeyEvent.KEYCODE_BACKSLASH -> 0x1c
            KeyEvent.KEYCODE_RIGHT_BRACKET -> 0x1d
            KeyEvent.KEYCODE_6 -> 0x1e
            KeyEvent.KEYCODE_MINUS, KeyEvent.KEYCODE_SLASH -> 0x1f
            KeyEvent.KEYCODE_DEL -> 0x7f.toByte()
            else -> null
        }
    }

    private fun shiftedText(char: Char): Char {
        return when (char) {
            in 'a'..'z' -> char.uppercaseChar()
            '1' -> '!'
            '2' -> '@'
            '3' -> '#'
            '4' -> '$'
            '5' -> '%'
            '6' -> '^'
            '7' -> '&'
            '8' -> '*'
            '9' -> '('
            '0' -> ')'
            '`' -> '~'
            '-' -> '_'
            '=' -> '+'
            '[' -> '{'
            ']' -> '}'
            '\\' -> '|'
            ';' -> ':'
            '\'' -> '"'
            ',' -> '<'
            '.' -> '>'
            '/' -> '?'
            else -> char
        }
    }

    private fun notifyModifierLatchChanged() {
        onModifierLatchChanged?.invoke(shiftLatch, ctrlLatch, altLatch)
    }
}
