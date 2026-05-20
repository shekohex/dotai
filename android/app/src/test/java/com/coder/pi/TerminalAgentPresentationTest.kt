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
        val snapshot = TerminalAgentStateSnapshot(run = AgentRunState("idle", metadata()))

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
    fun usesWhimsicalStatusWhenNoSpecificActivityExists() {
        val snapshot = TerminalAgentStateSnapshot(progress = AgentProgressState("active", null, null, metadata()))

        assertEquals(TerminalAgentStatusPresentation("Pi agent", "Combobulating..."), snapshot.statusPresentation())
        assertEquals(TerminalAgentProgressPresentation(true, ""), snapshot.progressPresentation())
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

        assertEquals(TerminalAgentNotificationPresentation("Rate · limit", "HTTP 429"), alert.notificationPresentation())
    }

    @Test
    fun preservesSafeInterviewNotificationUrl() {
        val alert = AgentAlertState("interview", "Interview ready", "Tap to answer", "info", null, "http://127.0.0.1:3939/i/abc", metadata())

        assertEquals(TerminalAgentNotificationPresentation("Interview ready", "Tap to answer", "http://127.0.0.1:3939/i/abc"), alert.notificationPresentation())
    }

    private fun metadata(): AgentEventMetadata = AgentEventMetadata("id", 1, "agent", "session", "/workspace", 1)

    private fun snapshotWithTool(toolName: String): TerminalAgentStateSnapshot = TerminalAgentStateSnapshot(
        progress = AgentProgressState("active", null, null, metadata()),
        tools = listOf(AgentToolState("tool-1", toolName, "running", false, null, null, metadata())),
    )
}
