package com.coder.pi

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.getSystemService
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.lang.ref.WeakReference

private const val TerminalKeyboardGapDp = 8

class TerminalActivity : AppCompatActivity() {
    private lateinit var terminalView: CoderTerminalView
    private var terminalSession: CoderTerminalSession? = null
    private var terminalMetadata: CoderActiveTerminalMetadata? = null
    private var terminalStore: CoderSessionStore? = null
    private var terminalId: String = ""
    private var previewJob: Job? = null
    private var currentTheme by mutableStateOf<CoderTheme?>(null)
    private var currentFontKey: String? = null
    private var currentFontSizePoints = 0
    private var keyboardAvoidanceOffset by mutableIntStateOf(0)
    private var terminalStatus by mutableStateOf(TerminalConnectionStatus.Connecting.wireName)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        terminalActivities.add(WeakReference(this))
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes =
                window.attributes.apply {
                    layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                }
        }
        @Suppress("DEPRECATION")
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        val launch =
            terminalLaunchRequestFromIntent() ?: run {
                finish()
                return
            }
        val identity =
            terminalIdentityFromIntent(launch) ?: run {
                finish()
                return
            }
        val windowTitle = terminalWindowTitle(launch)
        title = windowTitle
        @Suppress("DEPRECATION")
        setTaskDescription(android.app.ActivityManager.TaskDescription(windowTitle))
        val theme = CoderThemes.current(this)
        currentTheme = theme
        currentFontKey = CoderFonts.selectedKey(this)
        currentFontSizePoints = selectedTerminalFontSizePoints()
        applyKeepScreenAwake()
        terminalStore = CoderSessionStore(this)
        val localWorkspaceState = terminalStore?.workspaceState(identity.baseUrl, identity.userId, identity.workspaceId)
        terminalId = terminalSessionKey(identity)
        terminalView =
            CoderTerminalView(this, attachedEngine = TerminalConnectionManager.engineFor(terminalId)).also {
                it.setPreviewFontFamily(currentFontKey ?: CoderFonts.selectedKey(this))
                it.applyTheme(theme)
                it.setNotificationContext(TerminalNotificationContext(identity.workspaceId, launch.workspaceName, localWorkspaceState?.alias ?: launch.title, "pi://terminal?id=${android.net.Uri.encode(terminalId)}", localWorkspaceState?.iconUri.orEmpty(), launch.workspaceIconUrl.orEmpty(), terminalId))
                it.onNotificationPermissionNeeded = { if (android.os.Build.VERSION.SDK_INT >= 33) ActivityCompat.requestPermissions(this, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 52) }
                it.onAgentStateChanged = { persistTerminalState() }
            }
        terminalMetadata = CoderActiveTerminalMetadata(identity.baseUrl, identity.userId, identity.workspaceId, launch.workspaceName, identity.agentId, launch.badge, identity.command, launch.reconnectId, System.currentTimeMillis(), workspaceIconUrl = launch.workspaceIconUrl)
        terminalStore?.saveActiveTerminal(terminalMetadata ?: return)
        configureTerminalKeyboardInsets()
        val startTerminalSession = {
            if (!isFinishing && !isDestroyed && terminalSession == null) {
                terminalSession =
                    TerminalConnectionManager.startVisible(terminalId, launch, terminalView, { status ->
                        terminalStatus = status
                        terminalStore?.appendDebugLog("terminal window ${launch.title} $status")
                    }, { safeError ->
                        safeError?.let { terminalStore?.appendDebugLog("terminal window ${launch.title} error $it") }
                    })
            }
        }
        if (TerminalConnectionManager.hasRuntime(terminalId)) {
            startTerminalSession()
        } else {
            terminalView.runWhenTerminalSizeReady(startTerminalSession)
        }
        startPreviewPersistence()
        applySystemBars(currentTheme ?: theme)
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    moveTaskToBack(true)
                }
            },
        )
        setContent {
            MaterialTheme(typography = appTypography(CoderFonts.uiFontFamily(this))) {
                val renderedTheme = currentTheme ?: CoderThemes.current(this)
                val keyboardGapPx = with(LocalDensity.current) { TerminalKeyboardGapDp.dp.roundToPx() }
                TerminalSurface(
                    terminalView,
                    renderedTheme,
                    { showTerminalKeyboard() },
                    { hideTerminalKeyboard() },
                    Modifier
                        .fillMaxSize()
                        .background(renderedTheme.background.toComposeColor()),
                    showMetadataOverlay = false,
                    keyboardAvoidanceOffsetPx = keyboardAvoidanceOffset,
                    keyboardGapPx = keyboardGapPx,
                )
                DisposableEffect(terminalStatus) {
                    val metadata = terminalMetadata
                    if (metadata != null) {
                        terminalStore?.saveActiveTerminal(
                            metadata.copy(
                                updatedAtMillis = System.currentTimeMillis(),
                                preview =
                                    terminalView
                                        .snapshotText()
                                        .filter { it.isNotBlank() }
                                        .takeLast(5)
                                        .joinToString("\n"),
                            ),
                        )
                    }
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
            terminalStore?.appendDebugLog("terminal window ${metadata.workspaceName} resume without saved session")
            return
        }
        terminalMetadata?.let { terminalStore?.saveActiveTerminal(it.copy(updatedAtMillis = System.currentTimeMillis())) }
    }

    override fun onPause() {
        releaseKeepScreenAwake()
        terminalView.onPause()
        super.onPause()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applySystemBars(currentTheme ?: CoderThemes.current(this))
        terminalView.post { terminalView.forceRefreshSurface() }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        terminalMetadata?.let { terminalStore?.saveActiveTerminal(it.copy(updatedAtMillis = System.currentTimeMillis())) }
    }

    override fun onDestroy() {
        previewJob?.cancel()
        if (isChangingConfigurations || !isFinishing) {
            TerminalConnectionManager.detachRenderer(terminalId)
        } else {
            TerminalConnectionManager.stop(terminalId)
            terminalMetadata?.let { terminalStore?.removeActiveTerminal(it.baseUrl, it.userId, it.workspaceId, it.agentId, it.command) }
        }
        if (::terminalView.isInitialized) terminalView.dispose()
        terminalActivities.removeAll { it.get() == null || it.get() === this }
        super.onDestroy()
    }

    private fun startPreviewPersistence() {
        previewJob?.cancel()
        previewJob =
            CoroutineScope(SupervisorJob() + Dispatchers.Main).launch {
                while (true) {
                    persistTerminalState()
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
        applyKeepScreenAwake()
    }

    private fun selectedTerminalFontSizePoints(): Int = selectedTerminalFontSizeSp(this)

    private fun applyKeepScreenAwake() {
        if (getSharedPreferences("terminal", Context.MODE_PRIVATE).getBoolean("keep_screen_awake", false)) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun releaseKeepScreenAwake() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun persistTerminalState() {
        val metadata = terminalMetadata ?: return
        val nextMetadata =
            metadata.copy(
                updatedAtMillis = System.currentTimeMillis(),
                preview =
                    terminalView
                        .snapshotText()
                        .filter { it.isNotBlank() }
                        .takeLast(5)
                        .joinToString("\n"),
                agentStatusTitle = terminalView.agentStateSnapshot().statusPresentation()?.title,
                agentStatusSubtitle = terminalView.agentStateSnapshot().statusPresentation()?.subtitle,
            )
        terminalMetadata = nextMetadata
        terminalStore?.saveActiveTerminal(nextMetadata)
    }

    private fun terminalLaunchRequestFromIntent(): TerminalLaunchRequest? {
        val store = terminalStore ?: CoderSessionStore(this)
        val baseUrl = intent.getStringExtra(TerminalWindowLauncher.BaseUrl)
        if (baseUrl == null) {
            savedTerminalMetadataFromIntent()?.let { metadata ->
                val token = store.loadSession()?.takeIf { it.first == metadata.baseUrl }?.second ?: return null
                val localWorkspaceState = store.workspaceState(metadata.baseUrl, metadata.userId, metadata.workspaceId)
                return TerminalLaunchRequest(metadata.baseUrl, token, metadata.agentId, metadata.reconnectId, metadata.command, localWorkspaceState.alias ?: metadata.workspaceName, metadata.agentName, metadata.workspaceName, metadata.workspaceIconUrl)
            }
            return null
        }
        val token = store.loadSession()?.takeIf { it.first == baseUrl }?.second ?: return null
        val agentId = intent.getStringExtra(TerminalWindowLauncher.AgentId) ?: return null
        val reconnectId = intent.getStringExtra(TerminalWindowLauncher.ReconnectId) ?: return null
        val command = intent.getStringExtra(TerminalWindowLauncher.Command) ?: return null
        val title = intent.getStringExtra(TerminalWindowLauncher.WorkspaceName) ?: return null
        val badge = intent.getStringExtra(TerminalWindowLauncher.AgentName) ?: return null
        val iconUrl = intent.getStringExtra(TerminalWindowLauncher.WorkspaceIconUrl)
        val localWorkspaceState = store.workspaceState(baseUrl, intent.getStringExtra(TerminalWindowLauncher.UserId) ?: "", intent.getStringExtra(TerminalWindowLauncher.WorkspaceId) ?: "")
        return TerminalLaunchRequest(baseUrl, token, agentId, reconnectId, command, localWorkspaceState.alias ?: title, badge, title, iconUrl)
    }

    private fun terminalIdentityFromIntent(launch: TerminalLaunchRequest): TerminalIdentity? {
        if (intent.getStringExtra(TerminalWindowLauncher.BaseUrl) == null) savedTerminalMetadataFromIntent()?.let { metadata ->
            return TerminalIdentity(metadata.baseUrl, metadata.userId, metadata.workspaceId, metadata.agentId, metadata.command)
        }
        val userId = intent.getStringExtra(TerminalWindowLauncher.UserId) ?: return null
        val workspaceId = intent.getStringExtra(TerminalWindowLauncher.WorkspaceId) ?: return null
        return TerminalIdentity(launch.baseUrl, userId, workspaceId, launch.agentId, launch.command)
    }

    private fun savedTerminalMetadataFromIntent(): CoderActiveTerminalMetadata? {
        val uri = intent.data ?: return null
        if (uri.scheme != "pi" || uri.host != "terminal") return null
        val pathSegments = uri.pathSegments
        if (pathSegments.size < 3) return null
        val userId = pathSegments[0]
        val workspaceId = pathSegments[1]
        val agentId = pathSegments[2]
        val command = uri.getQueryParameter(TerminalWindowLauncher.Command) ?: return null
        val baseUrl = terminalStore?.loadSession()?.first ?: CoderSessionStore(this).loadSession()?.first ?: return null
        return CoderSessionStore(this)
            .activeTerminalsForBaseUrl(baseUrl, Long.MAX_VALUE)
            .firstOrNull { it.userId == userId && it.workspaceId == workspaceId && it.agentId == agentId && it.command == command }
    }

    private fun terminalWindowTitle(launch: TerminalLaunchRequest): String {
        val sessionLabel = terminalAttachLabel(launch.command)
        val suffix = sessionLabel ?: launch.badge.takeIf { it.isNotBlank() }
        return suffix?.let { "${launch.title} · $it" } ?: launch.title
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

    private fun configureTerminalKeyboardInsets() {
        val applyInsets: (WindowInsetsCompat) -> Unit = applyInsets@{ insets ->
            val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val navigationBottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
            keyboardAvoidanceOffset = (imeBottom - navigationBottom).coerceAtLeast(0)
        }
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            applyInsets(insets)
            insets
        }
        ViewCompat.setWindowInsetsAnimationCallback(
            window.decorView,
            object : WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                override fun onProgress(
                    insets: WindowInsetsCompat,
                    runningAnimations: MutableList<WindowInsetsAnimationCompat>,
                ): WindowInsetsCompat {
                    applyInsets(insets)
                    return insets
                }
            },
        )
        window.decorView.post { ViewCompat.requestApplyInsets(window.decorView) }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
            terminalView.post { terminalView.forceRefreshSurface() }
        }
        terminalView.sendFocusEvent(hasFocus)
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

        fun finishDetachedTerminals(
            baseUrl: String,
            userId: String,
        ) {
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
