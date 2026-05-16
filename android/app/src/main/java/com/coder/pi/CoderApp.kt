package com.coder.pi

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.net.Uri
import android.content.Intent
import android.widget.Toast
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import io.ktor.client.plugins.ClientRequestException
import io.ktor.http.HttpStatusCode
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.focusable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import java.util.UUID
import kotlin.math.abs

enum class AppDestination { HOME, TERMINAL, SETTINGS }
enum class SettingsPage { ROOT, THEME, FONTS, TEXT, TOOLBAR, SHORTCUTS, SHORTCUT, KEYBOARD, GESTURES, SPEECH, CONNECTION, PLACEHOLDER }

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

@Composable
fun CoderApp(
    terminalView: CoderTerminalView,
    theme: CoderTheme,
    uiRevision: Int,
    onThemeChanged: () -> Unit,
    onFontChanged: () -> Unit,
    onShowKeyboard: () -> Unit,
    onHideKeyboard: () -> Unit,
) {
    var destination by remember { mutableStateOf(AppDestination.HOME) }
    var authState by remember { mutableStateOf<AuthState>(AuthState.Loading) }
    val terminalSessions = remember { mutableStateListOf<ManagedTerminalSession>() }
    var selectedTerminalId by remember { mutableStateOf<String?>(null) }
    var confirmCloseTerminalId by remember { mutableStateOf<String?>(null) }
    var hydratedSessionKey by remember { mutableStateOf<String?>(null) }
    val tokens = remember(theme) { uiTokens(theme) }
    val context = LocalContext.current
    val sessionStore = remember(context) { CoderSessionStore(context) }
    LaunchedEffect(Unit) {
        val saved = sessionStore.loadSession()
        if (saved == null) {
            authState = AuthState.LoggedOut
        } else {
            runCatching {
                val api = CoderApi(saved.first, saved.second)
                CoderSession(saved.first, saved.second, api.me())
            }.onSuccess { authState = AuthState.LoggedIn(it) }.onFailure {
                sessionStore.clearSession()
                authState = AuthState.LoggedOut
            }
        }
    }
    (authState as? AuthState.LoggedIn)?.session?.let { session ->
        val sessionKey = "${session.baseUrl}|${session.user.id}"
        LaunchedEffect(sessionKey, theme.name) {
            if (hydratedSessionKey == sessionKey || terminalSessions.isNotEmpty()) return@LaunchedEffect
            hydratedSessionKey = sessionKey
            sessionStore.activeTerminals(session.baseUrl, session.user.id).forEach { metadata ->
                val launch = TerminalLaunchRequest(session.baseUrl, session.token, metadata.agentId, metadata.reconnectId, metadata.command, metadata.workspaceName, metadata.agentName)
                val identity = TerminalIdentity(metadata.baseUrl, metadata.userId, metadata.workspaceId, metadata.agentId, metadata.command)
                val id = terminalSessionKey(identity)
                if (terminalSessions.any { it.id == id }) return@forEach
                val nextTerminalView = CoderTerminalView(context).also {
                    it.setFontFamily(CoderFonts.selectedKey(context))
                    it.applyTheme(theme)
                }
                val managed = ManagedTerminalSession(id, launch, identity, TerminalSheetState(launch.title, launch.badge, TerminalConnectionStatus.Reconnecting.wireName), nextTerminalView, null, metadata.preview.lines().filter { it.isNotBlank() }.takeLast(5), metadata.updatedAtMillis)
                terminalSessions.add(managed)
                val terminalSession = CoderTerminalSession(CoderApi(launch.baseUrl, launch.token), nextTerminalView, launch.agentId, launch.reconnectId, launch.command) { status ->
                    val index = terminalSessions.indexOfFirst { it.id == id }
                    if (index >= 0) terminalSessions[index] = terminalSessions[index].copy(sheet = terminalSessions[index].sheet.copy(status = status))
                }
                val index = terminalSessions.indexOfFirst { it.id == id }
                if (index >= 0) terminalSessions[index] = terminalSessions[index].copy(session = terminalSession)
                terminalSession.start()
            }
        }
    }
    HapticTarget.view = LocalContext.current.findActivityView()
    HapticTarget.enabled = remember(context) { context.getSharedPreferences("app", Context.MODE_PRIVATE).getBoolean("haptic_feedback", true) }
    MaterialTheme {
        Box(Modifier.fillMaxSize().background(tokens.background)) {
            when (destination) {
                AppDestination.HOME -> when (val state = authState) {
                    AuthState.Loading -> LoadingScreen(tokens)
                    AuthState.LoggedOut -> LoginScreen(tokens) { baseUrl ->
                        authState = AuthState.TokenInput(baseUrl)
                        CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(baseUrl.trimEnd('/') + "/cli-auth"))
                    }
                    is AuthState.TokenInput -> TokenScreen(tokens, state.baseUrl, { baseUrl ->
                        CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(baseUrl.trimEnd('/') + "/cli-auth"))
                    }) { baseUrl, token ->
                        val api = CoderApi(baseUrl, token)
                        runCatching { api.me() }.onSuccess { user ->
                            sessionStore.saveSession(baseUrl, token)
                            authState = AuthState.LoggedIn(CoderSession(baseUrl, token, user))
                        }
                    }
                    is AuthState.LoggedIn -> CoderHomeScreen(
                        session = state.session,
                        terminalView = terminalView,
                        theme = theme,
                        tokens = tokens,
                        sessionStore = sessionStore,
                        onSessionExpired = {
                        sessionStore.clearSession()
                        sessionStore.clearActiveTerminals(state.session.baseUrl, state.session.user.id)
                        terminalSessions.forEach { it.session?.stop() }
                            terminalSessions.clear()
                            selectedTerminalId = null
                            authState = AuthState.LoggedOut
                            destination = AppDestination.HOME
                        },
                        onOpenSettings = { destination = AppDestination.SETTINGS; onHideKeyboard() },
                        activeTerminals = terminalSessions,
                        onResumeTerminal = {
                            val now = System.currentTimeMillis()
                            val index = terminalSessions.indexOfFirst { session -> session.id == it.id }
                            if (index >= 0) terminalSessions[index] = terminalSessions[index].copy(updatedAtMillis = now)
                            sessionStore.saveActiveTerminal(CoderActiveTerminalMetadata(it.identity.baseUrl, it.identity.userId, it.identity.workspaceId, it.launch.title, it.identity.agentId, it.launch.badge, it.identity.command, it.launch.reconnectId, now, it.previewLines.joinToString("\n")))
                            selectedTerminalId = it.id
                            onShowKeyboard()
                        },
                        onCloseTerminal = {
                            confirmCloseTerminalId = it.id
                        },
                        onOpenTerminal = { workspace, agent, command ->
                            val reconnect = sessionStore.reconnectToken(state.session.baseUrl, state.session.user.id, workspace.id, agent.id)
                            val launch = TerminalLaunchRequest(state.session.baseUrl, state.session.token, agent.id, reconnect.id, command, workspace.name, agent.name)
                            val identity = TerminalIdentity(state.session.baseUrl, state.session.user.id, workspace.id, agent.id, command)
                            val id = terminalSessionKey(identity)
                            terminalSessions.firstOrNull { it.id == id }?.let {
                                selectedTerminalId = it.id
                                onShowKeyboard()
                                return@CoderHomeScreen
                            }
                            if (terminalSessions.size >= MaxActiveTerminalSessions) {
                                Toast.makeText(context, "Close an active session before opening another terminal. Limit is $MaxActiveTerminalSessions.", Toast.LENGTH_SHORT).show()
                                return@CoderHomeScreen
                            }
                            val nextTerminalView = CoderTerminalView(context).also {
                                it.setFontFamily(CoderFonts.selectedKey(context))
                                it.applyTheme(theme)
                            }
                            sessionStore.saveActiveTerminal(CoderActiveTerminalMetadata(state.session.baseUrl, state.session.user.id, workspace.id, workspace.name, agent.id, agent.name, command, reconnect.id, System.currentTimeMillis()))
                            val managed = ManagedTerminalSession(id, launch, identity, TerminalSheetState(launch.title, launch.badge, TerminalConnectionStatus.Connecting.wireName), nextTerminalView, null, emptyList(), System.currentTimeMillis())
                            terminalSessions.add(managed)
                            val terminalSession = CoderTerminalSession(CoderApi(launch.baseUrl, launch.token), nextTerminalView, launch.agentId, launch.reconnectId, launch.command) { status ->
                                val index = terminalSessions.indexOfFirst { it.id == id }
                                if (index >= 0) terminalSessions[index] = terminalSessions[index].copy(sheet = terminalSessions[index].sheet.copy(status = status))
                            }
                            val index = terminalSessions.indexOfFirst { it.id == id }
                            if (index >= 0) terminalSessions[index] = terminalSessions[index].copy(session = terminalSession)
                            terminalSession.start()
                            selectedTerminalId = id
                            onShowKeyboard()
                        },
                    )
                }
                AppDestination.TERMINAL -> TerminalPane(terminalView, theme, onShowKeyboard, onHideKeyboard)
                AppDestination.SETTINGS -> SettingsNavigator((authState as? AuthState.LoggedIn)?.session, terminalView, theme, tokens, uiRevision, onThemeChanged, { key ->
                    terminalView.setFontFamily(key)
                    terminalSessions.forEach { it.terminalView.setFontFamily(key) }
                    onFontChanged()
                }, onFontChanged) { destination = AppDestination.HOME }
            }
            terminalSessions.firstOrNull { it.id == selectedTerminalId }?.let { managed ->
                val selectedIndex = terminalSessions.indexOfFirst { it.id == managed.id }.coerceAtLeast(0)
                CoderTerminalBottomSheet(
                    terminalView = managed.terminalView,
                    theme = theme,
                    tokens = tokens,
                    title = managed.sheet.title,
                    badge = managed.sheet.badge,
                    sessionLabel = tmuxSessionLabel(managed.identity.command),
                    status = managed.sheet.status,
                    sessionCount = terminalSessions.size,
                    selectedSessionIndex = selectedIndex,
                    onSelectSession = { index -> terminalSessions.getOrNull(index)?.let {
                        val now = System.currentTimeMillis()
                        terminalSessions[index] = it.copy(updatedAtMillis = now)
                        sessionStore.saveActiveTerminal(CoderActiveTerminalMetadata(it.identity.baseUrl, it.identity.userId, it.identity.workspaceId, it.launch.title, it.identity.agentId, it.launch.badge, it.identity.command, it.launch.reconnectId, now, it.previewLines.joinToString("\n")))
                        selectedTerminalId = it.id
                    } },
                    onRetry = {
                        val launch = managed.launch
                        managed.session?.stop()
                        sessionStore.saveActiveTerminal(CoderActiveTerminalMetadata(managed.identity.baseUrl, managed.identity.userId, managed.identity.workspaceId, launch.title, managed.identity.agentId, launch.badge, managed.identity.command, launch.reconnectId, System.currentTimeMillis()))
                        val index = terminalSessions.indexOfFirst { it.id == managed.id }
                        if (index >= 0) terminalSessions[index] = terminalSessions[index].copy(sheet = TerminalSheetState(launch.title, launch.badge, TerminalConnectionStatus.Reconnecting.wireName))
                        val terminalSession = CoderTerminalSession(CoderApi(launch.baseUrl, launch.token), managed.terminalView, launch.agentId, launch.reconnectId, launch.command) { status ->
                            val statusIndex = terminalSessions.indexOfFirst { it.id == managed.id }
                            if (statusIndex >= 0) terminalSessions[statusIndex] = terminalSessions[statusIndex].copy(sheet = terminalSessions[statusIndex].sheet.copy(status = status))
                        }
                        if (index >= 0) terminalSessions[index] = terminalSessions[index].copy(session = terminalSession)
                        terminalSession.start()
                    },
                    onDismiss = {
                        onHideKeyboard()
                        selectedTerminalId = null
                    },
                    onShowKeyboard = onShowKeyboard,
                    onHideKeyboard = onHideKeyboard,
                )
            }
            confirmCloseTerminalId?.let { terminalId ->
                ConfirmCloseTerminalDialog(
                    tokens = tokens,
                    onDismiss = { confirmCloseTerminalId = null },
                    onConfirm = {
                        confirmCloseTerminalId = null
                        val managed = terminalSessions.firstOrNull { it.id == terminalId }
                        managed?.session?.stop()
                        managed?.let { sessionStore.removeActiveTerminal(it.identity.baseUrl, it.identity.userId, it.identity.workspaceId, it.identity.agentId, it.identity.command) }
                        terminalSessions.removeAll { it.id == terminalId }
                        if (selectedTerminalId == terminalId) selectedTerminalId = null
                        onHideKeyboard()
                    },
                )
            }
        }
    }
}

private data class TerminalSheetState(val title: String, val badge: String, val status: String)

data class TerminalLaunchRequest(val baseUrl: String, val token: String, val agentId: String, val reconnectId: String, val command: String, val title: String, val badge: String)

data class TerminalIdentity(val baseUrl: String, val userId: String, val workspaceId: String, val agentId: String, val command: String)

private data class ManagedTerminalSession(val id: String, val launch: TerminalLaunchRequest, val identity: TerminalIdentity, val sheet: TerminalSheetState, val terminalView: CoderTerminalView, val session: CoderTerminalSession?, val previewLines: List<String>, val updatedAtMillis: Long)

private const val MaxActiveTerminalSessions = 10

@Composable
private fun ConfirmCloseTerminalDialog(tokens: UiTokens, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = tokens.surfaceHigh,
        titleContentColor = tokens.text,
        textContentColor = tokens.secondary,
        title = { Text("Close terminal?") },
        text = { Text("This stops the active Coder terminal connection. Minimize keeps it running in the background.") },
        confirmButton = { TextButton(onClick = { hapticClick(); onConfirm() }) { Text("Close", color = Color(0xffff5c7a)) } },
        dismissButton = { TextButton(onClick = { hapticClick(); onDismiss() }) { Text("Cancel", color = tokens.accent) } },
    )
}

@Composable
private fun ReplaceTerminalSheet(launch: TerminalLaunchRequest, tokens: UiTokens, onKeepCurrent: () -> Unit, onReplace: () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        SheetScrim(onKeepCurrent)
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().alignBottomSheet(tokens).padding(20.dp)) {
            SheetHandle(tokens)
            Text("Active terminal running", color = tokens.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Text("Opening ${launch.title} will close current connection. Keep current terminal minimized, or replace it.", color = tokens.secondary, fontSize = bodySize(), lineHeight = 20.sp)
            Spacer(Modifier.height(18.dp))
            CoderPrimaryButton("Keep current", tokens, onKeepCurrent)
            Spacer(Modifier.height(10.dp))
            CoderSecondaryButton("Replace terminal", tokens, onReplace)
        }
    }
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
private fun CoderHomeScreen(session: CoderSession, terminalView: CoderTerminalView, theme: CoderTheme, tokens: UiTokens, sessionStore: CoderSessionStore, activeTerminals: List<ManagedTerminalSession>, onResumeTerminal: (ManagedTerminalSession) -> Unit, onCloseTerminal: (ManagedTerminalSession) -> Unit, onSessionExpired: () -> Unit, onOpenSettings: () -> Unit, onOpenTerminal: (CoderWorkspace, CoderWorkspaceAgent, String) -> Unit) {
    val scope = rememberCoroutineScope()
    val api = remember(session) { CoderApi(session.baseUrl, session.token) }
    val context = LocalContext.current
    var workspaces by remember { mutableStateOf<List<CoderWorkspace>>(emptyList()) }
    var loadingWorkspaces by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var hideInactive by remember { mutableStateOf(sessionStore.hideInactive()) }
    var inactiveCollapsed by remember { mutableStateOf(hideInactive) }
    var selectedWorkspace by remember { mutableStateOf<CoderWorkspace?>(null) }
    var selectedAgentPicker by remember { mutableStateOf<CoderWorkspace?>(null) }
    var tmuxLoading by remember { mutableStateOf<CoderWorkspaceAgent?>(null) }
    var tmuxPicker by remember { mutableStateOf<Triple<CoderWorkspace, CoderWorkspaceAgent, List<TmuxSession>>?>(null) }
    val metrics = rememberCoderUiMetrics()
    val iconPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val workspace = selectedWorkspace ?: return@rememberLauncherForActivityResult
        uri?.let {
            context.contentResolver.takePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            sessionStore.saveIcon(session.baseUrl, session.user.id, workspace.id, it.toString())
        }
    }
    fun refresh() {
        scope.launch {
            loadingWorkspaces = true
            runCatching { api.workspaces() }
                .onSuccess { workspaces = it; error = null }
                .onFailure { failure -> if (failure.isUnauthorized()) onSessionExpired() else error = safeUserError(failure, "Could not load workspaces") }
            loadingWorkspaces = false
        }
    }
    LaunchedEffect(session) { refresh() }
    val sorted = workspaces.sortedWith(compareByDescending<CoderWorkspace> {
        val local = sessionStore.workspaceState(session.baseUrl, session.user.id, it.id)
        it.favorite || local.pinned
    }.thenBy { it.name })
    val running = sorted.filter { it.running }
    val inactive = sorted.filterNot { it.running }
    Box(Modifier.fillMaxSize().background(tokens.background).statusBarsPadding()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = WindowInsets.navigationBars.asPaddingValues()) {
            item { CoderHeaderActions("Workspaces", tokens, metrics, { refresh() }, onOpenSettings) }
            item { ActiveCoderSessionSection(activeTerminals, sessionStore, tokens, metrics, onResumeTerminal, onCloseTerminal) }
            if (error != null) item { Text(error ?: "", color = tokens.accent, modifier = Modifier.padding(horizontal = spacingLarge())) }
            if (loadingWorkspaces && workspaces.isEmpty()) item { WorkspaceLoadingSection(tokens, metrics) }
            WorkspaceSection("RUNNING WORKSPACES", running, session, sessionStore, api, tokens, metrics, onSessionExpired, { failure -> error = safeUserError(failure, "Workspace action failed") }, { selectedWorkspace = it }, { workspace -> openWorkspace(scope, api, workspace, onOpenTerminal, { selectedAgentPicker = it }, { tmuxLoading = it }, { tmuxLoading = null; tmuxPicker = it }) }, { refresh() })
            item { CoderSectionHeader("STOPPED WORKSPACES", if (inactiveCollapsed) "show" else "hide", tokens, metrics) { inactiveCollapsed = !inactiveCollapsed } }
            if (!inactiveCollapsed) WorkspaceRows(inactive, session, sessionStore, api, tokens, metrics, onSessionExpired, { failure -> error = safeUserError(failure, "Workspace action failed") }, { selectedWorkspace = it }, { workspace -> openWorkspace(scope, api, workspace, onOpenTerminal, { selectedAgentPicker = it }, { tmuxLoading = it }, { tmuxLoading = null; tmuxPicker = it }) }, { refresh() })
            item {
                Row(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Always hide inactive", color = tokens.text, fontSize = bodySize(), modifier = Modifier.weight(1f))
                    Switch(checked = hideInactive, onCheckedChange = { hideInactive = it; inactiveCollapsed = it; sessionStore.saveHideInactive(it) }, colors = SwitchDefaults.colors(checkedThumbColor = tokens.accent))
                }
            }
        }
        selectedWorkspace?.let { workspace -> WorkspaceEditSheet(workspace, session, sessionStore, tokens, { selectedWorkspace = null }, { iconPicker.launch(arrayOf("image/png", "image/jpeg", "image/webp", "image/*")) }) }
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

private fun LazyListScope.WorkspaceSection(title: String, workspaces: List<CoderWorkspace>, session: CoderSession, sessionStore: CoderSessionStore, api: CoderApi, tokens: UiTokens, metrics: CoderUiMetrics, onSessionExpired: () -> Unit, onActionError: (Throwable) -> Unit, onEdit: (CoderWorkspace) -> Unit, onOpen: (CoderWorkspace) -> Unit, refresh: () -> Unit) {
    item { CoderSectionHeader(title, null, tokens, metrics) }
    WorkspaceRows(workspaces, session, sessionStore, api, tokens, metrics, onSessionExpired, onActionError, onEdit, onOpen, refresh)
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
private fun ActiveCoderSessionSection(activeTerminals: List<ManagedTerminalSession>, sessionStore: CoderSessionStore, tokens: UiTokens, metrics: CoderUiMetrics, onResumeTerminal: (ManagedTerminalSession) -> Unit, onCloseTerminal: (ManagedTerminalSession) -> Unit) {
    Column {
        Row(Modifier.fillMaxWidth().padding(start = spacingLarge(), end = spacingLarge(), top = 18.dp, bottom = 7.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("ACTIVE SESSIONS", color = tokens.secondary, fontSize = metrics.sectionSize, letterSpacing = 0.6.sp, modifier = Modifier.weight(1f))
            Text(if (activeTerminals.any { it.terminalView.gestureEnabled("hold_to_close") }) "${activeTerminals.size}/$MaxActiveTerminalSessions · hold to close" else "${activeTerminals.size}/$MaxActiveTerminalSessions", color = tokens.secondary, fontSize = metrics.captionSize, fontFamily = FontFamily.Monospace)
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
                ActiveCoderSessionCard(managed, sessionStore, tokens, metrics, { onResumeTerminal(managed) }, { onCloseTerminal(managed) })
            }
        }
    }
}

@Composable
private fun connectionHostLabel(baseUrl: String): String = runCatching { Uri.parse(baseUrl).host ?: baseUrl.removePrefix("https://").removePrefix("http://") }.getOrDefault(baseUrl)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ActiveCoderSessionCard(managed: ManagedTerminalSession, sessionStore: CoderSessionStore, tokens: UiTokens, metrics: CoderUiMetrics, onResume: () -> Unit, onClose: () -> Unit) {
    val session = managed.sheet
    val holdToClose = managed.terminalView.gestureEnabled("hold_to_close")
    var previewLines by remember { mutableStateOf(managed.previewLines) }
    var updatedAtMillis by remember { mutableStateOf(managed.updatedAtMillis) }
    var relativeTime by remember { mutableStateOf(relativeSessionTime(updatedAtMillis)) }
    LaunchedEffect(managed.updatedAtMillis) {
        updatedAtMillis = managed.updatedAtMillis
        relativeTime = relativeSessionTime(updatedAtMillis)
    }
    LaunchedEffect(session.status) {
        while (true) {
            val lines = managed.terminalView.snapshotText().filter { it.isNotBlank() }.takeLast(5)
            if (lines.isNotEmpty()) {
                updatedAtMillis = System.currentTimeMillis()
                relativeTime = relativeSessionTime(updatedAtMillis)
                previewLines = lines
                val launch = managed.launch
                sessionStore.saveActiveTerminal(CoderActiveTerminalMetadata(managed.identity.baseUrl, managed.identity.userId, managed.identity.workspaceId, launch.title, managed.identity.agentId, launch.badge, managed.identity.command, launch.reconnectId, updatedAtMillis, lines.joinToString("\n")))
            } else {
                relativeTime = relativeSessionTime(updatedAtMillis)
            }
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
                Text(tmuxLabel, color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.TopEnd).padding(top = 8.dp, end = 7.dp).clip(RoundedCornerShape(8.dp)).background(if (terminalStatusFromWireName(session.status) == TerminalConnectionStatus.Connected) tokens.accent else Color(0xffff9f43)).padding(horizontal = 8.dp, vertical = 3.dp))
            }
            Column(Modifier.align(Alignment.TopStart).padding(start = 8.dp, top = 25.dp, end = 8.dp)) {
                val lines = previewLines.ifEmpty { listOf("› ${session.status}") }
                lines.forEach { line -> Text(line, color = Color(0xffd8d8ea), fontSize = 9.sp, lineHeight = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(session.title, color = tokens.text, fontSize = metrics.bodySize, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(if (terminalStatusIsRecoverable(session.status)) session.status else relativeTime, color = if (terminalStatusIsRecoverable(session.status)) Color(0xffff9f43) else tokens.secondary, fontSize = smallCaptionSize(), maxLines = 1)
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

private fun LazyListScope.WorkspaceRows(workspaces: List<CoderWorkspace>, session: CoderSession, sessionStore: CoderSessionStore, api: CoderApi, tokens: UiTokens, metrics: CoderUiMetrics, onSessionExpired: () -> Unit, onActionError: (Throwable) -> Unit, onEdit: (CoderWorkspace) -> Unit, onOpen: (CoderWorkspace) -> Unit, refresh: () -> Unit) {
    items(workspaces.size) { index -> WorkspaceRow(workspaces[index], session, sessionStore, api, tokens, metrics, onSessionExpired, onActionError, onEdit, onOpen, refresh) }
}

@Composable
private fun WorkspaceRow(workspace: CoderWorkspace, session: CoderSession, sessionStore: CoderSessionStore, api: CoderApi, tokens: UiTokens, metrics: CoderUiMetrics, onSessionExpired: () -> Unit, onActionError: (Throwable) -> Unit, onEdit: (CoderWorkspace) -> Unit, onOpen: (CoderWorkspace) -> Unit, refresh: () -> Unit) {
    val scope = rememberCoroutineScope()
    val local = sessionStore.workspaceState(session.baseUrl, session.user.id, workspace.id)
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

@Composable
private fun WorkspaceEditSheet(workspace: CoderWorkspace, session: CoderSession, sessionStore: CoderSessionStore, tokens: UiTokens, onDismiss: () -> Unit, onPickIcon: () -> Unit) {
    var alias by remember { mutableStateOf(sessionStore.workspaceState(session.baseUrl, session.user.id, workspace.id).alias.orEmpty()) }
    Box(Modifier.fillMaxSize()) {
        SheetScrim(onDismiss)
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().alignBottomSheet(tokens).padding(20.dp)) {
            SheetHandle(tokens)
            Text(workspace.name, color = tokens.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(14.dp))
            CoderTextField(alias, { alias = it }, "Local alias", tokens)
            Spacer(Modifier.height(12.dp))
            CoderSecondaryButton("Choose icon", tokens, onPickIcon)
            Spacer(Modifier.height(12.dp))
            CoderPrimaryButton("Save", tokens) { sessionStore.saveAlias(session.baseUrl, session.user.id, workspace.id, alias); onDismiss() }
        }
    }
}

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
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().alignBottomSheet(tokens).padding(20.dp)) {
            SheetHandle(tokens)
            Text("Tmux sessions on ${agent.name}", color = tokens.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            sessions.forEach { HostSheetRow(it.name, "${it.windows} windows", tokens) { onTmux(it) } }
            HostSheetRow("New shell", "No tmux attach", tokens) { onDismiss() }
        }
    }
}

@Composable
private fun CoderTmuxSheet(agent: CoderWorkspaceAgent, sessions: List<TmuxSession>, tokens: UiTokens, metrics: CoderUiMetrics, onDismiss: () -> Unit, onNewShell: () -> Unit, onTmux: (TmuxSession) -> Unit) {
    Box(Modifier.fillMaxSize()) {
        SheetScrim(onDismiss)
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.44f).alignBottomSheet(tokens).padding(metrics.sheetPadding)) {
            CoderSheetHandle(tokens, metrics)
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
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(metrics.rowCorner)).background(tokens.surface)) {
                sessions.forEach { session -> HostSheetRow(session.name, "${session.windows} windows", tokens) { onTmux(session) } }
            }
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
    Box(Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(14.dp)).background(tokens.accent).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) { Text(label, color = tokens.background, fontSize = bodySize(), fontWeight = FontWeight.Bold) }
}

@Composable
private fun CoderSecondaryButton(label: String, tokens: UiTokens, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().height(48.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surface).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) { Text(label, color = tokens.text, fontSize = bodySize()) }
}

private fun normalizeBaseUrl(value: String) = value.trim().trimEnd('/').let { if (it.startsWith("http://") || it.startsWith("https://")) it else "https://$it" }

private fun defaultShellCommand() = "sh -lc 'exec ${'$'}{SHELL:-/bin/sh}'"

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
private fun TerminalPane(
    terminalView: CoderTerminalView,
    theme: CoderTheme,
    onShowKeyboard: () -> Unit,
    onHideKeyboard: () -> Unit,
) {
    var selection by remember { mutableStateOf<TerminalSelectionRange?>(null) }
    val context = LocalContext.current
    Column(Modifier.fillMaxSize().background(theme.background.toComposeColor()).imePadding()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AndroidView(
                factory = { terminalView },
                modifier = Modifier.fillMaxSize(),
                update = { it.applyTheme(theme) },
            )
            TerminalPinchFontOverlay(terminalView)
            TerminalSelectionOverlay(terminalView, theme, terminalView.gestureEnabled("long_press_selection"), selection, { selection = it }) {
                val selectedText = selection?.let { terminalView.selectedText(it.start, it.end) }.orEmpty()
                if (selectedText.isNotBlank()) {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("Terminal selection", selectedText))
                    selection = null
                }
            }
        }
        TerminalAccessory(theme, terminalView, selection != null, {
            val selectedText = selection?.let { terminalView.selectedText(it.start, it.end) }.orEmpty()
            if (selectedText.isNotBlank()) {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("Terminal selection", selectedText))
                selection = null
            }
        }, { selection = null }, onShowKeyboard, onHideKeyboard)
    }
}

@Composable
private fun TerminalSelectionOverlay(terminalView: CoderTerminalView, theme: CoderTheme, enabled: Boolean, selection: TerminalSelectionRange?, onSelectionChange: (TerminalSelectionRange?) -> Unit, onCopy: () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        Canvas(
            Modifier
                .fillMaxSize()
                .pointerInput(terminalView, enabled) {
                    if (!enabled) return@pointerInput
                    var dragStart: TerminalCellPosition? = null
                    detectDragGesturesAfterLongPress(
                        onDragStart = { offset ->
                            val position = terminalView.cellAt(offset.x, offset.y)
                            dragStart = position
                            onSelectionChange(terminalView.wordRangeAt(position))
                            hapticClick()
                        },
                        onDrag = { change, _ ->
                            val start = dragStart ?: terminalView.cellAt(change.position.x, change.position.y)
                            onSelectionChange(TerminalSelectionRange(start, terminalView.cellAt(change.position.x, change.position.y)))
                            change.consume()
                        },
                        onDragCancel = { dragStart = null },
                        onDragEnd = { dragStart = null },
                    )
                },
        ) {
            val range = selection?.normalized() ?: return@Canvas
            val columns = terminalView.terminalColumns().coerceAtLeast(1)
            val rows = terminalView.terminalRows().coerceAtLeast(1)
            val cellWidth = size.width / columns
            val cellHeight = size.height / rows
            for (row in range.start.row..range.end.row) {
                val startCol = if (row == range.start.row) range.start.col else 0
                val endCol = if (row == range.end.row) range.end.col else columns - 1
                drawRect(
                    color = theme.selectionBackground.toComposeColor().copy(alpha = 0.55f),
                    topLeft = Offset(startCol * cellWidth, row * cellHeight),
                    size = Size((endCol - startCol + 1) * cellWidth, cellHeight),
                )
            }
        }
        if (selection != null) {
            Row(Modifier.align(Alignment.TopEnd).padding(12.dp).clip(RoundedCornerShape(18.dp)).background(theme.background.toComposeColor().copy(alpha = 0.92f)).padding(6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("COPY", color = theme.foreground.toComposeColor(), fontSize = captionSize(), fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(theme.selectionBackground.toComposeColor()).clickable { onCopy() }.padding(horizontal = 14.dp, vertical = 8.dp))
                Text("CLEAR", color = theme.foreground.toComposeColor(), fontSize = captionSize(), fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable { onSelectionChange(null) }.padding(horizontal = 14.dp, vertical = 8.dp))
            }
        }
    }
}

@Composable
private fun TerminalPinchFontOverlay(terminalView: CoderTerminalView) {
    Box(
        Modifier
            .fillMaxSize()
            .pointerInput(terminalView, terminalView.gestureEnabled("pinch_font_size")) {
                if (!terminalView.gestureEnabled("pinch_font_size")) return@pointerInput
                var accumulatedZoom = 1f
                detectTransformGestures { _, _, zoom, _ ->
                    accumulatedZoom *= zoom
                    when {
                        accumulatedZoom >= 1.12f -> {
                            terminalView.adjustFontSize(1)
                            accumulatedZoom = 1f
                            hapticClick()
                        }
                        accumulatedZoom <= 0.88f -> {
                            terminalView.adjustFontSize(-1)
                            accumulatedZoom = 1f
                            hapticClick()
                        }
                    }
                }
            }
    )
}

@Composable
private fun CoderTerminalBottomSheet(
    terminalView: CoderTerminalView,
    theme: CoderTheme,
    tokens: UiTokens,
    title: String,
    badge: String,
    sessionLabel: String?,
    status: String,
    sessionCount: Int,
    selectedSessionIndex: Int,
    onSelectSession: (Int) -> Unit,
    onRetry: () -> Unit,
    onDismiss: () -> Unit,
    onShowKeyboard: () -> Unit,
    onHideKeyboard: () -> Unit,
) {
    BackHandler { onDismiss() }
    var expanded by remember { mutableStateOf(false) }
    var selection by remember { mutableStateOf<TerminalSelectionRange?>(null) }
    val swipeSessionSwitch = terminalView.gestureEnabled("swipe_session_switch")
    val context = LocalContext.current
    val sessionSwipeModifier = if (swipeSessionSwitch) Modifier.pointerInput(sessionCount, selectedSessionIndex) { detectManagedSessionSwipe(sessionCount, selectedSessionIndex, onSelectSession) } else Modifier
    Box(Modifier.fillMaxSize()) {
        SheetScrim(onDismiss)
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .fillMaxHeight(if (expanded) 1f else 0.92f)
                .alignBottomSheet(tokens, expanded)
                .pointerInput(sessionCount, selectedSessionIndex, swipeSessionSwitch) { if (swipeSessionSwitch) detectManagedSessionSwipe(sessionCount, selectedSessionIndex, onSelectSession) }
                .imePadding(),
        ) {
            SheetHandle(tokens)
            Row(Modifier.fillMaxWidth().height(38.dp).then(sessionSwipeModifier).padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(18.dp).clip(CircleShape).background(Color(0xffffcc00)))
                Spacer(Modifier.width(8.dp))
                Box(Modifier.size(18.dp).clip(CircleShape).background(tokens.accent))
                Spacer(Modifier.width(14.dp))
                Text(title, color = tokens.secondary, fontSize = captionSize(), fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                if (sessionLabel != null) {
                    Text(sessionLabel, color = tokens.accent, fontSize = smallCaptionSize(), modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(tokens.surface).padding(horizontal = 10.dp, vertical = 4.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(status, color = if (terminalStatusFromWireName(status) == TerminalConnectionStatus.Connected) tokens.success else tokens.secondary, fontSize = smallCaptionSize(), modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(tokens.surface).padding(horizontal = 8.dp, vertical = 4.dp))
                Spacer(Modifier.width(10.dp))
                Text(if (expanded) "⌄" else "⌃", color = tokens.secondary, fontSize = 22.sp, modifier = Modifier.clip(CircleShape).clickable { hapticClick(); expanded = !expanded }.padding(horizontal = 10.dp, vertical = 2.dp))
            }
            if (sessionCount > 1) SessionPageDots(sessionCount, selectedSessionIndex, tokens, sessionSwipeModifier)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                AndroidView(factory = { terminalView }, modifier = Modifier.fillMaxSize(), update = { it.applyTheme(theme) })
                TerminalPinchFontOverlay(terminalView)
                if (terminalStatusIsRecoverable(status)) {
                    Column(Modifier.align(Alignment.Center).clip(RoundedCornerShape(18.dp)).background(tokens.background.copy(alpha = 0.92f)).padding(18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(if (terminalStatusFromWireName(status) == TerminalConnectionStatus.Failed) "Terminal failed" else "Terminal disconnected", color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(10.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text("Retry", color = tokens.background, fontSize = captionSize(), fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(tokens.accent).clickable { hapticClick(); onRetry() }.padding(horizontal = 14.dp, vertical = 8.dp))
                            Text("Close", color = tokens.text, fontSize = captionSize(), fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(tokens.surface).clickable { hapticClick(); onDismiss() }.padding(horizontal = 14.dp, vertical = 8.dp))
                        }
                    }
                }
                TerminalSelectionOverlay(terminalView, theme, terminalView.gestureEnabled("long_press_selection"), selection, { selection = it }) {
                    val selectedText = selection?.let { terminalView.selectedText(it.start, it.end) }.orEmpty()
                    if (selectedText.isNotBlank()) {
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText("Terminal selection", selectedText))
                        selection = null
                    }
                }
            }
            TerminalAccessory(theme, terminalView, selection != null, {
                val selectedText = selection?.let { terminalView.selectedText(it.start, it.end) }.orEmpty()
                if (selectedText.isNotBlank()) {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("Terminal selection", selectedText))
                    selection = null
                }
            }, { selection = null }, onShowKeyboard, onHideKeyboard)
        }
    }
}

private suspend fun PointerInputScope.detectManagedSessionSwipe(sessionCount: Int, selectedSessionIndex: Int, onSelectSession: (Int) -> Unit) {
    if (sessionCount <= 1) return
    var totalDrag = 0f
    var switched = false
    detectHorizontalDragGestures(
        onDragStart = { totalDrag = 0f; switched = false },
        onHorizontalDrag = { change, dragAmount ->
            totalDrag += dragAmount
            if (switched || abs(totalDrag) < 72f) return@detectHorizontalDragGestures
            change.consume()
            val nextIndex = when {
                totalDrag < 0f -> (selectedSessionIndex + 1).coerceAtMost(sessionCount - 1)
                else -> (selectedSessionIndex - 1).coerceAtLeast(0)
            }
            if (nextIndex != selectedSessionIndex) {
                switched = true
                hapticClick()
                onSelectSession(nextIndex)
            }
        }
    )
}

@Composable
private fun SessionPageDots(count: Int, selectedIndex: Int, tokens: UiTokens, modifier: Modifier = Modifier) {
    Row(Modifier.fillMaxWidth().height(18.dp).then(modifier), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        repeat(count) { index ->
            Box(Modifier.padding(horizontal = 3.dp).size(if (index == selectedIndex) 7.dp else 5.dp).clip(CircleShape).background(if (index == selectedIndex) tokens.accent else tokens.separator))
        }
    }
}

@Composable
private fun TerminalAccessory(theme: CoderTheme, terminalView: CoderTerminalView, selectionActive: Boolean, onCopySelection: () -> Unit, onClearSelection: () -> Unit, onShowKeyboard: () -> Unit, onHideKeyboard: () -> Unit) {
    var chatMode by remember { mutableStateOf(false) }
    var themeLabel by remember(theme.name) { mutableStateOf(CoderThemes.modeLabel(terminalView.context)) }
    var shiftActive by remember { mutableStateOf(false) }
    var ctrlActive by remember { mutableStateOf(false) }
    var altActive by remember { mutableStateOf(false) }
    var showChat by remember { mutableStateOf(terminalView.toolbarActionVisible("chat")) }
    var showPaste by remember { mutableStateOf(terminalView.toolbarActionVisible("paste")) }
    var showTheme by remember { mutableStateOf(terminalView.toolbarActionVisible("theme")) }
    var autoSend by remember { mutableStateOf(terminalView.autoSendEnabled()) }
    var shortcuts by remember { mutableStateOf(terminalView.customShortcuts()) }
    var toolbarOrder by remember { mutableStateOf(terminalView.toolbarOrder()) }
    val text = theme.foreground.toComposeColor()
    val active = theme.selectionBackground.toComposeColor()
    LaunchedEffect(terminalView) {
        terminalView.onModifierLatchChanged = { shift, ctrl, alt ->
            shiftActive = shift
            ctrlActive = ctrl
            altActive = alt
        }
        terminalView.onToolbarActionsChanged = {
            showChat = terminalView.toolbarActionVisible("chat")
            showPaste = terminalView.toolbarActionVisible("paste")
            showTheme = terminalView.toolbarActionVisible("theme")
            autoSend = terminalView.autoSendEnabled()
            shortcuts = terminalView.customShortcuts()
            toolbarOrder = terminalView.toolbarOrder()
        }
    }
    if (chatMode) {
        ChatInputBar(uiTokens(theme), autoSend, { terminalView.sendText(it + "\n") }) { chatMode = false }
        return
    }
    Box(Modifier.fillMaxWidth().height(74.dp).background(theme.background.toComposeColor()).padding(horizontal = 18.dp, vertical = 10.dp), contentAlignment = Alignment.Center) {
        Row(Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(22.dp)).background(uiTokens(theme).surfaceHigh).horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (selectionActive) {
                ToolbarTextButton("Copy", text, uiTokens(theme).surface, onCopySelection)
                ToolbarTextButton("Clear", text, uiTokens(theme).surface, onClearSelection)
            } else toolbarOrder.forEach { slot ->
                when (slot) {
                    "ctrl" -> ToolbarTextButton("Ctrl", text, if (ctrlActive) active else uiTokens(theme).surface) { terminalView.toggleCtrlLatch() }
                    "shift" -> ToolbarTextButton("Shift", text, if (shiftActive) active else uiTokens(theme).surface) { terminalView.toggleShiftLatch() }
                    "alt" -> ToolbarTextButton("Alt", text, if (altActive) active else uiTokens(theme).surface) { terminalView.toggleAltLatch() }
                    "esc" -> ToolbarTextButton("Esc", text, uiTokens(theme).surface) { terminalView.sendKey(KeyEvent.KEYCODE_ESCAPE) }
                    "tab" -> ToolbarTextButton("Tab", text, uiTokens(theme).surface) { terminalView.sendKey(KeyEvent.KEYCODE_TAB) }
                    "empty" -> EmptyToolbarSlot(uiTokens(theme).surface)
                    "paste" -> if (showPaste) ToolbarIconButton(R.drawable.ic_feather_upload, text, uiTokens(theme).surface) { terminalView.pasteFromClipboard() } else EmptyToolbarSlot(uiTokens(theme).surface)
                    "theme" -> if (showTheme) ToolbarIconButton(R.drawable.ic_feather_rotate_ccw, text, uiTokens(theme).surface) { CoderThemes.nextMode(terminalView.context); themeLabel = CoderThemes.modeLabel(terminalView.context); terminalView.applyTheme(CoderThemes.current(terminalView.context)) }
                    "chat" -> if (showChat) ToolbarIconButton(R.drawable.ic_feather_message_circle, text, Color.Transparent) { chatMode = true }
                    "keyboard" -> ToolbarIconButton(R.drawable.ic_feather_keyboard, text, Color.Transparent) { onHideKeyboard(); onShowKeyboard() }
                }
            }
            shortcuts.take(2).forEach { shortcut -> ToolbarTextButton(shortcut.label, text, uiTokens(theme).surface) { terminalView.sendText(shortcut.sequence) } }
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
private fun RowScope.ToolbarTextButton(label: String, color: Color, background: Color, onClick: () -> Unit) {
    Box(Modifier.padding(end = 6.dp).height(36.dp).clip(RoundedCornerShape(14.dp)).background(background).clickable { hapticClick(); onClick() }.padding(horizontal = 11.dp), contentAlignment = Alignment.Center) {
        Text(label, color = color, fontSize = 14.sp, fontFamily = FontFamily.Monospace, maxLines = 1)
    }
}

@Composable
private fun RowScope.ToolbarIconButton(icon: Int, color: Color, background: Color, onClick: () -> Unit) {
    Box(Modifier.padding(end = 6.dp).size(36.dp).clip(RoundedCornerShape(14.dp)).background(background).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) {
        Icon(painterResource(icon), null, tint = color, modifier = Modifier.size(19.dp))
    }
}

@Composable
private fun RowScope.EmptyToolbarSlot(background: Color) {
    Box(Modifier.padding(end = 6.dp).size(36.dp).clip(RoundedCornerShape(14.dp)).background(background))
}

@Composable
private fun SettingsNavigator(session: CoderSession?, terminalView: CoderTerminalView, theme: CoderTheme, tokens: UiTokens, uiRevision: Int, onThemeChanged: () -> Unit, onTerminalFontSelected: (String) -> Unit, onFontChanged: () -> Unit, onBackToHome: () -> Unit) {
    var page by remember { mutableStateOf(SettingsPage.ROOT) }
    var placeholderTitle by remember { mutableStateOf("Settings") }
    var shortcutBackPage by remember { mutableStateOf(SettingsPage.TOOLBAR) }
    when (page) {
        SettingsPage.ROOT -> SettingsRootScreen(session, terminalView, theme, tokens, uiRevision, onBackToHome, { page = SettingsPage.THEME }, { page = SettingsPage.FONTS }) {
            if (it == "Toolbar") page = SettingsPage.TOOLBAR else if (it == "Shortcuts") page = SettingsPage.SHORTCUTS else if (it == "Keyboard") page = SettingsPage.KEYBOARD else if (it == "Gestures") page = SettingsPage.GESTURES else if (it == "Speech") page = SettingsPage.SPEECH else if (it == "Coder Connection") page = SettingsPage.CONNECTION else {
                placeholderTitle = it
                page = SettingsPage.PLACEHOLDER
            }
        }
        SettingsPage.THEME -> ThemePickerScreen(tokens, { page = SettingsPage.ROOT }, onThemeChanged)
        SettingsPage.FONTS -> FontsScreen(terminalView, tokens, onTerminalFontSelected, onFontChanged, { page = SettingsPage.TEXT }) { page = SettingsPage.ROOT }
        SettingsPage.TEXT -> TextCustomizationScreen(terminalView, tokens) { page = SettingsPage.FONTS }
        SettingsPage.TOOLBAR -> ToolbarSettingsScreen(terminalView, tokens, { shortcutBackPage = SettingsPage.TOOLBAR; page = SettingsPage.SHORTCUT }) { page = SettingsPage.ROOT }
        SettingsPage.SHORTCUTS -> ShortcutsSettingsScreen(terminalView, tokens, { shortcutBackPage = SettingsPage.SHORTCUTS; page = SettingsPage.SHORTCUT }) { page = SettingsPage.ROOT }
        SettingsPage.SHORTCUT -> ShortcutEditorScreen(terminalView, tokens) { page = shortcutBackPage }
        SettingsPage.KEYBOARD -> KeyboardSettingsScreen(terminalView, tokens) { page = SettingsPage.ROOT }
        SettingsPage.GESTURES -> GesturesSettingsScreen(terminalView, tokens) { page = SettingsPage.ROOT }
        SettingsPage.SPEECH -> SpeechSettingsScreen(terminalView, tokens) { page = SettingsPage.ROOT }
        SettingsPage.CONNECTION -> ConnectionSettingsScreen(session, tokens) { page = SettingsPage.ROOT }
        SettingsPage.PLACEHOLDER -> PlaceholderSettingsScreen(placeholderTitle, tokens) { page = SettingsPage.ROOT }
    }
}

@Composable
private fun SettingsRootScreen(session: CoderSession?, terminalView: CoderTerminalView, theme: CoderTheme, tokens: UiTokens, uiRevision: Int, onBack: () -> Unit, onTheme: () -> Unit, onFonts: () -> Unit, onPlaceholder: (String) -> Unit) {
    val context = LocalContext.current
    var cursorBlink by remember { mutableStateOf(terminalView.cursorBlinkEnabled()) }
    var cursorMode by remember { mutableIntStateOf(terminalView.cursorMode()) }
    var chatMode by remember { mutableStateOf(terminalView.chatModeEnabled()) }
    var autoSend by remember { mutableStateOf(terminalView.autoSendEnabled()) }
    var hapticFeedback by remember { mutableStateOf(context.getSharedPreferences("app", Context.MODE_PRIVATE).getBoolean("haptic_feedback", true)) }
    val appPreferences = remember(context) { context.getSharedPreferences("app", Context.MODE_PRIVATE) }
    var fileSync by remember { mutableStateOf(appPreferences.getBoolean("file_sync", false)) }
    var syncCredentials by remember { mutableStateOf(appPreferences.getBoolean("sync_credentials", false)) }
    SettingsScaffold("Settings", tokens, onBack) {
        SettingsSection("TERMINAL", tokens) {
            SettingsValueRow(R.drawable.ic_feather_palette, "Theme", null, theme.name, tokens, pro = true, chevron = true, onClick = onTheme)
            SettingsValueRow(R.drawable.ic_feather_type, "Fonts & Size", null, CoderFonts.selectedName(LocalContext.current).also { uiRevision.hashCode() }, tokens, chevron = true, onClick = onFonts)
            SettingsSegmentedControlRow(R.drawable.ic_feather_type, "Cursor Mode", tokens, cursorMode) { cursorMode = it; terminalView.setCursorMode(it) }
            SettingsToggleRow(R.drawable.ic_feather_circle, "Cursor Blink", cursorBlink, tokens) { cursorBlink = it; terminalView.setCursorBlinkEnabled(it) }
            SettingsToggleRow(R.drawable.ic_feather_sliders, "Haptic Feedback", hapticFeedback, tokens) {
                hapticFeedback = it
                HapticTarget.enabled = it
                context.getSharedPreferences("app", Context.MODE_PRIVATE).edit().putBoolean("haptic_feedback", it).apply()
            }
        }
        SettingsSection("INPUT", tokens) {
            SettingsValueRow(R.drawable.ic_feather_sliders, "Toolbar", null, null, tokens, chevron = true) { onPlaceholder("Toolbar") }
            listOf("Shortcuts" to R.drawable.ic_feather_box, "Keyboard" to R.drawable.ic_feather_keyboard, "Gestures" to R.drawable.ic_feather_hand, "Speech" to R.drawable.ic_feather_mic).forEach { (title, icon) -> SettingsValueRow(icon, title, null, null, tokens, chevron = true) { onPlaceholder(title) } }
            SettingsToggleRow(R.drawable.ic_feather_message_circle, "Chat Mode", chatMode, tokens) { chatMode = it; terminalView.setChatModeEnabled(it) }
            SettingsToggleRow(R.drawable.ic_feather_send, "Auto Send", autoSend, tokens) { autoSend = it; terminalView.setAutoSendEnabled(it) }
        }
        SettingsSection("INTEGRATIONS", tokens) {
            SettingsValueRow(R.drawable.ic_feather_bell, "Push Notifications", null, "Off", tokens, chevron = true) { onPlaceholder("Push Notifications") }
            SettingsValueRow(R.drawable.ic_feather_box, "Inbox & Usage", null, null, tokens, chevron = true) { onPlaceholder("Inbox & Usage") }
            SettingsValueRow(R.drawable.ic_feather_folder, "File Sharing", null, null, tokens, pro = true, chevron = true) { onPlaceholder("File Sharing") }
            SettingsValueRow(R.drawable.ic_feather_terminal, "Shell", null, null, tokens, pro = true, chevron = true) { onPlaceholder("Shell") }
        }
        SettingsSection("SECURITY & SYNC", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_shield, "File Sync", fileSync, tokens) { fileSync = it; appPreferences.edit().putBoolean("file_sync", it).apply() }
            SettingsToggleRow(R.drawable.ic_feather_shield, "Sync Credentials", syncCredentials, tokens) { syncCredentials = it; appPreferences.edit().putBoolean("sync_credentials", it).apply() }
            SettingsValueRow(R.drawable.ic_feather_folder, "Sync Folder", null, "Not Set", tokens, chevron = true) { onPlaceholder("Sync Folder") }
        }
        SettingsSection("GENERAL", tokens) { SettingsValueRow(R.drawable.ic_feather_globe, "Language", null, "Auto", tokens, chevron = true) { onPlaceholder("Language") } }
        if (session != null) {
            SettingsSection("CONNECTION", tokens) {
                SettingsValueRow(R.drawable.ic_feather_server, "Coder Connection", session.user.username, connectionHostLabel(session.baseUrl), tokens, chevron = true) { onPlaceholder("Coder Connection") }
            }
        }
        SettingsSection("HELP", tokens) {
            listOf("Docs" to R.drawable.ic_feather_book, "Discover Moshi" to R.drawable.ic_feather_box, "Support" to R.drawable.ic_feather_mail, "What's New" to R.drawable.ic_feather_bell, "Open Source Licenses" to R.drawable.ic_feather_book).forEach { (title, icon) -> SettingsValueRow(icon, title, null, null, tokens, chevron = true) { onPlaceholder(title) } }
        }
        item { Text("Version 2.11.1", color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 28.dp), textAlign = TextAlign.Center) }
    }
}

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
private fun FontsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onTerminalFontSelected: (String) -> Unit, onFontChanged: () -> Unit, onCustomizeText: () -> Unit, onBack: () -> Unit) {
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
        item { FontSettingsPreview(tokens, fontSize, CoderFonts.uiFontFamily(context)) }
        SettingsSection("TERMINAL TEXT", tokens) {
            SettingsStepperRow(
                R.drawable.ic_feather_type,
                "Font Size",
                fontSize,
                tokens,
                {
                    if (fontSize > 8) {
                        fontSize--
                        terminalView.setFontSizePoints(fontSize)
                    }
                },
                {
                    if (fontSize < 32) {
                        fontSize++
                        terminalView.setFontSizePoints(fontSize)
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
                if (it) selectedUiFontKey = selectedFontKey
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
        item { Text("Download curated fonts or import your own from Files. Imported fonts are stored inside Moshi and registered with the same renderer used by the terminal.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
    }
}

@Composable
private fun TextCustomizationScreen(terminalView: CoderTerminalView, tokens: UiTokens, onBack: () -> Unit) {
    var ligatures by remember { mutableStateOf(terminalView.ligaturesEnabled()) }
    var cursorBlink by remember { mutableStateOf(terminalView.cursorBlinkEnabled()) }
    var cursorMode by remember { mutableIntStateOf(terminalView.cursorMode()) }
    SettingsScaffold("Customize Text", tokens, onBack) {
        SettingsSection("OPEN TYPE", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_type, "Ligatures", ligatures, tokens) {
                ligatures = it
                terminalView.setLigaturesEnabled(it)
            }
            SettingsValueRow(R.drawable.ic_feather_sliders, "Feature Tags", "liga, calt, kern", "Auto", tokens) {}
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
            SettingsValueRow(R.drawable.ic_feather_globe, "CJK Fallback", "Use system fallback when glyph missing", "Planned", tokens) {}
            SettingsValueRow(R.drawable.ic_feather_type, "Emoji Fallback", "Color emoji atlas", "Planned", tokens) {}
        }
        item { Text("Ligatures, cursor mode, and cursor blink apply immediately to the native terminal renderer. CJK and emoji fallback are tracked here until fallback font stacks land.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
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
                "ctrl", "shift", "alt", "esc", "tab" -> Text(toolbarSlotLabel(slot).replaceFirstChar { it.uppercaseChar() }, color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace, modifier = Modifier.padding(end = 16.dp))
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
private fun ShortcutsSettingsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onAddShortcut: () -> Unit, onBack: () -> Unit) {
    var shortcuts by remember { mutableStateOf(terminalView.customShortcuts()) }
    LaunchedEffect(Unit) { terminalView.onToolbarActionsChanged = { shortcuts = terminalView.customShortcuts() } }
    SettingsScaffold("Shortcuts", tokens, onBack) {
        SettingsSection("CUSTOM SHORTCUTS", tokens) {
            if (shortcuts.isEmpty()) SettingsValueRow(R.drawable.ic_feather_terminal, "No shortcuts yet", "Create key sequences for the terminal toolbar", null, tokens) {}
            shortcuts.forEachIndexed { index, shortcut ->
                SettingsValueRow(R.drawable.ic_feather_terminal, shortcut.label, shortcut.sequence, "Remove", tokens) {
                    terminalView.removeCustomShortcut(index)
                    shortcuts = terminalView.customShortcuts()
                }
            }
        }
        item {
            Box(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 18.dp).height(52.dp).clip(RoundedCornerShape(18.dp)).background(tokens.accent).clickable { hapticClick(); onAddShortcut() }, contentAlignment = Alignment.Center) {
                Text("+  New Shortcut", color = tokens.background, fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
            }
        }
        item { Text("Shortcuts appear as toolbar buttons and send their saved key sequence into the active terminal.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
    }
}

@Composable
private fun ShortcutEditorScreen(terminalView: CoderTerminalView, tokens: UiTokens, onBack: () -> Unit) {
    var ctrl by remember { mutableStateOf(false) }
    var opt by remember { mutableStateOf(false) }
    var shift by remember { mutableStateOf(false) }
    var selectedKey by remember { mutableStateOf("Tab") }
    var customText by remember { mutableStateOf("") }
    var hint by remember { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    SettingsScaffold("New Shortcut", tokens, onBack) {
        item { Box(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 10.dp).height(66.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surfaceHigh).padding(16.dp).focusRequester(focusRequester).focusable().onPreviewKeyEvent { event ->
            if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            ctrl = event.isCtrlPressed
            opt = event.isAltPressed
            shift = event.isShiftPressed
            val label = hardwareShortcutLabel(event.key.nativeKeyCode)
            if (label != null) selectedKey = label
            label != null
        }, contentAlignment = Alignment.CenterStart) { Text(shortcutPreview(ctrl, opt, shift, selectedKey, customText), color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace) } }
        item { Text("MODIFIERS", color = tokens.secondary, fontSize = sectionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 5.dp)) }
        item { Row(Modifier.fillMaxWidth().padding(horizontal = spacingLarge()), horizontalArrangement = Arrangement.spacedBy(8.dp)) { ShortcutChoice("^ Ctrl", ctrl, tokens) { ctrl = !ctrl }; ShortcutChoice("⌥ Opt", opt, tokens) { opt = !opt }; ShortcutChoice("⇧ Shift", shift, tokens) { shift = !shift } } }
        item { Text("KEY", color = tokens.secondary, fontSize = sectionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
        item { ShortcutKeyGrid(tokens, selectedKey) { selectedKey = it } }
        item { Box(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 6.dp).height(48.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surfaceHigh).padding(13.dp)) { BasicTextField(value = customText, onValueChange = { customText = it }, singleLine = true, textStyle = androidx.compose.ui.text.TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace), decorationBox = { inner -> if (customText.isEmpty()) Text("Custom text / command", color = tokens.secondary, fontSize = bodySize(), fontFamily = FontFamily.Monospace); inner() }) } }
        item { Text("HINT (OPTIONAL)", color = tokens.secondary, fontSize = sectionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
        item { Box(Modifier.fillMaxWidth().padding(horizontal = spacingLarge()).height(52.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surfaceHigh).padding(14.dp)) { BasicTextField(value = hint, onValueChange = { hint = it }, singleLine = true, textStyle = androidx.compose.ui.text.TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace), decorationBox = { inner -> if (hint.isEmpty()) Text("e.g. \"submit\"", color = tokens.secondary, fontSize = bodySize(), fontFamily = FontFamily.Monospace); inner() }) } }
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ShortcutFooterButton("Cancel", tokens.surfaceHigh, tokens.text, Modifier.weight(1f), onBack)
                ShortcutFooterButton("Save", tokens.accent, tokens.background, Modifier.weight(1f)) {
                    val sequence = shortcutSequence(ctrl, opt, shift, selectedKey, customText)
                    val label = hint.ifBlank { shortcutPreview(ctrl, opt, shift, selectedKey, customText) }.take(14)
                    if (sequence.isNotBlank()) terminalView.addCustomShortcut(TerminalShortcut(label, sequence))
                    onBack()
                }
            }
        }
    }
}

@Composable
private fun GesturesSettingsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onBack: () -> Unit) {
    var swipeSessionSwitch by remember { mutableStateOf(terminalView.gestureEnabled("swipe_session_switch")) }
    var pinchFontSize by remember { mutableStateOf(terminalView.gestureEnabled("pinch_font_size")) }
    var longPressSelection by remember { mutableStateOf(terminalView.gestureEnabled("long_press_selection")) }
    var dragScroll by remember { mutableStateOf(terminalView.gestureEnabled("drag_scroll")) }
    var holdToClose by remember { mutableStateOf(terminalView.gestureEnabled("hold_to_close")) }
    SettingsScaffold("Gestures", tokens, onBack) {
        SettingsSection("TERMINAL", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_hand, "Swipe Session Switch", swipeSessionSwitch, tokens) { swipeSessionSwitch = it; terminalView.setGestureEnabled("swipe_session_switch", it) }
            SettingsToggleRow(R.drawable.ic_feather_type, "Pinch Font Size", pinchFontSize, tokens) { pinchFontSize = it; terminalView.setGestureEnabled("pinch_font_size", it) }
            SettingsToggleRow(R.drawable.ic_feather_edit_3, "Long-press Selection", longPressSelection, tokens) { longPressSelection = it; terminalView.setGestureEnabled("long_press_selection", it) }
            SettingsToggleRow(R.drawable.ic_feather_sliders, "Drag Scroll", dragScroll, tokens) { dragScroll = it; terminalView.setGestureEnabled("drag_scroll", it) }
            SettingsToggleRow(R.drawable.ic_feather_power, "Hold to Close", holdToClose, tokens) { holdToClose = it; terminalView.setGestureEnabled("hold_to_close", it) }
        }
        item { Text("Gesture changes apply to new terminal interactions immediately.", color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
}

@Composable
private fun KeyboardSettingsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onBack: () -> Unit) {
    var keyboardPaste by remember { mutableStateOf(terminalView.keyboardPasteEnabled()) }
    var volumeFontSize by remember { mutableStateOf(terminalView.volumeFontSizeEnabled()) }
    SettingsScaffold("Keyboard", tokens, onBack) {
        SettingsSection("HARDWARE KEYBOARD", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_upload, "Keyboard Paste", keyboardPaste, tokens) { keyboardPaste = it; terminalView.setKeyboardPasteEnabled(it) }
            SettingsValueRow(R.drawable.ic_feather_keyboard, "Paste Shortcut", "Cmd+V or Ctrl+Shift+V", null, tokens) {}
            SettingsValueRow(R.drawable.ic_feather_terminal, "Terminal Keys", "Esc, Tab, Enter, arrows, Home, End, PgUp, PgDn", null, tokens) {}
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
private fun SpeechSettingsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onBack: () -> Unit) {
    var chatMode by remember { mutableStateOf(terminalView.chatModeEnabled()) }
    var autoSend by remember { mutableStateOf(terminalView.autoSendEnabled()) }
    SettingsScaffold("Speech", tokens, onBack) {
        SettingsSection("DICTATION INPUT", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_message_circle, "Chat Input Mode", chatMode, tokens) { chatMode = it; terminalView.setChatModeEnabled(it) }
            SettingsToggleRow(R.drawable.ic_feather_send, "Auto Send", autoSend, tokens) { autoSend = it; terminalView.setAutoSendEnabled(it) }
            SettingsValueRow(R.drawable.ic_feather_mic, "Microphone Button", "Available inside chat input mode", null, tokens) {}
        }
        SettingsSection("BEHAVIOR", tokens) {
            SettingsValueRow(R.drawable.ic_feather_terminal, "Terminal Target", "Send dictated text to active terminal", null, tokens) {}
            SettingsValueRow(R.drawable.ic_feather_shield, "Privacy", "No token or terminal data is logged by this app", null, tokens) {}
        }
        item { Text("Speech recognition provider integration is not enabled yet. These settings control the existing chat input surface and how submitted text is sent to the terminal.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
}

@Composable
private fun ShortcutFooterButton(label: String, background: Color, color: Color, modifier: Modifier, onClick: () -> Unit) {
    Box(modifier.height(52.dp).clip(RoundedCornerShape(18.dp)).background(background).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) {
        Text(label, color = color, fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun RowScope.ShortcutChoice(label: String, selected: Boolean, tokens: UiTokens, onClick: () -> Unit) {
    Box(Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(12.dp)).background(if (selected) tokens.accent.copy(alpha = 0.35f) else tokens.surfaceHigh).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) { Text(label, color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace) }
}

@Composable
private fun ShortcutKeyGrid(tokens: UiTokens, selectedKey: String, onSelected: (String) -> Unit) {
    val rows = listOf(listOf("Esc", "Tab", "Enter", "⌫"), listOf("↑", "↓", "←", "→"), listOf("Home", "End", "PgUp", "PgDn"))
    Column(Modifier.padding(horizontal = spacingLarge()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        rows.forEach { row -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) { row.forEach { key -> Box(Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(12.dp)).background(if (key == selectedKey) tokens.accent.copy(alpha = 0.35f) else tokens.surfaceHigh).clickable { hapticClick(); onSelected(key) }, contentAlignment = Alignment.Center) { Text(key, color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace) } } } }
        Box(Modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(12.dp)).background(tokens.surfaceHigh), contentAlignment = Alignment.Center) { Text("Custom Key / Text...", color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace) }
    }
}

@Composable
private fun ConnectionSettingsScreen(session: CoderSession?, tokens: UiTokens, onBack: () -> Unit) {
    SettingsScaffold("Coder Connection", tokens, onBack) {
        SettingsSection("SAVED CONNECTIONS", tokens) {
            SettingsValueRow(R.drawable.ic_feather_server, session?.baseUrl?.let { connectionHostLabel(it) } ?: "No saved connection", session?.user?.username, "Coder", tokens) {}
        }
        SettingsSection("CURRENT", tokens) {
            SettingsValueRow(R.drawable.ic_feather_server, "Host", null, session?.baseUrl?.let { connectionHostLabel(it) } ?: "Not connected", tokens) {}
            SettingsValueRow(R.drawable.ic_feather_globe, "User", null, session?.user?.username ?: "Unknown", tokens) {}
        }
        SettingsSection("SECURITY", tokens) {
            SettingsValueRow(R.drawable.ic_feather_shield, "Token", "Stored in encrypted app storage", "Hidden", tokens) {}
        }
        item { Text("Connection details live here instead of the home screen. Tokens are never displayed or copied into logs.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 8.dp)) }
    }
}

@Composable
private fun FontSettingsPreview(tokens: UiTokens, fontSize: Int, uiFontFamily: FontFamily) {
    Column(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 10.dp).clip(RoundedCornerShape(18.dp)).background(tokens.surfaceHigh).padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Font Preview", color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), fontFamily = uiFontFamily)
            Text("${fontSize}pt", color = tokens.secondary, fontSize = captionSize(), fontFamily = uiFontFamily)
        }
        Spacer(Modifier.height(12.dp))
        Box(Modifier.fillMaxWidth().height(112.dp).clip(RoundedCornerShape(14.dp)).background(Color(0xff101014)).padding(12.dp)) {
            Column {
                Text("› echo \$PATH", color = Color(0xffd8d8ea), fontSize = fontSize.coerceIn(10, 20).sp, fontFamily = uiFontFamily, maxLines = 1)
                Text("λ main 󰘧 󰌘 0123456789", color = tokens.accent, fontSize = fontSize.coerceIn(10, 20).sp, fontFamily = uiFontFamily, maxLines = 1)
                Text("Bold Italic Regular", color = Color(0xffa7f3d0), fontSize = fontSize.coerceIn(10, 20).sp, fontFamily = uiFontFamily, fontWeight = FontWeight.Bold, maxLines = 1)
                Text("Ligatures: -> => != <= >=", color = Color(0xffffcc00), fontSize = fontSize.coerceIn(10, 20).sp, fontFamily = uiFontFamily, maxLines = 1)
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
