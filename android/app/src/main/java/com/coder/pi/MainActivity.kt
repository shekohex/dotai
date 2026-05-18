package com.coder.pi

import android.graphics.Color
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
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
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {
    private lateinit var terminalView: CoderTerminalView
    private var currentTheme by mutableStateOf<CoderTheme?>(null)
    private var uiRevision by mutableIntStateOf(0)
    private var deepLinkSettingsPage by mutableStateOf<SettingsPage?>(null)
    private var deepLinkRevision by mutableIntStateOf(0)
    private var deepLinkTerminalId by mutableStateOf<String?>(null)
    private var debugPlaygroundRevision by mutableIntStateOf(0)
    private var keyboardTerminalView: CoderTerminalView? = null
    private var terminalPreferences: SharedPreferences? = null
    private var terminalPreferencesListener: SharedPreferences.OnSharedPreferenceChangeListener? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        @Suppress("DEPRECATION")
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        currentTheme = CoderThemes.current(this)
        handleDeepLink(intent)
        terminalView = CoderTerminalView(this)
        terminalPreferences = getSharedPreferences("terminal", MODE_PRIVATE)
        terminalPreferencesListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            when (key) {
                "themeMode", "themeName" -> {
                    currentTheme = CoderThemes.current(this)
                    terminalView.applyTheme(currentTheme ?: CoderThemes.current(this))
                    applySystemBars(currentTheme ?: CoderThemes.current(this))
                }
                "fontFamily" -> terminalView.setPreviewFontFamily(CoderFonts.selectedKey(this))
                "fontSizePx", "cellHeight", "cellWidth" -> terminalView.setFontSizePoints(selectedTerminalFontSizePixels(this))
                "keep_screen_awake" -> applyKeepScreenAwake()
            }
        }
        terminalPreferences?.registerOnSharedPreferenceChangeListener(terminalPreferencesListener)
        applySystemBars(currentTheme ?: CoderThemes.current(this))
        applyKeepScreenAwake()
        setContent {
            val context = LocalContext.current
            CoderApp(
                terminalView = terminalView,
                theme = currentTheme ?: CoderThemes.current(context),
                uiRevision = uiRevision,
                deepLinkSettingsPage = deepLinkSettingsPage,
                deepLinkTerminalId = deepLinkTerminalId,
                deepLinkRevision = deepLinkRevision,
                debugPlaygroundRevision = debugPlaygroundRevision,
                onThemeChanged = {
                    currentTheme = CoderThemes.current(this)
                    terminalView.applyTheme(currentTheme ?: CoderThemes.current(this))
                    applySystemBars(currentTheme ?: CoderThemes.current(this))
                },
                onFontChanged = { uiRevision++ },
                onShowKeyboard = { targetTerminalView ->
                    keyboardTerminalView?.setSoftwareKeyboardAllowed(false)
                    keyboardTerminalView = targetTerminalView
                    targetTerminalView.setSoftwareKeyboardAllowed(true)
                    showTerminalKeyboard(targetTerminalView)
                },
                onHideKeyboard = {
                    val targetTerminalView = keyboardTerminalView ?: terminalView
                    targetTerminalView.setSoftwareKeyboardAllowed(false)
                    keyboardTerminalView = null
                    WindowInsetsControllerCompat(window, targetTerminalView).hide(WindowInsetsCompat.Type.ime())
                    getSystemService<InputMethodManager>()?.hideSoftInputFromWindow(targetTerminalView.windowToken, 0)
                    WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.navigationBars())
                },
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "pi") return
        if (uri.host == "debug") {
            if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 && uri.path?.trim('/') == "render") debugPlaygroundRevision++
            return
        }
        if (uri.host == "terminal") {
            deepLinkTerminalId = uri.getQueryParameter("id")
            deepLinkRevision++
            return
        }
        if (uri.host != "settings") return
        deepLinkSettingsPage = when (uri.path?.trim('/')) {
            "fonts", "font", "size" -> SettingsPage.FONTS
            "text", "customize-text", "opentype", "open-type", "font-features" -> SettingsPage.TEXT
            "theme" -> SettingsPage.THEME
            "toolbar" -> SettingsPage.TOOLBAR
            "shortcuts" -> SettingsPage.SHORTCUTS
            "keyboard" -> SettingsPage.KEYBOARD
            "gestures" -> SettingsPage.GESTURES
            "speech" -> SettingsPage.SPEECH
            "links", "link-allowlist", "allowed-links" -> SettingsPage.LINKS
            "links/add", "link-allowlist/add", "allowed-links/add" -> SettingsPage.LINKS_ADD
            "notifications", "terminal-notifications" -> SettingsPage.NOTIFICATIONS
            "connection" -> SettingsPage.CONNECTION
            else -> SettingsPage.ROOT
        }
        deepLinkRevision++
    }

    private fun showTerminalKeyboard(targetTerminalView: CoderTerminalView) {
        val inputMethodManager = getSystemService<InputMethodManager>() ?: return
        fun requestKeyboard() {
            targetTerminalView.requestFocus()
            targetTerminalView.requestFocusFromTouch()
            inputMethodManager.restartInput(targetTerminalView)
            WindowInsetsControllerCompat(window, targetTerminalView).show(WindowInsetsCompat.Type.ime())
            inputMethodManager.showSoftInput(targetTerminalView, InputMethodManager.SHOW_IMPLICIT)
        }
        requestKeyboard()
        targetTerminalView.post {
            requestKeyboard()
            targetTerminalView.postDelayed({
                requestKeyboard()
                @Suppress("DEPRECATION")
                inputMethodManager.showSoftInput(targetTerminalView, InputMethodManager.SHOW_FORCED)
                WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.navigationBars())
            }, 120)
        }
    }

    private fun applySystemBars(theme: CoderTheme) {
        @Suppress("DEPRECATION")
        window.statusBarColor = theme.background.toComposeColor().toArgb()
        @Suppress("DEPRECATION")
        window.navigationBarColor = theme.background.toComposeColor().toArgb()
        val lightBars = luminance(theme.background) > 0.5
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.isAppearanceLightStatusBars = lightBars
        controller.isAppearanceLightNavigationBars = lightBars
        controller.hide(WindowInsetsCompat.Type.navigationBars())
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.navigationBars())
            terminalView.post { terminalView.forceRefreshSurface() }
        }
    }

    override fun onResume() {
        super.onResume()
        terminalView.onResume()
        currentTheme = CoderThemes.current(this)
        terminalView.applyTheme(currentTheme ?: CoderThemes.current(this))
        terminalView.setPreviewFontFamily(CoderFonts.selectedKey(this))
        terminalView.setFontSizePoints(selectedTerminalFontSizePixels(this))
        terminalView.post { terminalView.forceRefreshSurface() }
        applySystemBars(currentTheme ?: CoderThemes.current(this))
        applyKeepScreenAwake()
    }

    private fun applyKeepScreenAwake() {
        if (getSharedPreferences("terminal", MODE_PRIVATE).getBoolean("keep_screen_awake", false)) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    override fun onPause() {
        terminalView.onPause()
        super.onPause()
    }

    private fun luminance(rgb: Int): Double {
        val r = ((rgb shr 16) and 0xff) / 255.0
        val g = ((rgb shr 8) and 0xff) / 255.0
        val b = (rgb and 0xff) / 255.0
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    override fun onDestroy() {
        terminalPreferencesListener?.let { terminalPreferences?.unregisterOnSharedPreferenceChangeListener(it) }
        terminalView.dispose()
        super.onDestroy()
    }
}
