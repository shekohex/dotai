package com.coder.pi

import android.view.KeyEvent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.roundToInt

@Composable
fun TerminalDPadOverlay(
    expanded: Boolean,
    tokens: UiTokens,
    terminalView: CoderTerminalView,
    offset: IntOffset,
    onOffsetChanged: (IntOffset) -> Unit,
    onDragFinished: () -> Unit,
) {
    if (!expanded) return
    val visibleState = remember { MutableTransitionState(false).apply { targetState = true } }
    Popup(alignment = Alignment.BottomCenter, offset = IntOffset(offset.x, offset.y - 116), properties = PopupProperties(focusable = false)) {
        AnimatedVisibility(
            visibleState = visibleState,
            enter = fadeIn(animationSpec = spring(dampingRatio = 0.8f, stiffness = 520f)) + scaleIn(initialScale = 0.82f, animationSpec = spring(dampingRatio = 0.72f, stiffness = 420f)),
        ) {
            TerminalDPad(tokens, terminalView, Modifier, onOffsetChanged, onDragFinished)
        }
    }
}

@Composable
private fun TerminalDPad(
    tokens: UiTokens,
    terminalView: CoderTerminalView,
    modifier: Modifier,
    onOffsetChanged: (IntOffset) -> Unit,
    onDragFinished: () -> Unit,
) {
    val destructive = tokens.accent.copy(alpha = 0.42f)
    val topLeftAction = terminalView.selectedGestureAction("dpad_top_left", "backspace")
    val topRightAction = terminalView.selectedGestureAction("dpad_top_right", "ctrl_c")
    Column(modifier.width(212.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp), verticalAlignment = Alignment.CenterVertically) {
            if (topLeftAction != "hide") RepeatingDPadButton(R.drawable.ic_feather_delete, tokens.text, destructive) { terminalView.performGestureAction(topLeftAction) }
            RepeatingDPadButton(R.drawable.ic_feather_chevron_up, tokens.text, tokens.surfaceHigh) { terminalView.sendKey(KeyEvent.KEYCODE_DPAD_UP) }
            if (topRightAction != "hide") RepeatingDPadButton(R.drawable.ic_feather_trash_2, tokens.text, destructive) { terminalView.performGestureAction(topRightAction) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            RepeatingDPadButton(R.drawable.ic_feather_chevron_left, tokens.text, tokens.surfaceHigh) { terminalView.sendKey(KeyEvent.KEYCODE_DPAD_LEFT) }
            DPadIconButton(
                R.drawable.ic_feather_corner_down_left,
                tokens.text,
                tokens.surface,
                Modifier.pointerInput(Unit) {
                    detectDragGesturesAfterLongPress(
                        onDragStart = { hapticClick() },
                        onDragEnd = {
                            hapticClick()
                            onDragFinished()
                        },
                        onDragCancel = {
                            hapticClick()
                            onDragFinished()
                        },
                    ) { change, dragAmount ->
                        change.consume()
                        onOffsetChanged(IntOffset(dragAmount.x.roundToInt(), dragAmount.y.roundToInt()))
                    }
                },
            ) { terminalView.sendKey(KeyEvent.KEYCODE_ENTER) }
            RepeatingDPadButton(R.drawable.ic_feather_chevron_right, tokens.text, tokens.surfaceHigh) { terminalView.sendKey(KeyEvent.KEYCODE_DPAD_RIGHT) }
        }
        RepeatingDPadButton(R.drawable.ic_feather_chevron_down, tokens.text, tokens.surfaceHigh) { terminalView.sendKey(KeyEvent.KEYCODE_DPAD_DOWN) }
    }
}

@Composable
private fun DPadIconButton(
    icon: Int,
    color: Color,
    background: Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier.size(42.dp).clip(RoundedCornerShape(13.dp)).background(background).border(BorderStroke(1.dp, color.copy(alpha = 0.18f)), RoundedCornerShape(13.dp)).clickable {
            hapticClick()
            onClick()
        },
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(icon), null, tint = color, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun RepeatingDPadButton(
    icon: Int,
    color: Color,
    background: Color,
    onClick: () -> Unit,
) {
    var repeating by remember { mutableStateOf(false) }
    LaunchedEffect(repeating) {
        if (!repeating) return@LaunchedEffect
        var delayMillis = 320L
        while (repeating) {
            hapticClick()
            onClick()
            delay(delayMillis)
            delayMillis = (delayMillis * 0.78f).toLong().coerceAtLeast(42L)
        }
    }
    Box(
        Modifier
            .size(42.dp)
            .clip(RoundedCornerShape(13.dp))
            .background(background)
            .border(BorderStroke(1.dp, color.copy(alpha = 0.18f)), RoundedCornerShape(13.dp))
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown()
                    val upBeforeLongPress = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) { waitForUpOrCancellation() }
                    if (upBeforeLongPress != null) {
                        hapticClick()
                        onClick()
                        return@awaitEachGesture
                    }
                    hapticClick()
                    repeating = true
                    waitForUpOrCancellation()
                    repeating = false
                    hapticClick()
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(icon), null, tint = color, modifier = Modifier.size(20.dp))
    }
}
