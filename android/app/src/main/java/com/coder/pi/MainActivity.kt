package com.coder.pi

import android.os.Bundle
import android.graphics.Color
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.getSystemService
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlin.math.max

class MainActivity : AppCompatActivity() {
    private lateinit var terminalView: CoderTerminalView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
        terminalView = CoderTerminalView(this)
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        val accessory = createKeyboardAccessory()
        root.addView(terminalView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(accessory, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(88)))
        accessory.visibility = android.view.View.VISIBLE
        setContentView(root)
        fun applyKeyboardInsets(insets: WindowInsetsCompat) {
            val keyboardHeight = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val keyboardVisible = keyboardHeight > 0
            terminalView.setKeyboardAvoidanceOffset(0)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            applyKeyboardInsets(insets)
            insets
        }
        ViewCompat.setWindowInsetsAnimationCallback(root, object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
            override fun onProgress(insets: WindowInsetsCompat, runningAnimations: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat {
                applyKeyboardInsets(insets)
                return insets
            }
        })
        terminalView.requestFocus()
        terminalView.post {
            getSystemService<InputMethodManager>()?.showSoftInput(terminalView, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun createKeyboardAccessory(): LinearLayout {
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setBackgroundColor(Color.BLACK)
        root.setPadding(dp(8), dp(6), dp(8), dp(6))
        val firstRow = LinearLayout(this)
        val secondRow = LinearLayout(this)
        firstRow.orientation = LinearLayout.HORIZONTAL
        secondRow.orientation = LinearLayout.HORIZONTAL
        root.addView(firstRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(secondRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        addButton(firstRow, "ESC") { terminalView.sendKey(android.view.KeyEvent.KEYCODE_ESCAPE) }
        val shiftButton = addToggleButton(firstRow, "SHIFT") { terminalView.toggleShiftLatch() }
        val ctrlButton = addToggleButton(firstRow, "CTRL") { terminalView.toggleCtrlLatch() }
        val altButton = addToggleButton(firstRow, "ALT") { terminalView.toggleAltLatch() }
        terminalView.onModifierLatchChanged = { shiftActive, ctrlActive, altActive ->
            shiftButton.isSelected = shiftActive
            ctrlButton.isSelected = ctrlActive
            altButton.isSelected = altActive
        }
        addButton(firstRow, "⇥") { terminalView.sendKey(android.view.KeyEvent.KEYCODE_TAB) }
        addButton(firstRow, "@") { terminalView.sendText("@") }
        addButton(firstRow, "←") { terminalView.sendKey(android.view.KeyEvent.KEYCODE_DPAD_LEFT) }
        addButton(firstRow, "↑") { terminalView.sendKey(android.view.KeyEvent.KEYCODE_DPAD_UP) }
        addButton(firstRow, "→") { terminalView.sendKey(android.view.KeyEvent.KEYCODE_DPAD_RIGHT) }
        addButton(secondRow, ":") { terminalView.sendText(":") }
        addButton(secondRow, "/") { terminalView.sendText("/") }
        addButton(secondRow, "~") { terminalView.sendText("~") }
        addButton(secondRow, "PGUP") { terminalView.scrollRows(-12) }
        addButton(secondRow, "PGDN") { terminalView.scrollRows(12) }
        addButton(secondRow, "−") { terminalView.sendText("-") }
        addButton(secondRow, "↓") { terminalView.sendKey(android.view.KeyEvent.KEYCODE_DPAD_DOWN) }
        addButton(secondRow, "⌨") {
            WindowInsetsControllerCompat(window, terminalView).hide(WindowInsetsCompat.Type.ime())
            getSystemService<InputMethodManager>()?.hideSoftInputFromWindow(terminalView.windowToken, 0)
        }
        return root
    }

    private fun addButton(parent: LinearLayout, label: String, action: () -> Unit) {
        val button = TextView(this)
        button.text = label
        button.setTextColor(buttonTextColors())
        button.gravity = Gravity.CENTER
        button.textSize = 14f
        button.typeface = android.graphics.Typeface.DEFAULT_BOLD
        button.background = buttonBackground()
        button.isClickable = true
        button.isFocusable = true
        button.setOnClickListener {
            button.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            action()
        }
        parent.addView(button, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
    }

    private fun addToggleButton(parent: LinearLayout, label: String, action: () -> Boolean): TextView {
        val button = TextView(this)
        button.text = label
        button.setTextColor(buttonTextColors())
        button.gravity = Gravity.CENTER
        button.textSize = 14f
        button.typeface = android.graphics.Typeface.DEFAULT_BOLD
        button.background = buttonBackground()
        button.isClickable = true
        button.isFocusable = true
        button.setOnClickListener {
            button.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            button.isSelected = action()
        }
        parent.addView(button, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
        return button
    }

    private fun buttonTextColors(): ColorStateList {
        return ColorStateList(
            arrayOf(
                intArrayOf(android.R.attr.state_pressed),
                intArrayOf(android.R.attr.state_selected),
                intArrayOf(android.R.attr.state_focused),
                intArrayOf(),
            ),
            intArrayOf(
                Color.BLACK,
                Color.BLACK,
                Color.WHITE,
                Color.WHITE,
            ),
        )
    }

    private fun buttonBackground(): StateListDrawable {
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), roundedButton(Color.WHITE))
            addState(intArrayOf(android.R.attr.state_selected), roundedButton(Color.rgb(132, 219, 255)))
            addState(intArrayOf(android.R.attr.state_focused), roundedButton(Color.rgb(36, 36, 44)))
            addState(intArrayOf(), roundedButton(Color.TRANSPARENT))
        }
    }

    private fun roundedButton(color: Int): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(8).toFloat()
            setColor(color)
        }
    }

    private fun dp(value: Int): Int {
        return max(1, (value * resources.displayMetrics.density).toInt())
    }

    override fun onDestroy() {
        terminalView.dispose()
        super.onDestroy()
    }
}
