package com.coder.pi

import android.animation.ValueAnimator
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.graphics.Color
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.content.ClipData
import android.content.Context
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.opengl.GLSurfaceView
import android.util.AttributeSet
import android.util.Base64
import android.util.TypedValue
import android.text.InputType
import android.widget.Toast
import android.view.MotionEvent
import android.view.KeyEvent
import android.view.ViewConfiguration
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.view.inputmethod.InputConnection
import kotlin.math.roundToInt
import kotlin.math.sqrt
import androidx.core.content.edit
import androidx.core.content.getSystemService
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.net.toUri
import java.net.URI
import java.net.URL
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicInteger

data class TerminalOscMetadata(val title: String, val pwd: String, val bellCount: Long)
data class TerminalNotificationContext(val workspaceId: String = "", val workspaceName: String = "", val workspaceDisplayName: String = "", val deepLink: String = "", val iconUri: String = "", val iconUrl: String = "", val terminalId: String = "")
data class TerminalGestureAction(val id: String, val label: String, val description: String)

private const val TerminalOscNotificationChannelId = TerminalNotificationFormat.defaultOscChannelId
private const val TerminalOscProgressNotificationChannelId = TerminalNotificationFormat.defaultProgressChannelId
private const val TerminalOscProgressNotificationId = TerminalNotificationFormat.progressBaseId
const val TerminalNotificationReplyAction = "com.coder.pi.TERMINAL_NOTIFICATION_REPLY"
const val TerminalNotificationReplyInputKey = "terminal_reply"
const val TerminalNotificationWorkspaceIdKey = "workspace_id"
const val TerminalNotificationTerminalIdKey = "terminal_id"
const val TerminalNotificationIdKey = "notification_id"

class CoderTerminalView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null, attachedEngine: TerminalEngine? = null) : GLSurfaceView(context, attrs), GLSurfaceView.Renderer, CoderTerminalEndpoint {
    private val preferences = context.getSharedPreferences("terminal", Context.MODE_PRIVATE)
    private var fontSizeSp = selectedTerminalFontSizeSp(context)
    private var cellHeight = terminalCellHeightForFontSize(context, fontSizeSp)
    private var cellWidth = terminalCellWidthForFontSize(cellHeight)
    internal val terminalEngine = attachedEngine ?: TerminalEngine(80, 24, cellWidth, cellHeight)
    private val engine = terminalEngine
    private var managerOwnsEngine = false
    private var rendererHandle = native.nativeInitRenderer()
    private val native: CoderNative get() = engine.native
    private var handle: Long
        get() = engine.handle
        set(value) { engine.handle = value }
    private var nativeFontKey: String? = null
    private var surfaceWidth = 0
    private var surfaceHeight = 0
    private var lastTouchX = 0f
    private var lastTouchY = 0f
    private var mouseTouchStartX = 0f
    private var mouseTouchStartY = 0f
    private var mouseTouchMoved = false
    private var touchStartX = 0f
    private var touchStartY = 0f
    private var touchMoved = false
    private var scrollDownGestureTriggered = false
    private var scrollSuppressedUntilTouchEnd = false
    private var lastTapUpMillis = 0L
    private var tapCount = 0
    private var pendingTapAction: Runnable? = null
    private var copyMode = false
    private var copySelectionStart: TerminalCellPosition? = null
    private var copySelectionEnd: TerminalCellPosition? = null
    private var accumulatedScrollY = 0f
    private var smoothScrollAnimator: ValueAnimator? = null
    private var smoothScrollPendingPixels = 0f
    private var smoothScrollGesturePixels = 0f
    private var smoothScrollVelocityPixelsPerMillis = 0f
    private var smoothScrollLastEventMillis = 0L
    private var mouseTrackingTouch = false
    private var pinchDistance = 0f
    private var pinchAccumulatedZoom = 1f
    private var shiftLatch = false
    private var ctrlLatch = false
    private var altLatch = false
    private var softwareKeyboardAllowed = false
    private var lastBellCount = 0L
    private var lastBellFeedbackMillis = 0L
    private var lastNotificationMillis = 0L
    private var progressStatusRunnable: Runnable? = null
    private var progressHapticRunnable: Runnable? = null
    private var activeProgressState: Int? = null
    private var activeProgressValue = 0
    private var activeProgressIndeterminate = true
    private var progressStatusIndex = 0
    private var notificationContext = TerminalNotificationContext()
    private var workspaceIconRequestInFlight = false
    private var workspaceIconCacheKey = ""
    private var workspaceIconCache: android.graphics.Bitmap? = null
    private var remoteInput: ((ByteArray) -> Unit)? = null
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    private val pendingRemoteOutput = mutableListOf<ByteArray>()
    override var onTerminalSizeChanged: ((Int, Int) -> Unit)? = null
    var onOscMetadataChanged: ((TerminalOscMetadata) -> Unit)? = null
    var onHyperlinkActivated: ((String) -> Unit)? = null
    var onModifierLatchChanged: ((Boolean, Boolean, Boolean) -> Unit)? = null
    var onToolbarActionsChanged: (() -> Unit)? = null
    var onNotificationPermissionNeeded: (() -> Unit)? = null

    init {
        registerTerminalView(this)
        setEGLContextClientVersion(3)
        preserveEGLContextOnPause = true
        setRenderer(this)
        renderMode = RENDERMODE_CONTINUOUSLY
        isFocusable = true
        isFocusableInTouchMode = true
        addOnLayoutChangeListener { view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            val width = right - left
            val height = bottom - top
            if (width != oldRight - oldLeft || height != oldBottom - oldTop) {
                cancelSmoothScrollState()
                view.post { refreshSurface() }
            }
        }
    }

    override fun onSurfaceCreated(gl: javax.microedition.khronos.opengles.GL10?, config: javax.microedition.khronos.egl.EGLConfig?) {
        if (handle == 0L) return
        if (rendererHandle == 0L) rendererHandle = native.nativeInitRenderer()
        native.nativeRendererSetShaderCacheDir(rendererHandle, context.cacheDir.resolve("shader-cache").apply { mkdirs() }.absolutePath)
        val selectedFontKey = CoderFonts.selectedKey(context)
        CoderFonts.styleBytes(context, selectedFontKey).let { native.nativeRendererSetFontStyles(rendererHandle, it.regular, it.bold, it.italic, it.boldItalic, it.fallback) }
        nativeFontKey = selectedFontKey
        applyTextOptions()
        applyTheme(CoderThemes.current(context))
        native.nativeRendererSetRefreshRate(rendererHandle, display?.refreshRate ?: 60f)
        native.nativeRendererSurfaceCreated(rendererHandle)
        flushPendingRemoteOutput()
    }

    override fun onSurfaceChanged(gl: javax.microedition.khronos.opengles.GL10?, width: Int, height: Int) {
        surfaceWidth = width
        surfaceHeight = height
        if (handle != 0L && rendererHandle != 0L) native.nativeRendererSurfaceChanged(handle, rendererHandle, width, height, cellWidth, cellHeight)
        notifyTerminalSizeChanged()
    }

    override fun onDrawFrame(gl: javax.microedition.khronos.opengles.GL10?) {
        if (handle != 0L && rendererHandle != 0L) native.nativeRendererDrawFrame(handle, rendererHandle)
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
            if (rows != 0) scrollTerminal(-rows * 3, event.x, event.y)
            return true
        }
        return super.onGenericMotionEvent(event)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        requestFocus()
        if (event.pointerCount >= 2 && gestureEnabled("pinch_font_size")) {
            val distance = pointerDistance(event)
            when (event.actionMasked) {
                MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_DOWN -> {
                    pinchDistance = distance
                    pinchAccumulatedZoom = 1f
                }
                MotionEvent.ACTION_MOVE -> {
                    if (pinchDistance > 0f && distance > 0f) {
                        pinchAccumulatedZoom *= distance / pinchDistance
                        pinchDistance = distance
                        when {
                            pinchAccumulatedZoom >= 1.12f -> {
                                adjustFontSize(1)
                                pinchAccumulatedZoom = 1f
                            }
                            pinchAccumulatedZoom <= 0.88f -> {
                                adjustFontSize(-1)
                                pinchAccumulatedZoom = 1f
                            }
                        }
                    }
                }
            }
            return true
        }
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastTouchX = event.x
                lastTouchY = event.y
                touchStartX = event.x
                touchStartY = event.y
                touchMoved = false
                scrollDownGestureTriggered = false
                scrollSuppressedUntilTouchEnd = false
                accumulatedScrollY = 0f
                beginSmoothScrollGesture()
                if (copyMode) {
                    val start = screenPositionAt(event.x, event.y) ?: return true
                    copySelectionStart = start
                    copySelectionEnd = start
                    updateNativeSelection()
                    return true
                }
                if (terminalMouseTrackingActive()) {
                    mouseTrackingTouch = true
                    mouseTouchStartX = event.x
                    mouseTouchStartY = event.y
                    mouseTouchMoved = false
                    return true
                }
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val deltaY = event.y - lastTouchY
                val totalDeltaX = event.x - touchStartX
                val totalDeltaY = event.y - touchStartY
                if (totalDeltaX * totalDeltaX + totalDeltaY * totalDeltaY > touchSlop * touchSlop) touchMoved = true
                if (!scrollDownGestureTriggered && totalDeltaY > touchSlop * 5 && kotlin.math.abs(totalDeltaY) > kotlin.math.abs(totalDeltaX) * 1.4f) {
                    scrollDownGestureTriggered = true
                    if (performGestureAction(selectedGestureAction("scroll_down", "dismiss_keyboard"))) {
                        scrollSuppressedUntilTouchEnd = true
                        cancelSmoothScrollState()
                    }
                }
                if (scrollSuppressedUntilTouchEnd) return true
                if (copyMode) {
                    val edgeRows = copyModeEdgeScrollRows(event.y)
                    if (edgeRows != 0) scrollViewportRows(edgeRows)
                    copySelectionEnd = screenPositionAt(event.x, event.y) ?: copySelectionEnd
                    updateNativeSelection()
                    return true
                }
                if (mouseTrackingTouch) {
                    val distanceX = event.x - mouseTouchStartX
                    val distanceY = event.y - mouseTouchStartY
                    if (mouseTouchMoved || distanceX * distanceX + distanceY * distanceY > touchSlop * touchSlop) {
                        mouseTouchMoved = true
                        lastTouchX = event.x
                        lastTouchY = event.y
                        if (smoothScrollEnabled()) scrollPixels(deltaY) else {
                            accumulatedScrollY += deltaY
                            val rows = (accumulatedScrollY / cellHeight).toInt()
                            if (rows != 0) {
                                scrollRows(-rows)
                                accumulatedScrollY -= rows * cellHeight
                            }
                        }
                    }
                    return true
                }
                if (!gestureEnabled("drag_scroll")) return true
                lastTouchX = event.x
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
                pinchDistance = 0f
                pinchAccumulatedZoom = 1f
                scrollSuppressedUntilTouchEnd = false
                if (copyMode) {
                    if (event.actionMasked == MotionEvent.ACTION_UP) copySelectionEnd = screenPositionAt(event.x, event.y) ?: copySelectionEnd
                    updateNativeSelection()
                    endSmoothScrollGesture()
                    return true
                }
                if (mouseTrackingTouch) {
                    if (mouseTouchMoved) endSmoothScrollGesture() else if (event.actionMasked == MotionEvent.ACTION_UP && openHyperlinkAt(event.x, event.y)) {
                        endSmoothScrollGesture()
                    } else {
                        sendMouseEvent(0, mouseTouchStartX, mouseTouchStartY, 1, event.metaState)
                        sendMouseEvent(1, event.x, event.y, 1, event.metaState)
                    }
                    mouseTrackingTouch = false
                    mouseTouchMoved = false
                    return true
                }
                if (event.actionMasked == MotionEvent.ACTION_UP && !touchMoved && openHyperlinkAt(event.x, event.y)) return true
                if (event.actionMasked == MotionEvent.ACTION_UP && !touchMoved) handleTerminalTap()
                if (event.actionMasked == MotionEvent.ACTION_UP && touchMoved) handleTerminalSwipe(event.x - touchStartX, event.y - touchStartY)
                endSmoothScrollGesture()
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    private fun pointerDistance(event: MotionEvent): Float {
        if (event.pointerCount < 2) return 0f
        val deltaX = event.getX(0) - event.getX(1)
        val deltaY = event.getY(0) - event.getY(1)
        return sqrt(deltaX * deltaX + deltaY * deltaY)
    }

    fun handleTerminalTap() {
        val now = System.currentTimeMillis()
        if (now - lastTapUpMillis > ViewConfiguration.getDoubleTapTimeout()) tapCount = 0
        lastTapUpMillis = now
        tapCount++
        pendingTapAction?.let { removeCallbacks(it) }
        pendingTapAction = null
        when (tapCount) {
            1 -> {
                val action = Runnable {
                    performGestureAction(selectedGestureAction("single_tap", "no_action"))
                    tapCount = 0
                    pendingTapAction = null
                }
                pendingTapAction = action
                postDelayed(action, ViewConfiguration.getDoubleTapTimeout().toLong())
            }
            2 -> {
                performGestureAction(selectedGestureAction("double_tap", "paste"))
                pendingTapAction = null
            }
            else -> {
                performGestureAction(selectedGestureAction("triple_tap", "no_action"))
                tapCount = 0
                pendingTapAction = null
            }
        }
    }

    fun handleTerminalSwipe(deltaX: Float, deltaY: Float) {
        if (kotlin.math.abs(deltaX) < touchSlop * 6 || kotlin.math.abs(deltaX) < kotlin.math.abs(deltaY) * 1.35f) return
        when (selectedGestureAction("swipe", "switch_tmux_window")) {
            "switch_tmux_window" -> sendText(if (deltaX < 0f) "\u0002n" else "\u0002p")
            else -> performGestureAction(selectedGestureAction("swipe", "switch_tmux_window"))
        }
    }

    fun copyModeActive(): Boolean = copyMode

    fun setCopyModeActive(active: Boolean) {
        copyMode = active
        if (!active) clearCopySelection()
        context.getSystemService<InputMethodManager>()?.hideSoftInputFromWindow(windowToken, 0)
        clearFocus()
    }

    fun toggleCopyMode(): Boolean {
        setCopyModeActive(!copyMode)
        return copyMode
    }

    fun clearCopySelection() {
        copySelectionStart = null
        copySelectionEnd = null
        if (handle != 0L) native.nativeSetSelection(handle, false, 0, 0, 0, 0)
        requestRender()
    }

    fun copySelectionToClipboard(): Boolean {
        if (handle == 0L || copySelectionStart == null || copySelectionEnd == null) return false
        val selectedText = native.nativeCopySelection(handle).trimEnd()
        if (selectedText.isBlank()) return false
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Terminal selection", selectedText))
        setCopyModeActive(false)
        return true
    }

    private fun screenPositionAt(x: Float, y: Float): TerminalCellPosition? {
        if (handle == 0L) return null
        val position = cellAt(x, y)
        val result = native.nativeScreenPositionFromViewport(handle, position.row, position.col)
        if (result.size < 2 || result[0] < 0 || result[1] < 0) return null
        return TerminalCellPosition(result[0], result[1])
    }

    private fun updateNativeSelection() {
        val start = copySelectionStart ?: return
        val end = copySelectionEnd ?: start
        if (handle != 0L) native.nativeSetSelection(handle, true, start.row, start.col, end.row, end.col)
        requestRender()
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
        if (smooth && smoothScrollEnabled()) scrollPixels(-rowDelta * cellHeight.toFloat()) else scrollTerminal(rowDelta, lastTouchX, lastTouchY)
    }

    fun scrollRowHeight(): Int = cellHeight.coerceAtLeast(1)

    private fun scrollViewportRows(rowDelta: Int) {
        if (handle == 0L || rowDelta == 0) return
        native.nativeScroll(handle, rowDelta.coerceIn(-12, 12))
    }

    private fun copyModeEdgeScrollRows(y: Float): Int {
        val rowHeight = scrollRowHeight().toFloat()
        val edgeSize = (rowHeight * 1.5f).coerceAtLeast(48f)
        return when {
            y < edgeSize -> -((((edgeSize - y) / rowHeight).toInt() + 1).coerceIn(1, 6))
            surfaceHeight > 0 && y > surfaceHeight - edgeSize -> ((((y - (surfaceHeight - edgeSize)) / rowHeight).toInt() + 1).coerceIn(1, 6))
            else -> 0
        }
    }

    fun beginSmoothScrollGesture() {
        cancelSmoothScrollState()
        smoothScrollLastEventMillis = android.os.SystemClock.uptimeMillis()
    }

    private fun cancelSmoothScrollState() {
        smoothScrollAnimator?.cancel()
        smoothScrollAnimator = null
        smoothScrollGesturePixels = 0f
        smoothScrollVelocityPixelsPerMillis = 0f
        smoothScrollPendingPixels = 0f
        accumulatedScrollY = 0f
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
        scrollTerminal(-rows, lastTouchX, lastTouchY)
        smoothScrollPendingPixels -= rows * cellHeight
    }

    private fun scrollTerminal(rowDelta: Int, x: Float = 0f, y: Float = 0f) {
        if (handle == 0L || rowDelta == 0) return
        val output = native.nativeScrollInput(handle, rowDelta.coerceIn(-12, 12), x, y)
        if (output.isNotEmpty()) writeInput(output)
    }

    private fun sendMouseEvent(action: Int, x: Float, y: Float, button: Int, metaState: Int): Boolean {
        val tracking = handle != 0L && remoteInput != null && native.nativeMouseTracking(handle)
        if (!tracking) return false
        val output = native.nativeMouseEvent(handle, action, x, y, button, metaState)
        if (output.isEmpty()) return false
        remoteInput?.invoke(output)
        return true
    }

    fun terminalMouseTrackingActive(): Boolean {
        return handle != 0L && remoteInput != null && native.nativeMouseTracking(handle)
    }

    override fun terminalColumns(): Int = if (cellWidth > 0) surfaceWidth / cellWidth else 0

    override fun terminalRows(): Int = if (cellHeight > 0) surfaceHeight / cellHeight else 0

    fun cellAt(x: Float, y: Float): TerminalCellPosition {
        val col = if (cellWidth > 0) (x / cellWidth).toInt().coerceIn(0, (terminalColumns() - 1).coerceAtLeast(0)) else 0
        val row = if (cellHeight > 0) (y / cellHeight).toInt().coerceIn(0, (terminalRows() - 1).coerceAtLeast(0)) else 0
        return TerminalCellPosition(row, col)
    }

    fun hyperlinkUriAt(position: TerminalCellPosition): String {
        if (handle == 0L) return ""
        return native.nativeHyperlinkUriAt(handle, position.row, position.col)
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
            if (surfaceWidth == width && surfaceHeight == height) {
                requestRender()
                return
            }
            surfaceWidth = width
            surfaceHeight = height
            queueEvent { if (rendererHandle != 0L) native.nativeRendererSurfaceChanged(handle, rendererHandle, width, height, cellWidth, cellHeight) }
            notifyTerminalSizeChanged()
            requestRender()
        }
    }

    fun forceRefreshSurface() {
        if (handle != 0L && width > 0 && height > 0) {
            surfaceWidth = width
            surfaceHeight = height
            queueEvent { if (rendererHandle != 0L) native.nativeRendererSurfaceChanged(handle, rendererHandle, width, height, cellWidth, cellHeight) }
            notifyTerminalSizeChanged()
            requestRender()
        }
    }

    fun adjustFontSize(delta: Int) {
        val nextSizeSp = (fontSizeSp + delta).coerceIn(8, 32)
        val maxHeight = if (surfaceHeight > 0) (surfaceHeight / 8).coerceAtLeast(8) else Int.MAX_VALUE
        val nextHeight = terminalCellHeightForFontSize(context, nextSizeSp).coerceAtMost(maxHeight)
        fontSizeSp = nextSizeSp
        cellHeight = nextHeight
        cellWidth = terminalCellWidthForFontSize(nextHeight)
        preferences.edit { putInt("fontSizeSp", fontSizeSp).putInt("cellWidth", cellWidth).putInt("cellHeight", cellHeight) }
        if (handle != 0L && surfaceWidth > 0 && surfaceHeight > 0) {
            queueEvent { if (rendererHandle != 0L) native.nativeRendererSurfaceChanged(handle, rendererHandle, surfaceWidth, surfaceHeight, cellWidth, cellHeight) }
            notifyTerminalSizeChanged()
        }
    }

    fun fontSizePoints(): Int {
        return fontSizeSp.coerceIn(8, 32)
    }

    fun setFontSizePoints(points: Int) {
        val nextSizeSp = points.coerceIn(8, 32)
        val nextHeight = terminalCellHeightForFontSize(context, nextSizeSp)
        val nextWidth = terminalCellWidthForFontSize(nextHeight)
        fontSizeSp = nextSizeSp
        cellHeight = nextHeight
        cellWidth = nextWidth
        preferences.edit { putInt("fontSizeSp", fontSizeSp).putInt("cellWidth", cellWidth).putInt("cellHeight", cellHeight) }
        if (handle != 0L && surfaceWidth > 0 && surfaceHeight > 0) {
            queueEvent { if (rendererHandle != 0L) native.nativeRendererSurfaceChanged(handle, rendererHandle, surfaceWidth, surfaceHeight, cellWidth, cellHeight) }
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
        if (nativeFontKey == key) return
        val bytes = CoderFonts.styleBytes(context, key)
        if (handle != 0L) {
            nativeFontKey = key
            queueEvent { if (rendererHandle != 0L) native.nativeRendererSetFontStyles(rendererHandle, bytes.regular, bytes.bold, bytes.italic, bytes.boldItalic, bytes.fallback) }
        }
    }

    fun dispose() {
        unregisterTerminalView(this)
        if (rendererHandle != 0L) {
            val handleToDispose = rendererHandle
            runCatching { queueEvent { native.nativeDisposeRenderer(handleToDispose) } }
                .onFailure { native.nativeDisposeRenderer(handleToDispose) }
        }
        rendererHandle = 0L
        if (!managerOwnsEngine) engine.dispose()
        nativeFontKey = null
    }

    fun releaseEngineOwnershipToManager() {
        managerOwnsEngine = true
    }

    fun disposeManagerOwnedEngine() {
        managerOwnsEngine = false
        engine.dispose()
        nativeFontKey = null
    }

    fun applyTheme(theme: CoderTheme) {
        if (handle != 0L) native.nativeSetTerminalTheme(handle, theme.foreground, theme.background, theme.cursor, theme.selectionBackground, theme.palette)
        if (rendererHandle != 0L) native.nativeRendererSetTheme(rendererHandle, theme.background, theme.cursor, theme.cursorText)
    }

    fun setLigaturesEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("ligatures", enabled) }
        applyTextOptions()
    }

    fun ligaturesEnabled(): Boolean = preferences.getBoolean("ligatures", true)

    fun setContextualAlternatesEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("contextualAlternates", enabled) }
        applyTextOptions()
    }

    fun contextualAlternatesEnabled(): Boolean = preferences.getBoolean("contextualAlternates", true)

    fun setSlashedZeroEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("slashedZero", enabled) }
        applyTextOptions()
    }

    fun slashedZeroEnabled(): Boolean = preferences.getBoolean("slashedZero", true)

    fun setStylisticSet1Enabled(enabled: Boolean) {
        preferences.edit { putBoolean("stylisticSet1", enabled) }
        applyTextOptions()
    }

    fun stylisticSet1Enabled(): Boolean = preferences.getBoolean("stylisticSet1", false)

    fun setStylisticSet2Enabled(enabled: Boolean) {
        preferences.edit { putBoolean("stylisticSet2", enabled) }
        applyTextOptions()
    }

    fun stylisticSet2Enabled(): Boolean = preferences.getBoolean("stylisticSet2", false)

    fun setCharacterVariant1Enabled(enabled: Boolean) {
        preferences.edit { putBoolean("characterVariant1", enabled) }
        applyTextOptions()
    }

    fun characterVariant1Enabled(): Boolean = preferences.getBoolean("characterVariant1", false)

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

    fun selectedGestureAction(gesture: String, defaultAction: String): String = preferences.getString("gesture.action.$gesture", defaultAction).orEmpty().ifBlank { defaultAction }

    fun setGestureAction(gesture: String, action: String) {
        preferences.edit { putString("gesture.action.$gesture", action) }
        when (gesture to action) {
            "swipe" to "switch_tmux_window" -> setGestureEnabled("swipe_session_switch", true)
            "swipe" to "no_action" -> setGestureEnabled("swipe_session_switch", false)
            "pinch" to "adjust_font_size" -> setGestureEnabled("pinch_font_size", true)
            "pinch" to "no_action" -> setGestureEnabled("pinch_font_size", false)
            "scroll_down" to "dismiss_keyboard" -> setGestureEnabled("drag_scroll", true)
        }
    }

    fun performGestureAction(action: String): Boolean {
        return when (action) {
            "paste" -> pasteFromClipboard()
            "dismiss_keyboard" -> {
                cancelSmoothScrollState()
                context.getSystemService<InputMethodManager>()?.hideSoftInputFromWindow(windowToken, 0)
                clearFocus()
                post { forceRefreshSurface() }
                postDelayed({ forceRefreshSurface() }, 180L)
                postDelayed({ forceRefreshSurface() }, 360L)
                true
            }
            "send_escape" -> { sendKey(KeyEvent.KEYCODE_ESCAPE); true }
            "send_tab" -> { sendKey(KeyEvent.KEYCODE_TAB); true }
            "send_enter" -> { sendKey(KeyEvent.KEYCODE_ENTER); true }
            "backspace" -> { sendKey(KeyEvent.KEYCODE_DEL); true }
            "ctrl_c" -> { sendKey(KeyEvent.KEYCODE_C, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON); true }
            "tmux_pane_zoom" -> { sendText("\u0002z"); true }
            "switch_tmux_window" -> { sendText("\u0002n"); true }
            "lock_ctrl" -> { toggleCtrlLatch(); true }
            "toggle_keyboard" -> false
            "open_switcher" -> false
            "minimize_session" -> false
            "toggle_shortcuts_panel" -> false
            "lock_shortcuts_panel" -> false
            "open_speech_settings" -> false
            "custom_shortcut", "session_switcher", "adjust_font_size", "hide", "no_action" -> false
            else -> false
        }
    }

    fun setChatModeEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("chat_mode", enabled) }
        setToolbarActionVisible("chat", enabled)
    }

    fun chatModeEnabled(): Boolean = preferences.getBoolean("chat_mode", true)

    fun setChatAutoSendEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("chat_auto_send", enabled) }
    }

    fun chatAutoSendEnabled(): Boolean = preferences.getBoolean("chat_auto_send", true)

    fun setKeyboardPasteEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("keyboard_paste", enabled) }
    }

    fun keyboardPasteEnabled(): Boolean = preferences.getBoolean("keyboard_paste", true)

    fun setOscNotificationsEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("osc.notifications", enabled) }
    }

    fun oscNotificationsEnabled(): Boolean = preferences.getBoolean("osc.notifications", true)

    fun setOscNotificationAlertsEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("osc.notifications.alerts", enabled) }
    }

    fun oscNotificationAlertsEnabled(): Boolean = preferences.getBoolean("osc.notifications.alerts", true)

    fun setOscNotificationProgressEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("osc.notifications.progress", enabled) }
    }

    fun oscNotificationProgressEnabled(): Boolean = preferences.getBoolean("osc.notifications.progress", true)

    fun setOscNotificationToastsEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("osc.notifications.toasts", enabled) }
    }

    fun oscNotificationToastsEnabled(): Boolean = preferences.getBoolean("osc.notifications.toasts", true)

    fun setOscNotificationIconStyle(style: String) {
        preferences.edit { putString("osc.notifications.icon", style) }
    }

    fun oscNotificationIconStyle(): String = preferences.getString("osc.notifications.icon", "pi").orEmpty().ifBlank { "pi" }

    fun setOscProgressHapticPattern(pattern: String) {
        preferences.edit { putString("osc.progress.haptic.pattern", pattern) }
    }

    fun oscProgressHapticPattern(): String = preferences.getString("osc.progress.haptic.pattern", "ripple").orEmpty().ifBlank { "ripple" }

    fun previewOscProgressHapticPattern(pattern: String) {
        vibrateProgressPattern(pattern)
    }

    fun setNotificationContext(context: TerminalNotificationContext) {
        notificationContext = context.copy(
            workspaceId = context.workspaceId.take(128),
            workspaceName = context.workspaceName.take(128),
            workspaceDisplayName = context.workspaceDisplayName.take(128),
            deepLink = context.deepLink.take(2048),
            iconUri = context.iconUri.take(2048),
            iconUrl = context.iconUrl.take(2048),
            terminalId = context.terminalId.take(256),
        )
        workspaceIconCacheKey = ""
        workspaceIconCache = null
        synchronized(terminalNotificationTargets) {
            terminalNotificationTargets[notificationContext.workspaceId] = WeakReference(this)
            terminalNotificationTargets[notificationContext.terminalId] = WeakReference(this)
        }
    }

    fun notificationContextSnapshot(): TerminalNotificationContext? = notificationContext.takeIf { it.terminalId.isNotBlank() }

    fun setVolumeFontSizeEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("volume_font_size", enabled) }
    }

    fun volumeFontSizeEnabled(): Boolean = preferences.getBoolean("volume_font_size", true)

    fun setKeepScreenAwakeEnabled(enabled: Boolean) {
        preferences.edit { putBoolean("keep_screen_awake", enabled) }
    }

    fun keepScreenAwakeEnabled(): Boolean = preferences.getBoolean("keep_screen_awake", false)

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
        if (rendererHandle != 0L) native.nativeRendererSetTextOptions(rendererHandle, ligaturesEnabled(), contextualAlternatesEnabled(), slashedZeroEnabled(), stylisticSet1Enabled(), stylisticSet2Enabled(), characterVariant1Enabled(), cursorBlinkEnabled(), cursorMode())
    }

    override fun attachRemote(input: (ByteArray) -> Unit) {
        remoteInput = input
    }

    override fun detachRemote() {
        remoteInput = null
    }

    override fun feedRemoteOutput(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        if (handle == 0L) {
            pendingRemoteOutput.add(bytes)
            return
        }
        queueEvent {
            native.nativeFeed(handle, bytes)
            post { notifyOscMetadataChanged() }
        }
    }

    private fun flushPendingRemoteOutput() {
        if (handle == 0L || pendingRemoteOutput.isEmpty()) return
        val outputs = pendingRemoteOutput.toList()
        pendingRemoteOutput.clear()
        queueEvent {
            outputs.forEach { native.nativeFeed(handle, it) }
            post { notifyOscMetadataChanged() }
        }
    }

    override fun sendInput(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        remoteInput?.let { it(bytes); return }
        native.nativeWrite(handle, bytes)
    }

    private fun writeInput(bytes: ByteArray) = sendInput(bytes)

    private fun notifyModifierLatchChanged() {
        onModifierLatchChanged?.invoke(shiftLatch, ctrlLatch, altLatch)
    }

    private fun notifyTerminalSizeChanged() {
        val columns = terminalColumns()
        val rows = terminalRows()
        if (columns > 0 && rows > 0) onTerminalSizeChanged?.invoke(columns, rows)
    }

    private fun notifyOscMetadataChanged() {
        if (handle == 0L) return
        val metadata = TerminalOscMetadata(native.nativeTitle(handle), native.nativePwd(handle), native.nativeBellCount(handle))
        if (metadata.bellCount > lastBellCount) {
            val now = System.currentTimeMillis()
            if (now - lastBellFeedbackMillis >= 1000L) {
                performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
                lastBellFeedbackMillis = now
            }
            lastBellCount = metadata.bellCount
        }
        native.nativeConsumeOscEvents(handle).forEach { handleOscEvent(it) }
        onOscMetadataChanged?.invoke(metadata)
    }

    private fun handleOscEvent(event: String) {
        val parts = event.split("\t", limit = 3)
        when (parts.getOrNull(0)) {
            "clipboard" -> handleOscClipboard(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
            "notification" -> handleOscNotification(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
            "progress" -> handleOscProgress(parts.getOrNull(1).orEmpty(), parts.getOrNull(2).orEmpty())
        }
    }

    private fun handleOscClipboard(kind: String, data: String) {
        if (kind.none { it == 'c' || it == 's' || it == 'p' }) return
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        when {
            data == "?" -> {
                val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty().take(4096)
                val encoded = Base64.encodeToString(text.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                writeInput("\u001b]52;c;$encoded\u0007".toByteArray(Charsets.UTF_8))
            }
            data.isEmpty() -> clipboard.setPrimaryClip(ClipData.newPlainText("Terminal clipboard", ""))
            data.length <= 8192 -> runCatching {
                val decoded = Base64.decode(data, Base64.DEFAULT).toString(Charsets.UTF_8).take(4096)
                clipboard.setPrimaryClip(ClipData.newPlainText("Terminal clipboard", decoded))
            }
        }
    }

    private fun handleOscNotification(title: String, body: String) {
        val message = listOf(title, body).filter { it.isNotBlank() }.joinToString(" · ").take(256)
        if (message.isBlank()) return
        val now = System.currentTimeMillis()
        if (now - lastNotificationMillis < 3000L) return
        lastNotificationMillis = now
        if (!oscNotificationsEnabled() || !oscNotificationAlertsEnabled() || !postOscNotification(formatNotificationText(title), formatNotificationText(body), false, -1, false)) {
            if (oscNotificationToastsEnabled()) Toast.makeText(context, message, Toast.LENGTH_LONG).show()
        }
    }

    private fun formatNotificationText(text: String): String = TerminalNotificationFormat.cleanText(text)

    private fun handleOscProgress(stateText: String, valueText: String) {
        if (!oscNotificationsEnabled() || !oscNotificationProgressEnabled()) return
        val state = stateText.toIntOrNull() ?: return
        if (state == 0) {
            stopProgressStatusUpdates()
            NotificationManagerCompat.from(context).cancel(oscProgressNotificationId())
            return
        }
        val value = valueText.toIntOrNull()?.coerceIn(0, 100) ?: 0
        val indeterminate = state == 3 || valueText.isBlank()
        activeProgressState = state
        activeProgressValue = value
        activeProgressIndeterminate = indeterminate
        postOscProgressNotification(currentTerminalTitle(), nextProgressStatusText(), state, value, indeterminate)
        scheduleProgressStatusUpdate()
        scheduleProgressHapticPulse()
    }

    private fun currentTerminalTitle(): String = if (handle == 0L) "Terminal" else native.nativeTitle(handle).ifBlank { "Terminal" }.take(128)

    private fun nextProgressStatusText(): String {
        val messages = WhimsicalStatusMessages.working
        val message = messages[progressStatusIndex % messages.size]
        progressStatusIndex = (progressStatusIndex + 1) % messages.size
        return message
    }

    private fun postOscProgressNotification(title: String, body: String, state: Int, progress: Int, indeterminate: Boolean): Boolean {
        if (Build.VERSION.SDK_INT >= 36 && postNativeProgressNotification(title, body, state, progress, indeterminate)) return true
        return postOscNotification(title, body, state == 1 || state == 3 || state == 4, progress, indeterminate, oscProgressNotificationId())
    }

    private fun scheduleProgressStatusUpdate() {
        progressStatusRunnable?.let { removeCallbacks(it) }
        val runnable = Runnable {
            val state = activeProgressState ?: return@Runnable
            postOscProgressNotification(currentTerminalTitle(), nextProgressStatusText(), state, activeProgressValue, activeProgressIndeterminate)
            scheduleProgressStatusUpdate()
        }
        progressStatusRunnable = runnable
        postDelayed(runnable, 15_000L)
    }

    private fun stopProgressStatusUpdates() {
        progressStatusRunnable?.let { removeCallbacks(it) }
        progressHapticRunnable?.let { removeCallbacks(it) }
        progressStatusRunnable = null
        progressHapticRunnable = null
        activeProgressState = null
    }

    private fun scheduleProgressHapticPulse() {
        progressHapticRunnable?.let { removeCallbacks(it) }
        if (activeProgressState == null) return
        val runnable = Runnable {
            if (activeProgressState != null && isShown && hasWindowFocus()) {
                vibrateProgressPattern(oscProgressHapticPattern())
            }
            scheduleProgressHapticPulse()
        }
        progressHapticRunnable = runnable
        postDelayed(runnable, 1800L)
    }

    private fun vibrateProgressPattern(pattern: String) {
        val vibrator = if (Build.VERSION.SDK_INT >= 31) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Vibrator::class.java)
        } ?: return
        if (!vibrator.hasVibrator()) return
        val timings = progressHapticPatternTimings(pattern)
        val amplitudes = progressHapticPatternAmplitudes(pattern)
        if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(timings, amplitudes, -1)) else @Suppress("DEPRECATION") vibrator.vibrate(timings, -1)
    }

    private fun progressHapticPatternTimings(pattern: String): LongArray = when (pattern) {
        "heartbeat" -> longArrayOf(0, 38, 72, 58, 180, 32)
        "spark" -> longArrayOf(0, 18, 34, 18, 34, 26, 80, 18)
        "wave" -> longArrayOf(0, 28, 52, 42, 52, 58, 52, 42)
        "typewriter" -> longArrayOf(0, 14, 42, 14, 42, 14, 42, 36)
        else -> longArrayOf(0, 24, 46, 34, 70, 46)
    }

    private fun progressHapticPatternAmplitudes(pattern: String): IntArray = when (pattern) {
        "heartbeat" -> intArrayOf(0, 160, 0, 225, 0, 110)
        "spark" -> intArrayOf(0, 90, 0, 130, 0, 190, 0, 110)
        "wave" -> intArrayOf(0, 75, 0, 120, 0, 180, 0, 105)
        "typewriter" -> intArrayOf(0, 120, 0, 120, 0, 120, 0, 185)
        else -> intArrayOf(0, 80, 0, 135, 0, 190)
    }

    private fun postNativeProgressNotification(title: String, body: String, state: Int, progress: Int, indeterminate: Boolean): Boolean {
        ensureOscProgressNotificationChannel()
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            onNotificationPermissionNeeded?.invoke()
            return false
        }
        val channelId = oscProgressNotificationChannelId()
        val launchIntent = terminalNotificationLaunchIntent()
        val pendingIntent = PendingIntent.getActivity(context, notificationContext.deepLink.hashCode(), launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notificationBody = body.ifBlank { title }.take(512)
        val style = android.app.Notification.ProgressStyle()
            .setStyledByProgress(true)
            .setProgress(if (indeterminate) 0 else progress.coerceIn(0, 100))
            .setProgressSegments(listOf(android.app.Notification.ProgressStyle.Segment(100).setColor(if (state == 2) Color.RED else Color.rgb(125, 92, 255))))
        val builder = android.app.Notification.Builder(context, channelId)
            .setSmallIcon(oscNotificationIconRes())
            .setContentTitle(progressNotificationTitle(title))
            .setContentText(notificationBody)
            .setSubText(workspaceNotificationLabel())
            .setContentIntent(pendingIntent)
            .setOngoing(state == 1 || state == 3 || state == 4)
            .setAutoCancel(false)
            .setRequestPromotedOngoing(state == 1 || state == 3 || state == 4)
            .setShortCriticalText(body.take(7))
            .setStyle(style)
            .addAction(android.app.Notification.Action.Builder(oscNotificationIconRes(), "Open terminal", pendingIntent).build())
        builder.setLargeIcon(workspaceNotificationIcon())
        NotificationManagerCompat.from(context).notify(oscProgressNotificationId(), builder.build())
        return true
    }

    private fun postOscNotification(title: String, body: String, ongoing: Boolean, progress: Int, indeterminate: Boolean, notificationId: Int = if (ongoing) oscProgressNotificationId() else nextTerminalNotificationId()): Boolean {
        if (notificationId == oscProgressNotificationId()) ensureOscProgressNotificationChannel() else ensureOscNotificationChannel()
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            onNotificationPermissionNeeded?.invoke()
            return false
        }
        val channelId = if (notificationId == oscProgressNotificationId()) oscProgressNotificationChannelId() else oscNotificationChannelId()
        val launchIntent = terminalNotificationLaunchIntent()
        val pendingIntent = PendingIntent.getActivity(context, notificationContext.deepLink.hashCode(), launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notificationBody = body.ifBlank { title }.take(512)
        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(oscNotificationIconRes())
            .setContentTitle(progressNotificationTitle(title))
            .setContentText(notificationBody)
            .setSubText(workspaceNotificationLabel())
            .setContentIntent(pendingIntent)
            .setOngoing(ongoing)
            .setAutoCancel(true)
            .setGroup(terminalNotificationGroupKey())
            .addAction(oscNotificationIconRes(), "Open terminal", pendingIntent)
            .addAction(replyNotificationAction(notificationId))
        if (!ongoing) TerminalNotificationBehavior.applyAlertDefaults(builder)
        workspaceIconBitmap(localOnly = notificationId == oscProgressNotificationId())?.let { builder.setLargeIcon(it) }
        if (ongoing) builder.setProgress(100, progress.coerceIn(0, 100), indeterminate) else builder.setStyle(NotificationCompat.BigTextStyle().bigText(notificationBody))
        if (!ongoing) TerminalNotificationBehavior.wakeScreen(context)
        NotificationManagerCompat.from(context).notify(notificationId, builder.build())
        return true
    }

    private fun replyNotificationAction(notificationId: Int): NotificationCompat.Action {
        val input = androidx.core.app.RemoteInput.Builder(TerminalNotificationReplyInputKey).setLabel("Follow up").build()
        val intent = Intent(context, TerminalNotificationReplyReceiver::class.java).setAction(TerminalNotificationReplyAction).putExtra(TerminalNotificationWorkspaceIdKey, notificationContext.workspaceId).putExtra(TerminalNotificationTerminalIdKey, notificationContext.terminalId).putExtra(TerminalNotificationIdKey, notificationId)
        val pendingIntent = PendingIntent.getBroadcast(context, notificationId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        return NotificationCompat.Action.Builder(oscNotificationIconRes(), "Follow up", pendingIntent).addRemoteInput(input).setAllowGeneratedReplies(false).build()
    }

    private fun terminalNotificationLaunchIntent(): Intent = ((if (notificationContext.deepLink.isBlank()) context.packageManager.getLaunchIntentForPackage(context.packageName) else Intent(Intent.ACTION_VIEW, notificationContext.deepLink.toUri(), context, MainActivity::class.java)) ?: Intent(context, MainActivity::class.java)).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }

    private fun progressNotificationTitle(title: String): String {
        return title.ifBlank { "Terminal" }.take(128)
    }

    private fun workspaceNotificationLabel(): String = TerminalNotificationFormat.workspaceLabel(notificationContext)

    private fun terminalNotificationGroupKey(): String = TerminalNotificationFormat.groupKey(notificationContext, context.packageName)

    private fun workspaceNotificationIcon(): Icon {
        val workspaceBitmap = workspaceIconBitmap(localOnly = true)
        return if (workspaceBitmap != null) Icon.createWithBitmap(workspaceBitmap) else Icon.createWithResource(context, R.mipmap.ic_launcher)
    }

    private fun ensureOscNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        TerminalNotificationBehavior.ensureAlertChannel(context, oscNotificationChannelId(), oscNotificationChannelName())
    }

    private fun ensureOscProgressNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channelId = oscProgressNotificationChannelId()
        val existingChannel = notificationManager.getNotificationChannel(channelId)
        if (existingChannel != null && (existingChannel.importance != NotificationManager.IMPORTANCE_DEFAULT || existingChannel.sound != null)) notificationManager.deleteNotificationChannel(channelId)
        if (notificationManager.getNotificationChannel(channelId) == null) {
            notificationManager.createNotificationChannel(NotificationChannel(channelId, oscProgressNotificationChannelName(), NotificationManager.IMPORTANCE_DEFAULT).apply {
                setSound(null, null)
                enableVibration(false)
                enableLights(false)
            })
        }
    }

    private fun oscNotificationChannelId(): String = TerminalNotificationFormat.oscChannelId(notificationContext)

    private fun oscProgressNotificationChannelId(): String = TerminalNotificationFormat.progressChannelId(notificationContext)

    private fun oscNotificationChannelName(): String = TerminalNotificationFormat.oscChannelName(notificationContext)

    private fun oscProgressNotificationChannelName(): String = TerminalNotificationFormat.progressChannelName(notificationContext)

    private fun oscProgressNotificationId(): Int = TerminalNotificationFormat.progressNotificationId(notificationContext)

    private fun workspaceIconBitmap(localOnly: Boolean = false): android.graphics.Bitmap? {
        val localBitmap = runCatching {
            val uri = notificationContext.iconUri.takeIf { it.isNotBlank() }?.let { it.toUri() } ?: return@runCatching null
            context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }
        }.getOrNull()
        if (localBitmap != null) return localBitmap
        if (localOnly) return null
        val iconUrl = notificationContext.iconUrl.takeIf { it.startsWith("https://") || it.startsWith("http://") } ?: return null
        if (workspaceIconCacheKey == iconUrl) return workspaceIconCache
        if (!workspaceIconRequestInFlight) {
            workspaceIconRequestInFlight = true
            Thread {
                val bitmap = runCatching { URL(iconUrl).openStream().use { BitmapFactory.decodeStream(it) } }.getOrNull()
                post {
                    workspaceIconCacheKey = iconUrl
                    workspaceIconCache = bitmap
                    workspaceIconRequestInFlight = false
                }
            }.start()
        }
        return null
    }

    private fun oscNotificationIconRes(): Int = when (oscNotificationIconStyle()) {
        "bell" -> R.drawable.ic_feather_bell
        "terminal" -> R.drawable.ic_feather_terminal
        else -> R.drawable.pi_logo_mark
    }

    private fun nextTerminalNotificationId(): Int = terminalNotificationIdCounter.updateAndGet { if (it == Int.MAX_VALUE) 1 else it + 1 }

    private fun openHyperlinkAt(x: Float, y: Float): Boolean {
        val position = cellAt(x, y)
        val uri = hyperlinkUriAt(position).ifBlank { plainUrlAt(position) }
        terminalOscHyperlinkUri(uri) ?: return false
        onHyperlinkActivated?.invoke(uri)
        return true
    }

    private fun plainUrlAt(position: TerminalCellPosition): String {
        val line = snapshotText().getOrNull(position.row).orEmpty()
        if (line.isBlank()) return ""
        val match = PlainUrlRegex.findAll(line).firstOrNull { position.col in it.range } ?: return ""
        return match.value.trimEnd('.', ',', ';', ':', ')', ']', '}', '>', '"', '\'')
    }

    companion object {
        private val terminalNotificationIdCounter = AtomicInteger((System.currentTimeMillis() and 0x3fffffff).toInt())
        private val PlainUrlRegex = Regex("https?://\\S+")
        private val terminalNotificationTargets = mutableMapOf<String, WeakReference<CoderTerminalView>>()

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

fun terminalOscHyperlinkUri(value: String): URI? {
    if (value.isBlank() || value.length > 2048) return null
    val uri = runCatching { URI(value) }.getOrNull() ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "https" && scheme != "http") return null
    if (uri.rawAuthority.isNullOrBlank()) return null
    return uri
}

fun terminalOscHyperlinkHost(value: String): String? {
    return terminalOscHyperlinkUri(value)?.host?.lowercase()
}

fun terminalNormalizeLinkHostPattern(value: String): String? {
    val trimmed = value.trim().lowercase()
    if (trimmed.isBlank()) return null
    if (trimmed.startsWith("*.")) {
        val suffix = trimmed.removePrefix("*.").removeSuffix(".")
        if (suffix.isBlank() || suffix.contains('/') || suffix.contains(':') || suffix.any { it.isWhitespace() }) return null
        return "*.${suffix}"
    }
    val host = if (trimmed.contains("://")) runCatching { URI(trimmed).host?.lowercase()?.removeSuffix(".") }.getOrNull() else trimmed.removeSuffix(".")
    if (host.isNullOrBlank() || host.contains('/') || host.contains(':') || host.any { it.isWhitespace() }) return null
    return host
}

fun terminalAllowedLinkHosts(context: Context): Set<String> {
    return context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getStringSet("osc.allowed_link_hosts", emptySet()).orEmpty()
}

fun selectedTerminalFontSizeSp(context: Context): Int {
    val preferences = context.getSharedPreferences("terminal", Context.MODE_PRIVATE)
    if (preferences.contains("fontSizeSp")) return preferences.getInt("fontSizeSp", 14).coerceIn(8, 32)
    return (preferences.getInt("cellHeight", 36) / 2).coerceIn(8, 32)
}

fun terminalCellHeightForFontSize(context: Context, fontSizeSp: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, fontSizeSp.coerceIn(8, 32).toFloat(), context.resources.displayMetrics).roundToInt().coerceAtLeast(8)

fun terminalCellWidthForFontSize(fontSizePixels: Int): Int = (fontSizePixels * 0.55f).roundToInt().coerceIn(5, 80)

fun terminalSetLinkHostAllowed(context: Context, host: String, allowed: Boolean) {
    val normalized = terminalNormalizeLinkHostPattern(host) ?: return
    val next = terminalAllowedLinkHosts(context).toMutableSet()
    if (allowed) next.add(normalized) else next.remove(normalized)
    context.getSharedPreferences("terminal", Context.MODE_PRIVATE).edit { putStringSet("osc.allowed_link_hosts", next) }
}

fun terminalOscHyperlinkAllowed(context: Context, value: String): Boolean {
    val host = terminalOscHyperlinkHost(value) ?: return false
    return terminalAllowedLinkHosts(context).any { pattern ->
        if (pattern.startsWith("*.")) {
            val suffix = pattern.removePrefix("*.")
            host != suffix && host.endsWith(".${suffix}")
        } else host == pattern
    }
}

data class TerminalCellPosition(val row: Int, val col: Int)
