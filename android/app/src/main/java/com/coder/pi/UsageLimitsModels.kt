package com.coder.pi

import androidx.compose.ui.graphics.Color
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt

data class UsageProviderDefinition(
    val id: String,
    val displayName: String,
    val iconRawRes: Int,
    val iconGlyph: String,
    val settingsIcon: Int,
    val authLabel: String,
    val defaultBaseUrl: String,
    val configHint: String,
)

interface UsageLimitProvider {
    val definition: UsageProviderDefinition

    suspend fun fetch(repository: UsageLimitsRepository): UsageProviderSnapshot
}

fun UsageProviderDefinition.providerConfigValue(store: UsageLimitsCredentialStore): String =
    when (id) {
        "zai" -> store.providerLabel(id)
        else -> "CLIProxy"
    }

data class UsageProviderSnapshot(
    val provider: UsageProviderDefinition,
    val plan: String?,
    val accountLabel: String?,
    val sourceLabel: String,
    val metrics: List<UsageMetricSnapshot>,
    val textLines: List<UsageTextLine>,
    val fetchedAtMillis: Long,
    val error: String? = null,
)

data class UsageMetricSnapshot(
    val label: String,
    val used: Double,
    val limit: Double,
    val resetsAt: String?,
    val periodDurationMillis: Long?,
) {
    val leftPercent: Int = (100 - ((used / limit) * 100)).roundToInt().coerceIn(0, 100)

    fun primaryLabel(displayMode: UsageDisplayMode): String =
        if (displayMode == UsageDisplayMode.Left) {
            "$leftPercent% left"
        } else {
            "${((used / limit) * 100).roundToInt().coerceIn(0, 100)}% used"
        }

    fun resetLabel(format: UsageResetTimeFormat): String =
        when (format) {
            UsageResetTimeFormat.Relative -> resetLabel(resetsAt)
            UsageResetTimeFormat.Absolute -> resetsAt?.let { absoluteInstant(it) } ?: "Resets soon"
        }

    fun paceDetails(displayMode: UsageDisplayMode): UsagePaceDetails {
        val resetMillis = resetsAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
        val durationMillis = periodDurationMillis
        if (resetMillis == null || durationMillis == null || durationMillis <= 0 || limit <= 0) return UsagePaceDetails.Empty
        val now = System.currentTimeMillis()
        val periodStart = resetMillis - durationMillis
        val elapsedMillis = now - periodStart
        if (elapsedMillis <= 0 || now >= resetMillis) return UsagePaceDetails.Empty
        val elapsedFraction = (elapsedMillis.toDouble() / durationMillis.toDouble()).coerceIn(0.0, 1.0)
        if (elapsedFraction < 0.05) return UsagePaceDetails.Empty
        val projectedUsage = if (used == 0.0) 0.0 else (used / elapsedMillis.toDouble()) * durationMillis.toDouble()
        val status =
            when {
                used >= limit || projectedUsage > limit -> UsagePaceStatus.Behind
                projectedUsage <= limit * 0.8 -> UsagePaceStatus.Ahead
                else -> UsagePaceStatus.OnTrack
            }
        val projectedPercent = ((projectedUsage / limit) * 100).roundToInt().coerceIn(0, 100)
        val shownPercent = if (displayMode == UsageDisplayMode.Left) 100 - projectedPercent else projectedPercent
        val runsOutText =
            if (status == UsagePaceStatus.Behind && projectedUsage > 0) {
                val etaMillis = ((limit - used).coerceAtLeast(0.0) / (projectedUsage / durationMillis.toDouble())).toLong()
                val remainingMillis = resetMillis - now
                if (etaMillis in 1 until remainingMillis) "Runs out in ${compactDuration(etaMillis)}" else null
            } else {
                null
            }
        return UsagePaceDetails(status, status.label, "$shownPercent% ${if (displayMode == UsageDisplayMode.Left) "left" else "used"} at reset", runsOutText, elapsedFraction.toFloat())
    }
}

enum class UsageDisplayMode { Left, Used }

enum class UsageResetTimeFormat { Relative, Absolute }

enum class UsagePaceStatus(
    val label: String,
) {
    Ahead("Plenty of room"),
    OnTrack("Right on target"),
    Behind("Will run out"),
}

data class UsagePaceDetails(
    val status: UsagePaceStatus?,
    val statusText: String?,
    val projectedText: String?,
    val runsOutText: String?,
    val elapsedFraction: Float?,
) {
    companion object {
        val Empty = UsagePaceDetails(null, null, null, null, null)
    }
}

fun UsagePaceStatus?.color(tokens: UiTokens): Color =
    when (this) {
        UsagePaceStatus.Behind -> usageDangerColor(tokens)
        UsagePaceStatus.OnTrack -> usageWarningColor(tokens)
        UsagePaceStatus.Ahead -> tokens.success
        null -> tokens.secondary
    }

fun UsageMetricSnapshot.progressColor(tokens: UiTokens): Color =
    when {
        leftPercent <= 15 -> usageDangerColor(tokens)
        leftPercent <= 35 -> usageWarningColor(tokens)
        else -> tokens.success
    }

fun usageDangerColor(tokens: UiTokens): Color = tokens.error

fun usageWarningColor(tokens: UiTokens): Color = tokens.warning

data class UsageTextLine(
    val label: String,
    val value: String,
)

data class UsageProviderAccount(
    val providerId: String,
    val fileName: String,
    val label: String,
)

private fun resetLabel(resetsAt: String?): String = resetsAt?.let { "Resets ${relativeInstant(it)}" } ?: "Resets soon"

private fun relativeInstant(value: String): String {
    val instant = runCatching { Instant.parse(value) }.getOrNull() ?: return "soon"
    val seconds = instant.epochSecond - Instant.now().epochSecond
    if (seconds <= 0) return "soon"
    val hours = seconds / 3600
    val minutes = (seconds % 3600) / 60
    val days = hours / 24
    return if (days > 0) "in ${days}d ${hours % 24}h" else "in ${hours}h ${minutes}m"
}

fun relativeTime(timeMillis: Long): String {
    val seconds = ((System.currentTimeMillis() - timeMillis) / 1000).coerceAtLeast(0)
    if (seconds < 60) return "now"
    val minutes = seconds / 60
    if (minutes < 60) return "${minutes}m ago"
    val hours = minutes / 60
    return if (hours < 24) "${hours}h ago" else DateTimeFormatter.ofPattern("MMM d").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(timeMillis))
}

fun compactNumber(value: Double): String =
    when {
        value >= 1_000_000 -> "${(value / 1_000_000.0).roundToInt()}M"
        value >= 1_000 -> "${(value / 1_000.0).roundToInt()}K"
        else -> value.roundToInt().toString()
    }

fun urlEncode(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name())

fun nextAutoRefreshMinutes(current: Int): Int {
    val options = listOf(0, 5, 15, 30, 60)
    val index = options.indexOf(current).takeIf { it >= 0 } ?: 0
    return options[(index + 1) % options.size]
}

private fun compactDuration(milliseconds: Long): String {
    val totalMinutes = (milliseconds / 60_000L).coerceAtLeast(0)
    val totalHours = totalMinutes / 60L
    val days = totalHours / 24L
    val hours = totalHours % 24L
    val minutes = totalMinutes % 60L
    return when {
        days > 0 -> "${days}d ${hours}h"
        totalHours > 0 -> "${totalHours}h ${minutes}m"
        totalMinutes > 0 -> "${totalMinutes}m"
        else -> "<1m"
    }
}

private fun absoluteInstant(value: String): String = runCatching { DateTimeFormatter.ofPattern("MMM d, h:mm a").withZone(ZoneId.systemDefault()).format(Instant.parse(value)) }.getOrDefault("Resets soon")
