package com.coder.pi

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun ChatInputBar(tokens: UiTokens, autoSend: Boolean = false, onSubmit: (String) -> Unit, onClose: () -> Unit) {
    var text by remember { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().height(148.dp).background(tokens.background).padding(horizontal = 18.dp, vertical = 10.dp), verticalArrangement = Arrangement.Center) {
        Column(Modifier.fillMaxWidth().height(126.dp).clip(RoundedCornerShape(22.dp)).background(tokens.surfaceHigh).padding(horizontal = 16.dp, vertical = 10.dp)) {
            Box(Modifier.fillMaxWidth().height(56.dp)) {
                BasicTextField(value = text, onValueChange = { value -> if (autoSend && value.endsWith("\n")) { value.trimEnd().takeIf { it.isNotBlank() }?.let(onSubmit); text = "" } else text = value }, textStyle = androidx.compose.ui.text.TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace, lineHeight = 20.sp), modifier = Modifier.fillMaxSize(), decorationBox = { inner -> if (text.isEmpty()) Text(if (autoSend) "Enter sends" else "Enter newline, ↑ sends", color = tokens.secondary, fontSize = bodySize(), fontFamily = FontFamily.Monospace, lineHeight = 20.sp); inner() })
            }
            Text(if (autoSend) "Auto Send" else "Multiline", color = tokens.secondary, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("+", color = tokens.text, fontSize = 24.sp, modifier = Modifier.width(32.dp).clickable { hapticClick() })
                Text("×", color = tokens.text, fontSize = 24.sp, modifier = Modifier.width(32.dp).clickable { hapticClick(); onClose() })
                Spacer(Modifier.weight(1f))
                Icon(painterResource(R.drawable.ic_feather_mic), null, tint = tokens.secondary, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(12.dp))
                Box(Modifier.size(38.dp).clip(CircleShape).background(tokens.accent).clickable { hapticClick(); if (text.isNotBlank()) { onSubmit(text); text = "" } }, contentAlignment = Alignment.Center) { Text("↑", color = tokens.background, fontSize = 22.sp) }
            }
        }
    }
}

@Composable
fun SheetScrim(onDismiss: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.34f)).clickable { hapticClick(); onDismiss() })
}

@Composable
fun ColumnScope.SheetHandle(tokens: UiTokens) {
    Box(Modifier.fillMaxWidth().height(18.dp), contentAlignment = Alignment.Center) { Box(Modifier.width(44.dp).height(4.dp).clip(CircleShape).background(tokens.separator)) }
}

fun Modifier.alignBottomSheet(tokens: UiTokens, expanded: Boolean = false): Modifier {
    return fillMaxWidth().clip(RoundedCornerShape(topStart = if (expanded) 0.dp else 24.dp, topEnd = if (expanded) 0.dp else 24.dp)).background(tokens.background)
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
