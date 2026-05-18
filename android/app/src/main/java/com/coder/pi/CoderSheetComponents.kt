package com.coder.pi

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun ChatInputBar(tokens: UiTokens, autoSend: Boolean = false, modifier: Modifier = Modifier, onSubmit: (String) -> Unit, onClose: () -> Unit) {
    var text by remember { mutableStateOf("") }
    var dictating by remember { mutableStateOf(false) }
    var attachmentVisible by remember { mutableStateOf(false) }
    val submitText = {
        text.trimEnd().takeIf { it.isNotBlank() }?.let(onSubmit)
        text = ""
    }
    if (dictating) {
        DictationStubBar(tokens, modifier, { dictating = false })
        return
    }
    ChatModeDock(tokens, modifier, attachmentVisible) {
        ChatDraftField(
            text = text,
            autoSend = autoSend,
            tokens = tokens,
            attachmentVisible = attachmentVisible,
            onRemoveAttachment = { attachmentVisible = false },
            onTextChanged = { value ->
                if (autoSend && value.endsWith("\n")) {
                    value.trimEnd().takeIf { it.isNotBlank() }?.let(onSubmit)
                    text = ""
                } else {
                    text = value
                }
            },
        )
        ChatActionRail(
            tokens = tokens,
            canSend = text.isNotBlank(),
            onAttach = { hapticClick(); attachmentVisible = true },
            onClose = onClose,
            onMic = { hapticClick(); dictating = true },
            onSend = submitText,
        )
    }
}

@Composable
private fun ChatModeDock(tokens: UiTokens, modifier: Modifier, attachmentVisible: Boolean, content: @Composable ColumnScope.() -> Unit) {
    val dockHeight = if (attachmentVisible) 192.dp else 144.dp
    val contentHeight = if (attachmentVisible) 168.dp else 120.dp
    Column(modifier.fillMaxWidth().imePadding().height(dockHeight).padding(horizontal = 18.dp, vertical = 12.dp), verticalArrangement = Arrangement.Center) {
        Column(
            Modifier
                .fillMaxWidth()
                .height(contentHeight)
                .clip(RoundedCornerShape(34.dp))
                .background(tokens.surfaceHigh)
                .border(BorderStroke(0.7.dp, tokens.separator), RoundedCornerShape(34.dp))
                .padding(horizontal = 18.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.SpaceBetween,
            content = content,
        )
    }
}

@Composable
private fun ChatDraftField(text: String, autoSend: Boolean, tokens: UiTokens, attachmentVisible: Boolean, onRemoveAttachment: () -> Unit, onTextChanged: (String) -> Unit) {
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) {
        focusRequester.requestFocus()
        keyboardController?.show()
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (attachmentVisible) {
            AttachmentPreview(tokens, Modifier.align(Alignment.Start), onRemoveAttachment)
        }
        Box(Modifier.fillMaxWidth().height(42.dp).padding(horizontal = 4.dp)) {
            BasicTextField(
                value = text,
                onValueChange = onTextChanged,
                textStyle = TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace, lineHeight = 23.sp),
                modifier = Modifier.fillMaxSize().focusRequester(focusRequester).padding(horizontal = 10.dp, vertical = 8.dp),
                decorationBox = { inner ->
                    if (text.isEmpty()) Text(if (autoSend) "command..." else "message...", color = tokens.secondary.copy(alpha = 0.72f), fontSize = bodySize(), fontFamily = FontFamily.Monospace, lineHeight = 23.sp)
                    inner()
                },
            )
        }
    }
}

@Composable
private fun AttachmentPreview(tokens: UiTokens, modifier: Modifier, onRemove: () -> Unit) {
    Box(modifier.size(72.dp).clip(RoundedCornerShape(18.dp)).background(tokens.background).border(BorderStroke(0.6.dp, tokens.separator), RoundedCornerShape(18.dp)), contentAlignment = Alignment.Center) {
        Icon(painterResource(R.drawable.ic_feather_image), null, tint = tokens.secondary, modifier = Modifier.size(24.dp))
        Box(Modifier.align(Alignment.TopEnd).size(26.dp).clip(CircleShape).background(tokens.surfaceHigh).clickable { hapticClick(); onRemove() }, contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_feather_x), null, tint = tokens.text, modifier = Modifier.size(15.dp))
        }
    }
}

@Composable
private fun ChatActionRail(tokens: UiTokens, canSend: Boolean, onAttach: () -> Unit, onClose: () -> Unit, onMic: () -> Unit, onSend: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
        ChatRoundAction(R.drawable.ic_feather_plus, tokens.text, Color.Transparent, onAttach)
        Spacer(Modifier.width(10.dp))
        ChatRoundAction(R.drawable.ic_feather_x, tokens.text, Color.Transparent) {
            hapticClick()
            onClose()
        }
        Spacer(Modifier.weight(1f))
        ChatRoundAction(R.drawable.ic_feather_mic, tokens.secondary, Color.Transparent, onMic)
        Spacer(Modifier.width(12.dp))
        ChatSendAction(canSend, tokens, onSend)
    }
}

@Composable
private fun DictationStubBar(tokens: UiTokens, modifier: Modifier, onPause: () -> Unit) {
    Column(modifier.fillMaxWidth().imePadding().height(112.dp).padding(horizontal = 18.dp, vertical = 12.dp), verticalArrangement = Arrangement.Center) {
        Row(Modifier.fillMaxWidth().height(76.dp).clip(RoundedCornerShape(38.dp)).background(tokens.surfaceHigh).border(BorderStroke(0.7.dp, tokens.separator), RoundedCornerShape(38.dp)).padding(start = 24.dp, end = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            DictationMeter()
            Spacer(Modifier.width(20.dp))
            Text("Dictating...", color = tokens.text, fontSize = 22.sp, maxLines = 1)
            Spacer(Modifier.weight(1f))
            Box(Modifier.size(58.dp).clip(CircleShape).background(Color(0xfff04452)).clickable { hapticClick(); onPause() }, contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_feather_pause), null, tint = Color.White, modifier = Modifier.size(28.dp))
            }
        }
    }
}

@Composable
private fun DictationMeter() {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        listOf(15.dp, 20.dp, 24.dp, 18.dp, 22.dp).forEach { height ->
            Box(Modifier.width(7.dp).height(height).clip(RoundedCornerShape(6.dp)).background(Color(0xfff04452)))
        }
    }
}

@Composable
private fun ChatRoundAction(icon: Int, color: Color, background: Color, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).clip(CircleShape).background(background).clickable { onClick() }, contentAlignment = Alignment.Center) {
        Icon(painterResource(icon), null, tint = color, modifier = Modifier.size(25.dp))
    }
}

@Composable
private fun ChatSendAction(canSend: Boolean, tokens: UiTokens, onSend: () -> Unit) {
    val background = if (canSend) tokens.accent else Color.Transparent
    val tint = if (canSend) tokens.background else tokens.secondary
    Box(Modifier.size(44.dp).clip(CircleShape).background(background).clickable(enabled = canSend) { hapticClick(); onSend() }, contentAlignment = Alignment.Center) {
        Icon(painterResource(R.drawable.ic_feather_arrow_up), null, tint = tint, modifier = Modifier.size(27.dp))
    }
}

@Composable
fun SheetScrim(onDismiss: () -> Unit, alpha: Float = 0.34f) {
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = alpha)).clickable { hapticClick(); onDismiss() })
}

@Composable
fun ColumnScope.SheetHandle(tokens: UiTokens, onClick: (() -> Unit)? = null, dragModifier: Modifier = Modifier) {
    val modifier = if (onClick == null) Modifier.fillMaxWidth().height(18.dp) else Modifier.fillMaxWidth().height(28.dp).then(dragModifier).clickable { hapticClick(); onClick() }
    Box(modifier, contentAlignment = Alignment.Center) { Box(Modifier.width(44.dp).height(4.dp).clip(CircleShape).background(tokens.separator)) }
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
