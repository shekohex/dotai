package com.coder.pi

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.compose.AsyncImagePainter
import coil.decode.SvgDecoder
import coil.request.CachePolicy
import coil.request.ImageRequest
import kotlin.math.roundToInt

@Immutable
data class CoderUiMetrics(
    val screenPadding: Dp,
    val headerHeight: Dp,
    val rowHeight: Dp,
    val rowCorner: Dp,
    val rowHorizontalPadding: Dp,
    val iconSize: Dp,
    val iconGap: Dp,
    val sheetPadding: Dp,
    val sheetHandleWidth: Dp,
    val sheetHandleHeight: Dp,
    val sheetCorner: Dp,
    val actionRevealWidth: Dp,
    val actionIconHitSize: Dp,
    val actionRailGap: Dp,
    val pillCorner: Dp,
    val pillHorizontalPadding: Dp,
    val pillVerticalPadding: Dp,
    val bodySize: TextUnit,
    val titleSize: TextUnit,
    val captionSize: TextUnit,
    val sectionSize: TextUnit,
)

@Composable
fun rememberCoderUiMetrics(): CoderUiMetrics {
    val widthDp = LocalConfiguration.current.screenWidthDp
    return remember(widthDp) {
        val compact = widthDp < 380
        CoderUiMetrics(
            screenPadding = if (compact) 16.dp else 20.dp,
            headerHeight = if (compact) 96.dp else 112.dp,
            rowHeight = if (compact) 68.dp else 76.dp,
            rowCorner = if (compact) 16.dp else 18.dp,
            rowHorizontalPadding = if (compact) 18.dp else 22.dp,
            iconSize = if (compact) 22.dp else 26.dp,
            iconGap = if (compact) 16.dp else 20.dp,
            sheetPadding = if (compact) 16.dp else 20.dp,
            sheetHandleWidth = 44.dp,
            sheetHandleHeight = 4.dp,
            sheetCorner = 24.dp,
            actionRevealWidth = if (compact) 216.dp else 252.dp,
            actionIconHitSize = if (compact) 42.dp else 48.dp,
            actionRailGap = if (compact) 10.dp else 12.dp,
            pillCorner = 10.dp,
            pillHorizontalPadding = 12.dp,
            pillVerticalPadding = 7.dp,
            bodySize = if (compact) 13.sp else 14.sp,
            titleSize = if (compact) 19.sp else 21.sp,
            captionSize = if (compact) 11.sp else 12.sp,
            sectionSize = if (compact) 11.sp else 12.sp,
        )
    }
}

@Composable
fun CoderSectionHeader(title: String, trailing: String?, tokens: UiTokens, metrics: CoderUiMetrics, onTrailingClick: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(start = metrics.screenPadding, end = metrics.screenPadding, top = metrics.screenPadding, bottom = metrics.screenPadding / 2), verticalAlignment = Alignment.CenterVertically) {
        Text(title.uppercase(), color = tokens.secondary, fontSize = metrics.sectionSize, letterSpacing = 0.6.sp, modifier = Modifier.weight(1f))
        if (trailing != null) Text(trailing.uppercase(), color = tokens.accent, fontSize = metrics.sectionSize, modifier = if (onTrailingClick == null) Modifier else Modifier.clickable { onTrailingClick() })
    }
}

@Composable
fun CoderHeaderActions(title: String, tokens: UiTokens, metrics: CoderUiMetrics, onRefresh: () -> Unit, onOpenSettings: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(metrics.headerHeight).padding(horizontal = metrics.screenPadding), verticalAlignment = Alignment.CenterVertically) {
        Text(title.uppercase(), color = tokens.text, fontSize = metrics.titleSize, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp, modifier = Modifier.weight(1f))
        CoderIconButton(R.drawable.ic_feather_rotate_ccw, tokens, metrics, onRefresh)
        Spacer(Modifier.width(metrics.iconGap))
        CoderIconButton(R.drawable.ic_feather_settings, tokens, metrics, onOpenSettings)
    }
}

@Composable
fun CoderIconButton(icon: Int, tokens: UiTokens, metrics: CoderUiMetrics, onClick: () -> Unit) {
    Box(Modifier.size(metrics.iconSize + metrics.iconGap / 2).clip(CircleShape).clickable { onClick() }, contentAlignment = Alignment.Center) {
        Icon(painterResource(icon), null, tint = tokens.secondary, modifier = Modifier.size(metrics.iconSize))
    }
}

enum class CoderActionButtonVariant { Neutral, Accent, Destructive }

data class CoderSwipeActionItem(
    val icon: Int,
    val variant: CoderActionButtonVariant,
    val onClick: () -> Unit,
)

@Composable
fun CoderWorkspaceCard(title: String, subtitle: String, iconUri: String?, iconUrl: String?, favorite: Boolean, inactive: Boolean = false, tokens: UiTokens, metrics: CoderUiMetrics, actions: List<CoderSwipeActionItem>, onOpen: () -> Unit) {
    var offsetX by remember { mutableFloatStateOf(0f) }
    val actionRevealWidth = with(LocalDensity.current) { metrics.actionRevealWidth.toPx() }
    Box(Modifier.fillMaxWidth().height(metrics.rowHeight).padding(horizontal = metrics.screenPadding, vertical = metrics.screenPadding / 5)) {
        Row(Modifier.align(Alignment.CenterEnd).width(metrics.actionRevealWidth).height(metrics.rowHeight).padding(end = metrics.rowHorizontalPadding / 2), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(metrics.actionRailGap, Alignment.End)) {
            actions.forEach { action -> CoderActionButton(action.icon, action.variant, tokens, metrics, action.onClick) }
        }
        Row(
            Modifier
                .fillMaxWidth()
                .height(metrics.rowHeight)
                .offset { IntOffset(offsetX.roundToInt(), 0) }
                .clip(RoundedCornerShape(metrics.rowCorner))
                .background(if (inactive) tokens.surface else tokens.surfaceHigh)
                .pointerInput(Unit) {
                    detectHorizontalDragGestures(
                        onDragEnd = { offsetX = if (offsetX < -actionRevealWidth / 2f) -actionRevealWidth else 0f },
                        onHorizontalDrag = { change, dragAmount ->
                            change.consume()
                            offsetX = (offsetX + dragAmount).coerceIn(-actionRevealWidth, 0f)
                        },
                    )
                }
                .clickable { if (offsetX == 0f) onOpen() else offsetX = 0f }
                .padding(horizontal = metrics.rowHorizontalPadding),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CoderWorkspaceIcon(title, iconUri, iconUrl, tokens, metrics, inactive)
            Spacer(Modifier.width(metrics.iconGap))
            Column(Modifier.weight(1f)) {
                Text(title, color = if (inactive) tokens.secondary else tokens.text, fontSize = metrics.bodySize, fontWeight = FontWeight.SemiBold)
                Text(subtitle, color = tokens.secondary.copy(alpha = if (inactive) 0.68f else 1f), fontSize = metrics.captionSize, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
fun CoderWorkspaceIcon(title: String, iconUri: String?, iconUrl: String?, tokens: UiTokens, metrics: CoderUiMetrics, inactive: Boolean = false) {
    val model = iconUri ?: iconUrl
    Box(Modifier.size(metrics.iconSize + 10.dp).clip(RoundedCornerShape(metrics.rowCorner / 2)).background(if (inactive) tokens.background else if (model.isNullOrBlank()) tokens.surface else Color(0xfff4f4f6)), contentAlignment = Alignment.Center) {
        if (model.isNullOrBlank()) {
            Text(workspaceInitials(title), color = tokens.secondary.copy(alpha = if (inactive) 0.68f else 1f), fontSize = metrics.captionSize, fontWeight = FontWeight.SemiBold)
        } else {
            Box(Modifier.alpha(if (inactive) 0.46f else 1f)) { CoderCachedImage(model, title, tokens, metrics) }
        }
    }
}

@Composable
private fun CoderCachedImage(model: String, title: String, tokens: UiTokens, metrics: CoderUiMetrics) {
    val context = LocalContext.current
    var loaded by remember(model) { mutableStateOf(false) }
    var failed by remember(model) { mutableStateOf(false) }
    val request = remember(model) {
        ImageRequest.Builder(context)
            .data(model)
            .crossfade(true)
            .memoryCachePolicy(CachePolicy.ENABLED)
            .diskCachePolicy(CachePolicy.ENABLED)
            .decoderFactory(SvgDecoder.Factory())
            .build()
    }
    Box(Modifier.size(metrics.iconSize + 2.dp).clip(RoundedCornerShape(metrics.rowCorner / 2)), contentAlignment = Alignment.Center) {
        if (!loaded && !failed) CoderImageShimmer(tokens)
        if (failed) Text(workspaceInitials(title), color = tokens.secondary, fontSize = metrics.captionSize, fontWeight = FontWeight.SemiBold)
        AsyncImage(
            model = request,
            contentDescription = null,
            onState = {
                loaded = it is AsyncImagePainter.State.Success
                failed = it is AsyncImagePainter.State.Error
            },
            modifier = Modifier.size(metrics.iconSize + 2.dp).clip(RoundedCornerShape(metrics.rowCorner / 2)),
        )
    }
}

@Composable
fun CoderShimmerBox(tokens: UiTokens, modifier: Modifier) {
    val transition = rememberInfiniteTransition(label = "coder-image-shimmer")
    val progress by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "coder-image-shimmer-progress")
    BoxWithConstraints(modifier.background(tokens.surface)) {
        val width = constraints.maxWidth.toFloat().coerceAtLeast(1f)
        val offset = width * progress * 2f
        Box(Modifier.matchParentSize().background(Brush.linearGradient(listOf(tokens.surface, tokens.surfaceHigh, tokens.surface), start = Offset(offset - width, 0f), end = Offset(offset, width))))
    }
}

@Composable
private fun CoderImageShimmer(tokens: UiTokens) {
    CoderShimmerBox(tokens, Modifier.fillMaxSize())
}

private fun workspaceInitials(title: String): String = title.split(Regex("[^A-Za-z0-9]+"))
    .filter { it.isNotBlank() }
    .take(2)
    .joinToString("") { it.first().uppercaseChar().toString() }
    .ifBlank { "?" }

@Composable
fun CoderActionButton(icon: Int, variant: CoderActionButtonVariant, tokens: UiTokens, metrics: CoderUiMetrics, onClick: () -> Unit) {
    val background = when (variant) {
        CoderActionButtonVariant.Neutral -> tokens.surfaceHigh
        CoderActionButtonVariant.Accent -> tokens.accent.copy(alpha = 0.18f)
        CoderActionButtonVariant.Destructive -> Color(0xffff5c7a).copy(alpha = 0.16f)
    }
    val tint = when (variant) {
        CoderActionButtonVariant.Neutral -> tokens.secondary
        CoderActionButtonVariant.Accent -> tokens.accent
        CoderActionButtonVariant.Destructive -> Color(0xffff5c7a)
    }
    Box(Modifier.size(metrics.actionIconHitSize).clip(CircleShape).background(background).clickable { onClick() }, contentAlignment = Alignment.Center) {
        Icon(painterResource(icon), null, tint = tint, modifier = Modifier.size(metrics.iconSize * 0.82f))
    }
}

@Composable
fun CoderSheetHandle(tokens: UiTokens, metrics: CoderUiMetrics) {
    Box(Modifier.fillMaxWidth().height(metrics.sheetPadding), contentAlignment = Alignment.Center) {
        Box(Modifier.width(metrics.sheetHandleWidth).height(metrics.sheetHandleHeight).clip(CircleShape).background(tokens.separator))
    }
}

@Composable
fun CoderPill(label: String, tokens: UiTokens, metrics: CoderUiMetrics, onClick: (() -> Unit)? = null) {
    Text(label, color = tokens.text, fontSize = metrics.bodySize, modifier = Modifier.clip(RoundedCornerShape(metrics.pillCorner)).background(tokens.surface).then(if (onClick == null) Modifier else Modifier.clickable { onClick() }).padding(horizontal = metrics.pillHorizontalPadding, vertical = metrics.pillVerticalPadding))
}
