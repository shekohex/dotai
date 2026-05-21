package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalAgentPresentationTest {
    @Test
    fun prefersActiveToolForStatus() {
        val snapshot = TerminalAgentStateSnapshot(
            run = AgentRunState("running", metadata()),
            progress = AgentProgressState("active", null, null, metadata()),
            tools = listOf(AgentToolState("tool-1", "bash", "running", false, null, null, metadata())),
        )

        assertEquals(TerminalAgentStatusPresentation("Pi agent", "Bashing"), snapshot.statusPresentation())
    }

    @Test
    fun mapsToolNamesToAgentActivityText() {
        assertEquals("Bashing", snapshotWithTool("bash").statusPresentation()?.subtitle)
        assertEquals("Reading code", snapshotWithTool("read").statusPresentation()?.subtitle)
        assertEquals("Exploring code", snapshotWithTool("rg").statusPresentation()?.subtitle)
        assertEquals("Editing files", snapshotWithTool("apply_patch").statusPresentation()?.subtitle)
        assertEquals("Reviewing", snapshotWithTool("review").statusPresentation()?.subtitle)
    }

    @Test
    fun clearsStatusWhenAgentIdle() {
        val snapshot = TerminalAgentStateSnapshot(
            run = AgentRunState("idle", metadata()),
            tools = listOf(AgentToolState("tool-1", "read", "complete", false, "Reading foo.ts", "Read foo.ts", metadata())),
        )

        assertNull(snapshot.statusPresentation())
    }

    @Test
    fun clearsStatusWhenProgressClears() {
        val snapshot = TerminalAgentStateSnapshot(
            run = AgentRunState("running", metadata()),
            progress = AgentProgressState("clear", null, null, metadata()),
            tools = listOf(AgentToolState("tool-1", "read", "complete", false, "Reading foo.ts", "Read foo.ts", metadata())),
        )

        assertNull(snapshot.statusPresentation())
    }

    @Test
    fun mapsProgressToPiAgentProgressState() {
        assertEquals(TerminalAgentProgressPresentation(true), AgentProgressState("active", null, null, metadata()).progressPresentation())
        assertEquals(TerminalAgentProgressPresentation(false), AgentProgressState("clear", null, null, metadata()).progressPresentation())
        assertEquals(TerminalAgentProgressPresentation(false), AgentRunState("idle", metadata()).progressPresentation())
        assertNull(AgentRunState("running", metadata()).progressPresentation())
    }

    @Test
    fun mapsSnapshotProgressToAgentActivityText() {
        val snapshot = TerminalAgentStateSnapshot(
            progress = AgentProgressState("active", null, null, metadata()),
            tools = listOf(AgentToolState("tool-1", "apply_patch", "running", false, null, null, metadata())),
        )

        assertEquals(TerminalAgentProgressPresentation(true, "Editing files"), snapshot.progressPresentation())
    }

    @Test
    fun activeToolDrivesProgressWithoutRunState() {
        val snapshot = TerminalAgentStateSnapshot(
            tools = listOf(AgentToolState("tool-1", "read", "running", false, "Reading foo.ts", null, metadata())),
        )

        assertEquals(TerminalAgentProgressPresentation(true, "Reading foo.ts"), snapshot.progressPresentation())
    }

    @Test
    fun failedToolCompletionShowsFailure() {
        val snapshot = TerminalAgentStateSnapshot(
            progress = AgentProgressState("active", null, null, metadata()),
            tools = listOf(AgentToolState("tool-1", "read", "complete", true, "Reading foo.ts", "Read foo.ts", metadata())),
        )

        assertEquals(TerminalAgentProgressPresentation(true, "Read foo.ts failed"), snapshot.progressPresentation())
    }

    @Test
    fun includesFileNameInGenericCompletionSummaryWhenLabelHasContext() {
        val snapshot = TerminalAgentStateSnapshot(
            progress = AgentProgressState("active", null, null, metadata()),
            tools = listOf(AgentToolState("tool-1", "read", "complete", false, "Reading foo.ts", "Read file", metadata())),
        )

        assertEquals(TerminalAgentStatusPresentation("Pi agent", "Read foo.ts"), snapshot.statusPresentation())
        assertEquals(TerminalAgentProgressPresentation(true, "Read foo.ts"), snapshot.progressPresentation())
    }

    @Test
    fun ignoresProgressClearWhileAgentRunIsStillActive() {
        val snapshot = TerminalAgentStateSnapshot(
            run = AgentRunState("running", metadata()),
            progress = AgentProgressState("clear", null, null, metadata()),
        )

        assertEquals(TerminalAgentProgressPresentation(true, "Thinking"), snapshot.progressPresentation())
    }

    @Test
    fun showsThinkingStatusWhenNoSpecificActivityExists() {
        val snapshot = TerminalAgentStateSnapshot(progress = AgentProgressState("active", null, null, metadata()))

        assertEquals(TerminalAgentStatusPresentation("Pi agent", "Thinking"), snapshot.statusPresentation())
        assertEquals(TerminalAgentProgressPresentation(true, "Thinking"), snapshot.progressPresentation())
    }

    @Test
    fun showsGoalElapsedTimeInProgress() {
        val snapshot = TerminalAgentStateSnapshot(progress = AgentProgressState("active", null, 65, metadata()))

        assertEquals(TerminalAgentStatusPresentation("Pi agent", "Goal active · 1m 5s"), snapshot.statusPresentation())
        assertEquals(TerminalAgentProgressPresentation(true, "Goal active · 1m 5s", 65), snapshot.progressPresentation())
    }

    @Test
    fun sanitizesAlertNotificationText() {
        val alert = AgentAlertState("provider", "Rate\nlimit", "HTTP\t429", "warning", 429, null, metadata())

        assertEquals(TerminalAgentNotificationPresentation("Rate · limit", "HTTP 429", severity = "warning", kind = "provider"), alert.notificationPresentation())
    }

    @Test
    fun preservesSafeInterviewNotificationUrl() {
        val alert = AgentAlertState("interview", "Interview ready", "Tap to answer", "info", null, "http://127.0.0.1:3939/i/abc", metadata())

        assertEquals(TerminalAgentNotificationPresentation("Interview ready", "Tap to answer", "http://127.0.0.1:3939/i/abc", "info", "interview"), alert.notificationPresentation())
    }

    private fun metadata(): AgentEventMetadata = AgentEventMetadata("id", 1, "agent", "session", "/workspace", 1)

    private fun snapshotWithTool(toolName: String): TerminalAgentStateSnapshot = TerminalAgentStateSnapshot(
        progress = AgentProgressState("active", null, null, metadata()),
        tools = listOf(AgentToolState("tool-1", toolName, "running", false, null, null, metadata())),
    )
}
