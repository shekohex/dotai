package com.coder.pi

data class TerminalHapticPattern(
    val id: String,
    val label: String,
    val timings: LongArray,
    val amplitudes: IntArray,
) {
    override fun equals(other: Any?): Boolean = other is TerminalHapticPattern && id == other.id

    override fun hashCode(): Int = id.hashCode()
}

object TerminalHapticPatterns {
    const val defaultProgressPatternId = "ripple"
    const val defaultSuccessPatternId = "success"
    const val defaultAttentionPatternId = "warning"
    const val defaultErrorPatternId = "error"

    val options =
        listOf(
            TerminalHapticPattern("none", "None", longArrayOf(0), intArrayOf(0)),
            TerminalHapticPattern("ripple", "Ripple", longArrayOf(0, 24, 60, 42, 110, 28), intArrayOf(0, 80, 0, 150, 0, 210)),
            TerminalHapticPattern("tick", "Tick", longArrayOf(0, 12), intArrayOf(0, 90)),
            TerminalHapticPattern("double_tap", "Double Tap", longArrayOf(0, 24, 70, 32), intArrayOf(0, 170, 0, 220)),
            TerminalHapticPattern("heartbeat", "Heartbeat", longArrayOf(0, 42, 110, 72, 360, 38, 110, 66), intArrayOf(0, 165, 0, 245, 0, 150, 0, 235)),
            TerminalHapticPattern("spark", "Spark", longArrayOf(0, 14, 28, 18, 28, 24, 90, 16), intArrayOf(0, 70, 0, 120, 0, 210, 0, 80)),
            TerminalHapticPattern("wave", "Wave", longArrayOf(0, 30, 45, 55, 45, 85, 45, 45, 45, 25), intArrayOf(0, 55, 0, 95, 0, 155, 0, 115, 0, 70)),
            TerminalHapticPattern("ramp", "Ramp Up", longArrayOf(0, 24, 36, 34, 36, 46, 36, 62), intArrayOf(0, 55, 0, 95, 0, 150, 0, 230)),
            TerminalHapticPattern("success", "Success", longArrayOf(0, 32, 80, 72), intArrayOf(0, 130, 0, 240)),
            TerminalHapticPattern("warning", "Warning", longArrayOf(0, 55, 70, 55, 70, 120), intArrayOf(0, 220, 0, 175, 0, 240)),
            TerminalHapticPattern("error", "Error", longArrayOf(50, 100, 50, 100, 50), intArrayOf(255, 0, 255, 0, 255)),
            TerminalHapticPattern("heavy", "Heavy", longArrayOf(0, 95), intArrayOf(0, 255)),
            TerminalHapticPattern("buzz", "Buzz", longArrayOf(0, 28, 35, 28, 35, 28), intArrayOf(0, 190, 0, 190, 0, 190)),
            TerminalHapticPattern("typewriter", "Typewriter", longArrayOf(0, 10, 38, 10, 38, 10, 38, 24), intArrayOf(0, 105, 0, 105, 0, 105, 0, 170)),
        )

    fun option(id: String): TerminalHapticPattern = options.firstOrNull { it.id == id } ?: option(defaultProgressPatternId)

    fun next(id: String): TerminalHapticPattern {
        val index = options.indexOfFirst { it.id == id }.takeIf { it >= 0 } ?: 0
        return options[(index + 1) % options.size]
    }
}
