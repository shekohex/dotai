package com.coder.pi

import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
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
import kotlin.math.abs

enum class AppDestination { HOME, TERMINAL, SETTINGS }
enum class SettingsPage { ROOT, THEME, FONTS, PLACEHOLDER }
enum class HomeSheet { NONE, HOSTS, TERMINAL }

data class DemoSession(val title: String, val subtitle: String, val badge: String)

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
    val tokens = remember(theme) { uiTokens(theme) }
    HapticTarget.view = LocalContext.current.findActivityView()
    MaterialTheme {
        Box(Modifier.fillMaxSize().background(tokens.background)) {
            when (destination) {
                AppDestination.HOME -> HomeScreen(terminalView, theme, tokens, { destination = AppDestination.SETTINGS; onHideKeyboard() }, onShowKeyboard, onHideKeyboard)
                AppDestination.TERMINAL -> TerminalPane(terminalView, theme, onShowKeyboard, onHideKeyboard)
                AppDestination.SETTINGS -> SettingsNavigator(terminalView, theme, tokens, uiRevision, onThemeChanged, onFontChanged) { destination = AppDestination.HOME }
            }
        }
    }
}

@Composable
private fun HomeScreen(terminalView: CoderTerminalView, theme: CoderTheme, tokens: UiTokens, onOpenSettings: () -> Unit, onShowKeyboard: () -> Unit, onHideKeyboard: () -> Unit) {
    var hasActiveSession by remember { mutableStateOf(false) }
    var homeSheet by remember { mutableStateOf(HomeSheet.NONE) }
    var selectedSessionIndex by remember { mutableStateOf(0) }
    val sessions = remember {
        listOf(
            DemoSession("macbook", "just now", "SSH"),
            DemoSession("pi", "11h ago", "TMUX"),
            DemoSession("0", "11h ago", "SSH"),
        )
    }
    Box(Modifier.fillMaxSize().background(tokens.background).statusBarsPadding()) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = WindowInsets.navigationBars.asPaddingValues(),
        ) {
            item {
                Row(
                    Modifier.fillMaxWidth().height(64.dp).padding(horizontal = spacingLarge()),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.End,
                ) {
                    HeaderIcon(R.drawable.ic_feather_folder, tokens) {}
                    Spacer(Modifier.width(16.dp))
                    HeaderIcon(R.drawable.ic_feather_settings, tokens, onOpenSettings)
                }
            }
            HomeSection("ACTIVE SESSIONS", tokens, trailing = if (hasActiveSession) "hold to close   ▦" else null) {
                if (hasActiveSession) ActiveSessionPreview(sessions, selectedSessionIndex, tokens, { selectedSessionIndex = it }, { homeSheet = HomeSheet.TERMINAL }) else EmptyActiveSession(tokens) { hasActiveSession = true; homeSheet = HomeSheet.HOSTS }
            }
            HomeSection("SAVED CONNECTIONS", tokens) {
                SavedConnectionRow(tokens) { hasActiveSession = true; homeSheet = HomeSheet.HOSTS }
            }
            HomeSection("DISCOVER MOSHI", tokens, trailing = "3/16") {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(tokens.surfaceHigh).padding(12.dp)) {
                    Box(Modifier.fillMaxWidth().height(4.dp).clip(CircleShape).background(tokens.separator)) {
                        Box(Modifier.fillMaxWidth(0.18f).height(4.dp).clip(CircleShape).background(tokens.accent))
                    }
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        DiscoverCard(R.drawable.ic_feather_rotate_ccw, "Scrolling in Mosh", tokens, Modifier.weight(1f))
                        DiscoverCard(R.drawable.ic_feather_wifi, "Mosh Connection", tokens, Modifier.weight(1f))
                        DiscoverCard(R.drawable.ic_feather_image, "Paste & Annotate Images", tokens, Modifier.weight(1f))
                    }
                }
            }
        }
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .padding(end = spacingLarge(), bottom = 34.dp)
                .size(58.dp)
                .clip(CircleShape)
                .background(tokens.accent)
                .clickable { hapticClick(); hasActiveSession = true; homeSheet = HomeSheet.HOSTS },
            contentAlignment = Alignment.Center,
        ) {
            Text("+", color = tokens.background, fontSize = 28.sp, fontWeight = FontWeight.Light)
        }
        when (homeSheet) {
            HomeSheet.HOSTS -> HostListSheet(sessions, tokens, { homeSheet = HomeSheet.NONE }, { index -> selectedSessionIndex = index; hasActiveSession = true; onHideKeyboard(); homeSheet = HomeSheet.TERMINAL })
            HomeSheet.TERMINAL -> TerminalBottomSheet(terminalView, theme, sessions, selectedSessionIndex, tokens, { selectedSessionIndex = it }, { homeSheet = HomeSheet.NONE }, onShowKeyboard, onHideKeyboard)
            HomeSheet.NONE -> Unit
        }
    }
}

@Composable
private fun EmptyActiveSession(tokens: UiTokens, onClick: () -> Unit) {
    Box(Modifier.width(142.dp).height(152.dp).clip(RoundedCornerShape(16.dp)).border(BorderStroke(thinStroke(), tokens.separator), RoundedCornerShape(16.dp)).clickable { hapticClick(); onClick() }.padding(20.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(52.dp).clip(RoundedCornerShape(14.dp)).background(tokens.surface), contentAlignment = Alignment.Center) { Icon(painterResource(R.drawable.ic_feather_terminal), null, tint = tokens.accent, modifier = Modifier.size(28.dp)) }
            Text("No active\nsessions", color = tokens.text, fontSize = captionSize(), fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
            Text("tap + to add a\nconnection ↘", color = tokens.secondary, fontSize = smallCaptionSize(), fontFamily = FontFamily.Monospace, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun ActiveSessionPreview(sessions: List<DemoSession>, selectedSessionIndex: Int, tokens: UiTokens, onSelectSession: (Int) -> Unit, onClick: () -> Unit) {
    val session = sessions[selectedSessionIndex]
    Column(
        Modifier
            .width(196.dp)
            .pointerInput(selectedSessionIndex) { detectSessionSwipe(sessions, selectedSessionIndex, onSelectSession) }
            .clickable { hapticClick(); onClick() },
    ) {
        Box(Modifier.fillMaxWidth().height(156.dp).clip(RoundedCornerShape(8.dp)).background(tokens.text)) {
            Row(Modifier.fillMaxWidth().height(22.dp).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(session.title, color = tokens.background, fontSize = smallCaptionSize(), modifier = Modifier.weight(1f))
                Text(session.badge, color = tokens.background, fontSize = smallCaptionSize(), modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(tokens.accent).padding(horizontal = 7.dp, vertical = 2.dp))
            }
            Text("›", color = tokens.success, fontSize = 22.sp, modifier = Modifier.align(Alignment.TopStart).padding(start = 8.dp, top = 26.dp))
        }
        Spacer(Modifier.height(8.dp))
        Text(session.title, color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
        Text(session.subtitle, color = tokens.secondary, fontSize = captionSize())
    }
}

@Composable
private fun SavedConnectionRow(tokens: UiTokens, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(76.dp).clip(RoundedCornerShape(18.dp)).background(tokens.surfaceHigh).clickable { hapticClick(); onClick() }.padding(horizontal = 22.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(R.drawable.ic_feather_server), null, tint = tokens.secondary, modifier = Modifier.size(26.dp))
        Spacer(Modifier.width(20.dp))
        Column(Modifier.weight(1f)) {
            Text("macbook", color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
            Text("shady@macbook.owl-butterfly.ts.net:22", color = tokens.secondary, fontSize = captionSize(), fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text("›", color = tokens.secondary, fontSize = 24.sp)
    }
}

@Composable
private fun HostListSheet(sessions: List<DemoSession>, tokens: UiTokens, onDismiss: () -> Unit, onOpenTerminalSheet: (Int) -> Unit) {
    Box(Modifier.fillMaxSize()) {
        SheetScrim(onDismiss)
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.44f).alignBottomSheet(tokens).padding(20.dp)) {
            SheetHandle(tokens)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("›_  Tmux", color = tokens.text, fontSize = bodySize(), modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(tokens.surface).padding(horizontal = 12.dp, vertical = 7.dp))
                Spacer(Modifier.weight(1f))
                Text("Skip ▷", color = tokens.text, fontSize = bodySize(), modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(tokens.surface).padding(horizontal = 12.dp, vertical = 7.dp))
            }
            Spacer(Modifier.height(20.dp))
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(tokens.surface).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(painterResource(R.drawable.ic_feather_sliders), null, tint = tokens.accent, modifier = Modifier.size(24.dp))
                Spacer(Modifier.width(12.dp))
                Text("20 of 20 free uses left", color = tokens.text, fontSize = bodySize(), modifier = Modifier.weight(1f))
                Text("Unlock ›", color = tokens.accent, fontSize = bodySize())
            }
            Spacer(Modifier.height(14.dp))
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(tokens.surface)) {
                sessions.drop(1).forEachIndexed { index, session -> HostSheetRow(session.title, "1 window · ${session.subtitle}", tokens) { onOpenTerminalSheet(index + 1) } }
            }
        }
    }
}

@Composable
private fun HostSheetRow(title: String, subtitle: String, tokens: UiTokens, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().height(72.dp).clickable { hapticClick(); onClick() }.padding(horizontal = 18.dp), verticalArrangement = Arrangement.Center) {
        Text(title, color = tokens.text, fontSize = bodySize(), fontWeight = FontWeight.SemiBold)
        Text(subtitle, color = tokens.secondary, fontSize = captionSize())
    }
}

@Composable
private fun TerminalBottomSheet(terminalView: CoderTerminalView, theme: CoderTheme, sessions: List<DemoSession>, selectedSessionIndex: Int, tokens: UiTokens, onSelectSession: (Int) -> Unit, onDismiss: () -> Unit, onShowKeyboard: () -> Unit, onHideKeyboard: () -> Unit) {
    var chatMode by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(false) }
    var keyboardVisible by remember { mutableStateOf(false) }
    val session = sessions[selectedSessionIndex]
    LaunchedEffect(Unit) {
        terminalView.clearFocus()
        onHideKeyboard()
    }
    Box(Modifier.fillMaxSize()) {
        SheetScrim(onDismiss)
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(if (expanded) 1f else 0.92f).alignBottomSheet(tokens, expanded).pointerInput(selectedSessionIndex) { detectSessionSwipe(sessions, selectedSessionIndex, onSelectSession) }) {
            SheetHandle(tokens)
            Row(Modifier.fillMaxWidth().height(38.dp).padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(18.dp).clip(CircleShape).background(tokens.success))
                Spacer(Modifier.width(8.dp))
                Box(Modifier.size(18.dp).clip(CircleShape).background(tokens.accent))
                Spacer(Modifier.width(14.dp))
                Text(session.title, color = tokens.secondary, fontSize = captionSize(), fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                Text(session.badge, color = tokens.accent, fontSize = smallCaptionSize(), modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(tokens.surface).padding(horizontal = 10.dp, vertical = 4.dp))
                Spacer(Modifier.width(10.dp))
                Text(if (expanded) "⌄" else "⌃", color = tokens.secondary, fontSize = 22.sp, modifier = Modifier.clip(CircleShape).clickable { hapticClick(); expanded = !expanded }.padding(horizontal = 10.dp, vertical = 2.dp))
            }
            AndroidView(factory = { terminalView }, modifier = Modifier.weight(1f).fillMaxWidth(), update = { it.applyTheme(theme) })
            if (chatMode) ChatInputBar(tokens) { chatMode = false } else TerminalSheetToolbar(tokens, { chatMode = true }) {
                if (keyboardVisible) {
                    onHideKeyboard()
                } else {
                    onShowKeyboard()
                }
                keyboardVisible = !keyboardVisible
            }
        }
    }
}

private suspend fun PointerInputScope.detectSessionSwipe(sessions: List<DemoSession>, selectedSessionIndex: Int, onSelectSession: (Int) -> Unit) {
    detectHorizontalDragGestures { change, dragAmount ->
        if (abs(dragAmount) < 18f) return@detectHorizontalDragGestures
        change.consume()
        val nextIndex = when {
            dragAmount < 0f -> (selectedSessionIndex + 1).coerceAtMost(sessions.lastIndex)
            else -> (selectedSessionIndex - 1).coerceAtLeast(0)
        }
        if (nextIndex != selectedSessionIndex) {
            hapticClick()
            onSelectSession(nextIndex)
        }
    }
}

@Composable
private fun TerminalSheetToolbar(tokens: UiTokens, onChatMode: () -> Unit, onToggleKeyboard: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(70.dp).padding(horizontal = 18.dp, vertical = 10.dp).clip(RoundedCornerShape(18.dp)).background(tokens.surface).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        listOf("Ctrl", "Esc", "Tab").forEach { TerminalToolbarText(it, tokens) }
        TerminalToolbarIcon(R.drawable.ic_feather_box, tokens) {}
        TerminalToolbarIcon(R.drawable.ic_feather_rotate_ccw, tokens) {}
        Spacer(Modifier.weight(1f))
        Icon(painterResource(R.drawable.ic_feather_message_circle), null, tint = tokens.secondary, modifier = Modifier.size(24.dp).clickable { hapticClick(); onChatMode() })
        Spacer(Modifier.width(18.dp))
        Icon(painterResource(R.drawable.ic_feather_keyboard), null, tint = tokens.secondary, modifier = Modifier.size(24.dp).clickable { hapticClick(); onToggleKeyboard() })
    }
}

@Composable
private fun TerminalToolbarText(label: String, tokens: UiTokens) {
    Text(label, color = tokens.text, fontSize = bodySize(), modifier = Modifier.padding(end = 18.dp))
}

@Composable
private fun TerminalToolbarIcon(icon: Int, tokens: UiTokens, onClick: () -> Unit) {
    Icon(painterResource(icon), null, tint = tokens.secondary, modifier = Modifier.padding(end = 18.dp).size(22.dp).clickable { hapticClick(); onClick() })
}

@Composable
private fun ChatInputBar(tokens: UiTokens, onClose: () -> Unit) {
    var text by remember { mutableStateOf("") }
    Row(Modifier.fillMaxWidth().height(92.dp).padding(horizontal = 18.dp, vertical = 12.dp).clip(RoundedCornerShape(18.dp)).background(tokens.surface).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        BasicTextField(value = text, onValueChange = { text = it }, textStyle = androidx.compose.ui.text.TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace), modifier = Modifier.weight(1f), decorationBox = { inner -> if (text.isEmpty()) Text("Chat via Moshi...", color = tokens.secondary, fontSize = bodySize(), fontFamily = FontFamily.Monospace); inner() })
        Icon(painterResource(R.drawable.ic_feather_mic), null, tint = tokens.secondary, modifier = Modifier.size(24.dp))
        Spacer(Modifier.width(14.dp))
        Box(Modifier.size(40.dp).clip(CircleShape).background(tokens.accent).clickable { hapticClick(); onClose() }, contentAlignment = Alignment.Center) { Text("↑", color = tokens.background, fontSize = 22.sp) }
    }
}

@Composable
private fun SheetScrim(onDismiss: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.34f)).clickable { hapticClick(); onDismiss() })
}

@Composable
private fun ColumnScope.SheetHandle(tokens: UiTokens) {
    Box(Modifier.fillMaxWidth().height(18.dp), contentAlignment = Alignment.Center) { Box(Modifier.width(44.dp).height(4.dp).clip(CircleShape).background(tokens.separator)) }
}

private fun Modifier.alignBottomSheet(tokens: UiTokens, expanded: Boolean = false): Modifier {
    return this.fillMaxWidth().clip(RoundedCornerShape(topStart = if (expanded) 0.dp else 24.dp, topEnd = if (expanded) 0.dp else 24.dp)).background(tokens.background)
}

fun LazyListScope.HomeSection(title: String, tokens: UiTokens, trailing: String? = null, content: @Composable ColumnScope.() -> Unit) {
    item {
        Row(Modifier.fillMaxWidth().padding(start = spacingLarge(), end = spacingLarge(), top = 20.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, color = tokens.secondary, fontSize = sectionSize(), letterSpacing = 0.6.sp, modifier = Modifier.weight(1f))
            if (trailing != null) Text(trailing, color = tokens.accent, fontSize = sectionSize())
        }
        Column(Modifier.padding(horizontal = spacingLarge())) { content() }
    }
}

@Composable
private fun HeaderIcon(icon: Int, tokens: UiTokens, onClick: () -> Unit) {
    Box(Modifier.size(32.dp).clip(CircleShape).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) {
        Icon(painterResource(icon), null, tint = tokens.secondary, modifier = Modifier.size(22.dp))
    }
}

@Composable
private fun DiscoverCard(icon: Int, label: String, tokens: UiTokens, modifier: Modifier) {
    Column(modifier.height(66.dp).clip(RoundedCornerShape(12.dp)).background(tokens.surface).border(BorderStroke(thinStroke(), tokens.separator), RoundedCornerShape(12.dp)).padding(6.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Icon(painterResource(icon), null, tint = tokens.accent, modifier = Modifier.size(20.dp))
        Spacer(Modifier.height(8.dp))
        Text(label, color = tokens.secondary, fontSize = smallCaptionSize(), textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun TerminalPane(
    terminalView: CoderTerminalView,
    theme: CoderTheme,
    onShowKeyboard: () -> Unit,
    onHideKeyboard: () -> Unit,
) {
    Column(Modifier.fillMaxSize().background(theme.background.toComposeColor()).imePadding()) {
        AndroidView(
            factory = { terminalView },
            modifier = Modifier.weight(1f).fillMaxWidth(),
            update = { it.applyTheme(theme) },
        )
        TerminalAccessory(theme, terminalView, onShowKeyboard, onHideKeyboard)
    }
}

@Composable
private fun TerminalAccessory(theme: CoderTheme, terminalView: CoderTerminalView, onShowKeyboard: () -> Unit, onHideKeyboard: () -> Unit) {
    var themeLabel by remember(theme.name) { mutableStateOf(CoderThemes.modeLabel(terminalView.context)) }
    val text = theme.foreground.toComposeColor()
    Column(Modifier.fillMaxWidth().height(88.dp).background(theme.background.toComposeColor()).padding(horizontal = 8.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.SpaceBetween) {
            AccessoryKey("ESC", text) { terminalView.sendKey(KeyEvent.KEYCODE_ESCAPE) }
            AccessoryKey("SHIFT", text) { terminalView.toggleShiftLatch() }
            AccessoryKey("CTRL", text) { terminalView.toggleCtrlLatch() }
            AccessoryKey("ALT", text) { terminalView.toggleAltLatch() }
            AccessoryKey("⇥", text) { terminalView.sendKey(KeyEvent.KEYCODE_TAB) }
            AccessoryKey("@", text) { terminalView.sendText("@") }
            AccessoryKey("←", text) { terminalView.sendKey(KeyEvent.KEYCODE_DPAD_LEFT) }
            AccessoryKey("↑", text) { terminalView.sendKey(KeyEvent.KEYCODE_DPAD_UP) }
            AccessoryKey("→", text) { terminalView.sendKey(KeyEvent.KEYCODE_DPAD_RIGHT) }
        }
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.SpaceBetween) {
            AccessoryKey(":", text) { terminalView.sendText(":") }
            AccessoryKey("/", text) { terminalView.sendText("/") }
            AccessoryKey("~", text) { terminalView.sendText("~") }
            AccessoryKey("PGUP", text) { terminalView.scrollRows(-12) }
            AccessoryKey("PGDN", text) { terminalView.scrollRows(12) }
            AccessoryKey("−", text) { terminalView.sendText("-") }
            AccessoryKey("↓", text) { terminalView.sendKey(KeyEvent.KEYCODE_DPAD_DOWN) }
            AccessoryKey(themeLabel, text) {
                CoderThemes.nextMode(terminalView.context)
                themeLabel = CoderThemes.modeLabel(terminalView.context)
                terminalView.applyTheme(CoderThemes.current(terminalView.context))
            }
            AccessoryKey("⌨", text) {
                onHideKeyboard()
                onShowKeyboard()
            }
        }
    }
}

@Composable
private fun RowScope.AccessoryKey(label: String, color: Color, onClick: () -> Unit) {
    Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(8.dp)).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) {
        Text(label, color = color, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

@Composable
private fun SettingsNavigator(terminalView: CoderTerminalView, theme: CoderTheme, tokens: UiTokens, uiRevision: Int, onThemeChanged: () -> Unit, onFontChanged: () -> Unit, onBackToHome: () -> Unit) {
    var page by remember { mutableStateOf(SettingsPage.ROOT) }
    var placeholderTitle by remember { mutableStateOf("Settings") }
    when (page) {
        SettingsPage.ROOT -> SettingsRootScreen(theme, tokens, uiRevision, onBackToHome, { page = SettingsPage.THEME }, { page = SettingsPage.FONTS }) {
            placeholderTitle = it
            page = SettingsPage.PLACEHOLDER
        }
        SettingsPage.THEME -> ThemePickerScreen(tokens, { page = SettingsPage.ROOT }, onThemeChanged)
        SettingsPage.FONTS -> FontsScreen(terminalView, tokens, onFontChanged) { page = SettingsPage.ROOT }
        SettingsPage.PLACEHOLDER -> PlaceholderSettingsScreen(placeholderTitle, tokens) { page = SettingsPage.ROOT }
    }
}

@Composable
private fun SettingsRootScreen(theme: CoderTheme, tokens: UiTokens, uiRevision: Int, onBack: () -> Unit, onTheme: () -> Unit, onFonts: () -> Unit, onPlaceholder: (String) -> Unit) {
    var cursorBlink by remember { mutableStateOf(true) }
    var chatMode by remember { mutableStateOf(true) }
    var autoSend by remember { mutableStateOf(false) }
    var fileSync by remember { mutableStateOf(false) }
    var syncCredentials by remember { mutableStateOf(false) }
    SettingsScaffold("Settings", tokens, onBack) {
        SettingsSection("TERMINAL", tokens) {
            SettingsValueRow(R.drawable.ic_feather_palette, "Theme", null, theme.name, tokens, pro = true, chevron = true, onClick = onTheme)
            SettingsValueRow(R.drawable.ic_feather_type, "Fonts & Size", null, CoderFonts.selectedName(LocalContext.current).also { uiRevision.hashCode() }, tokens, chevron = true, onClick = onFonts)
            SettingsSegmentedControlRow(R.drawable.ic_feather_type, "Cursor Mode", tokens)
            SettingsToggleRow(R.drawable.ic_feather_circle, "Cursor Blink", cursorBlink, tokens) { cursorBlink = it }
        }
        SettingsSection("INPUT", tokens) {
            listOf("Toolbar" to R.drawable.ic_feather_sliders, "Shortcuts" to R.drawable.ic_feather_box, "Keyboard" to R.drawable.ic_feather_keyboard, "Gestures" to R.drawable.ic_feather_hand, "Speech" to R.drawable.ic_feather_mic).forEach { (title, icon) -> SettingsValueRow(icon, title, null, null, tokens, chevron = true) { onPlaceholder(title) } }
            SettingsToggleRow(R.drawable.ic_feather_message_circle, "Chat Mode", chatMode, tokens) { chatMode = it }
            SettingsToggleRow(R.drawable.ic_feather_send, "Auto Send", autoSend, tokens) { autoSend = it }
        }
        SettingsSection("INTEGRATIONS", tokens) {
            SettingsValueRow(R.drawable.ic_feather_bell, "Push Notifications", null, "Off", tokens, chevron = true) { onPlaceholder("Push Notifications") }
            SettingsValueRow(R.drawable.ic_feather_box, "Inbox & Usage", null, null, tokens, chevron = true) { onPlaceholder("Inbox & Usage") }
            SettingsValueRow(R.drawable.ic_feather_folder, "File Sharing", null, null, tokens, pro = true, chevron = true) { onPlaceholder("File Sharing") }
            SettingsValueRow(R.drawable.ic_feather_terminal, "Shell", null, null, tokens, pro = true, chevron = true) { onPlaceholder("Shell") }
        }
        SettingsSection("SECURITY & SYNC", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_shield, "File Sync", fileSync, tokens) { fileSync = it }
            SettingsToggleRow(R.drawable.ic_feather_shield, "Sync Credentials", syncCredentials, tokens) { syncCredentials = it }
            SettingsValueRow(R.drawable.ic_feather_folder, "Sync Folder", null, "Not Set", tokens, chevron = true) { onPlaceholder("Sync Folder") }
        }
        SettingsSection("GENERAL", tokens) { SettingsValueRow(R.drawable.ic_feather_globe, "Language", null, "Auto", tokens, chevron = true) { onPlaceholder("Language") } }
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
private fun FontsScreen(terminalView: CoderTerminalView, tokens: UiTokens, onFontChanged: () -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    var fontSize by remember { mutableIntStateOf(terminalView.fontSizePoints()) }
    var selectedFontKey by remember { mutableStateOf(CoderFonts.selectedKey(context)) }
    var importedFonts by remember { mutableStateOf(CoderFonts.importedOptions(context)) }
    val importLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            CoderFonts.importFont(context, uri)?.let { option ->
                importedFonts = CoderFonts.importedOptions(context)
                selectedFontKey = option.key
                terminalView.setFontFamily(option.key)
                onFontChanged()
            }
        }
    }
    SettingsScaffold("Fonts & Size", tokens, onBack) {
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
            SettingsValueRow(R.drawable.ic_feather_sliders, "Customize Text", "Ligatures and OpenType features", null, tokens, chevron = true) {}
        }
        SettingsSection("TERMINAL FONTS", tokens) {
            CoderFonts.builtInOptions().forEach { option ->
                FontOptionRow(option, selectedFontKey, tokens) {
                    selectedFontKey = option.key
                    terminalView.setFontFamily(option.key)
                    onFontChanged()
                }
            }
        }
        SettingsSection("IMPORTED FONTS · ${importedFonts.size}", tokens) {
            importedFonts.forEach { option ->
                FontOptionRow(option, selectedFontKey, tokens) {
                    selectedFontKey = option.key
                    terminalView.setFontFamily(option.key)
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
private fun FontOptionRow(option: CoderFontOption, selectedFontKey: String, tokens: UiTokens, onSelected: () -> Unit) {
    SettingsValueRow(R.drawable.ic_feather_type, option.name, option.subtitle, if (selectedFontKey == option.key) "✓" else null, tokens, pro = option.pro, onClick = onSelected)
}

@Composable
private fun PlaceholderSettingsScreen(title: String, tokens: UiTokens, onBack: () -> Unit) {
    SettingsScaffold(title, tokens, onBack) { SettingsSection("PLACEHOLDER", tokens) { SettingsValueRow(R.drawable.ic_feather_circle, title, "Screen scaffolded for future native settings", null, tokens) {} } }
}

@Composable
fun SettingsScaffold(title: String, tokens: UiTokens, onBack: () -> Unit, content: LazyListScope.() -> Unit) {
    LazyColumn(Modifier.fillMaxSize().background(tokens.background).statusBarsPadding(), contentPadding = WindowInsets.navigationBars.asPaddingValues()) {
        item {
            Row(Modifier.fillMaxWidth().height(54.dp).padding(horizontal = spacingLarge()), verticalAlignment = Alignment.CenterVertically) {
                Text("‹", color = tokens.text, fontSize = 28.sp, modifier = Modifier.width(34.dp).clickable { hapticClick(); onBack() })
                Text(title, color = tokens.text, fontSize = titleSize(), fontWeight = FontWeight.Bold)
            }
        }
        content()
    }
}

fun LazyListScope.SettingsSection(title: String, tokens: UiTokens, content: @Composable ColumnScope.() -> Unit) {
    item {
        Text(title, color = tokens.secondary, fontSize = sectionSize(), letterSpacing = 0.6.sp, modifier = Modifier.padding(start = spacingLarge(), end = spacingLarge(), top = 14.dp, bottom = 7.dp))
        Column(Modifier.padding(horizontal = spacingLarge()).clip(RoundedCornerShape(14.dp)).background(tokens.surfaceHigh)) { content() }
    }
}

@Composable
fun SettingsValueRow(icon: Int?, title: String, subtitle: String?, value: String?, tokens: UiTokens, pro: Boolean = false, chevron: Boolean = false, onClick: () -> Unit) {
    SettingsRow(icon, title, subtitle, tokens, onClick) {
        if (value != null) Text(value, color = if (value == "✓") tokens.accent else tokens.secondary, fontSize = valueSize(), maxLines = 1)
        if (pro) SettingsProBadge(tokens)
        if (chevron) Text("›", color = tokens.secondary, fontSize = 24.sp)
    }
}

@Composable
fun SettingsToggleRow(icon: Int?, title: String, checked: Boolean, tokens: UiTokens, onCheckedChange: (Boolean) -> Unit) {
    SettingsRow(icon, title, null, tokens, { onCheckedChange(!checked) }) {
        Switch(checked = checked, onCheckedChange = { hapticClick(); onCheckedChange(it) }, colors = SwitchDefaults.colors(checkedTrackColor = tokens.success, checkedThumbColor = tokens.background, uncheckedTrackColor = tokens.separator, uncheckedThumbColor = tokens.surface))
    }
}

@Composable
fun SettingsSegmentedControlRow(icon: Int?, title: String, tokens: UiTokens) {
    var selected by remember { mutableIntStateOf(0) }
    SettingsRow(icon, title, null, tokens, {}) { SettingsSegmentedControl(listOf("▮", "−", "▏"), selected, tokens) { selected = it } }
}

@Composable
fun SettingsStepperRow(icon: Int?, title: String, value: Int, tokens: UiTokens, onMinus: () -> Unit, onPlus: () -> Unit) {
    SettingsRow(icon, title, null, tokens, {}) {
        Row(Modifier.clip(RoundedCornerShape(28.dp)).background(tokens.separator).height(34.dp), verticalAlignment = Alignment.CenterVertically) {
            StepperButton("−", tokens, onMinus)
            Text("${value}pt", color = tokens.text, fontSize = bodySize(), modifier = Modifier.width(54.dp), textAlign = TextAlign.Center)
            StepperButton("+", tokens, onPlus)
        }
    }
}

@Composable
fun SettingsRow(icon: Int?, title: String, subtitle: String?, tokens: UiTokens, onClick: () -> Unit, trailing: @Composable RowScope.() -> Unit) {
    Row(Modifier.fillMaxWidth().height(if (subtitle == null) 46.dp else 58.dp).clickable { hapticClick(); onClick() }.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) {
            Icon(painterResource(icon), null, tint = tokens.secondary, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
            Text(title, color = tokens.text, fontSize = rowTitleSize(), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, color = tokens.secondary, fontSize = captionSize(), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) { trailing() }
    }
}

@Composable
fun SettingsSegmentedControl(labels: List<String>, selected: Int, tokens: UiTokens, onSelected: (Int) -> Unit) {
    Row(Modifier.clip(RoundedCornerShape(20.dp)).background(tokens.separator).height(38.dp).padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
        labels.forEachIndexed { index, label ->
            Box(Modifier.size(width = 34.dp, height = 30.dp).clip(RoundedCornerShape(15.dp)).background(if (index == selected) tokens.surface else Color.Transparent).clickable { hapticClick(); onSelected(index) }, contentAlignment = Alignment.Center) {
                Text(label, color = tokens.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
fun SettingsProBadge(tokens: UiTokens) {
    Text("PRO", color = tokens.proText, fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(tokens.proBackground).padding(horizontal = 6.dp, vertical = 3.dp))
}

@Composable
fun SettingsPalettePreview(palette: List<Int>) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { palette.take(5).forEach { Box(Modifier.size(18.dp).clip(RoundedCornerShape(5.dp)).background(it.toComposeColor())) } }
}

@Composable
private fun StepperButton(label: String, tokens: UiTokens, onClick: () -> Unit) {
    Box(Modifier.size(34.dp).clickable { hapticClick(); onClick() }, contentAlignment = Alignment.Center) { Text(label, color = tokens.secondary, fontSize = 18.sp) }
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

private fun spacingLarge(): Dp = 20.dp
private fun thinStroke(): Dp = 0.7.dp
private fun titleSize() = 21.sp
private fun rowTitleSize() = 15.5.sp
private fun bodySize() = 14.sp
private fun valueSize() = 14.sp
private fun captionSize() = 12.sp
private fun smallCaptionSize() = 10.5.sp
private fun sectionSize() = 12.sp

private object HapticTarget {
    var view: android.view.View? = null
}

private fun hapticClick() {
    HapticTarget.view?.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
}

private fun android.content.Context.findActivityView(): android.view.View? {
    return when (this) {
        is android.app.Activity -> window.decorView
        is android.content.ContextWrapper -> baseContext.findActivityView()
        else -> null
    }
}
