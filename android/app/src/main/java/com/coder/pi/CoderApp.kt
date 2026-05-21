package com.coder.pi

import android.content.Context
import android.content.res.Configuration
import android.content.pm.ApplicationInfo
import android.graphics.Rect
import android.net.Uri
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.ViewGroup
import android.content.Intent
import android.widget.Toast
import java.io.File
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.AnimatedVisibility
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.result.PickVisualMediaRequest
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.edit
import androidx.core.net.toUri
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.ClientRequestException
import io.ktor.http.HttpStatusCode
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.focusable
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import java.util.UUID
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.abs

enum class AppDestination { HOME, SETTINGS, DEBUG_RENDER, DEBUG_SPEECH }
enum class SettingsPage { ROOT, THEME, FONTS, TEXT, TOOLBAR, SHORTCUTS, SHORTCUT_TAB, SHORTCUT, KEYBOARD, GESTURES, CHAT, SPEECH, SPEECH_MODELS, SPEECH_MODEL_DETAIL, LINKS, LINKS_ADD, NOTIFICATIONS, CONNECTION, DEBUG_LOGS, PLACEHOLDER }

private sealed interface AuthState {
    data object Loading : AuthState
    data object LoggedOut : AuthState
    data class TokenInput(val baseUrl: String) : AuthState
    data class LoggedIn(val session: CoderSession) : AuthState
}

data class UiTokens(
    val isLight: Boolean,
    val background: Color,
    val surface: Color,
    val surfaceHigh: Color,
    val separator: Color,
    val text: Color,
    val secondary: Color,
    val accent: Color,
    val success: Color,
    val proBackground: Color,
    val proText: Color,
    val shadow: Color,
)

fun Int.toComposeColor(): Color = Color(0xff000000.toInt() or this)

fun appTypography(fontFamily: FontFamily): Typography {
    val base = Typography()
    return Typography(
        displayLarge = base.displayLarge.copy(fontFamily = fontFamily),
        displayMedium = base.displayMedium.copy(fontFamily = fontFamily),
        displaySmall = base.displaySmall.copy(fontFamily = fontFamily),
        headlineLarge = base.headlineLarge.copy(fontFamily = fontFamily),
        headlineMedium = base.headlineMedium.copy(fontFamily = fontFamily),
        headlineSmall = base.headlineSmall.copy(fontFamily = fontFamily),
        titleLarge = base.titleLarge.copy(fontFamily = fontFamily),
        titleMedium = base.titleMedium.copy(fontFamily = fontFamily),
        titleSmall = base.titleSmall.copy(fontFamily = fontFamily),
        bodyLarge = base.bodyLarge.copy(fontFamily = fontFamily),
        bodyMedium = base.bodyMedium.copy(fontFamily = fontFamily),
        bodySmall = base.bodySmall.copy(fontFamily = fontFamily),
        labelLarge = base.labelLarge.copy(fontFamily = fontFamily),
        labelMedium = base.labelMedium.copy(fontFamily = fontFamily),
        labelSmall = base.labelSmall.copy(fontFamily = fontFamily),
    )
}

fun CoderTerminalView.prepareForComposeHost(): CoderTerminalView {
    (parent as? ViewGroup)?.removeView(this)
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    visibility = android.view.View.VISIBLE
    post { refreshSurface() }
    return this
}

private fun openTerminalHyperlink(context: Context, uri: String) {
    CustomTabsIntent.Builder().build().launchUrl(context, uri.toUri())
}

@Composable
fun CoderApp(
    terminalView: CoderTerminalView,
    theme: CoderTheme,
    uiRevision: Int,
    deepLinkSettingsPage: SettingsPage?,
    deepLinkTerminalId: String?,
    deepLinkRevision: Int,
    debugPlaygroundRevision: Int,
    debugSpeechRevision: Int,
    debugSpeechState: String?,
    onThemeChanged: () -> Unit,
    onFontChanged: () -> Unit,
    onHideKeyboard: () -> Unit,
) {
    var destination by remember { mutableStateOf(AppDestination.HOME) }
    var appShortcutSettingsPage by remember { mutableStateOf<SettingsPage?>(null) }
    var authState by remember { mutableStateOf<AuthState>(AuthState.Loading) }
    val terminalSessions = remember { mutableStateListOf<ActiveTerminalWindow>() }
    var confirmCloseTerminalId by remember { mutableStateOf<String?>(null) }
    var hydratedSessionKey by remember { mutableStateOf<String?>(null) }
    val tokens = remember(theme) { uiTokens(theme) }
    val context = LocalContext.current
    val sessionStore = remember(context) { CoderSessionStore(context) }
    val lifecycleOwner = remember(context) { context.findLifecycleOwner() }
    val notificationPermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    DisposableEffect(context, terminalView, terminalSessions) {
        val preferences = context.getSharedPreferences("terminal", Context.MODE_PRIVATE)
        val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            when (key) {
                "themeMode", "themeName" -> {
                    val nextTheme = CoderThemes.current(context)
                    terminalView.applyTheme(nextTheme)
                }
                "fontFamily" -> {
                    val fontKey = CoderFonts.selectedKey(context)
                    terminalView.setPreviewFontFamily(fontKey)
                }
                "fontSizeSp", "cellHeight", "cellWidth" -> {
                    val points = selectedTerminalFontSizeSp(context)
                    terminalView.setFontSizePoints(points)
                }
            }
        }
        preferences.registerOnSharedPreferenceChangeListener(listener)
        terminalView.onNotificationPermissionNeeded = { if (android.os.Build.VERSION.SDK_INT >= 33) notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS) }
        terminalView.onApplicationShortcut = { shortcutId ->
            when (applicationShortcutAction(shortcutId)) {
                ApplicationShortcutAction.SHOW_SHORTCUTS -> { appShortcutSettingsPage = SettingsPage.SHORTCUTS; destination = AppDestination.SETTINGS; onHideKeyboard(); true }
                ApplicationShortcutAction.OPEN_SWITCHER -> { destination = AppDestination.HOME; onHideKeyboard(); true }
                ApplicationShortcutAction.NEW_CONNECTION -> { destination = AppDestination.HOME; onHideKeyboard(); true }
                ApplicationShortcutAction.CLOSE_SESSION -> { terminalSessions.lastOrNull()?.let { confirmCloseTerminalId = it.id }; true }
                ApplicationShortcutAction.PASTE -> { terminalView.pasteFromClipboard(); true }
                null -> false
            }
        }
        onDispose { preferences.unregisterOnSharedPreferenceChangeListener(listener); terminalView.onApplicationShortcut = null }
    }
    DisposableEffect(context, lifecycleOwner, terminalSessions) {
        if (lifecycleOwner == null) return@DisposableEffect onDispose { }
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP && context.getSharedPreferences("app", Context.MODE_PRIVATE).getBoolean("background_terminals", false) && terminalSessions.isNotEmpty()) {
                androidx.core.content.ContextCompat.startForegroundService(context, Intent(context, TerminalConnectionService::class.java))
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(deepLinkRevision) {
        if (deepLinkSettingsPage != null) destination = AppDestination.SETTINGS
    }
    LaunchedEffect(context) {
        if (context.getSharedPreferences("app", Context.MODE_PRIVATE).getBoolean("background_terminals", false)) TerminalCatchUpWorker.schedule(context) else TerminalCatchUpWorker.cancel(context)
    }
    DisposableEffect(context) {
        val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key?.startsWith("speech.") == true) {
                val settings = SpeechSettingsStore.values(context)
                if (settings.keepModelWarmEnabled && settings.localTranscriptionEnabled) SpeechWarmModelService.start(context) else SpeechWarmModelService.stop(context)
            }
        }
        val preferences = SpeechSettingsStore.registerChangeListener(context, listener)
        val settings = SpeechSettingsStore.values(context)
        if (settings.keepModelWarmEnabled && settings.localTranscriptionEnabled) SpeechWarmModelService.start(context)
        onDispose { preferences.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    LaunchedEffect(debugPlaygroundRevision) {
        val debugBuild = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (debugBuild && debugPlaygroundRevision > 0) destination = AppDestination.DEBUG_RENDER
    }
    LaunchedEffect(debugSpeechRevision) {
        val debugBuild = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (debugBuild && debugSpeechRevision > 0) destination = AppDestination.DEBUG_SPEECH
    }
    DisposableEffect(context) {
        val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val mainHandler = Handler(Looper.getMainLooper())
        fun hasValidatedNetwork(): Boolean {
            val network = connectivityManager.activeNetwork ?: return false
            val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
            return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        }
        hasValidatedNetwork()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                mainHandler.post {
                    sessionStore.appendDebugLog("network available")
                }
            }

            override fun onLost(network: Network) {
                mainHandler.post {
                    if (!hasValidatedNetwork()) {
                        sessionStore.appendDebugLog("network lost")
                        terminalSessions.forEachIndexed { index, managed ->
                            terminalSessions[index] = managed.copy(updatedAtMillis = System.currentTimeMillis())
                        }
                    }
                }
            }
        }
        connectivityManager.registerNetworkCallback(NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), callback)
        onDispose { connectivityManager.unregisterNetworkCallback(callback) }
    }
    LaunchedEffect(Unit) {
        val saved = sessionStore.loadSession()
        if (saved == null) {
            authState = AuthState.LoggedOut
        } else {
            runCatching {
                val api = CoderApi(saved.first, saved.second)
                try {
                    CoderSession(saved.first, saved.second, api.me())
                } finally {
                    api.close()
                }
            }.onSuccess { authState = AuthState.LoggedIn(it) }.onFailure {
                sessionStore.clearSession()
                authState = AuthState.LoggedOut
            }
        }
    }
    (authState as? AuthState.LoggedIn)?.session?.let { session ->
        LaunchedEffect(deepLinkRevision, deepLinkTerminalId, terminalSessions.size) {
            val terminalId = deepLinkTerminalId ?: return@LaunchedEffect
            terminalSessions.firstOrNull { it.id == terminalId }?.let {
                destination = AppDestination.HOME
                TerminalWindowLauncher.open(context, it.launch, it.identity)
            }
        }
        val sessionKey = "${session.baseUrl}|${session.user.id}"
        LaunchedEffect(sessionKey, theme.name) {
            if (hydratedSessionKey == sessionKey || terminalSessions.isNotEmpty()) return@LaunchedEffect
            hydratedSessionKey = sessionKey
            sessionStore.activeTerminals(session.baseUrl, session.user.id).forEach { metadata ->
                val workspaceLabel = sessionStore.workspaceState(metadata.baseUrl, metadata.userId, metadata.workspaceId).alias ?: metadata.workspaceName
                val launch = TerminalLaunchRequest(session.baseUrl, session.token, metadata.agentId, metadata.reconnectId, metadata.command, workspaceLabel, metadata.agentName, metadata.workspaceName, metadata.workspaceIconUrl)
                val identity = TerminalIdentity(metadata.baseUrl, metadata.userId, metadata.workspaceId, metadata.agentId, metadata.command)
                val id = terminalSessionKey(identity)
                if (terminalSessions.any { it.id == id }) return@forEach
                val managed = ActiveTerminalWindow(id, launch, identity, metadata.preview.lines().filter { it.isNotBlank() }.takeLast(5), metadata.updatedAtMillis, activeTerminalAgentStatus(id, metadata))
                terminalSessions.add(managed)
            }
        }
        LaunchedEffect(sessionKey) {
            while (true) {
                delay(2_000)
                val metadataById = sessionStore.activeTerminals(session.baseUrl, session.user.id).associateBy { metadata ->
                    terminalSessionKey(TerminalIdentity(metadata.baseUrl, metadata.userId, metadata.workspaceId, metadata.agentId, metadata.command))
                }
                terminalSessions.removeAll { managed -> managed.id !in metadataById.keys }
                metadataById.forEach { (id, metadata) ->
                    if (terminalSessions.any { it.id == id }) return@forEach
                    val workspaceLabel = sessionStore.workspaceState(metadata.baseUrl, metadata.userId, metadata.workspaceId).alias ?: metadata.workspaceName
                    val launch = TerminalLaunchRequest(session.baseUrl, session.token, metadata.agentId, metadata.reconnectId, metadata.command, workspaceLabel, metadata.agentName, metadata.workspaceName, metadata.workspaceIconUrl)
                    val identity = TerminalIdentity(metadata.baseUrl, metadata.userId, metadata.workspaceId, metadata.agentId, metadata.command)
                    terminalSessions.add(ActiveTerminalWindow(id, launch, identity, metadata.preview.lines().filter { it.isNotBlank() }.takeLast(5), metadata.updatedAtMillis, activeTerminalAgentStatus(id, metadata)))
                }
                terminalSessions.forEachIndexed { index, managed ->
                    val metadata = metadataById[managed.id] ?: return@forEachIndexed
                    val previewLines = metadata.preview.lines().filter { it.isNotBlank() }.takeLast(5)
                    terminalSessions[index] = managed.copy(previewLines = previewLines, updatedAtMillis = metadata.updatedAtMillis, agentStatus = activeTerminalAgentStatus(managed.id, metadata))
                }
            }
        }
    }
    HapticTarget.view = LocalContext.current.findActivityView()
    HapticTarget.enabled = remember(context) { context.getSharedPreferences("app", Context.MODE_PRIVATE).getBoolean("haptic_feedback", true) }
    val appTypography = remember(uiRevision) { appTypography(CoderFonts.uiFontFamily(context)) }
    MaterialTheme(typography = appTypography) {
        Box(Modifier.fillMaxSize().background(tokens.background)) {
            when (destination) {
                AppDestination.HOME -> when (val state = authState) {
                    AuthState.Loading -> LoadingScreen(tokens)
                    AuthState.LoggedOut -> LoginScreen(tokens) { baseUrl ->
                        authState = AuthState.TokenInput(baseUrl)
                        CustomTabsIntent.Builder().build().launchUrl(context, (baseUrl.trimEnd('/') + "/cli-auth").toUri())
                    }
                    is AuthState.TokenInput -> {
                        BackHandler { authState = AuthState.LoggedOut }
                        TokenScreen(tokens, state.baseUrl, { baseUrl ->
                            CustomTabsIntent.Builder().build().launchUrl(context, (baseUrl.trimEnd('/') + "/cli-auth").toUri())
                        }) { baseUrl, token ->
                            val api = CoderApi(baseUrl, token)
                            runCatching {
                                try {
                                    api.me()
                                } finally {
                                    api.close()
                                }
                            }.onSuccess { user ->
                                sessionStore.saveSession(baseUrl, token)
                                authState = AuthState.LoggedIn(CoderSession(baseUrl, token, user))
                            }
                        }
                    }
                    is AuthState.LoggedIn -> CoderHomeScreen(
                        session = state.session,
                        terminalView = terminalView,
                        theme = theme,
                        tokens = tokens,
                        sessionStore = sessionStore,
                        onSessionExpired = {
                        TerminalActivity.finishDetachedTerminals(state.session.baseUrl, state.session.user.id)
                        sessionStore.clearSession()
                        sessionStore.clearActiveTerminals(state.session.baseUrl, state.session.user.id)
                            TerminalConnectionManager.stopAll()
                            terminalSessions.clear()
                            authState = AuthState.LoggedOut
                            destination = AppDestination.HOME
                        },
                        onOpenSettings = { destination = AppDestination.SETTINGS; onHideKeyboard() },
                        activeTerminals = terminalSessions,
                        onResumeTerminal = {
                            val now = System.currentTimeMillis()
                            val index = terminalSessions.indexOfFirst { session -> session.id == it.id }
                            if (index >= 0) terminalSessions[index] = terminalSessions[index].copy(updatedAtMillis = now)
                            sessionStore.saveActiveTerminal(CoderActiveTerminalMetadata(it.identity.baseUrl, it.identity.userId, it.identity.workspaceId, it.launch.title, it.identity.agentId, it.launch.badge, it.identity.command, it.launch.reconnectId, now, it.previewLines.joinToString("\n"), workspaceIconUrl = it.launch.workspaceIconUrl, agentStatusTitle = it.agentStatus?.title, agentStatusSubtitle = it.agentStatus?.subtitle))
                            TerminalWindowLauncher.open(context, it.launch, it.identity)
                        },
                        onCloseTerminal = {
                            confirmCloseTerminalId = it.id
                        },
                        onOpenTerminal = { workspace, agent, command ->
                            val reconnect = sessionStore.reconnectToken(state.session.baseUrl, state.session.user.id, workspace.id, agent.id, command)
                            val workspaceLabel = sessionStore.workspaceState(state.session.baseUrl, state.session.user.id, workspace.id).alias ?: workspace.name
                            val launch = TerminalLaunchRequest(state.session.baseUrl, state.session.token, agent.id, reconnect.id, command, workspaceLabel, agent.name, workspace.name, workspace.templateIcon)
                            val identity = TerminalIdentity(state.session.baseUrl, state.session.user.id, workspace.id, agent.id, command)
                            val id = terminalSessionKey(identity)
                            terminalSessions.firstOrNull { it.id == id }?.let {
                                TerminalWindowLauncher.open(context, it.launch, it.identity)
                                return@CoderHomeScreen
                            }
                            if (terminalSessions.size >= MaxActiveTerminalSessions) {
                                Toast.makeText(context, "Close an active session before opening another terminal. Limit is $MaxActiveTerminalSessions.", Toast.LENGTH_SHORT).show()
                                return@CoderHomeScreen
                            }
                            sessionStore.saveActiveTerminal(CoderActiveTerminalMetadata(state.session.baseUrl, state.session.user.id, workspace.id, workspace.name, agent.id, agent.name, command, reconnect.id, System.currentTimeMillis(), workspaceIconUrl = workspace.templateIcon))
                            val managed = ActiveTerminalWindow(id, launch, identity, emptyList(), System.currentTimeMillis(), null)
                            terminalSessions.add(managed)
                            TerminalWindowLauncher.open(context, launch, identity)
                        },
                    )
                }
                AppDestination.DEBUG_RENDER -> DebugRenderPlayground(theme, tokens) { destination = AppDestination.HOME }
                AppDestination.DEBUG_SPEECH -> DebugSpeechPlayground(theme, tokens, debugSpeechState) { destination = AppDestination.HOME }
                AppDestination.SETTINGS -> SettingsNavigator((authState as? AuthState.LoggedIn)?.session, sessionStore, terminalView, theme, tokens, uiRevision, appShortcutSettingsPage ?: deepLinkSettingsPage, deepLinkRevision, onThemeChanged, { key ->
                    terminalView.setFontFamily(key)
                    onFontChanged()
                }, { points ->
                    terminalView.setFontSizePoints(points)
                    onFontChanged()
                }, onFontChanged) { appShortcutSettingsPage = null; destination = AppDestination.HOME }
            }
            confirmCloseTerminalId?.let { terminalId ->
                ConfirmCloseTerminalDialog(
                    tokens = tokens,
                    onDismiss = { confirmCloseTerminalId = null },
                    onConfirm = {
                        confirmCloseTerminalId = null
                        val managed = terminalSessions.firstOrNull { it.id == terminalId }
                        TerminalConnectionManager.stop(terminalId)
                        managed?.let { sessionStore.removeActiveTerminal(it.identity.baseUrl, it.identity.userId, it.identity.workspaceId, it.identity.agentId, it.identity.command) }
                        terminalSessions.removeAll { it.id == terminalId }
                        onHideKeyboard()
                    },
                )
            }
        }
    }
}

data class TerminalLaunchRequest(val baseUrl: String, val token: String, val agentId: String, val reconnectId: String, val command: String, val title: String, val badge: String, val workspaceName: String = title, val workspaceIconUrl: String? = null)

data class TerminalIdentity(val baseUrl: String, val userId: String, val workspaceId: String, val agentId: String, val command: String)

private data class ActiveTerminalWindow(val id: String, val launch: TerminalLaunchRequest, val identity: TerminalIdentity, val previewLines: List<String>, val updatedAtMillis: Long, val agentStatus: TerminalAgentStatusPresentation?)

private fun CoderActiveTerminalMetadata.agentStatusPresentation(): TerminalAgentStatusPresentation? {
    val title = agentStatusTitle?.takeIf { it.isNotBlank() } ?: return null
    val subtitle = agentStatusSubtitle?.takeIf { it.isNotBlank() } ?: return null
    return TerminalAgentStatusPresentation(title, subtitle)
}

private fun activeTerminalAgentStatus(terminalId: String, metadata: CoderActiveTerminalMetadata): TerminalAgentStatusPresentation? =
    if (TerminalConnectionManager.hasRuntime(terminalId)) TerminalConnectionManager.agentStatus(terminalId) else metadata.agentStatusPresentation()

private const val MaxActiveTerminalSessions = 10

@Composable
private fun ThemedAlertDialog(onDismissRequest: () -> Unit, tokens: UiTokens, title: @Composable () -> Unit, text: @Composable () -> Unit, confirmButton: @Composable () -> Unit, dismissButton: @Composable () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismissRequest,
        containerColor = tokens.surfaceHigh,
        titleContentColor = tokens.text,
        textContentColor = tokens.secondary,
        shape = RoundedCornerShape(28.dp),
        tonalElevation = 0.dp,
        title = title,
        text = text,
        confirmButton = confirmButton,
        dismissButton = dismissButton,
    )
}

@Composable
private fun ConfirmCloseTerminalDialog(tokens: UiTokens, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    ThemedAlertDialog(
        onDismissRequest = onDismiss,
        tokens = tokens,
        title = { Text("Close terminal?") },
        text = { Text("This stops the active Coder terminal connection. Minimize keeps it running in the background.") },
        confirmButton = { TextButton(onClick = { hapticClick(); onConfirm() }) { Text("Close", color = Color(0xffff5c7a)) } },
        dismissButton = { TextButton(onClick = { hapticClick(); onDismiss() }) { Text("Cancel", color = tokens.accent) } },
    )
}

@Composable
private fun LoadingScreen(tokens: UiTokens) {
    Column(Modifier.fillMaxSize().background(tokens.background).statusBarsPadding().padding(24.dp), verticalArrangement = Arrangement.Center) {
        CoderShimmerBox(tokens, Modifier.fillMaxWidth(0.52f).height(34.dp).clip(RoundedCornerShape(12.dp)))
        Spacer(Modifier.height(18.dp))
        CoderShimmerBox(tokens, Modifier.fillMaxWidth().height(92.dp).clip(RoundedCornerShape(22.dp)))
        Spacer(Modifier.height(12.dp))
        CoderShimmerBox(tokens, Modifier.fillMaxWidth().height(76.dp).clip(RoundedCornerShape(18.dp)))
        Spacer(Modifier.height(12.dp))
        CoderShimmerBox(tokens, Modifier.fillMaxWidth().height(76.dp).clip(RoundedCornerShape(18.dp)))
    }
}

@Composable
private fun LoginScreen(tokens: UiTokens, onLogin: (String) -> Unit) {
    var baseUrl by remember { mutableStateOf("https://coder.0iq.xyz") }
    Column(Modifier.fillMaxSize().background(tokens.background).statusBarsPadding().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("Coder", color = tokens.text, fontSize = 34.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(10.dp))
        Text("Enter self-hosted Coder URL. Login opens Coder CLI auth in browser.", color = tokens.secondary, fontSize = bodySize())
        Spacer(Modifier.height(22.dp))
        CoderTextField(baseUrl, { baseUrl = it }, "https://coder.example.com", tokens)
        Spacer(Modifier.height(16.dp))
        CoderPrimaryButton("Login", tokens) { onLogin(normalizeBaseUrl(baseUrl)) }
    }
}

@Composable
private fun TokenScreen(tokens: UiTokens, baseUrl: String, onReopen: (String) -> Unit, onToken: suspend (String, String) -> Unit) {
    var token by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().background(tokens.background).statusBarsPadding().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("Paste token", color = tokens.text, fontSize = 30.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(10.dp))
        Text("Complete login in browser, copy token, return here.", color = tokens.secondary, fontSize = bodySize())
        Spacer(Modifier.height(18.dp))
        CoderTextField(token, { token = it.trim() }, "Coder token", tokens)
        if (error != null) Text(error ?: "", color = tokens.accent, fontSize = captionSize(), modifier = Modifier.padding(top = 8.dp))
        Spacer(Modifier.height(16.dp))
        CoderPrimaryButton("Continue", tokens) {
            scope.launch { runCatching { onToken(baseUrl, token) }.onFailure { error = "Invalid token" } }
        }
        Spacer(Modifier.height(10.dp))
        CoderSecondaryButton("Reopen auth page", tokens) { onReopen(baseUrl) }
    }
}

@Composable
private fun CoderHomeScreen(session: CoderSession, terminalView: CoderTerminalView, theme: CoderTheme, tokens: UiTokens, sessionStore: CoderSessionStore, activeTerminals: List<ActiveTerminalWindow>, onResumeTerminal: (ActiveTerminalWindow) -> Unit, onCloseTerminal: (ActiveTerminalWindow) -> Unit, onSessionExpired: () -> Unit, onOpenSettings: () -> Unit, onOpenTerminal: (CoderWorkspace, CoderWorkspaceAgent, String) -> Unit) {
    val scope = rememberCoroutineScope()
    val api = remember(session) { CoderApi(session.baseUrl, session.token) }
    DisposableEffect(api) { onDispose { api.close() } }
    val context = LocalContext.current
    var workspaces by remember { mutableStateOf<List<CoderWorkspace>>(emptyList()) }
    var loadingWorkspaces by remember { mutableStateOf(true) }
    var refreshInFlight by remember { mutableStateOf(false) }
    var lastRefreshedAt by remember { mutableStateOf(0L) }
    var pullDistance by remember { mutableStateOf(0f) }
    var error by remember { mutableStateOf<String?>(null) }
    var inactiveCollapsed by remember { mutableStateOf(sessionStore.hideInactive()) }
    var selectedWorkspace by remember { mutableStateOf<CoderWorkspace?>(null) }
    var workspaceIconRevision by remember { mutableStateOf(0) }
    var selectedAgentPicker by remember { mutableStateOf<CoderWorkspace?>(null) }
    var tmuxLoading by remember { mutableStateOf<CoderWorkspaceAgent?>(null) }
    var tmuxPicker by remember { mutableStateOf<Triple<CoderWorkspace, CoderWorkspaceAgent, List<TmuxSession>>?>(null) }
    val metrics = rememberCoderUiMetrics()
    BackHandler(enabled = tmuxPicker != null || tmuxLoading != null || selectedAgentPicker != null || selectedWorkspace != null) {
        when {
            tmuxPicker != null -> tmuxPicker = null
            tmuxLoading != null -> tmuxLoading = null
            selectedAgentPicker != null -> selectedAgentPicker = null
            selectedWorkspace != null -> selectedWorkspace = null
        }
    }
    val iconPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val workspace = selectedWorkspace ?: return@rememberLauncherForActivityResult
        uri?.let {
            val localUri = copyWorkspaceIconToLocalStorage(context, workspace.id, it)
            if (localUri != null) {
                sessionStore.saveIcon(session.baseUrl, session.user.id, workspace.id, localUri)
                workspaceIconRevision++
            } else {
                Toast.makeText(context, "Could not save workspace icon", Toast.LENGTH_SHORT).show()
            }
        }
    }
    fun refresh() {
        if (refreshInFlight) return
        scope.launch {
            refreshInFlight = true
            loadingWorkspaces = true
            sessionStore.appendDebugLog("workspace refresh started")
            runCatching { api.workspaces() }
                .onSuccess { workspaces = it; error = null; lastRefreshedAt = System.currentTimeMillis(); sessionStore.appendDebugLog("workspace refresh ok ${it.size} workspaces") }
                .onFailure { failure -> if (failure.isUnauthorized()) onSessionExpired() else { error = safeUserError(failure, "Could not load workspaces"); sessionStore.appendDebugLog("workspace refresh failed ${error ?: "unknown"}") } }
            loadingWorkspaces = false
            refreshInFlight = false
        }
    }
    LaunchedEffect(session) { refresh() }
    LaunchedEffect(session, sessionStore.workspaceRefreshIntervalMillis()) {
        while (true) {
            delay(sessionStore.workspaceRefreshIntervalMillis())
            refresh()
        }
    }
    val sorted = workspaces.sortedWith(compareByDescending<CoderWorkspace> {
        val local = sessionStore.workspaceState(session.baseUrl, session.user.id, it.id)
        it.favorite || local.pinned
    }.thenBy { it.name })
    val running = sorted.filter { it.running }
    val inactive = sorted.filterNot { it.running }
    Box(Modifier.fillMaxSize().background(tokens.background).statusBarsPadding()) {
        LazyColumn(
            Modifier
                .fillMaxSize()
                .pointerInput(refreshInFlight) {
                    detectVerticalDragGestures(
                        onDragEnd = {
                            if (pullDistance > 130f) refresh()
                            pullDistance = 0f
                        },
                        onDragCancel = { pullDistance = 0f },
                    ) { change, dragAmount ->
                        if (dragAmount > 0f) {
                            pullDistance += dragAmount
                            change.consume()
                        }
                    }
                },
            contentPadding = WindowInsets.navigationBars.asPaddingValues(),
        ) {
            item { CoderHeaderActions("Workspaces", tokens, metrics, onOpenSettings) }
            if (lastRefreshedAt > 0L || refreshInFlight) item { Text(if (refreshInFlight) "Refreshing..." else "Updated ${relativeSessionTime(lastRefreshedAt)}", color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 4.dp)) }
            if (refreshInFlight) item { CoderShimmerBox(tokens, Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 6.dp).height(3.dp).clip(RoundedCornerShape(3.dp))) }
            item { ActiveCoderSessionSection(activeTerminals, tokens, metrics, onResumeTerminal, onCloseTerminal) }
            if (error != null) item { Text(error ?: "", color = tokens.accent, modifier = Modifier.padding(horizontal = spacingLarge())) }
            if (loadingWorkspaces && workspaces.isEmpty()) item { WorkspaceLoadingSection(tokens, metrics) }
            WorkspaceSection("RUNNING WORKSPACES", running, session, sessionStore, api, tokens, metrics, workspaceIconRevision, onSessionExpired, { failure -> error = safeUserError(failure, "Workspace action failed") }, { selectedWorkspace = it }, { workspace -> openWorkspace(scope, api, workspace, onOpenTerminal, { selectedAgentPicker = it }, { tmuxLoading = it }, { tmuxLoading = null; tmuxPicker = it }) }, { refresh() })
            item { CoderSectionHeader("STOPPED WORKSPACES", if (inactiveCollapsed) "show" else "hide", tokens, metrics) { inactiveCollapsed = !inactiveCollapsed } }
            if (!inactiveCollapsed) WorkspaceRows(inactive, session, sessionStore, api, tokens, metrics, workspaceIconRevision, onSessionExpired, { failure -> error = safeUserError(failure, "Workspace action failed") }, { selectedWorkspace = it }, { workspace -> openWorkspace(scope, api, workspace, onOpenTerminal, { selectedAgentPicker = it }, { tmuxLoading = it }, { tmuxLoading = null; tmuxPicker = it }) }, { refresh() })
        }
        selectedWorkspace?.let { workspace -> WorkspaceEditSheet(workspace, session, sessionStore, tokens, workspaceIconRevision, { selectedWorkspace = null }, { iconPicker.launch(arrayOf("image/png", "image/jpeg", "image/webp", "image/*")) }) }
        selectedAgentPicker?.let { workspace -> AgentPickerSheet(workspace, tokens, { selectedAgentPicker = null }) { agent ->
            selectedAgentPicker = null
            scope.launch {
                tmuxLoading = agent
                val sessions = runCatching { api.tmuxSessions(agent.id, UUID.randomUUID().toString()) }.getOrDefault(emptyList())
                tmuxLoading = null
                if (sessions.isEmpty()) onOpenTerminal(workspace, agent, defaultShellCommand()) else tmuxPicker = Triple(workspace, agent, sessions)
            }
        } }
        tmuxLoading?.let { agent -> CoderTmuxLoadingSheet(agent, tokens, metrics) { tmuxLoading = null } }
        tmuxPicker?.let { picker -> CoderTmuxSheet(picker.second, picker.third, tokens, metrics, { tmuxPicker = null }, { tmuxPicker = null; onOpenTerminal(picker.first, picker.second, defaultShellCommand()) }) { tmux -> tmuxPicker = null; onOpenTerminal(picker.first, picker.second, "tmux attach-session -t ${shellSingleQuote(tmux.name)}") } }
    }
}

private fun LazyListScope.WorkspaceSection(title: String, workspaces: List<CoderWorkspace>, session: CoderSession, sessionStore: CoderSessionStore, api: CoderApi, tokens: UiTokens, metrics: CoderUiMetrics, iconRevision: Int, onSessionExpired: () -> Unit, onActionError: (Throwable) -> Unit, onEdit: (CoderWorkspace) -> Unit, onOpen: (CoderWorkspace) -> Unit, refresh: () -> Unit) {
    item { CoderSectionHeader(title, null, tokens, metrics) }
    WorkspaceRows(workspaces, session, sessionStore, api, tokens, metrics, iconRevision, onSessionExpired, onActionError, onEdit, onOpen, refresh)
}

@Composable
private fun WorkspaceLoadingSection(tokens: UiTokens, metrics: CoderUiMetrics) {
    Column(Modifier.padding(top = 6.dp)) {
        CoderSectionHeader("LOADING WORKSPACES", null, tokens, metrics)
        repeat(3) {
            CoderShimmerBox(tokens, Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 6.dp).height(metrics.rowHeight).clip(RoundedCornerShape(metrics.rowCorner)))
        }
    }
}

@Composable
private fun ActiveCoderSessionSection(activeTerminals: List<ActiveTerminalWindow>, tokens: UiTokens, metrics: CoderUiMetrics, onResumeTerminal: (ActiveTerminalWindow) -> Unit, onCloseTerminal: (ActiveTerminalWindow) -> Unit) {
    val context = LocalContext.current
    val holdToClose = remember(context) { context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getBoolean("gesture.hold_to_close", true) }
    Column {
        Row(Modifier.fillMaxWidth().padding(start = spacingLarge(), end = spacingLarge(), top = 18.dp, bottom = 7.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("ACTIVE SESSIONS", color = tokens.secondary, fontSize = metrics.sectionSize, letterSpacing = 0.6.sp, modifier = Modifier.weight(1f))
            Text(if (holdToClose) "${activeTerminals.size}/$MaxActiveTerminalSessions · hold to close" else "${activeTerminals.size}/$MaxActiveTerminalSessions", color = tokens.secondary, fontSize = metrics.captionSize, fontFamily = FontFamily.Monospace)
        }
        if (activeTerminals.isEmpty()) {
            Box(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 4.dp).height(82.dp).clip(RoundedCornerShape(metrics.rowCorner)).background(tokens.surface).border(BorderStroke(0.5.dp, tokens.separator), RoundedCornerShape(metrics.rowCorner)).padding(horizontal = 18.dp), contentAlignment = Alignment.CenterStart) {
                Column {
                    Text("No active sessions", color = tokens.text, fontSize = metrics.bodySize, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(4.dp))
                    Text("Open a running workspace to start a terminal.", color = tokens.secondary, fontSize = metrics.captionSize)
                }
            }
            return@Column
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = spacingLarge(), end = spacingLarge()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            activeTerminals.forEach { managed ->
                ActiveCoderSessionCard(managed, tokens, metrics, holdToClose, { onResumeTerminal(managed) }, { onCloseTerminal(managed) })
            }
        }
    }
}

@Composable
private fun connectionHostLabel(baseUrl: String): String = runCatching { baseUrl.toUri().host ?: baseUrl.removePrefix("https://").removePrefix("http://") }.getOrDefault(baseUrl)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ActiveCoderSessionCard(managed: ActiveTerminalWindow, tokens: UiTokens, metrics: CoderUiMetrics, holdToClose: Boolean, onResume: () -> Unit, onClose: () -> Unit) {
    var updatedAtMillis by remember { mutableStateOf(managed.updatedAtMillis) }
    var relativeTime by remember { mutableStateOf(relativeSessionTime(updatedAtMillis)) }
    LaunchedEffect(managed.updatedAtMillis) {
        updatedAtMillis = managed.updatedAtMillis
        relativeTime = relativeSessionTime(updatedAtMillis)
    }
    LaunchedEffect(Unit) {
        while (true) {
            relativeTime = relativeSessionTime(updatedAtMillis)
            delay(1000)
        }
    }
    Column(
        Modifier
            .padding(start = 0.dp, top = 4.dp, bottom = 10.dp)
            .width(164.dp)
            .combinedClickable(onClick = { hapticClick(); onResume() }, onLongClick = if (holdToClose) ({ hapticClick(); onClose() }) else null)
    ) {
        Box(Modifier.width(148.dp).height(126.dp).clip(RoundedCornerShape(7.dp)).background(Color(0xff171724)).border(BorderStroke(0.5.dp, Color.White.copy(alpha = 0.08f)), RoundedCornerShape(7.dp))) {
            Row(Modifier.align(Alignment.TopStart).padding(start = 6.dp, top = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(6.dp).clip(CircleShape).background(Color(0xffffcc00)))
                Spacer(Modifier.width(4.dp))
                Box(Modifier.size(6.dp).clip(CircleShape).background(tokens.accent))
            }
            tmuxSessionLabel(managed.identity.command)?.let { tmuxLabel ->
                Text(tmuxLabel, color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.TopEnd).padding(top = 8.dp, end = 7.dp).clip(RoundedCornerShape(8.dp)).background(tokens.accent).padding(horizontal = 8.dp, vertical = 3.dp))
            }
            Column(Modifier.align(Alignment.TopStart).padding(start = 8.dp, top = 25.dp, end = 8.dp)) {
                val lines = managed.previewLines.ifEmpty { listOf("› terminal window") }
                lines.forEach { line -> Text(line, color = Color(0xffd8d8ea), fontSize = 9.sp, lineHeight = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(managed.launch.title, color = tokens.text, fontSize = metrics.bodySize, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(relativeTime, color = tokens.secondary, fontSize = smallCaptionSize(), maxLines = 1)
        managed.agentStatus?.let { status ->
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(6.dp).clip(CircleShape).background(tokens.accent))
                Spacer(Modifier.width(5.dp))
                Text(status.subtitle, color = tokens.accent, fontSize = smallCaptionSize(), maxLines = 1, overflow = TextOverflow.Ellipsis, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

fun tmuxSessionLabel(command: String): String? {
    val name = Regex("""tmux\s+attach(?:-session)?\s+-t\s+(.+)$""").find(command)?.groupValues?.getOrNull(1)?.trim()?.trim('"', '\'') ?: return null
    return if (name.length <= 10) name else name.split(Regex("[^A-Za-z0-9]+"), limit = 8).filter { it.isNotBlank() }.take(4).mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }.joinToString("").ifBlank { name.take(10) }
}

fun relativeSessionTime(timestampMillis: Long, nowMillis: Long = System.currentTimeMillis()): String {
    val seconds = ((nowMillis - timestampMillis).coerceAtLeast(0L) / 1000L).coerceAtLeast(0L)
    return when {
        seconds < 5 -> "now"
        seconds < 60 -> "${seconds}s ago"
        seconds < 3600 -> "${seconds / 60}m ago"
        seconds < 86_400 -> "${seconds / 3600}h ago"
        else -> "${seconds / 86_400}d ago"
    }
}

private fun LazyListScope.WorkspaceRows(workspaces: List<CoderWorkspace>, session: CoderSession, sessionStore: CoderSessionStore, api: CoderApi, tokens: UiTokens, metrics: CoderUiMetrics, iconRevision: Int, onSessionExpired: () -> Unit, onActionError: (Throwable) -> Unit, onEdit: (CoderWorkspace) -> Unit, onOpen: (CoderWorkspace) -> Unit, refresh: () -> Unit) {
    items(workspaces.size) { index -> WorkspaceRow(workspaces[index], session, sessionStore, api, tokens, metrics, iconRevision, onSessionExpired, onActionError, onEdit, onOpen, refresh) }
}

@Composable
private fun WorkspaceRow(workspace: CoderWorkspace, session: CoderSession, sessionStore: CoderSessionStore, api: CoderApi, tokens: UiTokens, metrics: CoderUiMetrics, iconRevision: Int, onSessionExpired: () -> Unit, onActionError: (Throwable) -> Unit, onEdit: (CoderWorkspace) -> Unit, onOpen: (CoderWorkspace) -> Unit, refresh: () -> Unit) {
    val scope = rememberCoroutineScope()
    val local = remember(workspace.id, iconRevision) { sessionStore.workspaceState(session.baseUrl, session.user.id, workspace.id) }
    CoderWorkspaceCard(
        title = local.alias ?: workspace.name,
        subtitle = "${workspace.templateName} · ${workspace.status}",
        iconUri = local.iconUri,
        iconUrl = workspace.templateIcon,
        favorite = workspace.favorite || local.pinned,
        inactive = !workspace.running,
        tokens = tokens,
        metrics = metrics,
        actions = listOf(
            CoderSwipeActionItem(R.drawable.ic_feather_edit_3, CoderActionButtonVariant.Neutral) { onEdit(workspace) },
            CoderSwipeActionItem(R.drawable.ic_feather_rotate_ccw, CoderActionButtonVariant.Accent) { scope.launch { runCatching { api.restartWorkspace(workspace.id) }.onSuccess { refresh() }.onFailure { if (it.isUnauthorized()) onSessionExpired() else onActionError(it) } } },
            CoderSwipeActionItem(R.drawable.ic_feather_power, if (workspace.running) CoderActionButtonVariant.Destructive else CoderActionButtonVariant.Accent) { scope.launch { runCatching { if (workspace.running) api.stopWorkspace(workspace.id) else api.startWorkspace(workspace.id) }.onSuccess { refresh() }.onFailure { if (it.isUnauthorized()) onSessionExpired() else onActionError(it) } } },
            CoderSwipeActionItem(R.drawable.ic_feather_star, if (workspace.favorite || local.pinned) CoderActionButtonVariant.Accent else CoderActionButtonVariant.Neutral) { scope.launch { runCatching { api.favoriteWorkspace(workspace.id, !workspace.favorite) }.onFailure { if (it.isUnauthorized()) onSessionExpired() else { sessionStore.savePinned(session.baseUrl, session.user.id, workspace.id, !local.pinned); onActionError(it) } }; refresh() } },
        ).filterNot { !workspace.running && it.icon == R.drawable.ic_feather_rotate_ccw },
        onOpen = { hapticClick(); onOpen(workspace) },
    )
}

private fun copyWorkspaceIconToLocalStorage(context: Context, workspaceId: String, uri: Uri): String? = runCatching {
    val directory = File(context.filesDir, "workspace_icons").apply { mkdirs() }
    val file = File(directory, "${workspaceId.hashCode()}.png")
    context.contentResolver.openInputStream(uri)?.use { input ->
        file.outputStream().use { output -> input.copyTo(output) }
    } ?: return@runCatching null
    Uri.fromFile(file).toString()
}.getOrNull()

@Composable
private fun WorkspaceEditSheet(workspace: CoderWorkspace, session: CoderSession, sessionStore: CoderSessionStore, tokens: UiTokens, iconRevision: Int, onDismiss: () -> Unit, onPickIcon: () -> Unit) {
    val initialAlias = remember(workspace.id) { sessionStore.workspaceState(session.baseUrl, session.user.id, workspace.id).alias.orEmpty() }
    var alias by remember { mutableStateOf(initialAlias) }
    var showDiscardDialog by remember { mutableStateOf(false) }
    val local = remember(workspace.id, iconRevision) { sessionStore.workspaceState(session.baseUrl, session.user.id, workspace.id) }
    val metrics = rememberCoderUiMetrics()
    val displayName = alias.ifBlank { workspace.name }
    val usefulResources = workspace.resources.filter { it.agents.isNotEmpty() || it.dailyCost > 0 || it.metadata.isNotEmpty() }.filterNot { it.type == "coder_env" || it.type == "terraform_data" }
    val hasUnsavedChanges = alias != initialAlias
    fun saveAndClose() {
        sessionStore.saveAlias(session.baseUrl, session.user.id, workspace.id, alias)
        onDismiss()
    }
    fun requestClose() {
        if (hasUnsavedChanges) showDiscardDialog = true else onDismiss()
    }
    BackHandler { requestClose() }
    Box(Modifier.fillMaxSize().background(tokens.background).statusBarsPadding()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = metrics.screenPadding, vertical = metrics.sheetPadding * 0.8f)) {
            Row(Modifier.fillMaxWidth().height(54.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("‹", color = tokens.text, fontSize = 28.sp, modifier = Modifier.width(34.dp).clickable { hapticClick(); requestClose() })
                Text("Workspace", color = tokens.text, fontSize = titleSize(), fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                Icon(painterResource(R.drawable.ic_feather_check), null, tint = tokens.text, modifier = Modifier.size(24.dp).clickable { hapticClick(); saveAndClose() })
            }
            Spacer(Modifier.height(metrics.sheetPadding * 0.8f))
            CoderWorkspaceSummary(displayName, "${workspace.templateName} · ${workspace.status}", local.iconUri, workspace.templateIcon, !workspace.running, tokens, metrics)
            Spacer(Modifier.height(metrics.sheetPadding * 1.1f))
            CoderAvatarPicker(displayName, local.iconUri, workspace.templateIcon, !workspace.running, tokens, metrics) { hapticClick(); onPickIcon() }
            Spacer(Modifier.height(metrics.sheetPadding * 0.8f))
            CoderSectionLabel("Local alias", tokens, metrics)
            Spacer(Modifier.height(metrics.sheetPadding / 2))
            CoderTextField(alias, { alias = it }, "Local alias", tokens)
            Spacer(Modifier.height(metrics.sheetPadding * 1.2f))
            CoderWorkspaceRuntimeSection(workspace, tokens, metrics)
            AnimatedVisibility(workspace.latestAppStatus != null) {
                Column {
                    Spacer(Modifier.height(metrics.sheetPadding * 0.6f))
                    workspace.latestAppStatus?.let { appStatus ->
                        CoderInfoSection("App status", workspaceInfoRows("State" to appStatus.state, "Message" to appStatus.message, "Needs attention" to if (appStatus.needsUserAttention) "Yes" else null), tokens, metrics)
                    }
                }
            }
            workspace.agents.forEach { agent ->
                Spacer(Modifier.height(metrics.sheetPadding * 0.6f))
                CoderInfoSection("Agent", workspaceInfoRows(
                    "Name" to agent.name,
                    "Status" to agent.status,
                    "Lifecycle" to agent.lifecycleState.ifBlank { null },
                    "Health" to agentHealthLabel(agent),
                    "Platform" to listOf(agent.operatingSystem, agent.architecture).filter { it.isNotBlank() }.joinToString(" / ").ifBlank { null },
                    "Version" to agent.version.ifBlank { null },
                    "Latency" to agent.latencyMilliseconds?.let { "${"%.1f".format(it)} ms" },
                    "Apps" to agent.appsCount.takeIf { it > 0 }?.toString(),
                    "Scripts" to agent.scriptsCount.takeIf { it > 0 }?.toString(),
                    "Started" to agent.startedAt,
                    "Last connected" to agent.lastConnectedAt,
                ), tokens, metrics)
            }
            usefulResources.forEach { resource ->
                Spacer(Modifier.height(metrics.sheetPadding * 0.6f))
                CoderInfoSection("Resource", workspaceInfoRows("Name" to resource.name.ifBlank { resource.type }, "Type" to resource.type.ifBlank { null }, "Cost" to resource.dailyCost.takeIf { it > 0 }?.let { "$it credits/day" }, *resource.metadata.map { readableWorkspaceMetadataKey(it.key) to it.value }.toTypedArray()), tokens, metrics)
            }
            Spacer(Modifier.height(WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 12.dp))
        }
        if (showDiscardDialog) {
            ThemedAlertDialog(
                onDismissRequest = { showDiscardDialog = false },
                tokens = tokens,
                title = { Text("Discard changes?") },
                text = { Text("Local alias has unsaved changes.") },
                confirmButton = { TextButton(onClick = { showDiscardDialog = false; onDismiss() }) { Text("Discard", color = tokens.accent) } },
                dismissButton = { TextButton(onClick = { showDiscardDialog = false }) { Text("Keep editing", color = tokens.text) } },
            )
        }
    }
}

@Composable
private fun CoderWorkspaceRuntimeSection(workspace: CoderWorkspace, tokens: UiTokens, metrics: CoderUiMetrics) {
    val rows = workspaceInfoRows(
                "Name" to workspace.name,
                "Template" to workspace.templateName,
                "Status" to workspace.status,
                "Health" to workspaceHealthLabel(workspace),
                "Cost" to workspace.dailyCost.takeIf { it > 0 }?.let { "$it credits/day" },
                "Transition" to workspace.transition.ifBlank { null },
                "Deadline" to workspace.deadline,
    )
    Column(Modifier.fillMaxWidth()) {
        CoderSectionLabel("Runtime", tokens, metrics)
        Spacer(Modifier.height(metrics.sheetPadding / 2))
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(metrics.rowCorner)).background(tokens.surface).border(BorderStroke(0.5.dp, tokens.separator), RoundedCornerShape(metrics.rowCorner)).padding(metrics.sheetPadding * 0.7f)) {
            val allRows = if (workspace.lastUsedAt == null) rows else rows.take(4) + ("Last used" to workspace.lastUsedAt) + rows.drop(4)
            allRows.forEachIndexed { index, row ->
                if (row.first == "Last used") {
                    CoderInfoRow(row.first, tokens, metrics) { CoderToggleDateValue(row.second, tokens, metrics, ::coderSinceLabel, ::coderDateLabel, Modifier.weight(1f)) }
                } else {
                    CoderInfoRow(row.first, tokens, metrics) { Text(row.second, color = tokens.text, fontSize = metrics.bodySize, modifier = Modifier.weight(1f)) }
                }
                if (index != allRows.lastIndex) Box(Modifier.fillMaxWidth().height(0.5.dp).background(tokens.separator))
            }
        }
    }
}

private fun workspaceInfoRows(vararg rows: Pair<String, String?>): List<Pair<String, String>> = rows.mapNotNull { row -> row.second?.let { row.first to it } }

private fun workspaceHealthLabel(workspace: CoderWorkspace): String? = workspace.health?.let { if (it.healthy) "Healthy" else "${it.failingAgents} failing agents" }

private fun agentHealthLabel(agent: CoderWorkspaceAgent): String? = agent.health?.let { if (it.healthy) "Healthy" else it.reason.ifBlank { "Unhealthy" } }

private fun coderSinceLabel(timestamp: String): String = runCatching { relativeSessionTime(Instant.parse(timestamp).toEpochMilli()) }.getOrDefault(timestamp)

private fun coderDateLabel(timestamp: String): String = runCatching { DateTimeFormatter.ofPattern("MMM d, yyyy HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(timestamp)) }.getOrDefault(timestamp)

private fun readableWorkspaceMetadataKey(key: String): String = key.replace('_', ' ').replace('-', ' ').split(' ').filter { it.isNotBlank() }.joinToString(" ") { it.replaceFirstChar { char -> char.uppercaseChar().toString() } }

@Composable
private fun AgentPickerSheet(workspace: CoderWorkspace, tokens: UiTokens, onDismiss: () -> Unit, onAgent: (CoderWorkspaceAgent) -> Unit) {
    Box(Modifier.fillMaxSize()) {
        SheetScrim(onDismiss)
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().alignBottomSheet(tokens).padding(20.dp)) {
            SheetHandle(tokens)
            Text("Choose agent", color = tokens.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            workspace.agents.forEach { HostSheetRow(it.name, it.status, tokens) { onAgent(it) } }
        }
    }
}

@Composable
private fun TmuxPickerSheet(agent: CoderWorkspaceAgent, sessions: List<TmuxSession>, tokens: UiTokens, onDismiss: () -> Unit, onTmux: (TmuxSession) -> Unit) {
    Box(Modifier.fillMaxSize()) {
        SheetScrim(onDismiss)
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.86f).alignBottomSheet(tokens).padding(20.dp)) {
            SheetHandle(tokens)
            Text("Tmux sessions on ${agent.name}", color = tokens.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(12.dp))
            LazyColumn(Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(18.dp)).background(tokens.surface), contentPadding = PaddingValues(bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 12.dp)) {
                items(sessions.size) { index ->
                    val tmux = sessions[index]
                    HostSheetRow(tmux.name, "${tmux.windows} windows", tokens) { onTmux(tmux) }
                }
                item { HostSheetRow("New shell", "No tmux attach", tokens) { onDismiss() } }
            }
        }
    }
}

@Composable
private fun CoderTmuxSheet(agent: CoderWorkspaceAgent, sessions: List<TmuxSession>, tokens: UiTokens, metrics: CoderUiMetrics, onDismiss: () -> Unit, onNewShell: () -> Unit, onTmux: (TmuxSession) -> Unit) {
    CoderResizableBottomSheet(tokens, metrics, onDismiss, label = "tmux-sheet-height") {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                CoderPill("›_  Tmux", tokens, metrics)
                Spacer(Modifier.weight(1f))
                CoderPill("Skip ▷", tokens, metrics) { hapticClick(); onNewShell() }
            }
            Spacer(Modifier.height(metrics.sheetPadding))
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(metrics.rowCorner)).background(tokens.surface).padding(metrics.sheetPadding * 0.8f), verticalAlignment = Alignment.CenterVertically) {
                Icon(painterResource(R.drawable.ic_feather_sliders), null, tint = tokens.accent, modifier = Modifier.size(metrics.iconSize))
                Spacer(Modifier.width(metrics.iconGap / 2))
                Column(Modifier.weight(1f)) {
                    Text("${sessions.size} tmux sessions on ${agent.name}", color = tokens.text, fontSize = metrics.bodySize, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(agent.status, color = tokens.secondary, fontSize = metrics.captionSize, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text("Open ›", color = tokens.accent, fontSize = metrics.bodySize)
            }
            Spacer(Modifier.height(metrics.sheetPadding * 0.7f))
            LazyColumn(Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(metrics.rowCorner)).background(tokens.surface), contentPadding = PaddingValues(bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + metrics.sheetPadding)) {
                items(sessions.size) { index ->
                    val session = sessions[index]
                    HostSheetRow(session.name, "${session.windows} windows", tokens) { onTmux(session) }
                }
            }
    }
}

@Composable
private fun CoderResizableBottomSheet(tokens: UiTokens, metrics: CoderUiMetrics, onDismiss: () -> Unit, label: String, initialHeightFraction: Float = 0.68f, minHeightFraction: Float = 0.42f, header: (@Composable ColumnScope.(Modifier, () -> Unit) -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    var sheetHeightFraction by remember { mutableFloatStateOf(initialHeightFraction) }
    var expanded by remember { mutableStateOf(false) }
    val density = LocalDensity.current.density
    val animatedSheetHeightFraction by animateFloatAsState(if (expanded) 1f else sheetHeightFraction, animationSpec = spring(dampingRatio = 0.82f, stiffness = 360f), label = label)
    val sheetDragModifier = Modifier.pointerInput(Unit) {
        detectVerticalDragGestures(
            onVerticalDrag = { change, dragAmount ->
                change.consume()
                sheetHeightFraction = (sheetHeightFraction - (dragAmount / density / 700f)).coerceIn(minHeightFraction, 1f)
                expanded = sheetHeightFraction > 0.96f
            },
            onDragEnd = {
                sheetHeightFraction = when {
                    sheetHeightFraction > 0.82f -> 1f
                    sheetHeightFraction > 0.58f -> initialHeightFraction
                    else -> minHeightFraction
                }
                expanded = sheetHeightFraction >= 0.99f
            },
        )
    }
    Box(Modifier.fillMaxSize()) {
        SheetScrim(onDismiss)
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(animatedSheetHeightFraction).alignBottomSheet(tokens, expanded).padding(metrics.sheetPadding)) {
            val expandSheet = { expanded = true; sheetHeightFraction = 1f }
            if (header == null) SheetHandle(tokens, expandSheet, sheetDragModifier) else header(sheetDragModifier, expandSheet)
            content()
        }
    }
}

@Composable
private fun CoderTmuxLoadingSheet(agent: CoderWorkspaceAgent, tokens: UiTokens, metrics: CoderUiMetrics, onDismiss: () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        SheetScrim(onDismiss)
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.34f).alignBottomSheet(tokens).padding(metrics.sheetPadding)) {
            CoderSheetHandle(tokens, metrics)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                CoderPill("›_  Tmux", tokens, metrics)
                Spacer(Modifier.weight(1f))
                CoderPill("Skip ▷", tokens, metrics) { hapticClick(); onDismiss() }
            }
            Spacer(Modifier.height(metrics.sheetPadding))
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(metrics.rowCorner)).background(tokens.surface).padding(metrics.sheetPadding * 0.8f), verticalAlignment = Alignment.CenterVertically) {
                Icon(painterResource(R.drawable.ic_feather_sliders), null, tint = tokens.accent, modifier = Modifier.size(metrics.iconSize))
                Spacer(Modifier.width(metrics.iconGap / 2))
                Column(Modifier.weight(1f)) {
                    Text("Checking tmux on ${agent.name}", color = tokens.text, fontSize = metrics.bodySize, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(agent.status, color = tokens.secondary, fontSize = metrics.captionSize, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Spacer(Modifier.height(metrics.sheetPadding * 0.7f))
            repeat(3) {
                CoderShimmerBox(tokens, Modifier.fillMaxWidth().height(42.dp).padding(vertical = 4.dp).clip(RoundedCornerShape(12.dp)))
            }
        }
    }
}

private fun openWorkspace(scope: kotlinx.coroutines.CoroutineScope, api: CoderApi, workspace: CoderWorkspace, onOpenTerminal: (CoderWorkspace, CoderWorkspaceAgent, String) -> Unit, onChooseAgent: (CoderWorkspace) -> Unit, onTmuxLoading: (CoderWorkspaceAgent) -> Unit, onTmux: (Triple<CoderWorkspace, CoderWorkspaceAgent, List<TmuxSession>>) -> Unit) {
    if (workspace.agents.size > 1) {
        onChooseAgent(workspace)
        return
    }
    val agent = workspace.agents.firstOrNull() ?: return
    scope.launch {
        onTmuxLoading(agent)
        val sessions = runCatching { api.tmuxSessions(agent.id, UUID.randomUUID().toString()) }.getOrDefault(emptyList())
        if (sessions.isEmpty()) onOpenTerminal(workspace, agent, defaultShellCommand()) else onTmux(Triple(workspace, agent, sessions))
    }
}

@Composable
private fun CoderTextField(value: String, onValueChange: (String) -> Unit, placeholder: String, tokens: UiTokens) {
    BasicTextField(value = value, onValueChange = onValueChange, singleLine = true, textStyle = androidx.compose.ui.text.TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace), modifier = Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surfaceHigh).padding(horizontal = 14.dp, vertical = 15.dp), decorationBox = { inner -> if (value.isEmpty()) Text(placeholder, color = tokens.secondary, fontSize = bodySize(), fontFamily = FontFamily.Monospace); inner() })
}

@Composable
private fun CoderPrimaryButton(label: String, tokens: UiTokens, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(14.dp)).background(tokens.accent).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) { Text(label, color = contentColorFor(tokens.accent), fontSize = bodySize(), fontWeight = FontWeight.Bold) }
}

@Composable
private fun CoderSecondaryButton(label: String, tokens: UiTokens, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().height(48.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surface).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) { Text(label, color = tokens.text, fontSize = bodySize()) }
}

private fun normalizeBaseUrl(value: String) = value.trim().trimEnd('/').let { if (it.startsWith("http://") || it.startsWith("https://")) it else "https://$it" }

private fun defaultShellCommand() = "bash -lc 'exec ${'$'}{SHELL:-bash}'"

private fun shellSingleQuote(value: String) = "'" + value.replace("'", "'\\''") + "'"

private fun Throwable.isUnauthorized(): Boolean = this is ClientRequestException && response.status == HttpStatusCode.Unauthorized

fun safeUserError(error: Throwable, fallback: String): String {
    val message = error.message.orEmpty()
        .replace(Regex("Coder-Session-Token=[^\\s&]+", RegexOption.IGNORE_CASE), "Coder-Session-Token=<hidden>")
        .replace(Regex("(token|reconnect|command)=([^\\s&]+)", RegexOption.IGNORE_CASE), "$1=<hidden>")
        .replace(Regex("https?://[^\\s]+"), "<url>")
        .replace(Regex("wss?://[^\\s]+"), "<url>")
    return message.ifBlank { fallback }.take(160)
}

@Composable
private fun HostSheetRow(title: String, subtitle: String, tokens: UiTokens, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().height(72.dp).clickable { hapticClick(); onClick() }.padding(horizontal = 18.dp), verticalArrangement = Arrangement.Center) {
        Text(title, color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
        Text(subtitle, color = tokens.secondary, fontSize = captionSize())
    }
}

@Composable
private fun DebugRenderPlayground(theme: CoderTheme, tokens: UiTokens, onBack: () -> Unit) {
    val context = LocalContext.current
    val debugBuild = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (!debugBuild) {
        Box(Modifier.fillMaxSize().background(tokens.background))
        return
    }
    val debugFonts = remember { CoderFonts.builtInOptions().filter { it.key in setOf("jetbrains", "geist", "ibm_plex", "iosevka", "maple") } }
    val debugFontSizes = remember { listOf(12, 14, 16, 18, 20, 22) }
    var selectedDebugFontIndex by remember { mutableIntStateOf(debugFonts.indexOfFirst { it.key == "maple" }.takeIf { it >= 0 } ?: 0) }
    var selectedDebugFontSizeIndex by remember { mutableIntStateOf(debugFontSizes.indexOf(16).takeIf { it >= 0 } ?: 0) }
    val selectedDebugFont = debugFonts[selectedDebugFontIndex.coerceIn(debugFonts.indices)]
    val selectedDebugFontSize = debugFontSizes[selectedDebugFontSizeIndex.coerceIn(debugFontSizes.indices)]
    var oscMetadata by remember { mutableStateOf(TerminalOscMetadata("", "", 0L)) }
    var pendingHyperlink by remember { mutableStateOf<String?>(null) }
    var debugFramesScheduled by remember { mutableStateOf(false) }
    val playgroundTerminalView = remember(context) {
        CoderTerminalView(context).also {
            it.setFontSizePoints(16)
            it.applyTheme(theme)
        }
    }
    BackHandler { onBack() }
    DisposableEffect(playgroundTerminalView) {
        val metadataHandler: (TerminalOscMetadata) -> Unit = { oscMetadata = it }
        val hyperlinkHandler: (String) -> Unit = { if (terminalOscHyperlinkAllowed(context, it)) openTerminalHyperlink(context, it) else pendingHyperlink = it }
        playgroundTerminalView.onOscMetadataChanged = metadataHandler
        playgroundTerminalView.onHyperlinkActivated = hyperlinkHandler
        onDispose {
            if (playgroundTerminalView.onOscMetadataChanged === metadataHandler) playgroundTerminalView.onOscMetadataChanged = null
            if (playgroundTerminalView.onHyperlinkActivated === hyperlinkHandler) playgroundTerminalView.onHyperlinkActivated = null
            playgroundTerminalView.dispose()
        }
    }
    LaunchedEffect(selectedDebugFont.key, selectedDebugFontSize, theme) {
        playgroundTerminalView.applyTheme(theme)
        playgroundTerminalView.setFontSizePoints(selectedDebugFontSize)
        playgroundTerminalView.setPreviewFontFamily(selectedDebugFont.key)
        playgroundTerminalView.feedRemoteOutput(debugRenderPlaygroundBytes("${selectedDebugFont.name} ${selectedDebugFontSize}pt"))
        playgroundTerminalView.post { playgroundTerminalView.refreshSurface() }
    }
    Box(Modifier.fillMaxSize().background(theme.background.toComposeColor())) {
        AndroidView(
            factory = { playgroundTerminalView.prepareForComposeHost() },
            modifier = Modifier.fillMaxSize(),
            update = {
                it.applyTheme(theme)
                it.post { it.refreshSurface() }
                it.setFontSizePoints(selectedDebugFontSize)
                if (debugFramesScheduled) return@AndroidView
                debugFramesScheduled = true
                repeat(96) { frameIndex ->
                    it.postDelayed({ it.feedRemoteOutput(debugWorkingIndicatorFrameBytes(frameIndex)) }, 4500L + frameIndex * 80L)
                }
                repeat(240) { frameIndex ->
                    it.postDelayed({ it.feedRemoteOutput(debugShimmerFrameBytes(frameIndex)) }, 4500L + frameIndex * 80L)
                }
                listOf(0, 20, 45, 70, 100).forEachIndexed { index, progress ->
                    it.postDelayed({ it.feedRemoteOutput("\u001b]9;4;1;$progress\u0007".toByteArray(Charsets.UTF_8)) }, 5200L + index * 700L)
                }
                it.postDelayed({ it.feedRemoteOutput("\u001b]9;4;0;0\u0007".toByteArray(Charsets.UTF_8)) }, 9000L)
            },
        )
        Row(Modifier.align(Alignment.BottomEnd).padding(end = 10.dp, bottom = 96.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surfaceHigh.copy(alpha = 0.94f)).padding(horizontal = 6.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { selectedDebugFontIndex = (selectedDebugFontIndex + 1) % debugFonts.size }) { Text(selectedDebugFont.name, color = tokens.accent, fontSize = captionSize(), maxLines = 1, overflow = TextOverflow.Ellipsis) }
            TextButton(onClick = { selectedDebugFontSizeIndex = (selectedDebugFontSizeIndex + 1) % debugFontSizes.size }) { Text("${selectedDebugFontSize}pt", color = tokens.accent, fontSize = captionSize()) }
        }
        if (oscMetadata.title.isNotBlank() || oscMetadata.pwd.isNotBlank()) {
            Column(Modifier.align(Alignment.TopStart).padding(10.dp).clip(RoundedCornerShape(12.dp)).background(theme.background.toComposeColor().copy(alpha = 0.86f)).padding(horizontal = 10.dp, vertical = 7.dp)) {
                if (oscMetadata.title.isNotBlank()) Text(oscMetadata.title, color = theme.foreground.toComposeColor(), fontSize = captionSize(), maxLines = 1, overflow = TextOverflow.Ellipsis, fontFamily = FontFamily.Monospace)
                if (oscMetadata.pwd.isNotBlank()) Text(oscMetadata.pwd, color = theme.foreground.toComposeColor().copy(alpha = 0.64f), fontSize = smallCaptionSize(), maxLines = 1, overflow = TextOverflow.Ellipsis, fontFamily = FontFamily.Monospace)
            }
        }
        TerminalAccessory(theme, playgroundTerminalView, false, {}, {}, {}, {}, Modifier.align(Alignment.BottomCenter))
    }
    pendingHyperlink?.let { uri ->
        val tokens = uiTokens(theme)
        ThemedAlertDialog(
            onDismissRequest = { pendingHyperlink = null },
            tokens = tokens,
            title = { Text("Open link?") },
            text = { Text(uri, fontFamily = FontFamily.Monospace, fontSize = captionSize()) },
            confirmButton = {
                Row {
                    TextButton(onClick = {
                        terminalOscHyperlinkHost(uri)?.let { terminalSetLinkHostAllowed(context, it, true) }
                        pendingHyperlink = null
                        openTerminalHyperlink(context, uri)
                    }) { Text("Always", color = tokens.accent) }
                    TextButton(onClick = { pendingHyperlink = null; openTerminalHyperlink(context, uri) }) { Text("Open", color = tokens.accent) }
                }
            },
            dismissButton = { TextButton(onClick = { pendingHyperlink = null }) { Text("Cancel", color = tokens.text) } },
        )
    }
}

@Composable
private fun DebugSpeechPlayground(theme: CoderTheme, tokens: UiTokens, initialStateName: String?, onBack: () -> Unit) {
    val context = LocalContext.current
    val debugBuild = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (!debugBuild) {
        Box(Modifier.fillMaxSize().background(tokens.background))
        return
    }
    var displayState by remember { mutableStateOf(SpeechDictationDisplayState.IDLE) }
    var transcript by remember { mutableStateOf("") }
    val contract = SpeechDictationUxContract.contractFor(displayState)
    val fixtures = SpeechDictationUxContract.fixtures
    LaunchedEffect(initialStateName) {
        val initialState = initialStateName?.let { name -> SpeechDictationDisplayState.entries.firstOrNull { it.name.equals(name, ignoreCase = true) } } ?: return@LaunchedEffect
        displayState = initialState
        transcript = when (initialState) {
            SpeechDictationDisplayState.RECORDING_WITH_SPEECH -> fixtures.partialTranscript
            SpeechDictationDisplayState.TRANSCRIPT_READY, SpeechDictationDisplayState.ENHANCING_COLLAPSED, SpeechDictationDisplayState.ENHANCEMENT_TIMED_OUT, SpeechDictationDisplayState.ENHANCEMENT_FAILED -> fixtures.finalTranscript
            SpeechDictationDisplayState.ENHANCED_READY -> fixtures.enhancedTranscript
            SpeechDictationDisplayState.SUBMITTED -> fixtures.enhancedTranscript
            else -> ""
        }
    }
    fun applySpeechAction(action: SpeechDictationAction) {
        displayState = SpeechDictationUxContract.transition(displayState, action)
        when (action) {
            SpeechDictationAction.DETECT_SPEECH -> transcript = fixtures.partialTranscript
            SpeechDictationAction.COMPLETE_TRANSCRIPTION -> transcript = fixtures.finalTranscript
            SpeechDictationAction.COMPLETE_ENHANCEMENT -> transcript = fixtures.enhancedTranscript
            SpeechDictationAction.RESET, SpeechDictationAction.CANCEL -> transcript = ""
            else -> Unit
        }
    }
    BackHandler { onBack() }
    Column(Modifier.fillMaxSize().background(theme.background.toComposeColor()).padding(start = 16.dp, top = 72.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Column {
                Text("Speech UX", color = tokens.text, fontSize = titleSize(), fontWeight = FontWeight.Bold)
                Text("pi://debug/speech", color = tokens.secondary, fontSize = captionSize(), fontFamily = FontFamily.Monospace)
            }
            TextButton(onClick = onBack) { Text("Close", color = tokens.accent) }
        }
        Box(Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(18.dp)).background(tokens.surface).border(BorderStroke(1.dp, tokens.separator), RoundedCornerShape(18.dp)).padding(16.dp)) {
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Terminal themed chat composer", color = tokens.secondary, fontSize = captionSize(), fontFamily = FontFamily.Monospace)
                if (displayState == SpeechDictationDisplayState.IDLE) {
                    DebugSpeechStateCard(displayState, transcript, contract, tokens)
                    ChatInputBar(tokens = tokens, text = transcript, onTextChanged = { transcript = it }, attachments = emptyList(), onClear = { transcript = "" }, onSubmit = { displayState = SpeechDictationDisplayState.SUBMITTED }, onReturn = {}, onClose = onBack)
                } else {
                    DictationInputSurface(tokens = tokens, displayState = displayState, transcript = transcript, onAction = ::applySpeechAction)
                }
            }
        }
        DebugSpeechSimulationRail(displayState, contract, tokens, ::applySpeechAction)
    }
}

@Composable
private fun DebugSpeechStateCard(displayState: SpeechDictationDisplayState, transcript: String, contract: SpeechDictationStateContract, tokens: UiTokens) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(tokens.surfaceHigh).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(contract.accessibility.label, color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
        Text(contract.accessibility.testId, color = tokens.secondary, fontSize = captionSize(), fontFamily = FontFamily.Monospace)
        Text("state=${displayState.name.lowercase()} expanded=${contract.expanded} edit=${contract.canEdit}", color = tokens.secondary, fontSize = captionSize(), fontFamily = FontFamily.Monospace)
        if (transcript.isNotBlank()) Text(transcript, color = tokens.text, fontSize = bodySize())
    }
}

@Composable
private fun DebugSpeechSimulationRail(displayState: SpeechDictationDisplayState, contract: SpeechDictationStateContract, tokens: UiTokens, onAction: (SpeechDictationAction) -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(tokens.surfaceHigh).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Simulation", color = tokens.text, fontSize = captionSize(), fontWeight = FontWeight.SemiBold)
        val actions = listOf(
            "Start" to SpeechDictationAction.START_RECORDING,
            "Partial" to SpeechDictationAction.DETECT_SPEECH,
            "Finalize" to SpeechDictationAction.STOP_RECORDING,
            "Transcript" to SpeechDictationAction.COMPLETE_TRANSCRIPTION,
            "Enhance" to SpeechDictationAction.START_ENHANCEMENT,
            "Timeout" to SpeechDictationAction.TIME_OUT_ENHANCEMENT,
            "Fail" to SpeechDictationAction.FAIL_ENHANCEMENT,
            "Retry" to SpeechDictationAction.RETRY_ENHANCEMENT,
            "Complete" to SpeechDictationAction.COMPLETE_ENHANCEMENT,
            "Submit Raw" to SpeechDictationAction.SEND_RAW,
            "Submit Enhanced" to SpeechDictationAction.SEND_ENHANCED,
            "Cancel" to SpeechDictationAction.CANCEL,
            "Reset" to SpeechDictationAction.RESET,
        )
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            actions.chunked(4).forEach { rowActions ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    rowActions.forEach { (label, action) ->
                        val enabled = action in SpeechDictationUxContract.allowedActions(displayState)
                        DebugSpeechActionButton(label, enabled, tokens) { onAction(action) }
                    }
                }
            }
        }
        Text("cancel=${contract.canCancel} retry=${contract.canRetry} raw=${contract.canSendRaw} enhanced=${contract.canSendEnhanced} autoSend=${contract.canAutoSend}", color = tokens.secondary, fontSize = smallCaptionSize(), fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun RowScope.DebugSpeechActionButton(label: String, enabled: Boolean, tokens: UiTokens, onClick: () -> Unit) {
    val background = if (enabled) tokens.surface else tokens.surface.copy(alpha = 0.45f)
    val textColor = if (enabled) tokens.text else tokens.secondary.copy(alpha = 0.55f)
    Box(Modifier.weight(1f).height(38.dp).clip(RoundedCornerShape(12.dp)).background(background).then(if (enabled) Modifier.clickable { hapticClick(); onClick() } else Modifier), contentAlignment = Alignment.Center) {
        Text(label, color = textColor, fontSize = smallCaptionSize(), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

internal fun debugRenderPlaygroundBytes(fontName: String): ByteArray {
    val esc = "\u001b"
    val sample = buildString {
        append("${esc}[2J${esc}[H")
        append("${esc}]2;DotAI OSC $fontName${'\u0007'}")
        append("${esc}]7;file://coder.example/home/coder/dotai${'\u0007'}")
        append("${esc}]9;OSC notification smoke${'\u0007'}")
        append("${esc}]9;4;1;42${'\u0007'}")
        append("${esc}]52;c;${'\u0007'}")
        append("${esc}]777;notify;OSC 777 smoke;Legacy notification path${'\u0007'}")
        append("${esc}]6767;pi;1;hello;eyJpZCI6ImRiZy1oZWxsbyIsInRzIjoxNzc5MjAwMDAwMDAwLCJzb3VyY2UiOiJhZ2VudCIsInNlc3Npb25JZCI6ImRlYnVnIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6MSwiZGF0YSI6eyJwcm90b2NvbCI6MSwiZXh0ZW5zaW9uIjoicGktb3NjIiwidmVyc2lvbiI6MX19${esc}\\")
        append("${esc}]6767;pi;1;agent.run;eyJpZCI6ImRiZy1ydW4iLCJ0cyI6MTc3OTIwMDAwMDAwMSwic291cmNlIjoiYWdlbnQiLCJzZXNzaW9uSWQiOiJkZWJ1ZyIsImN3ZCI6Ii93b3Jrc3BhY2UiLCJzZXEiOjIsImRhdGEiOnsic3RhdGUiOiJydW5uaW5nIn19${esc}\\")
        append("${esc}]6767;pi;1;agent.tool;eyJpZCI6ImRiZy10b29sIiwidHMiOjE3NzkyMDAwMDAwMDIsInNvdXJjZSI6ImFnZW50Iiwic2Vzc2lvbklkIjoiZGVidWciLCJjd2QiOiIvd29ya3NwYWNlIiwic2VxIjozLCJkYXRhIjp7InRvb2xDYWxsSWQiOiJ0b29sLTEiLCJ0b29sTmFtZSI6ImJhc2giLCJzdGF0ZSI6InJ1bm5pbmcifX0${esc}\\")
        append("${esc}]6767;pi;1;agent.progress;eyJpZCI6ImRiZy1wcm9ncmVzcyIsInRzIjoxNzc5MjAwMDAwMDAzLCJzb3VyY2UiOiJhZ2VudCIsInNlc3Npb25JZCI6ImRlYnVnIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6NCwiZGF0YSI6eyJzdGF0ZSI6ImFjdGl2ZSJ9fQ${esc}\\")
        append("${esc}]6767;pi;1;agent.tool;eyJpZCI6ImRiZy10b29sLWRvbmUiLCJ0cyI6MTc3OTIwMDAwMDAwNCwic291cmNlIjoiYWdlbnQiLCJzZXNzaW9uSWQiOiJkZWJ1ZyIsImN3ZCI6Ii93b3Jrc3BhY2UiLCJzZXEiOjUsImRhdGEiOnsidG9vbENhbGxJZCI6InRvb2wtMSIsInRvb2xOYW1lIjoiYmFzaCIsInN0YXRlIjoiY29tcGxldGUiLCJpc0Vycm9yIjpmYWxzZSwibGFiZWwiOiJTaGVsbCIsInN1bW1hcnkiOiJEZWJ1ZyBjb21tYW5kIGNvbXBsZXRlIn19${esc}\\")
        append("${esc}]6767;pi;1;agent.alert;eyJpZCI6ImRiZy1hbGVydCIsInRzIjoxNzc5MjAwMDAwMDA1LCJzb3VyY2UiOiJhZ2VudCIsInNlc3Npb25JZCI6ImRlYnVnIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6NiwiZGF0YSI6eyJraW5kIjoicHJvdmlkZXIiLCJ0aXRsZSI6IlBpIE9TQyBkZWJ1ZyBhbGVydCIsImJvZHkiOiJBZ2VudCBhbGVydCBzbW9rZSIsInNldmVyaXR5IjoiaW5mbyJ9fQ${esc}\\")
        append("${esc}]6767;pi;1;agent.progress;eyJpZCI6ImRiZy1wcm9ncmVzcy1jbGVhciIsInRzIjoxNzc5MjAwMDAwMDA2LCJzb3VyY2UiOiJhZ2VudCIsInNlc3Npb25JZCI6ImRlYnVnIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6NywiZGF0YSI6eyJzdGF0ZSI6ImNsZWFyIn19${esc}\\")
        append("${esc}[1mDotAI renderer playground · $fontName${esc}[0m\r\n")
        append("Real CoderTerminalView + libghostty-vt + native GLES renderer\r\n\r\n")
        append("Pi OSC: hello, run, progress, tool start/end, alert, clear progress\r\n")
        append("OSC 8: ${esc}]8;;https://example.com${'\u0007'}tap link${esc}]8;;${'\u0007'}  BEL:${'\u0007'}  Color:${esc}]10;#ff5c7a${'\u0007'}fg override${esc}]110${'\u0007'}\r\n\r\n")
        append("Selection/link: theme selection fg/bg; OSC8 tap link preserved\r\n")
        append("Working: ⣾ CoreUI indicator\r\n\r\n")
        append("Metrics: size selector exercises 12/14/16/18/20/22pt native logs\r\n")
        append("Shimmer SGR: ${esc}[97mrendering${esc}[39m ${esc}[37mterminal${esc}[39m ${esc}[2mfonts${esc}[22m\r\n\r\n")
        append("${esc}[1mBold${esc}[0m   ${esc}[3mItalic${esc}[0m   ${esc}[1;3mBoldItalic${esc}[0m\r\n")
        append("${esc}[2mFaint${esc}[0m   ${esc}[5mBlink${esc}[25m   ${esc}[9mStrike${esc}[0m   ${esc}[53mOverline${esc}[55m\r\n\r\n")
        append("Blend: ${esc}[38;2;64;64;72mnear bg${esc}[39m ${esc}[2m${esc}[38;2;180;180;190mfaint text${esc}[22;39m ${esc}[48;2;40;44;52m😀 alpha on bg${esc}[0m\r\n")
        append("Contrast: ${esc}[38;2;48;52;60m#30343c on bg${esc}[39m ${esc}[38;2;245;245;250mbright fg${esc}[39m ${esc}[48;2;255;245;220m${esc}[38;2;90;80;70mlight theme sample${esc}[0m\r\n\r\n")
        append("Images: Kitty graphics unsupported on Android; text grid remains authoritative ${esc}_Gf=24,s=1,v=1,a=T;/wAA${esc}\\after probe\r\n\r\n")
        append("${esc}[4mSingle underline${esc}[0m\r\n")
        append("${esc}[4:2mDouble underline${esc}[0m\r\n")
        append("${esc}[4:3mCurly underline${esc}[0m\r\n")
        append("${esc}[4:4mDotted underline${esc}[0m   ${esc}[4:5mDashed underline${esc}[0m\r\n")
        append("${esc}[58:2::255:120:80;4mColored underline${esc}[0m\r\n\r\n")
        append("Decorations wide: ${esc}[4m表表${esc}[0m emoji: ${esc}[4m😀⚡️${esc}[0m shaped: ${esc}[4m-> => !=${esc}[0m\r\n\r\n")
        append("CLI flags: --foo --help -vv --features=ligatures\r\n")
        append("Ligatures: -> => != <= >= === !== && || :: ...\r\n")
        append("Styled: ${esc}[31m-${esc}[32m>${esc}[0m ${esc}[34m=${esc}[35m>${esc}[0m cursor sample --foo\r\n\r\n")
        append("Nerd: 󰊢  λ 󰢱 󰊠 󰘳\r\n")
        append("Powerline:      Box: ┌─┬─┐ ╔═╦═╗ █ ░ ▒ ▓\r\n")
        append("Sprites: ▁▂▃▄▅▆▇█ ▏▎▍▌▋▊▉ ⣿⣀⠿ ◆ ■ ▲ ▼ ●\r\n")
        append("Legacy sprites: 🬀🬋🮋 Powerline branch:  \r\n")
        append("Box joins: ├─┼─┤ └─┴─┘ ╠═╬═╣ ╚═╩═╝\r\n")
        append("Box dash: ┄┄┄ ┅┅┅ ┆┆┆ ┇┇┇ ╱╲╳\r\n")
        append("Emoji: 😀 🧑🏽‍💻 👨‍👩‍👧‍👦 ⚡︎ ⚡️ 🇪🇬 🇺🇸\r\n\r\n")
        append("CJK: こんにちは 世界 你好 世界 안녕하세요\r\n")
        append("Arabic: مرحبا بالعالم\r\n")
        append("Fallback: Nerd 󰊢   CJK 表界  Arabic م Glyph �\r\n")
        append("Atlas stress: ASCII abc XYZ 012 CJK 表語界 Emoji 😀😃😄😁 Symbols ⣿◆󰊢\r\n")
        append("Bidi: ABC مرحبا DEF 123\r\n")
        append("Combining: café áô  Devanagari: कि नमस्ते\r\n")
        append("Emoji modifiers: 👩🏽‍🚀 🧑🏿‍💻 family: 👨‍👩‍👧‍👦\r\n")
        append("Wide: 表表表  Narrow: iii  Mixed: A表B😀C\r\n")
        append("${esc}]12;#ffcc00${'\u0007'}")
        append("${esc}[5 qbar cursor  ${esc}[3 qunderline cursor  ${esc}[1 qblock cursor\r\n")
        append("\r\n${esc}[38;2;137;180;250mForeground RGB${esc}[0m ${esc}[48;2;49;50;68mBackground RGB${esc}[0m\r\n")
    }
    return sample.toByteArray(Charsets.UTF_8)
}

private fun debugWorkingIndicatorFrameBytes(index: Int): ByteArray {
    val frames = listOf("⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷")
    val colors = listOf("\u001b[38;2;255;179;186m", "\u001b[38;2;255;223;186m", "\u001b[38;2;255;255;186m", "\u001b[38;2;186;255;201m", "\u001b[38;2;186;225;255m", "\u001b[38;2;218;186;255m")
    val frame = frames[index % frames.size]
    val color = colors[index % colors.size]
    return "\u001b[7;10H$color$frame\u001b[39m\u001b[999;1H".toByteArray(Charsets.UTF_8)
}

private fun debugShimmerFrameBytes(index: Int): ByteArray {
    val esc = "\u001b"
    val message = "rendering terminal fonts"
    val highlight = index % message.length
    val frame = buildString {
        append("${esc}[9;1H${esc}[2KShimmer SGR: ")
        message.forEachIndexed { charIndex, character ->
            if (character == ' ') {
                append(character)
            } else {
                val distance = kotlin.math.abs(charIndex - highlight)
                val style = when (distance) {
                    0 -> "${esc}[97m"
                    1 -> "${esc}[37m"
                    else -> "${esc}[2m"
                }
                append(style).append(character).append("${esc}[22;39m")
            }
        }
        append("${esc}[999;1H")
    }
    return frame.toByteArray(Charsets.UTF_8)
}

@Composable
fun TerminalPinchFontOverlay(terminalView: CoderTerminalView) {
}

@Composable
fun TerminalSurface(
    terminalView: CoderTerminalView,
    theme: CoderTheme,
    onShowKeyboard: () -> Unit,
    onHideKeyboard: () -> Unit,
    modifier: Modifier = Modifier,
    showMetadataOverlay: Boolean = true,
    statusContent: @Composable BoxScope.() -> Unit = {},
) {
    var copyModeActive by remember { mutableStateOf(terminalView.copyModeActive()) }
    var oscMetadata by remember { mutableStateOf(TerminalOscMetadata("", "", 0L)) }
    var pendingHyperlink by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    DisposableEffect(terminalView) {
        val metadataHandler: (TerminalOscMetadata) -> Unit = { oscMetadata = it }
        val hyperlinkHandler: (String) -> Unit = { if (terminalOscHyperlinkAllowed(context, it)) openTerminalHyperlink(context, it) else pendingHyperlink = it }
        terminalView.setTerminalForegroundActive(true)
        terminalView.post { terminalView.forceRefreshSurface() }
        terminalView.onOscMetadataChanged = metadataHandler
        terminalView.onHyperlinkActivated = hyperlinkHandler
        onDispose {
            if (terminalView.onOscMetadataChanged === metadataHandler) terminalView.onOscMetadataChanged = null
            if (terminalView.onHyperlinkActivated === hyperlinkHandler) terminalView.onHyperlinkActivated = null
            terminalView.setTerminalForegroundActive(false)
        }
    }
    Column(modifier.background(theme.background.toComposeColor())) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AndroidView(
                factory = { terminalView.prepareForComposeHost() },
                modifier = Modifier.fillMaxSize().onSizeChanged { terminalView.post { terminalView.forceRefreshSurface() } },
                update = {
                    it.applyTheme(theme)
                    it.post { it.forceRefreshSurface() }
                },
            )
            TerminalPinchFontOverlay(terminalView)
            if (showMetadataOverlay && (oscMetadata.title.isNotBlank() || oscMetadata.pwd.isNotBlank())) {
                Column(Modifier.align(Alignment.TopStart).padding(10.dp).clip(RoundedCornerShape(12.dp)).background(theme.background.toComposeColor().copy(alpha = 0.86f)).padding(horizontal = 10.dp, vertical = 7.dp)) {
                    if (oscMetadata.title.isNotBlank()) Text(oscMetadata.title, color = theme.foreground.toComposeColor(), fontSize = captionSize(), maxLines = 1, overflow = TextOverflow.Ellipsis, fontFamily = FontFamily.Monospace)
                    if (oscMetadata.pwd.isNotBlank()) Text(oscMetadata.pwd, color = theme.foreground.toComposeColor().copy(alpha = 0.64f), fontSize = smallCaptionSize(), maxLines = 1, overflow = TextOverflow.Ellipsis, fontFamily = FontFamily.Monospace)
                }
            }
            statusContent()
        }
        TerminalAccessory(
            theme,
            terminalView,
            copyModeActive,
            {
                if (terminalView.copySelectionToClipboard()) copyModeActive = false
            },
            {
                terminalView.setCopyModeActive(false)
                copyModeActive = false
            },
            onShowKeyboard,
            onHideKeyboard,
        ) { active ->
            terminalView.setCopyModeActive(active)
            copyModeActive = active
        }
    }
    pendingHyperlink?.let { uri ->
        val tokens = uiTokens(theme)
        ThemedAlertDialog(
            onDismissRequest = { pendingHyperlink = null },
            tokens = tokens,
            title = { Text("Open link?") },
            text = { Text(uri, fontFamily = FontFamily.Monospace, fontSize = captionSize()) },
            confirmButton = {
                Row {
                    TextButton(onClick = {
                        terminalOscHyperlinkHost(uri)?.let { terminalSetLinkHostAllowed(context, it, true) }
                        pendingHyperlink = null
                        openTerminalHyperlink(context, uri)
                    }) { Text("Always", color = tokens.accent) }
                    TextButton(onClick = { pendingHyperlink = null; openTerminalHyperlink(context, uri) }) { Text("Open", color = tokens.accent) }
                }
            },
            dismissButton = { TextButton(onClick = { pendingHyperlink = null }) { Text("Cancel", color = tokens.text) } },
        )
    }
}

@Composable
fun TerminalAccessory(theme: CoderTheme, terminalView: CoderTerminalView, selectionActive: Boolean, onCopySelection: () -> Unit, onClearSelection: () -> Unit, onShowKeyboard: () -> Unit, onHideKeyboard: () -> Unit, modifier: Modifier = Modifier, onCopyModeChanged: (Boolean) -> Unit = {}) {
    var chatMode by remember { mutableStateOf(false) }
    var dpadExpanded by remember { mutableStateOf(false) }
    var dpadOffset by remember { mutableStateOf(IntOffset.Zero) }
    var shiftActive by remember { mutableStateOf(false) }
    var ctrlActive by remember { mutableStateOf(false) }
    var altActive by remember { mutableStateOf(false) }
    var showChat by remember { mutableStateOf(terminalView.toolbarActionVisible("chat")) }
    var showPaste by remember { mutableStateOf(terminalView.toolbarActionVisible("paste")) }
    var shortcutsPanelExpanded by remember { mutableStateOf(false) }
    var selectedShortcutPanelTab by remember { mutableStateOf<String?>(null) }
    var chatDraft by remember { mutableStateOf("") }
    var chatAttachments by remember { mutableStateOf<List<ChatImageAttachment>>(emptyList()) }
    var replacingAttachmentIndex by remember { mutableStateOf<Int?>(null) }
    var shortcuts by remember { mutableStateOf(terminalView.customShortcuts()) }
    var toolbarOrder by remember { mutableStateOf(terminalView.toolbarOrder()) }
    val text = theme.foreground.toComposeColor()
    val active = theme.selectionBackground.toComposeColor()
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current
    val view = LocalView.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val enhancementHttpClient = remember { HttpClient(OkHttp) }
    var keyboardVisible by remember { mutableStateOf(false) }
    val hardwareKeyboardAvailable = configuration.keyboard != Configuration.KEYBOARD_NOKEYS
    val toolbarHiddenForHardwareKeyboard = terminalToolbarHiddenForHardwareKeyboard(terminalView.autoHideToolbarEnabled(), hardwareKeyboardAvailable, selectionActive, chatMode)
    val screenWidthPx = with(density) { configuration.screenWidthDp.dp.roundToPx() }
    val screenHeightPx = with(density) { configuration.screenHeightDp.dp.roundToPx() }
    val shortcutPanelTabs = remember(shortcuts, toolbarOrder, shortcutsPanelExpanded) { terminalShortcutPanelTabs(terminalView) }
    val selectedPanelTab = shortcutPanelTabs.firstOrNull { it.id == selectedShortcutPanelTab } ?: shortcutPanelTabs.firstOrNull { it.rows.isNotEmpty() } ?: shortcutPanelTabs.firstOrNull()
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        val replaceIndex = replacingAttachmentIndex
        replacingAttachmentIndex = null
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        chatAttachments = if (replaceIndex != null) {
            chatAttachments.mapIndexed { index, attachment -> if (index == replaceIndex) attachment.copy(uri = uris.first()) else attachment }
        } else {
            chatAttachments + uris.map { ChatImageAttachment(it) }
        }
    }
    fun clampDPadOffset(offset: IntOffset): IntOffset {
        val horizontalLimit = (screenWidthPx / 2 - with(density) { 116.dp.roundToPx() }).coerceAtLeast(0)
        val topLimit = -(screenHeightPx - with(density) { 220.dp.roundToPx() }).coerceAtMost(0)
        return IntOffset(offset.x.coerceIn(-horizontalLimit, horizontalLimit), offset.y.coerceIn(topLimit, 0))
    }
    fun snapDPadOffset() {
        val horizontalLimit = (screenWidthPx / 2 - with(density) { 116.dp.roundToPx() }).coerceAtLeast(0)
        dpadOffset = clampDPadOffset(IntOffset(if (dpadOffset.x < 0) -horizontalLimit else horizontalLimit, dpadOffset.y))
    }
    LaunchedEffect(terminalView) {
        terminalView.onModifierLatchChanged = { shift, ctrl, alt ->
            shiftActive = shift
            ctrlActive = ctrl
            altActive = alt
        }
        terminalView.onToolbarActionsChanged = {
            showChat = terminalView.toolbarActionVisible("chat")
            showPaste = terminalView.toolbarActionVisible("paste")
            shortcuts = terminalView.customShortcuts()
            toolbarOrder = terminalView.toolbarOrder()
            selectedShortcutPanelTab = null
        }
    }
    DisposableEffect(terminalView) {
        terminalView.onClipboardImagePaste = { uri ->
            chatAttachments = chatAttachments + ChatImageAttachment(uri)
            chatMode = true
            true
        }
        onDispose { terminalView.onClipboardImagePaste = null }
    }
    DisposableEffect(view) {
        val visibleFrame = Rect()
        val listener = android.view.ViewTreeObserver.OnGlobalLayoutListener {
            view.getWindowVisibleDisplayFrame(visibleFrame)
            keyboardVisible = view.rootView.height - visibleFrame.bottom > view.rootView.height * 0.15f
        }
        view.viewTreeObserver.addOnGlobalLayoutListener(listener)
        onDispose { view.viewTreeObserver.removeOnGlobalLayoutListener(listener) }
    }
    DisposableEffect(enhancementHttpClient) { onDispose { enhancementHttpClient.close() } }
    val speechSettings = SpeechSettingsStore.values(context)
    val speechEnhancementClient = remember(context, enhancementHttpClient) {
        object : SpeechEnhancementClient {
            override suspend fun enhance(request: SpeechEnhancementRequest): String {
                val latestSettings = SpeechSettingsStore.values(context)
                val apiKey = SpeechSettingsStore.enhancementApiKey(context)
                if (!latestSettings.enhancementEnabled || apiKey.isBlank()) return ""
                return when (SpeechEnhancementProvider.byId(latestSettings.enhancementProvider)) {
                    SpeechEnhancementProvider.OpenAiCompatible -> OpenAiHttpSpeechEnhancementClient(enhancementHttpClient, latestSettings.enhancementBaseUrl, apiKey, latestSettings.enhancementModel).enhance(request)
                    SpeechEnhancementProvider.Gemini -> GeminiHttpSpeechEnhancementClient(enhancementHttpClient, apiKey, latestSettings.enhancementModel).enhance(request)
                    SpeechEnhancementProvider.Disabled -> ""
                }
            }
        }
    }
    if (chatMode) {
        ChatInputBar(
            tokens = uiTokens(theme),
            text = chatDraft,
            onTextChanged = { chatDraft = it },
            modifier = modifier,
            attachments = chatAttachments,
            onAttach = { imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            onRemoveAttachment = { index -> chatAttachments = chatAttachments.filterIndexed { currentIndex, _ -> currentIndex != index } },
            onReplaceAttachment = { index -> replacingAttachmentIndex = index; imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            onCaptionAttachment = { index, caption -> chatAttachments = chatAttachments.mapIndexed { currentIndex, attachment -> if (currentIndex == index) attachment.copy(caption = caption) else attachment } },
            visibleTerminalLines = { terminalView.snapshotText() },
            speechEnhancementClient = speechEnhancementClient,
            onClear = { chatDraft = ""; chatAttachments = emptyList() },
            onSubmit = {
                terminalView.sendText(it)
                if (terminalView.chatAutoSendEnabled()) terminalView.sendKey(KeyEvent.KEYCODE_ENTER)
            },
            onReturn = { terminalView.sendKey(KeyEvent.KEYCODE_ENTER) },
        ) {
            onShowKeyboard()
            scope.launch {
                delay(16)
                chatMode = false
            }
        }
        return
    }
    if (toolbarHiddenForHardwareKeyboard) return
    TerminalDPadOverlay(dpadExpanded, uiTokens(theme), terminalView, dpadOffset, { delta -> dpadOffset = clampDPadOffset(dpadOffset + delta) }, ::snapDPadOffset)
    Box(modifier.fillMaxWidth().wrapContentHeight().padding(horizontal = 18.dp, vertical = 10.dp), contentAlignment = Alignment.BottomCenter) {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(30.dp)).background(uiTokens(theme).surfaceHigh).border(BorderStroke(0.7.dp, uiTokens(theme).separator), RoundedCornerShape(30.dp)).padding(horizontal = 10.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth().height(38.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).fillMaxHeight().clipToBounds().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
                if (selectionActive) {
                    ToolbarTextButton("Copy", text, uiTokens(theme).surface, onClick = onCopySelection)
                    ToolbarTextButton("Clear", text, uiTokens(theme).surface, onClick = onClearSelection)
                } else toolbarOrder.filterNot { it == "keyboard" || it == "chat" }.forEach { slot ->
                    when (slot) {
                        "ctrl" -> ToolbarTextButton("ctrl", text, if (ctrlActive || shortcutsPanelExpanded) active else uiTokens(theme).surface, contentDescription = "Terminal Ctrl button", onClick = { if (shortcutsPanelExpanded) shortcutsPanelExpanded = false else terminalView.toggleCtrlLatch() }, onLongClick = { shortcutsPanelExpanded = true; selectedShortcutPanelTab = null })
                        "shift" -> ToolbarTextButton("⇧", text, if (shiftActive) active else uiTokens(theme).surface) { terminalView.toggleShiftLatch() }
                        "alt" -> ToolbarTextButton("alt", text, if (altActive) active else uiTokens(theme).surface) { terminalView.toggleAltLatch() }
                        "esc" -> ToolbarTextButton("esc", text, uiTokens(theme).surface) { terminalView.sendKey(KeyEvent.KEYCODE_ESCAPE) }
                        "tab" -> ToolbarTextButton("tab", text, uiTokens(theme).surface) { terminalView.sendKey(KeyEvent.KEYCODE_TAB) }
                        "copy" -> ToolbarTextButton("copy", text, uiTokens(theme).surface) { onCopyModeChanged(true) }
                        "dpad" -> ToolbarTextButton("✣", text, if (dpadExpanded) active else uiTokens(theme).surface) { dpadExpanded = !dpadExpanded }
                        "empty" -> Unit
                        "paste" -> if (showPaste) ToolbarIconButton(R.drawable.ic_feather_clipboard, text, uiTokens(theme).surface) { terminalView.pasteFromClipboard() } else EmptyToolbarSlot(uiTokens(theme).surface)
                        "undo" -> ToolbarIconButton(R.drawable.ic_feather_rotate_ccw, text, uiTokens(theme).surface) { terminalView.sendKey(KeyEvent.KEYCODE_Z, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON) }
                    }
                }
                if (!selectionActive && "dpad" !in toolbarOrder) ToolbarTextButton("✣", text, if (dpadExpanded) active else uiTokens(theme).surface) { dpadExpanded = !dpadExpanded }
                if (!selectionActive) shortcuts.forEach { shortcut -> ToolbarTextButton(shortcut.label, text, uiTokens(theme).surface) { terminalView.executeTerminalShortcut(shortcut.sequence) } }
            }
            Spacer(Modifier.width(5.dp))
            Row(Modifier.height(40.dp).clip(RoundedCornerShape(20.dp)).padding(horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                if (showChat) ToolbarIconButton(R.drawable.ic_feather_message_circle, text, Color.Transparent) { chatMode = true }
                if (!keyboardVisible) ToolbarIconButton(R.drawable.ic_feather_keyboard, text, Color.Transparent) { onShowKeyboard() }
            }
        }
            if (shortcutsPanelExpanded && selectedPanelTab != null) TerminalShortcutPanel(selectedPanelTab, shortcutPanelTabs, terminalView, text, uiTokens(theme), { selectedShortcutPanelTab = it }) { shortcutsPanelExpanded = false }
        }
    }
}

private data class TerminalShortcutPanelTab(val id: String, val title: String, val rows: List<ShortcutRowDefinition>)

private fun terminalShortcutPanelTabs(terminalView: CoderTerminalView): List<TerminalShortcutPanelTab> {
    return terminalView.shortcutTabOrder().filter { terminalView.shortcutTabActive(it) }.map { tabId ->
        val title = when (tabId) {
            "favorites" -> "Favorites"
            "tmux" -> "Tmux"
            "ctrl" -> "Ctrl"
            else -> "Pi"
        }
        val rows = if (tabId == "favorites") terminalView.customShortcuts().map { ShortcutRowDefinition(it.sequence, it.label) } else defaultShortcutRows(title, terminalView.tmuxPrefixIndex(), terminalView.tmuxStartWindowFromOne())
        val orderedRows = rows.sortedBy { terminalView.shortcutRowOrder(tabId, rows).indexOf(shortcutRowId(it)) }
        TerminalShortcutPanelTab(tabId, title, orderedRows.filterIndexed { index, shortcut -> terminalView.shortcutRowActive(tabId, shortcut, index < 4) })
    }
}

@Composable
private fun TerminalShortcutPanel(selectedTab: TerminalShortcutPanelTab, tabs: List<TerminalShortcutPanelTab>, terminalView: CoderTerminalView, text: Color, tokens: UiTokens, onSelectTab: (String) -> Unit, onShortcutExecuted: () -> Unit) {
    Column(Modifier.fillMaxWidth().semantics { contentDescription = "Terminal shortcuts panel" }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            tabs.forEach { tab ->
                Box(Modifier.height(32.dp).clip(RoundedCornerShape(12.dp)).background(if (tab.id == selectedTab.id) tokens.accent.copy(alpha = 0.24f) else tokens.surface).clickable { hapticClick(); onSelectTab(tab.id) }.padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                    Text(tab.title, color = text, fontSize = captionSize(), maxLines = 1)
                }
            }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            selectedTab.rows.take(8).forEach { shortcut ->
                val shortcutLabel = shortcut.hint.ifBlank { shortcut.sequence }
                ToolbarTextButton(shortcutLabel, text, tokens.surface, contentDescription = "Terminal shortcut $shortcutLabel") {
                    terminalView.executeTerminalShortcut(shortcut.sequence)
                    onShortcutExecuted()
                }
            }
        }
    }
}

@Composable
private fun RowScope.AccessoryKey(label: String, color: Color, background: Color = Color.Transparent, onClick: () -> Unit) {
    Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(8.dp)).background(background).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) {
        Text(label, color = color, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun RowScope.ToolbarTextButton(label: String, color: Color, background: Color, contentDescription: String? = null, onLongClick: (() -> Unit)? = null, onClick: () -> Unit) {
    val semanticsModifier = if (contentDescription == null) Modifier else Modifier.semantics { this.contentDescription = contentDescription }
    Box(Modifier.padding(end = 4.dp).height(32.dp).then(semanticsModifier).clip(RoundedCornerShape(12.dp)).background(background).combinedClickable(onClick = { hapticClick(); onClick() }, onLongClick = onLongClick?.let { { hapticClick(); it() } }).padding(horizontal = 7.dp), contentAlignment = Alignment.Center) {
        Text(label, color = color, fontSize = 12.sp, fontFamily = FontFamily.Monospace, maxLines = 1)
    }
}

@Composable
private fun RowScope.ToolbarIconButton(icon: Int, color: Color, background: Color, onClick: () -> Unit) {
    Box(Modifier.padding(end = 4.dp).size(32.dp).clip(RoundedCornerShape(12.dp)).background(background).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) {
        Icon(painterResource(icon), null, tint = color, modifier = Modifier.size(17.dp))
    }
}

@Composable
private fun RowScope.EmptyToolbarSlot(background: Color) {
    Box(Modifier.padding(end = 5.dp).size(34.dp).clip(RoundedCornerShape(13.dp)).background(background))
}

@Composable
private fun SettingsNavigator(session: CoderSession?, sessionStore: CoderSessionStore, terminalView: CoderTerminalView, theme: CoderTheme, tokens: UiTokens, uiRevision: Int, deepLinkSettingsPage: SettingsPage?, deepLinkRevision: Int, onThemeChanged: () -> Unit, onTerminalFontSelected: (String) -> Unit, onTerminalFontSizeSelected: (Int) -> Unit, onFontChanged: () -> Unit, onBackToHome: () -> Unit) {
    var page by remember { mutableStateOf(SettingsPage.ROOT) }
    var placeholderTitle by remember { mutableStateOf("Settings") }
    var shortcutBackPage by remember { mutableStateOf(SettingsPage.TOOLBAR) }
    var editingShortcut by remember { mutableStateOf<ShortcutRowDefinition?>(null) }
    var selectedShortcutTab by remember { mutableStateOf(shortcutOverviewTabs(emptyList()).first()) }
    var selectedSpeechModelId by remember { mutableStateOf(ParakeetModelArtifacts.int8.id) }
    LaunchedEffect(deepLinkRevision) {
        deepLinkSettingsPage?.let { page = it }
    }
    fun navigateBack() {
        page = when (page) {
            SettingsPage.ROOT -> {
                onBackToHome()
                SettingsPage.ROOT
            }
            SettingsPage.TEXT -> SettingsPage.FONTS
            SettingsPage.SHORTCUT_TAB -> SettingsPage.SHORTCUTS
            SettingsPage.SHORTCUT -> shortcutBackPage
            SettingsPage.SPEECH_MODEL_DETAIL -> SettingsPage.SPEECH_MODELS
            SettingsPage.SPEECH_MODELS -> SettingsPage.SPEECH
            SettingsPage.DEBUG_LOGS -> SettingsPage.CONNECTION
            else -> SettingsPage.ROOT
        }
    }
    BackHandler { navigateBack() }
    when (page) {
        SettingsPage.ROOT -> SettingsRootScreen(session, terminalView, theme, tokens, uiRevision, ::navigateBack, { page = SettingsPage.THEME }, { page = SettingsPage.FONTS }, { page = SettingsPage.NOTIFICATIONS }) {
            if (it == "Toolbar") page = SettingsPage.TOOLBAR else if (it == "Shortcuts") page = SettingsPage.SHORTCUTS else if (it == "Keyboard") page = SettingsPage.KEYBOARD else if (it == "Gestures") page = SettingsPage.GESTURES else if (it == "Chat Mode") page = SettingsPage.CHAT else if (it == "Speech") page = SettingsPage.SPEECH else if (it == "Links") page = SettingsPage.LINKS else if (it == "Coder Connection") page = SettingsPage.CONNECTION else {
                placeholderTitle = it
                page = SettingsPage.PLACEHOLDER
            }
        }
        SettingsPage.THEME -> ThemePickerScreen(tokens, ::navigateBack, onThemeChanged)
        SettingsPage.FONTS -> FontsScreen(terminalView, tokens, onTerminalFontSelected, onTerminalFontSizeSelected, onFontChanged, { page = SettingsPage.TEXT }, ::navigateBack)
        SettingsPage.TEXT -> TextCustomizationScreen(terminalView, tokens, ::navigateBack)
        SettingsPage.TOOLBAR -> ShortcutsSettingsScreen(terminalView, tokens, { tab -> selectedShortcutTab = tab; page = SettingsPage.SHORTCUT_TAB }, { editingShortcut = null; shortcutBackPage = SettingsPage.TOOLBAR; page = SettingsPage.SHORTCUT }, ::navigateBack)
        SettingsPage.SHORTCUTS -> ShortcutsSettingsScreen(terminalView, tokens, { tab -> selectedShortcutTab = tab; page = SettingsPage.SHORTCUT_TAB }, { editingShortcut = null; shortcutBackPage = SettingsPage.SHORTCUTS; page = SettingsPage.SHORTCUT }, ::navigateBack)
        SettingsPage.SHORTCUT_TAB -> ShortcutTabSettingsScreen(selectedShortcutTab, terminalView, tokens, { editingShortcut = null; shortcutBackPage = SettingsPage.SHORTCUT_TAB; page = SettingsPage.SHORTCUT }, { shortcut -> editingShortcut = shortcut; shortcutBackPage = SettingsPage.SHORTCUT_TAB; page = SettingsPage.SHORTCUT }, ::navigateBack)
        SettingsPage.SHORTCUT -> ShortcutEditorScreen(terminalView, tokens, editingShortcut, selectedShortcutTab.id, ::navigateBack)
        SettingsPage.KEYBOARD -> KeyboardSettingsScreen(terminalView, tokens, ::navigateBack)
        SettingsPage.GESTURES -> GesturesSettingsScreen(terminalView, tokens, ::navigateBack)
        SettingsPage.CHAT -> ChatModeSettingsScreen(terminalView, tokens, ::navigateBack)
        SettingsPage.SPEECH -> SpeechSettingsScreen(terminalView, tokens, { page = SettingsPage.SPEECH_MODELS }, ::navigateBack)
        SettingsPage.SPEECH_MODELS -> SpeechModelSettingsScreen(tokens, { selectedSpeechModelId = it; page = SettingsPage.SPEECH_MODEL_DETAIL }, ::navigateBack)
        SettingsPage.SPEECH_MODEL_DETAIL -> SpeechModelDetailScreen(ParakeetModelArtifacts.byId(selectedSpeechModelId), tokens, ::navigateBack)
        SettingsPage.LINKS -> LinkAllowlistSettingsScreen(tokens, false, ::navigateBack)
        SettingsPage.LINKS_ADD -> LinkAllowlistSettingsScreen(tokens, true, ::navigateBack)
        SettingsPage.NOTIFICATIONS -> TerminalNotificationsSettingsScreen(terminalView, tokens, ::navigateBack)
        SettingsPage.CONNECTION -> ConnectionSettingsScreen(session, sessionStore, tokens, { page = SettingsPage.DEBUG_LOGS }, ::navigateBack)
        SettingsPage.DEBUG_LOGS -> DebugLogsScreen(sessionStore, tokens, ::navigateBack)
        SettingsPage.PLACEHOLDER -> PlaceholderSettingsScreen(placeholderTitle, tokens, ::navigateBack)
    }
}

@Composable
private fun SettingsRootScreen(session: CoderSession?, terminalView: CoderTerminalView, theme: CoderTheme, tokens: UiTokens, uiRevision: Int, onBack: () -> Unit, onTheme: () -> Unit, onFonts: () -> Unit, onNotifications: () -> Unit, onPlaceholder: (String) -> Unit) {
    val context = LocalContext.current
    var cursorBlink by remember { mutableStateOf(terminalView.cursorBlinkEnabled()) }
    var cursorMode by remember { mutableIntStateOf(terminalView.cursorMode()) }
    var keepScreenAwake by remember { mutableStateOf(terminalView.keepScreenAwakeEnabled()) }
    var oscNotifications by remember { mutableStateOf(terminalView.oscNotificationsEnabled()) }
    var hapticFeedback by remember { mutableStateOf(context.getSharedPreferences("app", Context.MODE_PRIVATE).getBoolean("haptic_feedback", true)) }
    val appPreferences = remember(context) { context.getSharedPreferences("app", Context.MODE_PRIVATE) }
    var backgroundTerminals by remember { mutableStateOf(appPreferences.getBoolean("background_terminals", false)) }
    SettingsScaffold("Settings", tokens, onBack) {
        SettingsSection("APPEARANCE", tokens) {
            SettingsValueRow(R.drawable.ic_feather_palette, "Theme", null, theme.name, tokens, pro = true, chevron = true, onClick = onTheme)
            SettingsValueRow(R.drawable.ic_feather_type, "Fonts & Size", null, CoderFonts.selectedName(LocalContext.current).also { uiRevision.hashCode() }, tokens, chevron = true, onClick = onFonts)
        }
        SettingsSection("TERMINAL", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_terminal, "Background Terminals", backgroundTerminals, tokens) {
                backgroundTerminals = it
                appPreferences.edit { putBoolean("background_terminals", it) }
                if (it) TerminalCatchUpWorker.schedule(context) else TerminalCatchUpWorker.cancel(context)
            }
            SettingsSegmentedControlRow(R.drawable.ic_feather_type, "Cursor Mode", tokens, cursorMode) { cursorMode = it; terminalView.setCursorMode(it) }
            SettingsToggleRow(R.drawable.ic_feather_circle, "Cursor Blink", cursorBlink, tokens) { cursorBlink = it; terminalView.setCursorBlinkEnabled(it) }
            SettingsToggleRow(R.drawable.ic_feather_power, "Keep Screen Awake", keepScreenAwake, tokens) { keepScreenAwake = it; terminalView.setKeepScreenAwakeEnabled(it) }
        }
        SettingsSection("INPUT", tokens) {
            SettingsValueRow(R.drawable.ic_feather_sliders, "Toolbar", "Accessory key rows", null, tokens, chevron = true) { onPlaceholder("Toolbar") }
            SettingsValueRow(R.drawable.ic_feather_box, "Shortcuts", "Tabs, keys, and custom actions", null, tokens, chevron = true) { onPlaceholder("Shortcuts") }
            SettingsValueRow(R.drawable.ic_feather_keyboard, "Keyboard", "Hardware and terminal key behavior", null, tokens, chevron = true) { onPlaceholder("Keyboard") }
            SettingsValueRow(R.drawable.ic_feather_hand, "Gestures", "Touch, scroll, and selection", null, tokens, chevron = true) { onPlaceholder("Gestures") }
        }
        SettingsSection("CHAT", tokens) {
            SettingsValueRow(R.drawable.ic_feather_message_circle, "Chat Mode", "Prompt sheet behavior", null, tokens, chevron = true) { onPlaceholder("Chat Mode") }
            SettingsValueRow(R.drawable.ic_feather_mic, "Speech", "Dictation and voice input", null, tokens, chevron = true) { onPlaceholder("Speech") }
        }
        SettingsSection("FEEDBACK", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_sliders, "Haptic Feedback", hapticFeedback, tokens) {
                hapticFeedback = it
                HapticTarget.enabled = it
                context.getSharedPreferences("app", Context.MODE_PRIVATE).edit { putBoolean("haptic_feedback", it) }
            }
            SettingsValueRow(R.drawable.ic_feather_bell, "Terminal Notifications", "Alerts, progress, sound, haptics", if (oscNotifications) "On" else "Off", tokens, chevron = true) { onNotifications() }
        }
        SettingsSection("INTEGRATIONS", tokens) {
            SettingsValueRow(R.drawable.ic_feather_globe, "Links", "Allowed OSC 8 link hosts", null, tokens, chevron = true) { onPlaceholder("Links") }
        }
        SettingsSection("GENERAL", tokens) { SettingsValueRow(R.drawable.ic_feather_globe, "Language", null, "Auto", tokens, chevron = true) { onPlaceholder("Language") } }
        if (session != null) {
            SettingsSection("CONNECTION", tokens) {
                SettingsValueRow(R.drawable.ic_feather_server, "Coder Connection", session.user.username, connectionHostLabel(session.baseUrl), tokens, chevron = true) { onPlaceholder("Coder Connection") }
            }
        }
        SettingsSection("HELP", tokens) {
            SettingsValueRow(R.drawable.ic_feather_github, "GitHub", "shekohex/dotai", null, tokens, chevron = true) { CustomTabsIntent.Builder().build().launchUrl(context, "https://github.com/shekohex/dotai".toUri()) }
            SettingsValueRow(R.drawable.ic_feather_mail, "Support", "Open GitHub issues", null, tokens, chevron = true) { CustomTabsIntent.Builder().build().launchUrl(context, "https://github.com/shekohex/dotai/issues".toUri()) }
            SettingsValueRow(R.drawable.ic_feather_book, "Open Source Licenses", null, null, tokens, chevron = true) { onPlaceholder("Open Source Licenses") }
        }
        item { Text("Version 2.11.1", color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 28.dp), textAlign = TextAlign.Center) }
    }
}

@Composable
private fun TerminalNotificationsSettingsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onBack: () -> Unit) {
    val context = LocalContext.current
    var enabled by remember { mutableStateOf(terminalView.oscNotificationsEnabled()) }
    var alerts by remember { mutableStateOf(terminalView.oscNotificationAlertsEnabled()) }
    var progress by remember { mutableStateOf(terminalView.oscNotificationProgressEnabled()) }
    var toasts by remember { mutableStateOf(terminalView.oscNotificationToastsEnabled()) }
    var iconStyle by remember { mutableStateOf(terminalView.oscNotificationIconStyle()) }
    var hapticPattern by remember { mutableStateOf(terminalView.oscProgressHapticPattern()) }
    var alertFeedbackRevision by remember { mutableIntStateOf(0) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    SettingsScaffold("Terminal Notifications", tokens, onBack) {
        SettingsSection("OSC", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_bell, "Enabled", enabled, tokens) {
                enabled = it
                terminalView.setOscNotificationsEnabled(it)
                if (it && android.os.Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) permissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
            }
            SettingsToggleRow(R.drawable.ic_feather_bell, "OSC 9 Alerts", alerts, tokens) { alerts = it; terminalView.setOscNotificationAlertsEnabled(it) }
            SettingsToggleRow(R.drawable.ic_feather_sliders, "OSC 9 Progress", progress, tokens) { progress = it; terminalView.setOscNotificationProgressEnabled(it) }
            SettingsToggleRow(R.drawable.ic_feather_message_circle, "Toast Fallback", toasts, tokens) { toasts = it; terminalView.setOscNotificationToastsEnabled(it) }
        }
        SettingsSection("ICON", tokens) {
            listOf("pi" to "Pi", "terminal" to "Terminal", "bell" to "Bell").forEach { (value, label) ->
                SettingsValueRow(R.drawable.ic_feather_bell, label, null, if (iconStyle == value) "✓" else null, tokens) {
                    iconStyle = value
                    terminalView.setOscNotificationIconStyle(value)
                }
            }
        }
        SettingsSection("ALERT FEEDBACK", tokens) {
            alertFeedbackRevision.hashCode()
            TerminalAlertFeedbackState.entries.forEach { state ->
                val soundId = TerminalAlertFeedback.soundId(context, state)
                val hapticId = TerminalAlertFeedback.hapticId(context, state)
                SettingsValueRow(R.drawable.ic_feather_bell, "${state.label} Sound", "Tap to cycle and preview", TerminalNotificationSounds.option(soundId).label, tokens) {
                    val next = TerminalNotificationSounds.next(soundId)
                    TerminalAlertFeedback.setSoundId(context, state, next.id)
                    TerminalNotificationSounds.playPreview(context, next.id)
                    alertFeedbackRevision++
                }
                SettingsValueRow(R.drawable.ic_feather_sliders, "${state.label} Vibration", "Tap to cycle and preview", TerminalHapticPatterns.option(hapticId).label, tokens) {
                    val next = TerminalHapticPatterns.next(hapticId)
                    TerminalAlertFeedback.setHapticId(context, state, next.id)
                    terminalView.previewOscProgressHapticPattern(next.id)
                    alertFeedbackRevision++
                }
            }
        }
        SettingsSection("PROGRESS HAPTICS", tokens) {
            progressHapticOptions().forEach { (value, label) ->
                SettingsValueRow(R.drawable.ic_feather_sliders, label, "Tap to preview and select", if (hapticPattern == value) "✓" else null, tokens) {
                    hapticPattern = value
                    terminalView.setOscProgressHapticPattern(value)
                    terminalView.previewOscProgressHapticPattern(value)
                }
            }
        }
        SettingsSection("SYSTEM", tokens) {
            SettingsValueRow(R.drawable.ic_feather_sliders, "Android Notification Settings", "Channel, sound, vibration, lock screen", null, tokens, chevron = true) {
                val intent = Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
                context.startActivity(intent)
            }
        }
    }
}

private fun progressHapticOptions(): List<Pair<String, String>> = TerminalHapticPatterns.options.filterNot { it.id == "none" }.map { it.id to it.label }

@Composable
private fun ThemePickerScreen(tokens: UiTokens, onBack: () -> Unit, onThemeChanged: () -> Unit) {
    val context = LocalContext.current
    var selected by remember { mutableStateOf(CoderThemes.selectedThemeName(context)) }
    SettingsScaffold("Theme", tokens, onBack) {
        ThemeSection("DARK", CoderThemes.darkOptions, selected, tokens) { option -> selected = option.name; CoderThemes.setSelectedTheme(context, option); onThemeChanged() }
        ThemeSection("LIGHT", CoderThemes.lightOptions, selected, tokens) { option -> selected = option.name; CoderThemes.setSelectedTheme(context, option); onThemeChanged() }
    }
}

private fun LazyListScope.ThemeSection(title: String, options: List<CoderThemeOption>, selected: String, tokens: UiTokens, onSelected: (CoderThemeOption) -> Unit) {
    SettingsSection(title, tokens) {
        options.forEach { option ->
            SettingsRow(null, option.name, null, tokens, { hapticClick(); onSelected(option) }) {
                SettingsPalettePreview(option.palette)
                Text(if (selected == option.name) "✓" else "", color = tokens.success, fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(18.dp))
            }
        }
    }
}

@Composable
private fun LinkAllowlistSettingsScreen(tokens: UiTokens, showAddOnOpen: Boolean, onBack: () -> Unit) {
    val context = LocalContext.current
    var hosts by remember { mutableStateOf(terminalAllowedLinkHosts(context).toList().sorted()) }
    var addDialog by remember { mutableStateOf(false) }
    var addValue by remember { mutableStateOf("") }
    var addError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(showAddOnOpen) {
        if (showAddOnOpen) addDialog = true
    }
    fun removeHost(host: String) {
        terminalSetLinkHostAllowed(context, host, false)
        hosts = terminalAllowedLinkHosts(context).toList().sorted()
    }
    fun addHost() {
        val pattern = terminalNormalizeLinkHostPattern(addValue)
        if (pattern == null) {
            addError = "Enter host, URL, or wildcard like *.example.com"
            return
        }
        terminalSetLinkHostAllowed(context, pattern, true)
        hosts = terminalAllowedLinkHosts(context).toList().sorted()
        addValue = ""
        addError = null
        addDialog = false
    }
    SettingsScaffold("Links", tokens, onBack, R.drawable.ic_feather_plus, { addDialog = true }) {
        SettingsSection("OSC 8 ALLOWLIST", tokens) {
            if (hosts.isEmpty()) {
                item {
                    Text("No hosts allowed. Terminal links ask before opening.", color = tokens.secondary, fontSize = bodySize(), modifier = Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 16.dp))
                }
            } else {
                hosts.forEach { host ->
                    SettingsRow(R.drawable.ic_feather_globe, host, "Opens without asking", tokens, {}) {
                        Text("Remove", color = Color(0xffff5c7a), fontSize = captionSize(), fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable { removeHost(host) }.padding(horizontal = 10.dp, vertical = 7.dp))
                    }
                }
            }
        }
    }
    if (addDialog) {
        ThemedAlertDialog(
            onDismissRequest = { addDialog = false; addError = null },
            tokens = tokens,
            title = { Text("Allow link host") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    BasicTextField(
                        value = addValue,
                        onValueChange = { addValue = it; addError = null },
                        singleLine = true,
                        textStyle = androidx.compose.ui.text.TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace),
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(tokens.surface).padding(12.dp),
                    )
                    Text(addError ?: "Examples: example.com, https://example.com, *.example.com", color = if (addError == null) tokens.secondary else Color(0xffff5c7a), fontSize = captionSize())
                }
            },
            confirmButton = { TextButton(onClick = { addHost() }) { Text("Add", color = tokens.accent) } },
            dismissButton = { TextButton(onClick = { addDialog = false; addError = null }) { Text("Cancel", color = tokens.secondary) } },
        )
    }
}

@Composable
private fun FontsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onTerminalFontSelected: (String) -> Unit, onTerminalFontSizeSelected: (Int) -> Unit, onFontChanged: () -> Unit, onCustomizeText: () -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    var fontSize by remember { mutableIntStateOf(terminalView.fontSizePoints()) }
    var selectedFontKey by remember { mutableStateOf(CoderFonts.selectedKey(context)) }
    var selectedUiFontKey by remember { mutableStateOf(CoderFonts.selectedUiKey(context)) }
    var matchFonts by remember { mutableStateOf(CoderFonts.uiMatchesTerminal(context)) }
    var importedFonts by remember { mutableStateOf(CoderFonts.importedOptions(context)) }
    val importLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            CoderFonts.importFont(context, uri)?.let { option ->
                importedFonts = CoderFonts.importedOptions(context)
                selectedFontKey = option.key
                if (matchFonts) selectedUiFontKey = option.key
                onTerminalFontSelected(option.key)
                onFontChanged()
            }
        }
    }
    SettingsScaffold("Fonts & Size", tokens, onBack) {
        item { FontSettingsPreview(tokens, fontSize, CoderFonts.uiFontFamily(context, selectedUiFontKey)) }
        SettingsSection("TERMINAL TEXT", tokens) {
            SettingsStepperRow(
                R.drawable.ic_feather_type,
                "Font Size",
                fontSize,
                tokens,
                {
                    if (fontSize > 8) {
                        fontSize--
                        onTerminalFontSizeSelected(fontSize)
                    }
                },
                {
                    if (fontSize < 32) {
                        fontSize++
                        onTerminalFontSizeSelected(fontSize)
                    }
                },
            )
            SettingsValueRow(R.drawable.ic_feather_sliders, "Customize Text", "Ligatures and OpenType features", null, tokens, chevron = true, onClick = onCustomizeText)
        }
        SettingsSection("TERMINAL FONTS", tokens) {
            CoderFonts.builtInOptions().forEach { option ->
                FontOptionRow(option, selectedFontKey, tokens) {
                    selectedFontKey = option.key
                    if (matchFonts) selectedUiFontKey = option.key
                    onTerminalFontSelected(option.key)
                    onFontChanged()
                }
            }
        }
        SettingsSection("UI MONOSPACE FONT", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_type, "Match Terminal Font", matchFonts, tokens) {
                matchFonts = it
                CoderFonts.setUiMatchesTerminal(context, it)
                if (it) {
                    selectedUiFontKey = selectedFontKey
                    onTerminalFontSelected(selectedFontKey)
                }
                onFontChanged()
            }
            CoderFonts.builtInOptions().forEach { option ->
                FontOptionRow(option, selectedUiFontKey, tokens) {
                    selectedUiFontKey = option.key
                    matchFonts = false
                    CoderFonts.setUiMatchesTerminal(context, false)
                    CoderFonts.setSelectedUi(context, option.key)
                    onFontChanged()
                }
            }
        }
        SettingsSection("IMPORTED FONTS · ${importedFonts.size}", tokens) {
            importedFonts.forEach { option ->
                FontOptionRow(option, selectedFontKey, tokens) {
                    selectedFontKey = option.key
                    if (matchFonts) selectedUiFontKey = option.key
                    onTerminalFontSelected(option.key)
                    onFontChanged()
                }
            }
            SettingsValueRow(R.drawable.ic_feather_upload, "Import font...", ".ttf, .otf, .ttc, or .otc from Files", null, tokens, chevron = true) { importLauncher.launch(arrayOf("font/*", "application/octet-stream")) }
        }
        SettingsSection("CURATED FONTS", tokens) {
            CoderFonts.curatedOptions().forEach { option ->
                SettingsValueRow(R.drawable.ic_feather_type, option.name, option.subtitle, null, tokens, pro = option.pro) {}
            }
        }
        item { Text("Download curated fonts or import your own from Files. Imported fonts are stored locally and registered with the same renderer used by the terminal.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
    }
}

@Composable
private fun TextCustomizationScreen(terminalView: CoderTerminalView, tokens: UiTokens, onBack: () -> Unit) {
    var ligatures by remember { mutableStateOf(terminalView.ligaturesEnabled()) }
    var contextualAlternates by remember { mutableStateOf(terminalView.contextualAlternatesEnabled()) }
    var slashedZero by remember { mutableStateOf(terminalView.slashedZeroEnabled()) }
    var stylisticSet1 by remember { mutableStateOf(terminalView.stylisticSet1Enabled()) }
    var stylisticSet2 by remember { mutableStateOf(terminalView.stylisticSet2Enabled()) }
    var characterVariant1 by remember { mutableStateOf(terminalView.characterVariant1Enabled()) }
    var boldFontStyle by remember { mutableStateOf(terminalView.boldFontStyleEnabled()) }
    var cursorBlink by remember { mutableStateOf(terminalView.cursorBlinkEnabled()) }
    var cursorMode by remember { mutableIntStateOf(terminalView.cursorMode()) }
    SettingsScaffold("Customize Text", tokens, onBack) {
        SettingsSection("OPEN TYPE", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_type, "Standard Ligatures", ligatures, tokens) {
                ligatures = it
                terminalView.setLigaturesEnabled(it)
            }
            SettingsToggleRow(R.drawable.ic_feather_sliders, "Programming Ligatures", contextualAlternates, tokens) {
                contextualAlternates = it
                terminalView.setContextualAlternatesEnabled(it)
            }
            SettingsToggleRow(R.drawable.ic_feather_type, "Slashed Zero", slashedZero, tokens) {
                slashedZero = it
                terminalView.setSlashedZeroEnabled(it)
            }
            SettingsToggleRow(R.drawable.ic_feather_sliders, "Stylistic Set 1", stylisticSet1, tokens) {
                stylisticSet1 = it
                terminalView.setStylisticSet1Enabled(it)
            }
            SettingsToggleRow(R.drawable.ic_feather_sliders, "Stylistic Set 2", stylisticSet2, tokens) {
                stylisticSet2 = it
                terminalView.setStylisticSet2Enabled(it)
            }
            SettingsToggleRow(R.drawable.ic_feather_sliders, "Character Variant 1", characterVariant1, tokens) {
                characterVariant1 = it
                terminalView.setCharacterVariant1Enabled(it)
            }
            SettingsValueRow(R.drawable.ic_feather_sliders, "Feature Tags", "liga, calt, zero, ss01, ss02, cv01", if (contextualAlternates) "calt on" else "calt off", tokens) {}
        }
        SettingsSection("STYLE", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_type, "Bold Font Style", boldFontStyle, tokens) {
                boldFontStyle = it
                terminalView.setBoldFontStyleEnabled(it)
            }
            item { Text("Off keeps SGR 1 from changing glyph weight. This avoids shimmer weight flicker while preserving terminal bold state.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
        }
        SettingsSection("CURSOR", tokens) {
            CursorSettingsPreview(tokens, cursorMode, cursorBlink)
            SettingsSegmentedControlRow(R.drawable.ic_feather_type, "Cursor Mode", tokens, cursorMode) {
                cursorMode = it
                terminalView.setCursorMode(it)
            }
            SettingsToggleRow(R.drawable.ic_feather_circle, "Cursor Blink", cursorBlink, tokens) {
                cursorBlink = it
                terminalView.setCursorBlinkEnabled(it)
            }
        }
        SettingsSection("FALLBACK", tokens) {
            SettingsValueRow(R.drawable.ic_feather_globe, "CJK Fallback", "Use Android system fallback when glyph missing", "Native", tokens) {}
            SettingsValueRow(R.drawable.ic_feather_type, "Emoji Fallback", "Use Android color emoji fonts", "Native", tokens) {}
        }
        item { Text("OpenType features, bold font style, cursor mode, and cursor blink apply immediately to the native terminal renderer. CJK and emoji fallback use the native fallback stack.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
    }
}

@Composable
private fun CursorSettingsPreview(tokens: UiTokens, cursorMode: Int, cursorBlink: Boolean) {
    val transition = rememberInfiniteTransition(label = "cursor-preview")
    val blinkAlpha by transition.animateFloat(
        initialValue = 1f,
        targetValue = if (cursorBlink) 0.18f else 1f,
        animationSpec = infiniteRepeatable(tween(550), RepeatMode.Reverse),
        label = "cursor-preview-alpha",
    )
    val modeLabels = listOf("Block", "Underline", "Bar")
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        modeLabels.forEachIndexed { index, label ->
            Column(Modifier.weight(1f).clip(RoundedCornerShape(14.dp)).background(if (cursorMode == index) tokens.accent.copy(alpha = 0.22f) else tokens.surface).padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.height(42.dp).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text("A", color = tokens.text, fontSize = 24.sp, fontFamily = FontFamily.Monospace)
                    when (index) {
                        0 -> Text("█", color = tokens.accent.copy(alpha = if (cursorMode == index) blinkAlpha else 0.35f), fontSize = 25.sp, fontFamily = FontFamily.Monospace)
                        1 -> Text("▁", color = tokens.accent.copy(alpha = if (cursorMode == index) blinkAlpha else 0.35f), fontSize = 28.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(top = 18.dp))
                        else -> Text("▏", color = tokens.accent.copy(alpha = if (cursorMode == index) blinkAlpha else 0.35f), fontSize = 30.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(start = 18.dp))
                    }
                }
                Text(label, color = if (cursorMode == index) tokens.text else tokens.secondary, fontSize = captionSize(), fontFamily = FontFamily.Monospace)
            }
        }
    }
}

@Composable
private fun ToolbarSettingsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onAddShortcut: () -> Unit, onBack: () -> Unit) {
    var chat by remember { mutableStateOf(terminalView.toolbarActionVisible("chat")) }
    var paste by remember { mutableStateOf(terminalView.toolbarActionVisible("paste")) }
    var theme by remember { mutableStateOf(terminalView.toolbarActionVisible("theme")) }
    var shortcuts by remember { mutableStateOf(terminalView.customShortcuts()) }
    var order by remember { mutableStateOf(terminalView.toolbarOrder()) }
    LaunchedEffect(Unit) { terminalView.onToolbarActionsChanged = { shortcuts = terminalView.customShortcuts(); order = terminalView.toolbarOrder() } }
    SettingsScaffold("Toolbar", tokens, onBack) {
        item {
            Column(Modifier.fillMaxWidth().height(250.dp).background(tokens.accent.copy(alpha = 0.28f)).padding(horizontal = 20.dp, vertical = 26.dp), verticalArrangement = Arrangement.Bottom) {
                Text("Live preview of your toolbar.", color = tokens.secondary, fontSize = bodySize(), modifier = Modifier.align(Alignment.CenterHorizontally).weight(1f))
                ToolbarSettingsPreview(tokens, order, chat, paste, theme)
            }
        }
        SettingsSection("TOOLBAR BUTTONS", tokens) {
            order.forEach { slot -> ToolbarOrderRow(slot, tokens) { delta -> order = moveToolbarSlot(order, slot, delta); terminalView.setToolbarOrder(order) } }
        }
        SettingsSection("ACTIONS", tokens) {
            ToolbarButtonRow("Empty slot", null, true, tokens) { }
            ToolbarButtonRow("Double tap anywhere in terminal to paste", R.drawable.ic_feather_upload, paste, tokens) { paste = !paste; terminalView.setToolbarActionVisible("paste", paste) }
            ToolbarButtonRow("Pick from saved dictation history and send it immediately", R.drawable.ic_feather_rotate_ccw, theme, tokens) { theme = !theme; terminalView.setToolbarActionVisible("theme", theme) }
            ToolbarButtonRow("Chat input mode", R.drawable.ic_feather_message_circle, chat, tokens) { chat = !chat; terminalView.setChatModeEnabled(chat) }
        }
        if (shortcuts.isNotEmpty()) {
            SettingsSection("CUSTOM", tokens) {
                shortcuts.forEachIndexed { index, shortcut -> ToolbarButtonRow("${shortcut.label}  ${shortcut.sequence}", R.drawable.ic_feather_terminal, true, tokens) { terminalView.removeCustomShortcut(index) } }
            }
        }
        item {
            Box(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 18.dp).height(48.dp).clickable { hapticClick(); onAddShortcut() }, contentAlignment = Alignment.Center) {
                Text("+  Add Shortcut", color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
            }
        }
        item { Text("Create custom shortcut buttons for the toolbar. Tap to edit, toggle to hide or show.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
    }
}

@Composable
private fun ToolbarSettingsPreview(tokens: UiTokens, order: List<String>, chat: Boolean, paste: Boolean, theme: Boolean) {
    Row(Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(22.dp)).background(tokens.surfaceHigh).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        order.forEach { slot ->
            when (slot) {
                "ctrl", "shift", "alt", "esc", "tab", "copy" -> Text(toolbarSlotLabel(slot).replaceFirstChar { it.uppercaseChar() }, color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace, modifier = Modifier.padding(end = 16.dp))
                "empty" -> Box(Modifier.padding(end = 10.dp).size(34.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surface))
                "paste" -> if (paste) Icon(painterResource(R.drawable.ic_feather_upload), null, tint = tokens.text, modifier = Modifier.padding(end = 14.dp).size(19.dp))
                "theme" -> if (theme) Icon(painterResource(R.drawable.ic_feather_rotate_ccw), null, tint = tokens.text, modifier = Modifier.padding(end = 14.dp).size(19.dp))
                "chat" -> if (chat) Icon(painterResource(R.drawable.ic_feather_message_circle), null, tint = tokens.text, modifier = Modifier.padding(end = 18.dp).size(22.dp))
                "keyboard" -> Icon(painterResource(R.drawable.ic_feather_keyboard), null, tint = tokens.text, modifier = Modifier.size(22.dp))
            }
        }
    }
}

@Composable
private fun ToolbarOrderRow(slot: String, tokens: UiTokens, onMove: (Int) -> Unit) {
    var dragOffset by remember { mutableStateOf(0f) }
    Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(toolbarSlotLabel(slot), color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
        Text(
            "⠿",
            color = tokens.secondary,
            fontSize = 22.sp,
            modifier = Modifier
                .width(56.dp)
                .pointerInput(slot) {
                    detectVerticalDragGestures(
                        onDragStart = { dragOffset = 0f },
                        onDragEnd = { dragOffset = 0f },
                        onDragCancel = { dragOffset = 0f },
                    ) { change, dragAmount ->
                        dragOffset += dragAmount
                        when {
                            dragOffset <= -38f -> {
                                change.consume()
                                dragOffset = 0f
                                hapticClick()
                                onMove(-1)
                            }
                            dragOffset >= 38f -> {
                                change.consume()
                                dragOffset = 0f
                                hapticClick()
                                onMove(1)
                            }
                        }
                    }
                },
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun ToolbarButtonRow(title: String, icon: Int?, visible: Boolean, tokens: UiTokens, onToggle: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(if (title.length > 18) 68.dp else 52.dp).clickable { hapticClick(); onToggle() }.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (visible) "⊖" else "⊕", color = if (visible) Color(0xffd62d5a) else tokens.accent, fontSize = 24.sp, modifier = Modifier.width(34.dp))
        if (icon != null) Icon(painterResource(icon), null, tint = tokens.secondary, modifier = Modifier.padding(end = 14.dp).size(20.dp))
        Text(title, color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text("⠿", color = tokens.secondary, fontSize = 20.sp)
    }
}

@Composable
private fun ShortcutsSettingsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onOpenTab: (ShortcutOverviewTab) -> Unit, onAddShortcut: () -> Unit, onBack: () -> Unit) {
    var shortcuts by remember { mutableStateOf(terminalView.customShortcuts()) }
    var hideTitles by remember { mutableStateOf(terminalView.shortcutTabTitlesHidden()) }
    var uploads by remember { mutableStateOf(terminalView.uploadsPanelVisible()) }
    var tabOrder by remember { mutableStateOf(terminalView.shortcutTabOrder()) }
    var tabRevision by remember { mutableIntStateOf(0) }
    val tabs = shortcutOverviewTabs(shortcuts, tabOrder) { tabRevision; terminalView.shortcutTabActive(it) }
    LaunchedEffect(Unit) { terminalView.onToolbarActionsChanged = { shortcuts = terminalView.customShortcuts(); tabOrder = terminalView.shortcutTabOrder(); tabRevision++ } }
    val resetShortcuts = {
        terminalView.resetShortcutsToDefaults()
        hideTitles = false
        uploads = true
        tabOrder = defaultShortcutTabOrder
        tabRevision++
        Unit
    }
    SettingsScaffold("Shortcuts", tokens, onBack, R.drawable.ic_feather_rotate_ccw, resetShortcuts, "Reset shortcuts") {
        item { ShortcutsOverviewPreview(tokens, tabs, hideTitles, uploads) }
        SettingsSection("PANEL TABS", tokens) { tabs.filter { it.active }.forEach { tab -> ShortcutPanelTabRow(tab, true, tokens, onToggle = { terminalView.setShortcutTabActive(tab.id, false); tabRevision++ }, onMove = { delta -> tabOrder = moveShortcutTab(tabOrder, tab.id, delta); terminalView.setShortcutTabOrder(tabOrder) }) { onOpenTab(tab) } } }
        val inactiveTabs = tabs.filterNot { it.active }
        if (inactiveTabs.isNotEmpty()) SettingsSection("INACTIVE TABS", tokens) { inactiveTabs.forEach { tab -> ShortcutPanelTabRow(tab, true, tokens, onToggle = { terminalView.setShortcutTabActive(tab.id, true); tabRevision++ }, onMove = { delta -> tabOrder = moveShortcutTab(tabOrder, tab.id, delta); terminalView.setShortcutTabOrder(tabOrder) }) { onOpenTab(tab) } } }
        item { Text("Tap − to hide, + to show. Drag to reorder. Tap a row to configure shortcuts.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 10.dp)) }
        SettingsSection("SETTINGS", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_type, "Hide Title on Tabs", hideTitles, tokens) { hideTitles = it; terminalView.setShortcutTabTitlesHidden(it) }
            SettingsToggleRow(R.drawable.ic_feather_upload, "Show Uploads Panel", uploads, tokens) { uploads = it; terminalView.setUploadsPanelVisible(it) }
        }
        item {
            Box(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 18.dp).height(52.dp).clip(RoundedCornerShape(18.dp)).background(tokens.accent).clickable { hapticClick(); onAddShortcut() }, contentAlignment = Alignment.Center) {
                Text("+  New Shortcut", color = contentColorFor(tokens.accent), fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
            }
        }
        item { Box(Modifier.fillMaxWidth().padding(bottom = 18.dp).height(44.dp).clickable { hapticClick(); resetShortcuts() }, contentAlignment = Alignment.Center) { Text("↻  Reset", color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold) } }
    }
}

private data class ShortcutOverviewTab(val id: String, val title: String, val subtitle: String, val icon: Int?, val active: Boolean)

private fun shortcutOverviewTabs(shortcuts: List<TerminalShortcut>, order: List<String> = defaultShortcutTabOrder, isActive: (String) -> Boolean = { true }): List<ShortcutOverviewTab> = defaultShortcutTabs(shortcuts.size, isActive).sortedBy { normalizeShortcutTabOrder(order.joinToString(",")).indexOf(it.id) }.map { tab ->
    ShortcutOverviewTab(tab.id, tab.title, tab.subtitle, when (tab.id) {
        "favorites" -> R.drawable.ic_feather_star
        "tmux" -> R.drawable.ic_feather_terminal
        "ctrl" -> R.drawable.ic_feather_chevron_up
        else -> null
    }, tab.active)
}

@Composable
private fun ShortcutsOverviewPreview(tokens: UiTokens, tabs: List<ShortcutOverviewTab>, hideTitles: Boolean, uploads: Boolean) {
    Column(Modifier.fillMaxWidth().height(280.dp).background(tokens.accent.copy(alpha = 0.28f)).padding(horizontal = spacingLarge(), vertical = 24.dp), verticalArrangement = Arrangement.Bottom) {
        Text("Long-press Ctrl to open the shortcuts bar. Tap Ctrl to close.", color = tokens.secondary, fontSize = bodySize(), lineHeight = 21.sp, modifier = Modifier.align(Alignment.CenterHorizontally).weight(1f).padding(top = 46.dp))
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(26.dp)).background(tokens.surfaceHigh).padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth().semantics { contentDescription = if (uploads) "Shortcut preview uploads shown" else "Shortcut preview uploads hidden" }, verticalAlignment = Alignment.CenterVertically) {
                listOf("Ctrl", "Esc", "Tab").forEach { label -> ShortcutPreviewTextButton(label, tokens) }
                ShortcutPreviewIcon(R.drawable.ic_feather_move, tokens)
                if (uploads) ShortcutPreviewIcon(R.drawable.ic_feather_clipboard, tokens)
                ShortcutPreviewIcon(R.drawable.ic_feather_rotate_ccw, tokens)
                Spacer(Modifier.weight(1f))
                ShortcutPreviewIcon(R.drawable.ic_feather_message_circle, tokens)
                ShortcutPreviewIcon(R.drawable.ic_feather_keyboard, tokens)
            }
            Row(Modifier.fillMaxWidth().semantics { contentDescription = "Shortcut preview active tabs ${tabs.count { it.active }} ${tabs.filter { it.active }.joinToString(" ") { it.title }} ${if (hideTitles) "icon only" else "with titles"}" }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                tabs.filter { it.active }.take(4).forEach { tab -> ShortcutPreviewTab(tab, hideTitles, tokens) }
            }
        }
    }
}

@Composable
private fun ShortcutPreviewTextButton(label: String, tokens: UiTokens) {
    Box(Modifier.padding(end = 6.dp).height(34.dp).clip(RoundedCornerShape(13.dp)).background(tokens.surface).padding(horizontal = 10.dp), contentAlignment = Alignment.Center) { Text(label, color = tokens.text, fontSize = captionSize(), fontFamily = FontFamily.Monospace) }
}

@Composable
private fun ShortcutPreviewIcon(icon: Int, tokens: UiTokens) {
    Box(Modifier.padding(end = 6.dp).size(34.dp).clip(RoundedCornerShape(13.dp)).background(tokens.surface), contentAlignment = Alignment.Center) { Icon(painterResource(icon), null, tint = tokens.text, modifier = Modifier.size(17.dp)) }
}

@Composable
private fun ShortcutPreviewTab(tab: ShortcutOverviewTab, hideTitles: Boolean, tokens: UiTokens) {
    Row(Modifier.height(34.dp).clip(RoundedCornerShape(13.dp)).background(tokens.surface).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        ShortcutTabIcon(tab, tokens, tokens.text, Modifier.size(16.dp))
        if (!hideTitles) Text(tab.title, color = tokens.text, fontSize = captionSize(), modifier = Modifier.padding(start = 6.dp), maxLines = 1)
    }
}

@Composable
private fun ShortcutTabIcon(tab: ShortcutOverviewTab, tokens: UiTokens, tint: Color, modifier: Modifier) {
    if (tab.icon == null) PiLogo(tokens, tab.title, modifier, tint) else Icon(painterResource(tab.icon), null, tint = tint, modifier = modifier)
}

@Composable
private fun ShortcutPanelTabRow(tab: ShortcutOverviewTab, reorderable: Boolean, tokens: UiTokens, onToggle: () -> Unit = {}, onMove: (Int) -> Unit = {}, onClick: () -> Unit) {
    var dragOffset by remember { mutableStateOf(0f) }
    Row(Modifier.fillMaxWidth().height(72.dp).clickable { hapticClick(); onClick() }.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (tab.active) "⊖" else "⊕", color = if (tab.active) Color(0xffd62d5a) else tokens.accent, fontSize = 25.sp, modifier = Modifier.width(36.dp).semantics { contentDescription = if (tab.active) "Hide ${tab.title} tab" else "Show ${tab.title} tab" }.clickable { hapticClick(); onToggle() })
        ShortcutTabIcon(tab, tokens, tokens.secondary, Modifier.size(22.dp))
        Column(Modifier.padding(start = 18.dp).weight(1f), verticalArrangement = Arrangement.Center) {
            Text(tab.title, color = tokens.text, fontSize = rowTitleSize(), maxLines = 1)
            Text(tab.subtitle, color = tokens.secondary, fontSize = captionSize(), maxLines = 1)
        }
        if (reorderable) Text(
            "⠿",
            color = tokens.secondary,
            fontSize = 22.sp,
            modifier = Modifier.width(56.dp).semantics { contentDescription = "Move ${tab.title} tab" }.pointerInput(tab.id) {
                detectVerticalDragGestures(
                    onDragStart = { dragOffset = 0f },
                    onDragEnd = { dragOffset = 0f },
                    onDragCancel = { dragOffset = 0f },
                ) { change, dragAmount ->
                    dragOffset += dragAmount
                    when {
                        dragOffset <= -38f -> {
                            change.consume()
                            dragOffset = 0f
                            hapticClick()
                            onMove(-1)
                        }
                        dragOffset >= 38f -> {
                            change.consume()
                            dragOffset = 0f
                            hapticClick()
                            onMove(1)
                        }
                    }
                }
            },
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun ShortcutTabSettingsScreen(tab: ShortcutOverviewTab, terminalView: CoderTerminalView, tokens: UiTokens, onAddShortcut: () -> Unit, onEditShortcut: (ShortcutRowDefinition) -> Unit, onBack: () -> Unit) {
    var tmuxPrefixIndex by remember { mutableIntStateOf(terminalView.tmuxPrefixIndex()) }
    var tmuxStartWindowFromOne by remember { mutableStateOf(terminalView.tmuxStartWindowFromOne()) }
    var shortcutRevision by remember { mutableIntStateOf(0) }
    var shortcutOrder by remember { mutableStateOf(emptyList<String>()) }
    val defaultShortcuts = if (tab.title == "Favorites") terminalView.customShortcuts().map { ShortcutRowDefinition(it.sequence, it.label) } else defaultShortcutRows(tab.title, tmuxPrefixIndex, tmuxStartWindowFromOne)
    val shortcuts = defaultShortcuts.sortedBy { terminalView.shortcutRowOrder(tab.id, defaultShortcuts).indexOf(shortcutRowId(it)) }
    LaunchedEffect(tab.id, defaultShortcuts) { shortcutOrder = terminalView.shortcutRowOrder(tab.id, defaultShortcuts) }
    val activeShortcuts = shortcuts.filterIndexed { index, shortcut -> shortcutRevision; terminalView.shortcutRowActive(tab.id, shortcut, index < 4) }
    val inactiveShortcuts = shortcuts.filterIndexed { index, shortcut -> shortcutRevision; !terminalView.shortcutRowActive(tab.id, shortcut, index < 4) }
    SettingsScaffold(tab.title, tokens, onBack) {
        if (tab.title == "Tmux") {
            SettingsSection("SETTINGS", tokens) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("Prefix Key", color = tokens.text, fontSize = rowTitleSize(), modifier = Modifier.weight(1f))
                        Text(tmuxPrefixPreview(tmuxPrefixIndex), color = tokens.text, fontSize = valueSize(), fontFamily = FontFamily.Monospace)
                    }
                    Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("Ctrl+B", "Ctrl+A", "Ctrl+Space").forEachIndexed { index, label -> TmuxPrefixChoice(label, tmuxPrefixIndex == index, tokens) { tmuxPrefixIndex = index; terminalView.setTmuxPrefixIndex(index) } }
                    }
                }
            }
            item { Text("If you changed tmux from Ctrl+B to Ctrl+A or Ctrl+Space, set it here so the quick actions match.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 10.dp)) }
            item {
                Column(Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surfaceHigh)) {
                    SettingsToggleRow(null, "Start window from 1", tmuxStartWindowFromOne, tokens) { tmuxStartWindowFromOne = it; terminalView.setTmuxStartWindowFromOne(it) }
                }
            }
        }
        SettingsSection("ACTIVE", tokens) {
            if (activeShortcuts.isEmpty()) {
                Box(Modifier.fillMaxWidth().height(76.dp), contentAlignment = Alignment.Center) { Text("No active shortcuts", color = tokens.secondary, fontSize = bodySize()) }
            } else {
                activeShortcuts.forEach { shortcut -> ShortcutDetailRow(shortcut.sequence, shortcut.hint, true, tokens, onMove = { delta -> shortcutOrder = moveShortcutRow(terminalView.shortcutRowOrder(tab.id, defaultShortcuts), shortcutRowId(shortcut), delta); terminalView.setShortcutRowOrder(tab.id, shortcutOrder, defaultShortcuts); shortcutRevision++ }, onEdit = { onEditShortcut(shortcut) }) { terminalView.setShortcutRowActive(tab.id, shortcut, false); shortcutRevision++ } }
            }
        }
        item { Text("Tap − to disable, + to enable, or trash to delete inactive shortcuts. Drag to reorder. Tap a row to edit.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 10.dp)) }
        if (inactiveShortcuts.isNotEmpty()) {
            SettingsSection("INACTIVE", tokens) { inactiveShortcuts.forEach { shortcut -> ShortcutDetailRow(shortcut.sequence, shortcut.hint, false, tokens, onDelete = if (tab.id == "favorites") ({ terminalView.removeCustomShortcut(shortcut); shortcutRevision++ }) else null, onEdit = { onEditShortcut(shortcut) }) { terminalView.setShortcutRowActive(tab.id, shortcut, true); shortcutRevision++ } } }
        }
        item {
            Box(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 18.dp).height(56.dp).clip(RoundedCornerShape(26.dp)).background(tokens.surfaceHigh).clickable { hapticClick(); onAddShortcut() }, contentAlignment = Alignment.Center) {
                Text("+  Add Shortcut", color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
            }
        }
        item { Box(Modifier.fillMaxWidth().height(46.dp).clickable { hapticClick() }, contentAlignment = Alignment.Center) { Text("↻  Reset", color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold) } }
    }
}

@Composable
private fun RowScope.TmuxPrefixChoice(label: String, selected: Boolean, tokens: UiTokens, onClick: () -> Unit) {
    Box(Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(12.dp)).border(2.dp, if (selected) tokens.accent else Color.Transparent, RoundedCornerShape(12.dp)).background(tokens.surface).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) {
        Text(label, color = if (selected) tokens.accent else tokens.text, fontSize = captionSize(), fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun ShortcutDetailRow(sequence: String, hint: String, active: Boolean, tokens: UiTokens, onDelete: (() -> Unit)? = null, onMove: (Int) -> Unit = {}, onEdit: () -> Unit = {}, onToggle: () -> Unit = {}) {
    var dragOffset by remember { mutableStateOf(0f) }
    Row(Modifier.fillMaxWidth().height(72.dp).semantics { contentDescription = "Edit $hint shortcut" }.clickable { hapticClick(); onEdit() }.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (active) "⊖" else "⊕", color = if (active) Color(0xffd62d5a) else tokens.accent, fontSize = 25.sp, modifier = Modifier.width(42.dp).semantics { contentDescription = if (active) "Disable $hint shortcut" else "Enable $hint shortcut" }.clickable { hapticClick(); onToggle() })
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
            Text(sequence, color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace)
            Text(hint, color = tokens.secondary, fontSize = captionSize())
        }
        if (active) Text("⠿", color = tokens.secondary, fontSize = 22.sp, modifier = Modifier.width(44.dp).semantics { contentDescription = "Move $hint shortcut" }.clickable { hapticClick(); onMove(1) }.pointerInput(sequence) { var movedInDrag = false; detectVerticalDragGestures(onDragStart = { dragOffset = 0f; movedInDrag = false }, onDragEnd = { dragOffset = 0f }, onDragCancel = { dragOffset = 0f }) { change, dragAmount -> if (!movedInDrag) { dragOffset += dragAmount; when { dragOffset <= -38f -> { change.consume(); dragOffset = 0f; movedInDrag = true; hapticClick(); onMove(-1) }; dragOffset >= 38f -> { change.consume(); dragOffset = 0f; movedInDrag = true; hapticClick(); onMove(1) } } } } }, textAlign = TextAlign.Center) else Icon(painterResource(R.drawable.ic_feather_trash_2), null, tint = Color(0xffd62d5a), modifier = Modifier.size(20.dp).semantics { contentDescription = "Delete $hint shortcut" }.clickable(enabled = onDelete != null) { hapticClick(); onDelete?.invoke() })
    }
}

private fun defaultShortcutRows(tab: String, tmuxPrefixIndex: Int, tmuxStartWindowFromOne: Boolean): List<ShortcutRowDefinition> = when (tab) {
    "Tmux" -> tmuxShortcutRows(tmuxPrefixIndex, tmuxStartWindowFromOne)
    else -> defaultShortcutRowsForReset(tab)
}

@Composable
private fun ShortcutEditorScreen(terminalView: CoderTerminalView, tokens: UiTokens, editingShortcut: ShortcutRowDefinition? = null, editingTabId: String = "favorites", onBack: () -> Unit) {
    var ctrl by remember { mutableStateOf(false) }
    var opt by remember { mutableStateOf(false) }
    var shift by remember { mutableStateOf(false) }
    var selectedKey by remember { mutableStateOf("") }
    var customText by remember(editingShortcut) { mutableStateOf(editingShortcut?.sequence.orEmpty()) }
    var hint by remember(editingShortcut) { mutableStateOf(editingShortcut?.hint.orEmpty()) }
    val canSave = isShortcutInputValid(ctrl, opt, shift, selectedKey, customText)
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    SettingsScaffold(if (editingShortcut == null) "New Shortcut" else "Edit Shortcut", tokens, onBack) {
        item { Box(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 10.dp).height(66.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surfaceHigh).padding(16.dp).focusRequester(focusRequester).focusable().onPreviewKeyEvent { event ->
            if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            ctrl = event.isCtrlPressed
            opt = event.isAltPressed
            shift = event.isShiftPressed
            val label = hardwareShortcutLabel(event.key.nativeKeyCode)
            if (label != null) selectedKey = label
            label != null
        }, contentAlignment = Alignment.CenterStart) { Text(shortcutPreview(ctrl, opt, shift, selectedKey, customText), color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace, modifier = Modifier.semantics { contentDescription = "Shortcut editor preview ${shortcutPreview(ctrl, opt, shift, selectedKey, customText)}" }) } }
        item { Text("MODIFIERS", color = tokens.secondary, fontSize = sectionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 5.dp)) }
        item { Row(Modifier.fillMaxWidth().padding(horizontal = spacingLarge()), horizontalArrangement = Arrangement.spacedBy(8.dp)) { ShortcutChoice("^ Ctrl", ctrl, tokens) { ctrl = !ctrl }; ShortcutChoice("⌥ Opt", opt, tokens) { opt = !opt }; ShortcutChoice("⇧ Shift", shift, tokens) { shift = !shift } } }
        item { Text("KEY", color = tokens.secondary, fontSize = sectionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
        item { ShortcutKeyGrid(tokens, selectedKey) { selectedKey = it } }
        item { Box(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 6.dp).height(48.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surfaceHigh).padding(13.dp)) { BasicTextField(value = customText, onValueChange = { customText = it }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Shortcut command" }, singleLine = true, textStyle = androidx.compose.ui.text.TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace), decorationBox = { inner -> if (customText.isEmpty()) Text("Custom text / command", color = tokens.secondary, fontSize = bodySize(), fontFamily = FontFamily.Monospace); inner() }) } }
        item { Text("HINT (OPTIONAL)", color = tokens.secondary, fontSize = sectionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
        item { Box(Modifier.fillMaxWidth().padding(horizontal = spacingLarge()).height(52.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surfaceHigh).padding(14.dp)) { BasicTextField(value = hint, onValueChange = { hint = it }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Shortcut hint" }, singleLine = true, textStyle = androidx.compose.ui.text.TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace), decorationBox = { inner -> if (hint.isEmpty()) Text("e.g. \"submit\"", color = tokens.secondary, fontSize = bodySize(), fontFamily = FontFamily.Monospace); inner() }) } }
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ShortcutFooterButton("Cancel", tokens.surfaceHigh, tokens.text, Modifier.weight(1f), onClick = onBack)
                ShortcutFooterButton("Save", tokens.accent, contentColorFor(tokens.accent), Modifier.weight(1f), canSave) {
                    val sequence = shortcutSequence(ctrl, opt, shift, selectedKey, customText)
                    val label = hint.ifBlank { shortcutPreview(ctrl, opt, shift, selectedKey, customText) }.take(14)
                    if (sequence.isNotEmpty()) {
                        val shortcut = TerminalShortcut(label, sequence)
                        if (editingShortcut != null && editingTabId == "favorites") terminalView.replaceCustomShortcut(editingShortcut, shortcut) else terminalView.addCustomShortcut(shortcut)
                    }
                    onBack()
                }
            }
        }
    }
}

@Composable
private fun GesturesSettingsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onBack: () -> Unit) {
    var revision by remember { mutableIntStateOf(0) }
    SettingsScaffold("Gestures", tokens, onBack) {
        GestureSettingsSection("TERMINAL", terminalGestureSpecs(), terminalView, tokens, revision) { revision++ }
        item { Text("These gestures run directly on the terminal surface.", color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 10.dp)) }
        GestureSettingsSection("HEADER", headerGestureSpecs(), terminalView, tokens, revision) { revision++ }
        item { Text("Soft and hard drags let you split the short pull from the long pull.", color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 10.dp)) }
        GestureSettingsSection("TOOLBAR SWIPES", toolbarSwipeGestureSpecs(), terminalView, tokens, revision) { revision++ }
        item { Text("Swipe gestures on the floating input bar.", color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 10.dp)) }
        GestureSettingsSection("TOOLBAR BUTTONS", toolbarButtonGestureSpecs(), terminalView, tokens, revision) { revision++ }
        item { Text("Configure the keyboard, mic, Ctrl, Shortcuts, and D-Pad toolbar buttons.", color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 10.dp)) }
        GestureSettingsSection("D-PAD", dpadGestureSpecs(), terminalView, tokens, revision) { revision++ }
        item { Text("Configure the D-Pad corner buttons.", color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 10.dp)) }
        item { Box(Modifier.fillMaxWidth().padding(vertical = 18.dp).clickable { resetGestureActions(terminalView); revision++ }, contentAlignment = Alignment.Center) { Text("↻  Reset to Defaults", color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold) } }
    }
}

private data class GestureSettingSpec(val icon: Int, val title: String, val key: String, val defaultAction: String, val actions: List<TerminalGestureAction>, val subtitle: String? = null)

private fun LazyListScope.GestureSettingsSection(title: String, specs: List<GestureSettingSpec>, terminalView: CoderTerminalView, tokens: UiTokens, revision: Int, onChanged: () -> Unit) {
    SettingsSection(title, tokens) {
        specs.forEach { spec -> GestureActionRow(spec, terminalView, tokens, revision, onChanged) }
    }
}

@Composable
private fun GestureActionRow(spec: GestureSettingSpec, terminalView: CoderTerminalView, tokens: UiTokens, revision: Int, onChanged: () -> Unit) {
    var expanded by remember(spec.key) { mutableStateOf(false) }
    val selectedActionId = remember(revision, spec.key) { terminalView.selectedGestureAction(spec.key, spec.defaultAction) }
    val selected = spec.actions.firstOrNull { it.id == selectedActionId } ?: gestureAction(spec.defaultAction)
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(0.dp)).background(tokens.surface).clickable { expanded = !expanded }.padding(horizontal = spacingLarge(), vertical = 14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(spec.icon), null, tint = tokens.secondary, modifier = Modifier.size(20.dp))
            Column(Modifier.padding(start = 14.dp).weight(1f)) {
                Text(spec.title, color = tokens.text, fontSize = rowTitleSize())
                if (spec.subtitle != null) Text(spec.subtitle, color = tokens.secondary, fontSize = captionSize())
            }
            Text(selected.label, color = if (selected.id == "no_action") tokens.secondary else tokens.text, fontSize = valueSize(), maxLines = 1)
            Text(if (expanded) "⌃" else "⌄", color = tokens.secondary, fontSize = 18.sp, modifier = Modifier.padding(start = 8.dp))
        }
        if (expanded) {
            spec.actions.forEach { action ->
                Row(Modifier.fillMaxWidth().padding(top = 18.dp).clickable { terminalView.setGestureAction(spec.key, action.id); expanded = false; onChanged() }, verticalAlignment = Alignment.CenterVertically) {
                    Text(if (selected.id == action.id) "✓" else "", color = tokens.accent, fontSize = bodySize(), modifier = Modifier.width(34.dp))
                    Column {
                        Text(action.label, color = if (selected.id == action.id) tokens.accent else tokens.text, fontSize = bodySize(), fontWeight = if (selected.id == action.id) FontWeight.Bold else FontWeight.Normal)
                        Text(action.description, color = tokens.secondary, fontSize = captionSize(), lineHeight = 16.sp)
                    }
                }
            }
        }
    }
}

private fun terminalGestureSpecs(): List<GestureSettingSpec> = listOf(
    GestureSettingSpec(R.drawable.ic_feather_circle, "Single Tap", "single_tap", "no_action", terminalTapActions()),
    GestureSettingSpec(R.drawable.ic_feather_circle, "Double Tap", "double_tap", "paste", terminalTapActions()),
    GestureSettingSpec(R.drawable.ic_feather_circle, "Triple Tap", "triple_tap", "no_action", terminalTapActions()),
    GestureSettingSpec(R.drawable.ic_feather_sliders, "Scroll Down", "scroll_down", "dismiss_keyboard", actions("dismiss_keyboard", "no_action")),
    GestureSettingSpec(R.drawable.ic_feather_hand, "Swipe", "swipe", "switch_tmux_window", actions("switch_tmux_window", "session_switcher", "no_action")),
    GestureSettingSpec(R.drawable.ic_feather_maximize_2, "Pinch", "pinch", "adjust_font_size", actions("adjust_font_size", "tmux_pane_zoom", "custom_shortcut", "no_action")),
)

private fun headerGestureSpecs(): List<GestureSettingSpec> = listOf(
    GestureSettingSpec(R.drawable.ic_feather_arrow_up, "Drag Down Soft", "header_drag_down_soft", "open_switcher", actions("open_switcher", "minimize_session", "no_action")),
    GestureSettingSpec(R.drawable.ic_feather_arrow_up, "Drag Down Hard", "header_drag_down_hard", "minimize_session", actions("open_switcher", "minimize_session", "no_action")),
)

private fun toolbarSwipeGestureSpecs(): List<GestureSettingSpec> = listOf(
    GestureSettingSpec(R.drawable.ic_feather_arrow_up, "Swipe Up", "toolbar_swipe_up", "open_switcher", actions("open_switcher", "dismiss_keyboard", "no_action")),
    GestureSettingSpec(R.drawable.ic_feather_arrow_up, "Swipe Down", "toolbar_swipe_down", "dismiss_keyboard", actions("dismiss_keyboard", "no_action")),
)

private fun toolbarButtonGestureSpecs(): List<GestureSettingSpec> = listOf(
    GestureSettingSpec(R.drawable.ic_feather_keyboard, "Keyboard Tap", "keyboard_tap", "toggle_keyboard", toolbarButtonActions()),
    GestureSettingSpec(R.drawable.ic_feather_keyboard, "Keyboard Double Tap", "keyboard_double_tap", "send_enter", toolbarButtonActions()),
    GestureSettingSpec(R.drawable.ic_feather_keyboard, "Keyboard Long Press", "keyboard_long_press", "no_action", toolbarButtonActions()),
    GestureSettingSpec(R.drawable.ic_feather_mic, "Mic Long Press", "mic_long_press", "open_speech_settings", toolbarButtonActions()),
    GestureSettingSpec(R.drawable.ic_feather_chevron_up, "Ctrl Double Tap", "ctrl_double_tap", "lock_ctrl", toolbarButtonActions()),
    GestureSettingSpec(R.drawable.ic_feather_chevron_up, "Ctrl Long Press", "ctrl_long_press", "toggle_shortcuts_panel", toolbarButtonActions()),
    GestureSettingSpec(R.drawable.ic_feather_box, "Shortcuts Double Tap", "shortcuts_double_tap", "lock_shortcuts_panel", toolbarButtonActions()),
)

private fun dpadGestureSpecs(): List<GestureSettingSpec> = listOf(
    GestureSettingSpec(R.drawable.ic_feather_delete, "Top Left", "dpad_top_left", "backspace", dpadCornerActions(), "Upper-left D-Pad button"),
    GestureSettingSpec(R.drawable.ic_feather_command, "Top Right", "dpad_top_right", "ctrl_c", dpadCornerActions(), "Upper-right D-Pad button"),
)

private fun terminalTapActions(): List<TerminalGestureAction> = actions("paste", "send_escape", "send_tab", "custom_shortcut", "no_action")

private fun toolbarButtonActions(): List<TerminalGestureAction> = actions("toggle_keyboard", "send_enter", "lock_ctrl", "toggle_shortcuts_panel", "lock_shortcuts_panel", "open_speech_settings", "no_action")

private fun dpadCornerActions(): List<TerminalGestureAction> = actions("backspace", "ctrl_c", "custom_shortcut", "hide")

private fun actions(vararg ids: String): List<TerminalGestureAction> = ids.map(::gestureAction)

private fun gestureAction(id: String): TerminalGestureAction = when (id) {
    "paste" -> TerminalGestureAction(id, "Paste", "Paste the current clipboard into the terminal.")
    "send_escape" -> TerminalGestureAction(id, "Send Escape", "Send an Escape key press to the terminal.")
    "send_tab" -> TerminalGestureAction(id, "Send Tab", "Send a Tab key press to the terminal.")
    "send_enter" -> TerminalGestureAction(id, "Send Enter", "Send an Enter key press to the terminal.")
    "dismiss_keyboard" -> TerminalGestureAction(id, "Dismiss Keyboard", "Hide the keyboard when it is visible.")
    "switch_tmux_window" -> TerminalGestureAction(id, "Switch Tmux Window", "Swipe left or right to move between tmux windows when tmux is active.")
    "session_switcher" -> TerminalGestureAction(id, "Session Switcher", "Swipe into the switcher and land on the adjacent session card.")
    "adjust_font_size" -> TerminalGestureAction(id, "Adjust Font Size", "Change the terminal font size with a pinch gesture.")
    "tmux_pane_zoom" -> TerminalGestureAction(id, "Tmux Pane Zoom", "Send the tmux pane zoom shortcut (prefix + z).")
    "open_switcher" -> TerminalGestureAction(id, "Open Switcher", "Open the terminal session switcher.")
    "minimize_session" -> TerminalGestureAction(id, "Minimize Session", "Detach the terminal into a background session.")
    "toggle_keyboard" -> TerminalGestureAction(id, "Toggle Keyboard", "Show or hide the software keyboard.")
    "lock_ctrl" -> TerminalGestureAction(id, "Lock Ctrl", "Keep Ctrl latched for the next terminal input.")
    "toggle_shortcuts_panel" -> TerminalGestureAction(id, "Toggle Shortcuts Panel", "Show or hide the shortcuts panel.")
    "lock_shortcuts_panel" -> TerminalGestureAction(id, "Lock Shortcuts Panel", "Keep the shortcuts panel open.")
    "open_speech_settings" -> TerminalGestureAction(id, "Open Speech Settings", "Open speech input settings.")
    "backspace" -> TerminalGestureAction(id, "Backspace", "Send Backspace from this D-Pad corner.")
    "ctrl_c" -> TerminalGestureAction(id, "Ctrl+C", "Send Ctrl+C from this D-Pad corner.")
    "custom_shortcut" -> TerminalGestureAction(id, "Custom Shortcut", "Open the shortcut builder and bind a custom shortcut.")
    "hide" -> TerminalGestureAction(id, "Hide", "Hide this D-Pad corner button.")
    else -> TerminalGestureAction("no_action", "No Action", "Leave this gesture unassigned.")
}

private fun resetGestureActions(terminalView: CoderTerminalView) {
    (terminalGestureSpecs() + headerGestureSpecs() + toolbarSwipeGestureSpecs() + toolbarButtonGestureSpecs() + dpadGestureSpecs()).forEach { terminalView.setGestureAction(it.key, it.defaultAction) }
}

@Composable
private fun KeyboardSettingsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onBack: () -> Unit) {
    var keyboardPaste by remember { mutableStateOf(terminalView.keyboardPasteEnabled()) }
    var optionAsMeta by remember { mutableStateOf(terminalView.optionAsMetaEnabled()) }
    var autoHideToolbar by remember { mutableStateOf(terminalView.autoHideToolbarEnabled()) }
    var volumeFontSize by remember { mutableStateOf(terminalView.volumeFontSizeEnabled()) }
    SettingsScaffold("Keyboard", tokens, onBack) {
        SettingsSection("HARDWARE KEYBOARD", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_minimize_2, "Auto-hide Toolbar", autoHideToolbar, tokens) { autoHideToolbar = it; terminalView.setAutoHideToolbarEnabled(it) }
            SettingsToggleRow(R.drawable.ic_feather_upload, "Keyboard Paste", keyboardPaste, tokens) { keyboardPaste = it; terminalView.setKeyboardPasteEnabled(it) }
            SettingsToggleRow(R.drawable.ic_feather_command, "Option as Meta", optionAsMeta, tokens) { optionAsMeta = it; terminalView.setOptionAsMetaEnabled(it) }
            SettingsValueRow(R.drawable.ic_feather_keyboard, "Paste Shortcut", "Cmd+V or Ctrl+Shift+V", null, tokens) {}
            SettingsValueRow(R.drawable.ic_feather_terminal, "Terminal Keys", "Esc, Tab, Enter, arrows, Home, End, PgUp, PgDn", null, tokens) {}
        }
        SettingsSection("APPLICATION SHORTCUTS", tokens) {
            applicationShortcutDefinitions.forEach { shortcut -> SettingsValueRow(R.drawable.ic_feather_command, shortcut.title, shortcut.description, shortcut.chord, tokens) {} }
        }
        SettingsSection("DEVICE KEYS", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_type, "Volume Font Size", volumeFontSize, tokens) { volumeFontSize = it; terminalView.setVolumeFontSizeEnabled(it) }
            SettingsValueRow(R.drawable.ic_feather_type, "Volume Up", "Increase terminal font size", null, tokens) {}
            SettingsValueRow(R.drawable.ic_feather_type, "Volume Down", "Decrease terminal font size", null, tokens) {}
        }
        item { Text("Modifier latches and custom key sequences are configured in Shortcuts and Toolbar.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
}

@Composable
private fun ChatModeSettingsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onBack: () -> Unit) {
    var chatMode by remember { mutableStateOf(terminalView.chatModeEnabled()) }
    var autoSend by remember { mutableStateOf(terminalView.chatAutoSendEnabled()) }
    SettingsScaffold("Chat Mode", tokens, onBack) {
        SettingsSection("CHAT INPUT", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_message_circle, "Enable Chat Mode", chatMode, tokens) { chatMode = it; terminalView.setChatModeEnabled(it) }
            SettingsToggleRow(R.drawable.ic_feather_send, "Auto Send", autoSend, tokens) { autoSend = it; terminalView.setChatAutoSendEnabled(it) }
        }
        item { Text("When Auto Send is enabled, submitting chat input sends the prompt plus Return/Enter to the terminal. Disable it to paste the prompt without executing it.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
}

@Composable
private fun SpeechSettingsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onModels: () -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    var speechSettings by remember { mutableStateOf(SpeechSettingsStore.values(context)) }
    var promptDialogOpen by remember { mutableStateOf(false) }
    var providerDialogOpen by remember { mutableStateOf(false) }
    var apiKeyDialogOpen by remember { mutableStateOf(false) }
    var modelDialogOpen by remember { mutableStateOf(false) }
    var baseUrlDialogOpen by remember { mutableStateOf(false) }
    var enhancementApiKeyStored by remember { mutableStateOf(SpeechSettingsStore.enhancementApiKey(context).isNotBlank()) }
    val defaultPrompt = remember(context) { SpeechSettingsStore.defaultPrompt(context) }
    SettingsScaffold("Speech", tokens, onBack) {
        SettingsSection("DICTATION INPUT", tokens) {
            SettingsValueRow(R.drawable.ic_feather_mic, "Microphone Button", "Available inside chat input mode", null, tokens) {}
            SettingsToggleRow(R.drawable.ic_feather_shield, "Local LiteRT Parakeet", speechSettings.localTranscriptionEnabled, tokens) {
                SpeechSettingsStore.setLocalTranscriptionEnabled(context, it)
                speechSettings = SpeechSettingsStore.values(context)
            }
            SettingsToggleRow(R.drawable.ic_feather_wifi, "Pause Downloads on Metered", speechSettings.pauseModelDownloadsOnMeteredNetwork, tokens) {
                SpeechSettingsStore.setPauseModelDownloadsOnMeteredNetwork(context, it)
                speechSettings = SpeechSettingsStore.values(context)
            }
            SettingsValueRow(R.drawable.ic_feather_box, "Models", ParakeetModelArtifacts.byId(speechSettings.selectedSpeechModelId).title, "Manage", tokens, chevron = true) { onModels() }
            SettingsValueRow(R.drawable.ic_feather_sliders, "VAD Sensitivity", speechSettings.vadSensitivityLabel(), "+", tokens) {
                SpeechSettingsStore.setVadSensitivity(context, (speechSettings.vadSensitivity + 1) % 5)
                speechSettings = SpeechSettingsStore.values(context)
            }
            SettingsToggleRow(R.drawable.ic_feather_bell, "Sound Feedback", speechSettings.soundFeedbackEnabled, tokens) {
                SpeechSettingsStore.setSoundFeedbackEnabled(context, it)
                speechSettings = SpeechSettingsStore.values(context)
            }
        }
        SettingsSection("PERFORMANCE", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_zap, "Keep Model Warm", speechSettings.keepModelWarmEnabled, tokens) {
                SpeechSettingsStore.setKeepModelWarmEnabled(context, it)
                speechSettings = SpeechSettingsStore.values(context)
            }
            SettingsValueRow(R.drawable.ic_feather_cpu, "Warm Interval", "${speechSettings.keepModelWarmMinutes} min", "+", tokens) {
                val next = when (speechSettings.keepModelWarmMinutes) {
                    5 -> 10
                    10 -> 15
                    15 -> 30
                    30 -> 60
                    else -> 5
                }
                SpeechSettingsStore.setKeepModelWarmMinutes(context, next)
                speechSettings = SpeechSettingsStore.values(context)
            }
            SettingsValueRow(R.drawable.ic_feather_cpu, "LiteRT Accelerator", SpeechAcceleratorMode.byId(speechSettings.accelerator).label, "+", tokens) {
                val modes = SpeechAcceleratorMode.all
                val currentIndex = modes.indexOf(SpeechAcceleratorMode.byId(speechSettings.accelerator)).coerceAtLeast(0)
                SpeechSettingsStore.setAccelerator(context, modes[(currentIndex + 1) % modes.size].id)
                speechSettings = SpeechSettingsStore.values(context)
            }
        }
        SettingsSection("ENHANCEMENT", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_message_circle, "Enhance Transcript", speechSettings.enhancementEnabled, tokens) {
                SpeechSettingsStore.setEnhancementEnabled(context, it)
                speechSettings = SpeechSettingsStore.values(context)
            }
            SettingsValueRow(R.drawable.ic_feather_server, "Provider", SpeechEnhancementProvider.byId(speechSettings.enhancementProvider).label, "Select", tokens) { providerDialogOpen = true }
            if (SpeechEnhancementProvider.byId(speechSettings.enhancementProvider) == SpeechEnhancementProvider.OpenAiCompatible) SettingsValueRow(R.drawable.ic_feather_globe, "Endpoint", speechSettings.enhancementBaseUrl, "Edit", tokens) { baseUrlDialogOpen = true }
            SettingsValueRow(R.drawable.ic_feather_cpu, "Model", speechSettings.enhancementModel, "Edit", tokens) { modelDialogOpen = true }
            SettingsValueRow(R.drawable.ic_feather_shield, "API Key", if (enhancementApiKeyStored) "Stored encrypted" else "Missing", "Edit", tokens) { apiKeyDialogOpen = true }
            SettingsValueRow(R.drawable.ic_feather_edit_3, "Prompt", "Default VoiceInk-style prompt", "Edit", tokens) { promptDialogOpen = true }
            SettingsToggleRow(R.drawable.ic_feather_terminal, "Visible Terminal Context", speechSettings.includeVisibleTerminalContext, tokens) {
                SpeechSettingsStore.setIncludeVisibleTerminalContext(context, it)
                speechSettings = SpeechSettingsStore.values(context)
            }
            SettingsValueRow(R.drawable.ic_feather_terminal, "Terminal Target", "Send dictated text to active terminal", null, tokens) {}
            SettingsValueRow(R.drawable.ic_feather_shield, "Privacy", "Transcription stays on device. Enhancement sends transcript and bounded visible context to selected provider.", null, tokens) {}
        }
        item { Text("Audio transcription is local-only through LiteRT Parakeet. Terminal context is bounded to visible terminal text when enabled.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
    if (promptDialogOpen) SpeechPromptOverrideDialog(tokens, speechSettings.promptOverride.ifBlank { defaultPrompt }, { promptDialogOpen = false }) {
        SpeechSettingsStore.setPromptOverride(context, it)
        speechSettings = SpeechSettingsStore.values(context)
        promptDialogOpen = false
    }
    if (providerDialogOpen) SpeechChoiceDialog(tokens, "Enhancement Provider", SpeechEnhancementProvider.all.map { it.label }, SpeechEnhancementProvider.byId(speechSettings.enhancementProvider).label, { providerDialogOpen = false }) { label ->
        SpeechSettingsStore.setEnhancementProvider(context, SpeechEnhancementProvider.all.first { it.label == label }.id)
        speechSettings = SpeechSettingsStore.values(context)
        providerDialogOpen = false
    }
    if (apiKeyDialogOpen) SpeechSingleLineDialog(tokens, "Enhancement API Key", "", if (SpeechSettingsStore.enhancementApiKey(context).isBlank()) "Paste API key" else "New key, blank clears stored key", { apiKeyDialogOpen = false }) {
        SpeechSettingsStore.setEnhancementApiKey(context, it)
        enhancementApiKeyStored = it.isNotBlank()
        speechSettings = SpeechSettingsStore.values(context)
        apiKeyDialogOpen = false
    }
    if (modelDialogOpen) SpeechSingleLineDialog(tokens, "Enhancement Model", speechSettings.enhancementModel, if (SpeechEnhancementProvider.byId(speechSettings.enhancementProvider) == SpeechEnhancementProvider.Gemini) "gemini-2.5-flash" else "gpt-4o-mini", { modelDialogOpen = false }) {
        SpeechSettingsStore.setEnhancementModel(context, it)
        speechSettings = SpeechSettingsStore.values(context)
        modelDialogOpen = false
    }
    if (baseUrlDialogOpen) SpeechSingleLineDialog(tokens, "OpenAI-Compatible Endpoint", speechSettings.enhancementBaseUrl, "https://api.openai.com/v1", { baseUrlDialogOpen = false }) {
        SpeechSettingsStore.setEnhancementBaseUrl(context, it)
        speechSettings = SpeechSettingsStore.values(context)
        baseUrlDialogOpen = false
    }
}

private fun SpeechSettingsValues.vadSensitivityLabel(): String = when (vadSensitivity.coerceIn(0, 4)) {
    0 -> "Very low"
    1 -> "Low"
    2 -> "Normal"
    3 -> "High"
    else -> "Very high"
}

@Composable
private fun SpeechChoiceDialog(tokens: UiTokens, title: String, options: List<String>, selected: String, onDismiss: () -> Unit, onSelect: (String) -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = tokens.surfaceHigh,
        titleContentColor = tokens.text,
        textContentColor = tokens.secondary,
        shape = RoundedCornerShape(24.dp),
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                options.forEach { option ->
                    SettingsValueRow(R.drawable.ic_feather_check, option, null, if (option == selected) "✓" else null, tokens) { onSelect(option) }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = tokens.text) } },
    )
}

@Composable
private fun SpeechSingleLineDialog(tokens: UiTokens, title: String, initialValue: String, placeholder: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var value by remember(initialValue) { mutableStateOf(initialValue) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = tokens.surfaceHigh,
        titleContentColor = tokens.text,
        textContentColor = tokens.secondary,
        shape = RoundedCornerShape(24.dp),
        title = { Text(title) },
        text = { CoderTextField(value, { value = it }, placeholder, tokens) },
        confirmButton = { TextButton(onClick = { onSave(value) }) { Text("Save", color = tokens.accent) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = tokens.text) } },
    )
}

@Composable
private fun SpeechModelSettingsScreen(tokens: UiTokens, onModel: (String) -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var speechSettings by remember { mutableStateOf(SpeechSettingsStore.values(context)) }
    var refreshTick by remember { mutableIntStateOf(0) }
    val tokenizerCache = remember(context) { ParakeetTokenizerCache(context) }
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(800)
            refreshTick++
        }
    }
    SettingsScaffold("Speech Models", tokens, onBack) {
        SettingsSection("ACTIVE MODEL", tokens) {
            val activeArtifact = ParakeetModelArtifacts.byId(speechSettings.selectedSpeechModelId)
            SettingsValueRow(R.drawable.ic_feather_check, activeArtifact.title, activeArtifact.precision, "Active", tokens) {}
            SettingsValueRow(R.drawable.ic_feather_download_cloud, "Tokenizer", if (tokenizerCache.isReady()) "Ready" else "Required for Parakeet decoding", if (tokenizerCache.isReady()) "✓" else "Download", tokens) {
                if (!tokenizerCache.isReady()) scope.launch { tokenizerCache.ensureTokenizer(); refreshTick++ }
            }
        }
        item { Text("MODELS", color = tokens.secondary, fontSize = sectionSize(), letterSpacing = 0.6.sp, modifier = Modifier.padding(start = spacingLarge(), end = spacingLarge(), top = 14.dp, bottom = 7.dp)) }
        ParakeetModelArtifacts.all.forEach { artifact ->
            item {
                val cache = remember(context, artifact.id, refreshTick) { ParakeetModelCache(context, artifact) }
                val status = cache.status()
                val downloadState = cache.downloadStatus()
                val downloading = downloadState.status in setOf(ModelDownloadState.Running, ModelDownloadState.Paused)
                val progress = if (downloadState.totalBytes > 0) (downloadState.bytesDownloaded * 100 / downloadState.totalBytes).coerceIn(0, 100) else 0
                SpeechModelCard(
                    tokens = tokens,
                    artifact = artifact,
                    selected = artifact.id == speechSettings.selectedSpeechModelId,
                    statusText = when {
                        status.ready -> "Ready · ${artifact.sizeBytes.toHumanBytesLabel()}"
                        downloading -> "${if (downloadState.status == ModelDownloadState.Paused) "Paused" else "Downloading"} ${progress}% · ${downloadState.bytesDownloaded.toHumanBytesLabel()} · ${downloadState.bytesPerSecond.toSpeedLabel()} · ETA ${downloadState.etaSeconds.toEtaLabel()}"
                        status.hasCache -> status.label
                        else -> "Not downloaded · ${artifact.sizeBytes.toHumanBytesLabel()}"
                    },
                    progress = if (downloading) progress.toInt() else null,
                    onClick = { onModel(artifact.id) },
                )
            }
        }
        item { Text("Downloads use Pi's resumable model downloader: HTTP Range, ETag validators, persisted progress, foreground service execution, and optional auto-pause on metered mobile/Wi‑Fi networks.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
}

@Composable
private fun SpeechModelCard(tokens: UiTokens, artifact: ParakeetModelArtifact, selected: Boolean, statusText: String, progress: Int?, onClick: () -> Unit) {
    Column(Modifier.padding(horizontal = spacingLarge(), vertical = 6.dp).clip(RoundedCornerShape(18.dp)).background(tokens.surfaceHigh).clickable { hapticClick(); onClick() }.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(if (artifact.precision.contains("Float")) R.drawable.ic_feather_cpu else R.drawable.ic_feather_zap), null, tint = tokens.secondary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(artifact.title, color = tokens.text, fontSize = rowTitleSize(), fontWeight = FontWeight.SemiBold)
                Text(artifact.precision, color = tokens.secondary, fontSize = captionSize())
            }
            if (selected) Text("ACTIVE", color = tokens.accent, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            Text(" ›", color = tokens.secondary, fontSize = 24.sp)
        }
        Text(artifact.recommendedUse, color = tokens.secondary, fontSize = captionSize(), lineHeight = 18.sp)
        Text(statusText, color = tokens.text, fontSize = captionSize(), fontFamily = FontFamily.Monospace)
        if (progress != null) Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(tokens.separator)) { Box(Modifier.fillMaxWidth(progress / 100f).height(6.dp).background(tokens.accent)) }
    }
}

@Composable
private fun SpeechModelDetailScreen(artifact: ParakeetModelArtifact, tokens: UiTokens, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val notificationPermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    var speechSettings by remember { mutableStateOf(SpeechSettingsStore.values(context)) }
    var refreshTick by remember { mutableIntStateOf(0) }
    val cache = remember(context, artifact.id, refreshTick) { ParakeetModelCache(context, artifact) }
    val tokenizerCache = remember(context) { ParakeetTokenizerCache(context) }
    val importLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch { cache.importModel(uri); tokenizerCache.ensureTokenizer(); refreshTick++ }
    }
    val status = cache.status()
    val downloadState = cache.downloadStatus()
    val sideLoadedModelReady = cache.sideLoadedModelFile().isFile
    val sideLoadedTokenizerReady = tokenizerCache.sideLoadedTokenizerFile().isFile
    val running = downloadState.status == ModelDownloadState.Running
    val paused = downloadState.status == ModelDownloadState.Paused
    val completedDownload = downloadState.status == ModelDownloadState.Success
    val failedDownload = downloadState.status == ModelDownloadState.Failed
    val downloading = running || paused
    val progress = if (downloadState.totalBytes > 0) (downloadState.bytesDownloaded * 100 / downloadState.totalBytes).coerceIn(0, 100) else 0
    fun requestNotificationsIfNeeded() {
        if (android.os.Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(800)
            refreshTick++
        }
    }
    SettingsScaffold(artifact.title, tokens, onBack) {
        SettingsSection("OVERVIEW", tokens) {
            SettingsValueRow(R.drawable.ic_feather_cpu, "Precision", artifact.precision, null, tokens) {}
            SettingsValueRow(R.drawable.ic_feather_database, "Download Size", artifact.sizeBytes.toHumanBytesLabel(), null, tokens) {}
            SettingsValueRow(R.drawable.ic_feather_info, "Recommended Use", artifact.recommendedUse, null, tokens) {}
            SettingsValueRow(R.drawable.ic_feather_shield, "Integrity", artifact.sha256.take(12) + "…", null, tokens) {}
        }
        SettingsSection("STATUS", tokens) {
            SettingsValueRow(R.drawable.ic_feather_hard_drive, "Cache", if (status.ready) "Ready" else status.label, if (status.ready) "✓" else null, tokens) {}
            SettingsValueRow(R.drawable.ic_feather_download_cloud, "Download", if (status.ready) "Ready · local model available" else downloadStatusLabel(downloadState, progress), if (status.ready) "Ready" else downloadStatusBadge(downloadState), tokens) {}
            if (running) {
                SettingsValueRow(R.drawable.ic_feather_zap, "Speed", if (downloadState.bytesPerSecond > 0) downloadState.bytesPerSecond.toSpeedLabel() else "Starting", null, tokens) {}
                SettingsValueRow(R.drawable.ic_feather_info, "ETA", downloadState.etaSeconds.toEtaLabel(), null, tokens) {}
            }
            SettingsValueRow(R.drawable.ic_feather_check, "Tokenizer", if (tokenizerCache.isReady()) "Ready" else "Required", if (tokenizerCache.isReady()) "✓" else null, tokens) {}
        }
        SettingsSection("ACTIONS", tokens) {
            if (status.ready) {
                SettingsValueRow(R.drawable.ic_feather_check, "Use This Model", if (speechSettings.selectedSpeechModelId == artifact.id) "Already selected" else "Set as active speech model", if (speechSettings.selectedSpeechModelId == artifact.id) "✓" else "Use", tokens) {
                    SpeechSettingsStore.setSelectedSpeechModelId(context, artifact.id)
                    speechSettings = SpeechSettingsStore.values(context)
                }
            }
            when {
                running -> {
                    SettingsValueRow(R.drawable.ic_feather_pause, "Pause Download", "Keep partial file and stop network stream", "Pause", tokens) { cache.pauseDownload(); refreshTick++ }
                    SettingsValueRow(R.drawable.ic_feather_x, "Cancel Download", "Stop and remove partial file", "Cancel", tokens) { cache.cancelDownload(); refreshTick++ }
                }
                paused -> {
                    SettingsValueRow(R.drawable.ic_feather_play, "Resume Download", "Continue with HTTP Range and ETag", "Resume", tokens) { requestNotificationsIfNeeded(); cache.startDownload(); refreshTick++ }
                    SettingsValueRow(R.drawable.ic_feather_x, "Cancel Download", "Stop and remove partial file", "Cancel", tokens) { cache.cancelDownload(); refreshTick++ }
                }
                completedDownload -> {
                    SettingsValueRow(R.drawable.ic_feather_check, "Verify And Import", "Validate SHA-256, import cache, fetch tokenizer", "Verify", tokens) { scope.launch { cache.finalizeDownloadIfComplete(); tokenizerCache.ensureTokenizer(); refreshTick++ } }
                }
                failedDownload -> {
                    SettingsValueRow(R.drawable.ic_feather_play, "Retry Download", "Resume partial bytes when server allows", "Retry", tokens) { requestNotificationsIfNeeded(); cache.startDownload(); refreshTick++ }
                    SettingsValueRow(R.drawable.ic_feather_x, "Clear Failed Download", "Remove partial file and reset state", "Clear", tokens) { cache.cancelDownload(); refreshTick++ }
                }
                !status.ready -> {
                    SettingsValueRow(R.drawable.ic_feather_download_cloud, "Download Model", "Start background resumable download", "Download", tokens) { requestNotificationsIfNeeded(); cache.startDownload(); refreshTick++ }
                    SettingsValueRow(R.drawable.ic_feather_upload, "Import Model File", "Pick an existing .tflite file and verify SHA-256", "Import", tokens) { importLauncher.launch(arrayOf("application/octet-stream", "application/vnd.tensorflow.lite", "*/*")) }
                    if (sideLoadedModelReady) SettingsValueRow(R.drawable.ic_feather_hard_drive, "Import Side-Loaded Model", "Use ${cache.sideLoadedModelFile().parentFile?.absolutePath.orEmpty()} without network", if (sideLoadedTokenizerReady) "Import" else "Import + Tokenizer", tokens) { scope.launch { cache.importSideLoadedModel(); tokenizerCache.ensureTokenizer(); refreshTick++ } }
                }
            }
            SettingsValueRow(R.drawable.ic_feather_external_link, "Open Hugging Face", "litert-community/parakeet-tdt-0.6b-v3", "Open", tokens) { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://huggingface.co/litert-community/parakeet-tdt-0.6b-v3"))) }
            if (status.ready || status.hasCache || downloadState.bytesDownloaded > 0) SettingsValueRow(R.drawable.ic_feather_trash_2, "Delete Local Files", "Remove model cache and download state", "Delete", tokens) { cache.cancelDownload(); cache.delete(); refreshTick++ }
        }
        item { Text("Downloader persists partial files and resumes with Range: bytes=<offset>- plus If-Range: <ETag>. If server returns 200 instead of 206, partial file resets. If metered-network pause is enabled, mobile data and metered Wi‑Fi pause automatically.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
}

private fun Long.toHumanBytesLabel(): String = when {
    this >= 1_000_000_000L -> "${this / 100_000_000L / 10.0} GB"
    this >= 1_000_000L -> "${this / 1_000_000L} MB"
    this >= 1_000L -> "${this / 1_000L} KB"
    else -> "$this B"
}

private fun downloadStatusLabel(state: ModelDownloadState, progress: Long): String = when (state.status) {
    ModelDownloadState.Idle -> "No active download"
    ModelDownloadState.Running -> "${progress}% · ${state.bytesDownloaded.toHumanBytesLabel()} / ${state.totalBytes.toHumanBytesLabel()}"
    ModelDownloadState.Paused -> "Paused at ${progress}% · ${state.bytesDownloaded.toHumanBytesLabel()}"
    ModelDownloadState.Success -> "Downloaded · ready to verify"
    ModelDownloadState.Failed -> "Failed · ${state.bytesDownloaded.toHumanBytesLabel()} saved"
    ModelDownloadState.Canceled -> "Canceled"
    else -> "Not downloaded"
}

private fun downloadStatusBadge(state: ModelDownloadState): String? = when (state.status) {
    ModelDownloadState.Running -> "Active"
    ModelDownloadState.Paused -> "Paused"
    ModelDownloadState.Success -> "Verify"
    ModelDownloadState.Failed -> "Retry"
    else -> null
}

private fun Long.toEtaLabel(): String = when {
    this < 0 -> "--"
    this < 60 -> "${this}s"
    this < 3600 -> "${this / 60}m ${this % 60}s"
    else -> "${this / 3600}h ${(this % 3600) / 60}m"
}

private fun Long.toSpeedLabel(): String = when {
    this >= 1024L * 1024L * 1024L -> "%.1f GB/s".format(this / (1024.0 * 1024.0 * 1024.0))
    this >= 1024L * 1024L -> "%.1f MB/s".format(this / (1024.0 * 1024.0))
    this >= 1024L -> "%.1f KB/s".format(this / 1024.0)
    else -> "$this B/s"
}

@Composable
private fun SpeechPromptOverrideDialog(tokens: UiTokens, initialPrompt: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var prompt by remember { mutableStateOf(initialPrompt) }
    ThemedAlertDialog(
        onDismissRequest = onDismiss,
        tokens = tokens,
        title = { Text("Enhancement Prompt") },
        text = {
            BasicTextField(
                value = prompt,
                onValueChange = { prompt = it.take(8_000) },
                textStyle = TextStyle(color = tokens.text, fontSize = captionSize(), fontFamily = FontFamily.Monospace),
                cursorBrush = SolidColor(tokens.accent),
                modifier = Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(12.dp)).background(tokens.surfaceHigh).padding(12.dp),
            )
        },
        confirmButton = { TextButton(onClick = { onSave(prompt) }) { Text("Save", color = tokens.accent) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = tokens.text) } },
    )
}

@Composable
private fun ShortcutFooterButton(label: String, background: Color, color: Color, modifier: Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Box(modifier.height(52.dp).semantics { contentDescription = label; if (!enabled) disabled() }.alpha(if (enabled) 1f else 0.55f).clip(RoundedCornerShape(18.dp)).background(background).clickable(enabled = enabled) { hapticClick(); onClick() }, contentAlignment = Alignment.Center) {
        Text(label, color = color, fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun RowScope.ShortcutChoice(label: String, selected: Boolean, tokens: UiTokens, onClick: () -> Unit) {
    Box(Modifier.weight(1f).height(44.dp).semantics { contentDescription = "$label modifier ${if (selected) "selected" else "not selected"}" }.clip(RoundedCornerShape(12.dp)).background(if (selected) tokens.accent.copy(alpha = 0.35f) else tokens.surfaceHigh).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) { Text(label, color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace) }
}

@Composable
private fun ShortcutKeyGrid(tokens: UiTokens, selectedKey: String, onSelected: (String) -> Unit) {
    val rows = listOf(listOf("Esc", "Tab", "Enter", "⌫"), listOf("↑", "↓", "←", "→"), listOf("Home", "End", "PgUp", "PgDn"))
    Column(Modifier.padding(horizontal = spacingLarge()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        rows.forEach { row -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) { row.forEach { key -> Box(Modifier.weight(1f).height(44.dp).semantics { contentDescription = "$key key ${if (key == selectedKey) "selected" else "not selected"}" }.clip(RoundedCornerShape(12.dp)).background(if (key == selectedKey) tokens.accent.copy(alpha = 0.35f) else tokens.surfaceHigh).clickable { hapticClick(); onSelected(key) }, contentAlignment = Alignment.Center) { Text(key, color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace) } } } }
        Box(Modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(12.dp)).background(tokens.surfaceHigh), contentAlignment = Alignment.Center) { Text("Custom Key / Text...", color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace) }
    }
}

@Composable
private fun ConnectionSettingsScreen(session: CoderSession?, sessionStore: CoderSessionStore, tokens: UiTokens, onDebugLogs: () -> Unit, onBack: () -> Unit) {
    var refreshInterval by remember { mutableStateOf(sessionStore.workspaceRefreshIntervalMillis()) }
    var hideInactive by remember { mutableStateOf(sessionStore.hideInactive()) }
    SettingsScaffold("Coder Connection", tokens, onBack) {
        SettingsSection("SAVED CONNECTIONS", tokens) {
            SettingsValueRow(R.drawable.ic_feather_server, session?.baseUrl?.let { connectionHostLabel(it) } ?: "No saved connection", session?.user?.username, "Coder", tokens) {}
        }
        SettingsSection("REFRESH", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_server, "Always Hide Inactive", hideInactive, tokens) {
                hideInactive = it
                sessionStore.saveHideInactive(it)
            }
            listOf(
                30_000L to "30s",
                60_000L to "60s",
                300_000L to "5min",
                900_000L to "15min",
            ).forEach { (value, label) ->
                SettingsValueRow(R.drawable.ic_feather_rotate_ccw, "Refresh every $label", null, if (refreshInterval == value) "✓" else null, tokens) {
                    refreshInterval = value
                    sessionStore.saveWorkspaceRefreshIntervalMillis(value)
                }
            }
        }
        SettingsSection("CURRENT", tokens) {
            SettingsValueRow(R.drawable.ic_feather_server, "Host", null, session?.baseUrl?.let { connectionHostLabel(it) } ?: "Not connected", tokens) {}
            SettingsValueRow(R.drawable.ic_feather_globe, "User", null, session?.user?.username ?: "Unknown", tokens) {}
        }
        SettingsSection("SECURITY", tokens) {
            SettingsValueRow(R.drawable.ic_feather_shield, "Token", "Stored in encrypted app storage", "Hidden", tokens) {}
        }
        SettingsSection("DIAGNOSTICS", tokens) {
            SettingsValueRow(R.drawable.ic_feather_terminal, "Debug Logs", "Sanitized connection and terminal events", "Open", tokens, chevron = true) { onDebugLogs() }
        }
        item { Text("Connection details live here instead of the home screen. Tokens are never displayed or copied into logs.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
    }
}

@Composable
private fun DebugLogsScreen(sessionStore: CoderSessionStore, tokens: UiTokens, onBack: () -> Unit) {
    var logs by remember { mutableStateOf(sessionStore.debugLogs()) }
    SettingsScaffold("Debug Logs", tokens, onBack) {
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Sanitized app diagnostics", color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.weight(1f))
                Text("Clear", color = tokens.accent, fontSize = bodySize(), modifier = Modifier.clickable { hapticClick(); sessionStore.clearDebugLogs(); logs = emptyList() })
            }
        }
        SettingsSection("EVENTS · ${logs.size}", tokens) {
            if (logs.isEmpty()) SettingsValueRow(R.drawable.ic_feather_terminal, "No events yet", "Connection diagnostics will appear here", null, tokens) {}
            logs.takeLast(80).asReversed().forEach { entry ->
                val timestamp = entry.substringBefore('|').toLongOrNull() ?: 0L
                val message = entry.substringAfter('|', entry)
                SettingsValueRow(R.drawable.ic_feather_terminal, message, relativeSessionTime(timestamp), null, tokens) {}
            }
        }
        item { Text("Logs are bounded and sanitized before storage. Tokens, secret query values, URLs, reconnect IDs, commands, and clipboard contents are not recorded.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
    }
}

@Composable
private fun FontSettingsPreview(tokens: UiTokens, fontSize: Int, uiFontFamily: FontFamily) {
    val previewSize = fontSize.coerceIn(10, 18).sp
    val previewLineHeight = (fontSize.coerceIn(10, 18) + 4).sp
    Column(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 10.dp).clip(RoundedCornerShape(20.dp)).background(tokens.surfaceHigh).padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Font Preview", color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), fontFamily = uiFontFamily)
            Text("${fontSize}pt", color = tokens.secondary, fontSize = captionSize(), fontFamily = uiFontFamily)
        }
        Spacer(Modifier.height(12.dp))
        Box(Modifier.fillMaxWidth().height(188.dp).clip(RoundedCornerShape(16.dp)).background(Color(0xff101014)).padding(horizontal = 13.dp, vertical = 12.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("coder in ~/android", color = Color(0xffa7f3d0), fontSize = previewSize, lineHeight = previewLineHeight, fontFamily = uiFontFamily, maxLines = 1)
                Text("› ./gradlew build", color = Color(0xffd8d8ea), fontSize = previewSize, lineHeight = previewLineHeight, fontFamily = uiFontFamily, maxLines = 1)
                Text("fun draw(g) = g != null && x <= y", color = Color(0xfff8f8f2), fontSize = previewSize, lineHeight = previewLineHeight, fontFamily = uiFontFamily, maxLines = 1)
                Text("Ligatures  ->  =>  !=  <=  >=  ===", color = Color(0xffffcc00), fontSize = previewSize, lineHeight = previewLineHeight, fontFamily = uiFontFamily, maxLines = 1)
                Text("Nerd Font      󰘧  󰌘  󰈸  󰊢", color = tokens.accent, fontSize = previewSize, lineHeight = previewLineHeight, fontFamily = uiFontFamily, maxLines = 1)
                Text("Emoji      😀  🧑🏽‍💻  👨‍👩‍👧‍👦  ⚡", color = Color(0xfffff1a8), fontSize = previewSize, lineHeight = previewLineHeight, fontFamily = uiFontFamily, maxLines = 1)
                Text("CJK/Arabic こんにちは 世界 مرحبا", color = Color(0xff93c5fd), fontSize = previewSize, lineHeight = previewLineHeight, fontFamily = uiFontFamily, maxLines = 1)
                Text("Bold weight 0123456789 AaBbCc", color = Color(0xfffda4af), fontSize = previewSize, lineHeight = previewLineHeight, fontFamily = uiFontFamily, fontWeight = FontWeight.Bold, maxLines = 1)
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(tokens.accent, tokens.success, Color(0xffffcc00), Color(0xffff5c7a), tokens.secondary).forEach { color -> Box(Modifier.size(22.dp).clip(CircleShape).background(color)) }
        }
    }
}

@Composable
private fun FontOptionRow(option: CoderFontOption, selectedFontKey: String, tokens: UiTokens, onSelected: () -> Unit) {
    SettingsValueRow(R.drawable.ic_feather_type, option.name, option.subtitle, if (selectedFontKey == option.key) "✓" else null, tokens, pro = option.pro, onClick = onSelected)
}

@Composable
private fun PlaceholderSettingsScreen(title: String, tokens: UiTokens, onBack: () -> Unit) {
    SettingsScaffold(title, tokens, onBack) { SettingsSection("PLACEHOLDER", tokens) { SettingsValueRow(R.drawable.ic_feather_circle, title, "Screen scaffolded for future native settings", null, tokens) {} } }
}

private fun uiTokens(theme: CoderTheme): UiTokens {
    val background = theme.background.toComposeColor()
    val foreground = theme.foreground.toComposeColor()
    val accent = theme.palette.getOrElse(4) { theme.cursor }.toComposeColor()
    val selection = theme.selectionBackground.toComposeColor()
    val light = background.luminance() > 0.55f
    val surface = blend(background, foreground, if (light) 0.045f else 0.09f)
    val surfaceHigh = blend(background, foreground, if (light) 0.075f else 0.12f)
    val separator = blend(background, foreground, if (light) 0.14f else 0.17f)
    val secondary = blend(background, foreground, if (light) 0.58f else 0.68f)
    return UiTokens(light, background, surface, surfaceHigh, separator, foreground, secondary, accent, selection, blend(background, accent, 0.18f), accent, blend(background, foreground, 0.25f))
}

fun contentColorFor(background: Color): Color = if (background.luminance() > 0.5f) Color(0xff111111) else Color.White

private fun blend(base: Color, overlay: Color, amount: Float): Color {
    val ratio = amount.coerceIn(0f, 1f)
    return Color(red = base.red + (overlay.red - base.red) * ratio, green = base.green + (overlay.green - base.green) * ratio, blue = base.blue + (overlay.blue - base.blue) * ratio, alpha = 1f)
}

fun spacingLarge(): Dp = 20.dp
fun thinStroke(): Dp = 0.7.dp
fun titleSize() = 21.sp
fun rowTitleSize() = 15.5.sp
fun bodySize() = 14.sp
fun valueSize() = 14.sp
fun captionSize() = 12.sp
private fun smallCaptionSize() = 10.5.sp
fun sectionSize() = 12.sp

private object HapticTarget {
    var view: android.view.View? = null
    var enabled: Boolean = true
}

fun hapticClick() {
    if (!HapticTarget.enabled) return
    HapticTarget.view?.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
}

private fun android.content.Context.findActivityView(): android.view.View? {
    return when (this) {
        is android.app.Activity -> window.decorView
        is android.content.ContextWrapper -> baseContext.findActivityView()
        else -> null
    }
}

private fun android.content.Context.findLifecycleOwner(): LifecycleOwner? {
    return when (this) {
        is LifecycleOwner -> this
        is android.content.ContextWrapper -> baseContext.findLifecycleOwner()
        else -> null
    }
}
