package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CoderActiveSessionUiTest {
    @Test
    fun relativeSessionTimeFormatsHumanIntervals() {
        val now = 100_000L

        assertEquals("now", relativeSessionTime(now - 1_000L, now))
        assertEquals("12s ago", relativeSessionTime(now - 12_000L, now))
        assertEquals("3m ago", relativeSessionTime(now - 180_000L, now))
        assertEquals("2h ago", relativeSessionTime(now - 7_200_000L, now))
        assertEquals("2d ago", relativeSessionTime(now - 172_800_000L, now))
    }

    @Test
    fun tmuxSessionLabelExtractsNameAndAcronym() {
        assertEquals("main", tmuxSessionLabel("tmux attach-session -t 'main'"))
        assertEquals("PS", tmuxSessionLabel("tmux attach -t 'production-shell'"))
        assertNull(tmuxSessionLabel("sh"))
    }
}
