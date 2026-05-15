package com.coder.pi

import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.getSystemService
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {
    private lateinit var terminalView: CoderTerminalView
    private var currentTheme by mutableStateOf<CoderTheme?>(null)
    private var uiRevision by mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        currentTheme = CoderThemes.current(this)
        terminalView = CoderTerminalView(this)
        applySystemBars(currentTheme ?: CoderThemes.current(this))
        setContent {
            val context = LocalContext.current
            CoderApp(
                terminalView = terminalView,
                theme = currentTheme ?: CoderThemes.current(context),
                uiRevision = uiRevision,
                onThemeChanged = {
                    currentTheme = CoderThemes.current(this)
                    terminalView.applyTheme(currentTheme ?: CoderThemes.current(this))
                    applySystemBars(currentTheme ?: CoderThemes.current(this))
                },
                onFontChanged = { uiRevision++ },
                onShowKeyboard = {
                    terminalView.requestFocus()
                    terminalView.post {
                        getSystemService<InputMethodManager>()?.showSoftInput(terminalView, InputMethodManager.SHOW_IMPLICIT)
                    }
                },
                onHideKeyboard = {
                    WindowInsetsControllerCompat(window, terminalView).hide(androidx.core.view.WindowInsetsCompat.Type.ime())
                    getSystemService<InputMethodManager>()?.hideSoftInputFromWindow(terminalView.windowToken, 0)
                },
            )
        }
    }

    private fun applySystemBars(theme: CoderTheme) {
        window.statusBarColor = theme.background.toComposeColor().toArgb()
        window.navigationBarColor = theme.background.toComposeColor().toArgb()
        val lightBars = luminance(theme.background) > 0.5
        WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars = lightBars
        WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightNavigationBars = lightBars
    }

    private fun luminance(rgb: Int): Double {
        val r = ((rgb shr 16) and 0xff) / 255.0
        val g = ((rgb shr 8) and 0xff) / 255.0
        val b = (rgb and 0xff) / 255.0
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    override fun onDestroy() {
        terminalView.dispose()
        super.onDestroy()
    }
}
