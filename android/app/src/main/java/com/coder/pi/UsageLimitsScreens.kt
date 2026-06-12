package com.coder.pi

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun UsageLimitsSettingsScreen(
    tokens: UiTokens,
    onConfiguration: () -> Unit,
    onDisplay: () -> Unit,
    onProviders: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val store = remember(context) { UsageLimitsCredentialStore(context) }
    val repository = remember(context) { UsageLimitsRepository(store) }
    val scope = rememberCoroutineScope()
    var refreshKey by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var snapshots by remember { mutableStateOf<List<UsageProviderSnapshot>>(emptyList()) }
    var selectingAccount by remember { mutableStateOf<UsageProviderDefinition?>(null) }
    var switchableAccountProviders by remember { mutableStateOf<Set<String>>(emptySet()) }
    var settingsRevision by remember { mutableIntStateOf(0) }
    var nextRefreshAt by remember { mutableStateOf(0L) }
    var nowMillis by remember { mutableStateOf(System.currentTimeMillis()) }
    val displayMode = store.displayMode().also { settingsRevision.hashCode() }
    val resetFormat = store.resetTimeFormat().also { settingsRevision.hashCode() }
    val showPace = store.showPace().also { settingsRevision.hashCode() }
    val hideAccountLabels = store.hideAccountLabels().also { settingsRevision.hashCode() }
    val autoRefreshMinutes = store.autoRefreshMinutes().also { settingsRevision.hashCode() }

    fun refresh() {
        scope.launch {
            if (snapshots.isEmpty()) snapshots = repository.cachedSnapshots()
            loading = true
            val previousSnapshots = snapshots
            val startedAt = System.currentTimeMillis()
            val fetchResult = runCatching { repository.fetchAll() }
            val nextSnapshots = fetchResult.getOrElse { previousSnapshots }
            if (nextSnapshots.isNotEmpty() || previousSnapshots.isEmpty()) snapshots = nextSnapshots
            loading = false
            if (fetchResult.isSuccess && nextSnapshots.any { it.fetchedAtMillis >= startedAt }) {
                val refreshedAt = System.currentTimeMillis()
                store.saveLastRefreshAtMillis(refreshedAt)
                nextRefreshAt = refreshedAt + autoRefreshMinutes * 60_000L
            }
        }
    }

    LaunchedEffect(Unit) {
        snapshots = repository.cachedSnapshots()
        val refreshIntervalMillis = autoRefreshMinutes * 60_000L
        val shouldRefresh = snapshots.isEmpty() || (autoRefreshMinutes > 0 && System.currentTimeMillis() - store.lastRefreshAtMillis() >= refreshIntervalMillis)
        if (shouldRefresh) {
            refresh()
        } else {
            loading = false
            nextRefreshAt = store.lastRefreshAtMillis() + refreshIntervalMillis
        }
    }
    LaunchedEffect(snapshots.map { it.provider.id }) {
        switchableAccountProviders =
            UsageLimitsRepository.providers
                .filter { it.id == "codex" || it.id == "google" }
                .filter { repository.cliproxyAccounts(it.id).size > 1 }
                .map { it.id }
                .toSet()
    }
    LaunchedEffect(refreshKey) { if (refreshKey > 0) refresh() }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000L)
            nowMillis = System.currentTimeMillis()
        }
    }
    LaunchedEffect(autoRefreshMinutes, settingsRevision) {
        if (autoRefreshMinutes > 0) {
            while (true) {
                delay(autoRefreshMinutes * 60_000L)
                refresh()
            }
        }
    }

    SettingsScaffold("Usage Limits", tokens, onBack, R.drawable.ic_feather_rotate_ccw, { refreshKey++ }, "Refresh usage limits") {
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Usage data refreshes on demand. Codex, Gemini, and Z.ai use configured credentials.", color = tokens.muted, fontSize = captionSize(), lineHeight = 18.sp, modifier = Modifier.weight(1f))
                if (loading) CircularProgressIndicator(Modifier.size(18.dp), color = tokens.accent, strokeWidth = 2.dp)
            }
        }
        if (loading && snapshots.isEmpty()) {
            UsageLimitsRepository.providers.filter { store.providerEnabled(it.id) }.forEach { provider ->
                item { UsageProviderCardShimmer(provider.displayName, tokens) }
            }
        } else if (snapshots.isEmpty()) {
            item { UsageLimitsEmptyState(tokens) }
        } else {
            snapshots.forEach { snapshot ->
                item { UsageProviderCard(snapshot, tokens, displayMode, resetFormat, showPace, hideAccountLabels, loading, switchableAccountProviders.contains(snapshot.provider.id)) { provider -> selectingAccount = provider } }
            }
        }
        SettingsSection("SETTINGS", tokens) {
            SettingsValueRow(R.drawable.ic_feather_database, "Providers", "Enable and configure usage providers", store.providersSummary(), tokens, chevron = true) { onProviders() }
            SettingsValueRow(R.drawable.ic_feather_server, "Configuration", "CLIProxyAPI key and endpoints", store.cliproxyLabel(), tokens, chevron = true) { onConfiguration() }
            SettingsValueRow(R.drawable.ic_feather_sliders, "Display", "Refresh, reset timers, pace marker", if (displayMode == UsageDisplayMode.Left) "Left" else "Used", tokens, chevron = true) { onDisplay() }
        }
        item { Text(nextRefreshLabel(nextRefreshAt, nowMillis, autoRefreshMinutes), color = tokens.muted, fontSize = captionSize(), modifier = Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 8.dp)) }
        item { Spacer(Modifier.height(42.dp)) }
    }
    selectingAccount?.let { provider ->
        UsageAccountSelectionDialog(provider, store, tokens, onDismiss = { selectingAccount = null }) {
            selectingAccount = null
            refreshKey++
        }
    }
}

private fun nextRefreshLabel(
    nextRefreshAt: Long,
    nowMillis: Long,
    intervalMinutes: Int,
): String =
    if (intervalMinutes <= 0) {
        "Auto refresh off"
    } else {
        val seconds = ((nextRefreshAt - nowMillis) / 1000L).coerceAtLeast(0)
        "Next refresh in ${seconds / 60}m ${seconds % 60}s"
    }

@Composable
fun UsageConfigurationSettingsScreen(
    tokens: UiTokens,
    onCliproxyEndpoints: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val store = remember(context) { UsageLimitsCredentialStore(context) }
    var editing by remember { mutableStateOf<UsageLimitsConfigTarget?>(null) }
    var revision by remember { mutableIntStateOf(0) }
    SettingsScaffold("Usage Configuration", tokens, onBack) {
        SettingsSection("CLIPROXYAPI", tokens) {
            SettingsValueRow(R.drawable.ic_feather_server, "Management Key", "Stored encrypted", store.cliproxyLabel(), tokens, chevron = true) { editing = UsageLimitsConfigTarget.Cliproxy }
            SettingsValueRow(R.drawable.ic_feather_globe, "Endpoints", "LAN, Tailscale, public fallback", "${store.cliproxyBaseUrls().size}", tokens, chevron = true) { onCliproxyEndpoints() }
        }
        item { Text("Codex and Gemini use CLIProxyAPI auth files. Z.ai uses its API key. Endpoints are tried in order.", color = tokens.muted, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
    editing?.let { target ->
        UsageLimitsConfigDialog(target, store, tokens, onDismiss = { editing = null }) {
            editing = null
            revision++
        }
    }
    revision.hashCode()
}

@Composable
fun UsageDisplaySettingsScreen(
    tokens: UiTokens,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val store = remember(context) { UsageLimitsCredentialStore(context) }
    var revision by remember { mutableIntStateOf(0) }
    val displayMode = store.displayMode().also { revision.hashCode() }
    val resetFormat = store.resetTimeFormat().also { revision.hashCode() }
    val showPace = store.showPace().also { revision.hashCode() }
    val hideAccountLabels = store.hideAccountLabels().also { revision.hashCode() }
    val autoRefreshMinutes = store.autoRefreshMinutes().also { revision.hashCode() }
    SettingsScaffold("Usage Display", tokens, onBack) {
        SettingsSection("DISPLAY", tokens) {
            SettingsValueRow(R.drawable.ic_feather_rotate_ccw, "Auto Refresh", "How obsessive are you", if (autoRefreshMinutes == 0) "Off" else "$autoRefreshMinutes min", tokens) {
                store.saveAutoRefreshMinutes(nextAutoRefreshMinutes(autoRefreshMinutes))
                revision++
            }
            SettingsValueRow(R.drawable.ic_feather_loader, "Usage Mode", "Glass half full or half empty", if (displayMode == UsageDisplayMode.Left) "Left" else "Used", tokens) {
                store.saveDisplayMode(if (displayMode == UsageDisplayMode.Left) UsageDisplayMode.Used else UsageDisplayMode.Left)
                revision++
            }
            SettingsValueRow(R.drawable.ic_feather_clock, "Reset Timers", "Countdown or clock time", if (resetFormat == UsageResetTimeFormat.Relative) "Relative" else "Absolute", tokens) {
                store.saveResetTimeFormat(if (resetFormat == UsageResetTimeFormat.Relative) UsageResetTimeFormat.Absolute else UsageResetTimeFormat.Relative)
                revision++
            }
            SettingsToggleRow(R.drawable.ic_feather_sliders, "Pace Marker", showPace, tokens) {
                store.saveShowPace(it)
                revision++
            }
            SettingsToggleRow(R.drawable.ic_feather_shield, "Hide Account Labels", hideAccountLabels, tokens) {
                store.saveHideAccountLabels(it)
                revision++
            }
        }
        item { Text("Pace marker shows elapsed time in the quota window. Hide account labels before sharing screenshots.", color = tokens.muted, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
}

@Composable
fun UsageCliproxyEndpointsSettingsScreen(
    tokens: UiTokens,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val store = remember(context) { UsageLimitsCredentialStore(context) }
    var revision by remember { mutableIntStateOf(0) }
    var addDialog by remember { mutableStateOf(false) }
    val endpoints = store.cliproxyBaseUrls().also { revision.hashCode() }
    SettingsScaffold("CLIProxy Endpoints", tokens, onBack, R.drawable.ic_feather_plus, { addDialog = true }, "Add endpoint") {
        SettingsSection("ENDPOINTS", tokens) {
            if (endpoints.isEmpty()) {
                item { Text("No endpoints. Add LAN, Tailscale, or public HTTPS endpoint.", color = tokens.muted, fontSize = bodySize(), modifier = Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 16.dp)) }
            } else {
                endpoints.forEachIndexed { index, endpoint ->
                    SettingsRow(R.drawable.ic_feather_globe, endpoint, if (index == 0) "First priority" else "Fallback #${index + 1}", tokens, {}) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "↑",
                                color = tokens.secondary,
                                fontSize = 18.sp,
                                modifier =
                                    Modifier.width(28.dp).clickable {
                                        store.saveCliproxyEndpoints(moveUsageEndpoint(endpoints, endpoint, -1))
                                        revision++
                                    },
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            )
                            Text(
                                "↓",
                                color = tokens.secondary,
                                fontSize = 18.sp,
                                modifier =
                                    Modifier.width(28.dp).clickable {
                                        store.saveCliproxyEndpoints(moveUsageEndpoint(endpoints, endpoint, 1))
                                        revision++
                                    },
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            )
                            Text(
                                "Remove",
                                color = usageDangerColor(tokens),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                modifier =
                                    Modifier
                                        .clip(RoundedCornerShape(10.dp))
                                        .clickable {
                                            store.saveCliproxyEndpoints(endpoints - endpoint)
                                            revision++
                                        }.padding(horizontal = 8.dp, vertical = 6.dp),
                            )
                        }
                    }
                }
            }
        }
        item { Text("Endpoints are tried in order. HTTP is allowed only for localhost, LAN, and Tailscale ranges. HTTPS is always allowed.", color = tokens.muted, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
    if (addDialog) {
        UsageEndpointDialog(tokens, onDismiss = { addDialog = false }) { endpoint ->
            store.saveCliproxyEndpoints((endpoints + endpoint).distinct())
            revision++
            addDialog = false
        }
    }
}

@Composable
fun UsageProvidersSettingsScreen(
    tokens: UiTokens,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val store = remember(context) { UsageLimitsCredentialStore(context) }
    var revision by remember { mutableIntStateOf(0) }
    var editing by remember { mutableStateOf<UsageProviderDefinition?>(null) }
    SettingsScaffold("Usage Providers", tokens, onBack) {
        SettingsSection("PROVIDERS", tokens) {
            UsageLimitsRepository.providers.forEach { provider ->
                SettingsToggleRow(provider.settingsIcon, provider.displayName, store.providerEnabled(provider.id), tokens) {
                    store.saveProviderEnabled(provider.id, it)
                    revision++
                }
                SettingsValueRow(provider.settingsIcon, "${provider.displayName} Source", provider.authLabel, provider.providerConfigValue(store), tokens, chevron = provider.id == "zai") {
                    if (provider.id == "zai") editing = provider
                }
            }
        }
        item { Text("Codex and Gemini read OAuth auth files through CLIProxyAPI. Z.ai uses direct API key.", color = tokens.muted, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
    editing?.let { provider ->
        UsageLimitsConfigDialog(UsageLimitsConfigTarget.Provider(provider), store, tokens, onDismiss = { editing = null }) {
            editing = null
            revision++
        }
    }
}

@Composable
private fun UsageAccountSelectionDialog(
    provider: UsageProviderDefinition,
    store: UsageLimitsCredentialStore,
    tokens: UiTokens,
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
) {
    val repository = remember(store) { UsageLimitsRepository(store) }
    var loading by remember { mutableStateOf(true) }
    var accounts by remember { mutableStateOf<List<UsageProviderAccount>>(emptyList()) }
    LaunchedEffect(provider.id) {
        loading = true
        accounts = repository.cliproxyAccounts(provider.id)
        loading = false
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("${provider.displayName} Account", color = tokens.text) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SettingsRow(provider.settingsIcon, "Auto", "First available account", tokens, {}) {
                    Text(
                        if (store.selectedAccountFile(provider.id).isBlank()) "✓" else "Select",
                        color = tokens.accent,
                        fontSize = captionSize(),
                        modifier =
                            Modifier.clickable {
                                store.saveSelectedAccountFile(provider.id, "")
                                onSaved()
                            },
                    )
                }
                accounts.forEach { account ->
                    SettingsRow(provider.settingsIcon, account.label, account.fileName, tokens, {}) {
                        Text(
                            if (store.selectedAccountFile(provider.id) == account.fileName) "✓" else "Select",
                            color = tokens.accent,
                            fontSize = captionSize(),
                            modifier =
                                Modifier.clickable {
                                    store.saveSelectedAccountFile(provider.id, account.fileName)
                                    onSaved()
                                },
                        )
                    }
                }
                if (loading) CoderShimmerBox(tokens, Modifier.fillMaxWidth().height(34.dp).clip(RoundedCornerShape(12.dp)))
                if (!loading && accounts.isEmpty()) Text("No CLIProxyAPI accounts found.", color = tokens.muted, fontSize = captionSize())
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
        dismissButton = {
            TextButton(onClick = {
                store.saveSelectedAccountFile(provider.id, "")
                onSaved()
            }) { Text("Auto") }
        },
        containerColor = tokens.surfaceHigh,
    )
}

@Composable
private fun UsageLimitsEmptyState(tokens: UiTokens) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = spacingLarge(), vertical = 12.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(tokens.surfaceHigh)
            .padding(16.dp),
    ) {
        Text("No usage data", color = tokens.text, fontSize = rowTitleSize(), fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Text("Configure CLIProxyAPI or provider API keys, then refresh.", color = tokens.muted, fontSize = captionSize(), lineHeight = 18.sp)
    }
}

@Composable
private fun UsageProviderCardShimmer(
    title: String,
    tokens: UiTokens,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = spacingLarge(), vertical = 8.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(tokens.surfaceHigh)
            .padding(16.dp),
    ) {
        Text(title, color = tokens.text, fontSize = titleSize(), fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp))
        CoderShimmerBox(tokens, Modifier.fillMaxWidth(0.55f).height(12.dp).clip(RoundedCornerShape(6.dp)))
        Spacer(Modifier.height(10.dp))
        CoderShimmerBox(tokens, Modifier.fillMaxWidth().height(10.dp).clip(RoundedCornerShape(5.dp)))
        Spacer(Modifier.height(8.dp))
        CoderShimmerBox(tokens, Modifier.fillMaxWidth(0.78f).height(10.dp).clip(RoundedCornerShape(5.dp)))
    }
}

@Composable
private fun UsageProviderCard(
    snapshot: UsageProviderSnapshot,
    tokens: UiTokens,
    displayMode: UsageDisplayMode,
    resetFormat: UsageResetTimeFormat,
    showPace: Boolean,
    hideAccountLabels: Boolean,
    refreshing: Boolean,
    canSwitchAccount: Boolean,
    onAccountClick: (UsageProviderDefinition) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = spacingLarge(), vertical = 8.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(tokens.surfaceHigh)
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ProviderLogo(snapshot.provider, tokens)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(snapshot.provider.displayName, color = tokens.text, fontSize = titleSize(), fontWeight = FontWeight.Bold)
                Text(
                    listOfNotNull(snapshot.plan, snapshot.accountLabel.displayAccountLabel(hideAccountLabels), snapshot.sourceLabel).joinToString(" · "),
                    color = tokens.muted,
                    fontSize = captionSize(),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier =
                        Modifier.then(
                            if (canSwitchAccount) {
                                Modifier.clickable { onAccountClick(snapshot.provider) }
                            } else {
                                Modifier
                            },
                        ),
                )
            }
            UsageStatusDot(snapshot, tokens)
        }
        Spacer(Modifier.height(14.dp))
        if (snapshot.error != null) {
            Text(snapshot.error, color = usageDangerColor(tokens), fontSize = captionSize(), lineHeight = 18.sp)
        } else {
            snapshot.metrics.forEach { metric ->
                UsageMetricBar(metric, tokens, displayMode, resetFormat, showPace, refreshing)
                Spacer(Modifier.height(13.dp))
            }
            snapshot.textLines.forEach { line ->
                Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    Text(line.label, color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.weight(1f))
                    Text(line.value, color = tokens.secondary, fontSize = captionSize())
                }
            }
        }
        Spacer(Modifier.height(4.dp))
        Text("Updated ${relativeTime(snapshot.fetchedAtMillis)}", color = tokens.muted, fontSize = 11.sp)
    }
}

@Composable
private fun ProviderLogo(
    provider: UsageProviderDefinition,
    tokens: UiTokens,
) {
    Box(Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).background(tokens.surface), contentAlignment = Alignment.Center) {
        Text(provider.iconGlyph, color = tokens.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
    }
}

private fun String?.displayAccountLabel(hide: Boolean): String? {
    val value = this?.trim()?.takeIf { it.isNotBlank() } ?: return null
    if (!hide) return value
    val primary = value.substringBefore(" (").trim()
    return if (primary.contains('@')) {
        val domain = primary.substringAfter('@', "")
        if (domain.isBlank()) "••••" else "••••@$domain"
    } else {
        "••••"
    }
}

@Composable
private fun UsageStatusDot(
    snapshot: UsageProviderSnapshot,
    tokens: UiTokens,
) {
    val color =
        when {
            snapshot.error != null -> usageDangerColor(tokens)
            snapshot.metrics.any { it.leftPercent <= 15 } -> usageWarningColor(tokens)
            else -> tokens.accent
        }
    Box(Modifier.size(9.dp).clip(CircleShape).background(color))
}

@Composable
private fun UsageMetricBar(
    metric: UsageMetricSnapshot,
    tokens: UiTokens,
    displayMode: UsageDisplayMode,
    resetFormat: UsageResetTimeFormat,
    showPace: Boolean,
    refreshing: Boolean,
) {
    val usedFraction = (metric.used / metric.limit).toFloat().coerceIn(0f, 1f)
    val displayedFraction = if (displayMode == UsageDisplayMode.Left) (metric.leftPercent / 100f).coerceIn(0f, 1f) else usedFraction
    val pace = metric.paceDetails(displayMode)
    val statusColor = pace.status.color(tokens)
    val progressColor = metric.progressColor(tokens)
    Column {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(metric.label, color = tokens.text, fontSize = rowTitleSize(), fontWeight = FontWeight.SemiBold)
            if (pace.statusText != null) {
                Spacer(Modifier.width(7.dp))
                Box(Modifier.size(7.dp).clip(CircleShape).background(statusColor))
                Spacer(Modifier.width(5.dp))
                Text(pace.statusText, color = statusColor, fontSize = captionSize(), modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            } else {
                Spacer(Modifier.weight(1f))
                if (metric.leftPercent <= 20) Box(Modifier.size(7.dp).clip(CircleShape).background(usageWarningColor(tokens)))
            }
        }
        if (pace.projectedText != null) {
            Spacer(Modifier.height(3.dp))
            Text(pace.projectedText, color = tokens.muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(6.dp))
        UsageMetricProgressIndicator(displayedFraction, pace.elapsedFraction.takeIf { showPace }, progressColor, tokens, refreshing)
        Spacer(Modifier.height(5.dp))
        Row(Modifier.fillMaxWidth()) {
            Text(metric.primaryLabel(displayMode), color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.weight(1f))
            Text(metric.resetLabel(resetFormat), color = tokens.secondary, fontSize = captionSize())
        }
        if (pace.runsOutText != null) {
            Spacer(Modifier.height(4.dp))
            Text(pace.runsOutText, color = usageDangerColor(tokens), fontSize = captionSize())
        }
    }
}

@Composable
private fun UsageMetricProgressIndicator(
    usedFraction: Float,
    elapsedFraction: Float?,
    progressColor: Color,
    tokens: UiTokens,
    refreshing: Boolean,
) {
    BoxWithConstraints(Modifier.fillMaxWidth().height(10.dp).clip(RoundedCornerShape(5.dp))) {
        LinearProgressIndicator(
            progress = { usedFraction },
            modifier = Modifier.fillMaxWidth().height(10.dp),
            color = progressColor,
            trackColor = tokens.separator,
        )
        if (elapsedFraction != null) {
            val markerOffset = (maxWidth - 2.dp) * elapsedFraction.coerceIn(0f, 1f)
            Box(
                Modifier
                    .offset(x = markerOffset)
                    .width(2.dp)
                    .fillMaxHeight()
                    .background(tokens.accent),
            )
        }
        if (refreshing) UsageProgressRefreshShimmer(tokens)
    }
}

@Composable
private fun BoxScope.UsageProgressRefreshShimmer(tokens: UiTokens) {
    val transition = rememberInfiniteTransition(label = "usage-progress-refresh")
    val progress by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "usage-progress-refresh-progress")
    BoxWithConstraints(Modifier.matchParentSize()) {
        val width = constraints.maxWidth.toFloat().coerceAtLeast(1f)
        val shimmerOffset = width * progress * 2f
        Box(
            Modifier
                .matchParentSize()
                .background(
                    Brush.linearGradient(
                        listOf(Color.Transparent, tokens.text.copy(alpha = 0.28f), Color.Transparent),
                        start = Offset(shimmerOffset - width, 0f),
                        end = Offset(shimmerOffset, width),
                    ),
                ),
        )
    }
}

@Composable
private fun UsageLimitsConfigDialog(
    target: UsageLimitsConfigTarget,
    store: UsageLimitsCredentialStore,
    tokens: UiTokens,
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
) {
    when (target) {
        UsageLimitsConfigTarget.Cliproxy -> {
            var apiKey by remember { mutableStateOf("") }
            UsageLimitsDialogShell("CLIProxyAPI", tokens, onDismiss, onSave = {
                store.saveCliproxyKey(apiKey)
                onSaved()
            }) {
                UsageTextField("Management key", apiKey, tokens, secret = true) { apiKey = it }
                Text(if (store.cliproxyApiKey().isBlank()) "No key saved. Paste management key." else "Key already saved. Leave blank to keep it.", color = tokens.muted, fontSize = captionSize(), lineHeight = 18.sp)
                Text("Endpoints are managed from CLIProxy Endpoints.", color = tokens.muted, fontSize = captionSize(), lineHeight = 18.sp)
            }
        }
        is UsageLimitsConfigTarget.Provider -> {
            var apiKey by remember { mutableStateOf("") }
            var baseUrl by remember { mutableStateOf(store.providerBaseUrl(target.provider.id)) }
            UsageLimitsDialogShell(target.provider.displayName, tokens, onDismiss, onSave = {
                store.saveProvider(target.provider.id, apiKey, baseUrl)
                onSaved()
            }) {
                UsageTextField("API key", apiKey, tokens, secret = true) { apiKey = it }
                if (target.provider.defaultBaseUrl.isNotBlank()) UsageTextField("Base URL", baseUrl, tokens) { baseUrl = it }
                Text(if (store.providerApiKey(target.provider.id).isBlank()) "No key saved. Paste API key." else "Key already saved. Leave blank to keep it.", color = tokens.muted, fontSize = captionSize(), lineHeight = 18.sp)
                Text(target.provider.configHint, color = tokens.muted, fontSize = captionSize(), lineHeight = 18.sp)
            }
        }
    }
}

@Composable
private fun UsageLimitsDialogShell(
    title: String,
    tokens: UiTokens,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, color = tokens.text) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp), content = content) },
        confirmButton = { Button(onClick = onSave) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = tokens.surfaceHigh,
    )
}

@Composable
private fun UsageTextField(
    label: String,
    value: String,
    tokens: UiTokens,
    singleLine: Boolean = true,
    secret: Boolean = false,
    onValueChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label, color = tokens.secondary) },
        singleLine = singleLine,
        modifier = Modifier.fillMaxWidth(),
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        textStyle =
            androidx.compose.ui.text
                .TextStyle(color = tokens.text, fontSize = bodySize()),
    )
}

@Composable
private fun UsageEndpointDialog(
    tokens: UiTokens,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    var value by remember { mutableStateOf("") }
    val normalized = value.normalizeCliproxyBaseUrl()
    val valid = normalized?.isAllowedCliproxyEndpoint() == true
    UsageLimitsDialogShell("Add Endpoint", tokens, onDismiss, onSave = {
        if (valid) onSave(normalized.orEmpty())
    }) {
        UsageTextField("Endpoint", value, tokens) { value = it }
        Text("Example: http://100.100.1.116:8317", color = tokens.muted, fontSize = captionSize(), lineHeight = 18.sp)
        if (value.isNotBlank() && !valid) Text("Use HTTPS, localhost, LAN, or Tailscale HTTP endpoint.", color = usageDangerColor(tokens), fontSize = captionSize(), lineHeight = 18.sp)
    }
}

private fun moveUsageEndpoint(
    endpoints: List<String>,
    endpoint: String,
    delta: Int,
): List<String> {
    val list = endpoints.toMutableList()
    val index = list.indexOf(endpoint)
    val target = (index + delta).coerceIn(0, list.lastIndex)
    if (index >= 0 && index != target) java.util.Collections.swap(list, index, target)
    return list
}

private sealed interface UsageLimitsConfigTarget {
    data object Cliproxy : UsageLimitsConfigTarget

    data class Provider(
        val provider: UsageProviderDefinition,
    ) : UsageLimitsConfigTarget
}
