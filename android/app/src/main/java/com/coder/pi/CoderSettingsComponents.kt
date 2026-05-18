package com.coder.pi

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun SettingsScaffold(title: String, tokens: UiTokens, onBack: () -> Unit, actionIcon: Int? = null, onAction: (() -> Unit)? = null, content: LazyListScope.() -> Unit) {
    LazyColumn(Modifier.fillMaxSize().background(tokens.background).statusBarsPadding(), contentPadding = WindowInsets.navigationBars.asPaddingValues()) {
        item {
            Row(Modifier.fillMaxWidth().height(54.dp).padding(horizontal = spacingLarge()), verticalAlignment = Alignment.CenterVertically) {
                Text("‹", color = tokens.text, fontSize = 28.sp, modifier = Modifier.width(34.dp).clickable { hapticClick(); onBack() })
                Text(title, color = tokens.text, fontSize = titleSize(), fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                if (actionIcon != null && onAction != null) Icon(painterResource(actionIcon), null, tint = tokens.text, modifier = Modifier.size(24.dp).clickable { hapticClick(); onAction() })
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
fun SettingsSegmentedControlRow(icon: Int?, title: String, tokens: UiTokens, selected: Int, onSelected: (Int) -> Unit) {
    SettingsRow(icon, title, null, tokens, {}) { SettingsSegmentedControl(listOf("▮", "−", "▏"), selected, tokens, onSelected) }
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
