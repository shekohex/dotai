package com.coder.pi

import android.graphics.Color
import android.content.Context
import android.os.Bundle
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.core.content.getSystemService
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.lang.ref.WeakReference

class TerminalActivity : AppCompatActivity() {
    private lateinit var terminalView: CoderTerminalView
    private var terminalSession: CoderTerminalSession? = null
    private var terminalMetadata: CoderActiveTerminalMetadata? = null
    private var terminalStore: CoderSessionStore? = null
    private var previewJob: Job? = null
    private var currentTheme by mutableStateOf<CoderTheme?>(null)
    private var currentFontKey: String? = null
    private var currentFontSizePoints = 0
    private var terminalStatus by mutableStateOf(TerminalConnectionStatus.Connecting.wireName)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        terminalActivities.add(WeakReference(this))
        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("DEPRECATION")
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        val launch = terminalLaunchRequestFromIntent() ?: run {
            finish()
            return
        }
        val identity = terminalIdentityFromIntent(launch) ?: run {
            finish()
            return
        }
        title = launch.title
        setTaskDescription(android.app.ActivityManager.TaskDescription(launch.title))
        val theme = CoderThemes.current(this)
        currentTheme = theme
        currentFontKey = CoderFonts.selectedKey(this)
        currentFontSizePoints = selectedTerminalFontSizePoints()
        terminalView = CoderTerminalView(this).also {
            it.setPreviewFontFamily(currentFontKey ?: CoderFonts.selectedKey(this))
            it.applyTheme(theme)
        }
        terminalStore = CoderSessionStore(this)
        terminalMetadata = CoderActiveTerminalMetadata(identity.baseUrl, identity.userId, identity.workspaceId, launch.title, identity.agentId, launch.badge, identity.command, launch.reconnectId, System.currentTimeMillis(), detached = true)
        terminalStore?.saveActiveTerminal(terminalMetadata ?: return)
        terminalSession = CoderTerminalSession(CoderApi(launch.baseUrl, launch.token), terminalView, launch.agentId, launch.reconnectId, launch.command, { status ->
            terminalStatus = status
            terminalStore?.appendDebugLog("terminal window ${launch.title} $status")
        }, { safeError ->
            safeError?.let { terminalStore?.appendDebugLog("terminal window ${launch.title} error $it") }
        }).also { it.start() }
        startPreviewPersistence()
        applySystemBars(currentTheme ?: theme)
        setContent {
            MaterialTheme(typography = appTypography(CoderFonts.uiFontFamily(this))) {
                val renderedTheme = currentTheme ?: CoderThemes.current(this)
                TerminalSurface(terminalView, renderedTheme, terminalView.gestureEnabled("long_press_selection"), false, {}, { showTerminalKeyboard() }, { hideTerminalKeyboard() }, Modifier.fillMaxSize().background(renderedTheme.background.toComposeColor()).imePadding())
                DisposableEffect(terminalStatus) {
                    val metadata = terminalMetadata
                    if (metadata != null) terminalStore?.saveActiveTerminal(metadata.copy(updatedAtMillis = System.currentTimeMillis(), preview = terminalView.snapshotText().filter { it.isNotBlank() }.takeLast(5).joinToString("\n"), detached = true))
                    onDispose {}
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        terminalView.onResume()
        applyCurrentSettings()
        terminalView.post { terminalView.forceRefreshSurface() }
        val metadata = terminalMetadata
        val session = metadata?.let { terminalStore?.loadSession()?.takeIf { saved -> saved.first == it.baseUrl } }
        if (metadata != null && session == null) {
            finish()
            return
        }
        terminalMetadata?.let { terminalStore?.saveActiveTerminal(it.copy(updatedAtMillis = System.currentTimeMillis(), detached = true)) }
    }

    override fun onPause() {
        terminalView.onPause()
        super.onPause()
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        terminalMetadata?.let { terminalStore?.saveActiveTerminal(it.copy(updatedAtMillis = System.currentTimeMillis(), detached = true)) }
    }

    override fun onDestroy() {
        previewJob?.cancel()
        terminalSession?.stop()
        if (!isChangingConfigurations) terminalMetadata?.let { terminalStore?.updateActiveTerminalDetached(it.baseUrl, it.userId, it.workspaceId, it.agentId, it.command, false) }
        if (::terminalView.isInitialized) terminalView.dispose()
        terminalActivities.removeAll { it.get() == null || it.get() === this }
        super.onDestroy()
    }

    private fun startPreviewPersistence() {
        previewJob?.cancel()
        previewJob = CoroutineScope(SupervisorJob() + Dispatchers.Main).launch {
            while (true) {
                persistTerminalState(true)
                applyCurrentSettings()
                delay(1000)
            }
        }
    }

    private fun applyCurrentSettings() {
        val nextTheme = CoderThemes.current(this)
        if (nextTheme != currentTheme) {
            currentTheme = nextTheme
            terminalView.applyTheme(nextTheme)
            applySystemBars(nextTheme)
        }
        val nextFontKey = CoderFonts.selectedKey(this)
        if (nextFontKey != currentFontKey) {
            currentFontKey = nextFontKey
            terminalView.setPreviewFontFamily(nextFontKey)
        }
        val nextFontSizePoints = selectedTerminalFontSizePoints()
        if (nextFontSizePoints != currentFontSizePoints) {
            currentFontSizePoints = nextFontSizePoints
            terminalView.setFontSizePoints(nextFontSizePoints)
        }
    }

    private fun selectedTerminalFontSizePoints(): Int {
        return (getSharedPreferences("terminal", Context.MODE_PRIVATE).getInt("cellHeight", 36) / 2).coerceIn(8, 32)
    }

    private fun persistTerminalState(detached: Boolean) {
        val metadata = terminalMetadata ?: return
        val nextMetadata = metadata.copy(
            updatedAtMillis = System.currentTimeMillis(),
            preview = terminalView.snapshotText().filter { it.isNotBlank() }.takeLast(5).joinToString("\n"),
            detached = detached,
        )
        terminalMetadata = nextMetadata
        terminalStore?.saveActiveTerminal(nextMetadata)
    }

    private fun terminalLaunchRequestFromIntent(): TerminalLaunchRequest? {
        val baseUrl = intent.getStringExtra(TerminalWindowLauncher.BaseUrl) ?: return null
        val token = CoderSessionStore(this).loadSession()?.takeIf { it.first == baseUrl }?.second ?: return null
        val agentId = intent.getStringExtra(TerminalWindowLauncher.AgentId) ?: return null
        val reconnectId = intent.getStringExtra(TerminalWindowLauncher.ReconnectId) ?: return null
        val command = intent.getStringExtra(TerminalWindowLauncher.Command) ?: return null
        val title = intent.getStringExtra(TerminalWindowLauncher.WorkspaceName) ?: return null
        val badge = intent.getStringExtra(TerminalWindowLauncher.AgentName) ?: return null
        return TerminalLaunchRequest(baseUrl, token, agentId, reconnectId, command, title, badge)
    }

    private fun terminalIdentityFromIntent(launch: TerminalLaunchRequest): TerminalIdentity? {
        val userId = intent.getStringExtra(TerminalWindowLauncher.UserId) ?: return null
        val workspaceId = intent.getStringExtra(TerminalWindowLauncher.WorkspaceId) ?: return null
        return TerminalIdentity(launch.baseUrl, userId, workspaceId, launch.agentId, launch.command)
    }

    private fun applySystemBars(theme: CoderTheme) {
        @Suppress("DEPRECATION")
        window.statusBarColor = theme.background.toComposeColor().toArgb()
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.BLACK
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
            terminalView.post { terminalView.forceRefreshSurface() }
        }
    }

    private fun showTerminalKeyboard() {
        val inputMethodManager = getSystemService<InputMethodManager>() ?: return
        terminalView.setSoftwareKeyboardAllowed(true)
        terminalView.requestFocus()
        terminalView.requestFocusFromTouch()
        inputMethodManager.restartInput(terminalView)
        WindowInsetsControllerCompat(window, terminalView).show(WindowInsetsCompat.Type.ime())
        inputMethodManager.showSoftInput(terminalView, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun hideTerminalKeyboard() {
        terminalView.setSoftwareKeyboardAllowed(false)
        WindowInsetsControllerCompat(window, terminalView).hide(WindowInsetsCompat.Type.ime())
        getSystemService<InputMethodManager>()?.hideSoftInputFromWindow(terminalView.windowToken, 0)
        WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
    }

    companion object {
        private val terminalActivities = mutableSetOf<WeakReference<TerminalActivity>>()

        fun finishDetachedTerminals(baseUrl: String, userId: String) {
            terminalActivities.toList().forEach { reference ->
                val activity = reference.get()
                val metadata = activity?.terminalMetadata
                if (activity == null) {
                    terminalActivities.remove(reference)
                } else if (metadata?.baseUrl == baseUrl && metadata.userId == userId) {
                    activity.finish()
                }
            }
        }
    }
}
