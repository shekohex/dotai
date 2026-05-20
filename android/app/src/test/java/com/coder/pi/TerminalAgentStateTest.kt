package com.coder.pi

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalAgentStateTest {
    @Test
    fun updatesAllV1States() {
        val state = TerminalAgentState()

        state.apply(piEvent("hello", """{"protocol":1,"extension":"pi-osc","version":1}"""))
        state.apply(piEvent("agent.session", """{"state":"started","reason":"startup"}"""))
        state.apply(piEvent("agent.run", """{"state":"running"}"""))
        state.apply(piEvent("agent.turn", """{"state":"running","turnIndex":2}"""))
        state.apply(piEvent("agent.progress", """{"state":"active"}"""))
        state.apply(piEvent("agent.tool", """{"toolCallId":"tool-1","toolName":"bash","state":"running"}"""))
        state.apply(piEvent("agent.alert", """{"kind":"provider","title":"Rate limit","body":"HTTP 429","severity":"warning","statusCode":429}"""))
        state.apply(piEvent("agent.compaction", """{"state":"preparing"}"""))

        val snapshot = state.snapshot()
        assertEquals("evt-hello", snapshot.hello?.id)
        assertEquals("startup", snapshot.session?.reason)
        assertEquals("running", snapshot.run?.state)
        assertEquals(2L, snapshot.turn?.turnIndex)
        assertEquals("active", snapshot.progress?.state)
        assertEquals("bash", snapshot.tools.single().toolName)
        assertEquals(429L, snapshot.alerts.single().statusCode)
        assertEquals("preparing", snapshot.compaction?.state)
    }

    @Test
    fun upsertsAndBoundsToolHistory() {
        val state = TerminalAgentState(maxTools = 2)

        state.apply(piEvent("agent.tool", """{"toolCallId":"tool-1","toolName":"bash","state":"running"}"""))
        state.apply(piEvent("agent.tool", """{"toolCallId":"tool-1","toolName":"bash","state":"complete","isError":true,"label":"Bash","summary":"Failed"}"""))
        state.apply(piEvent("agent.tool", """{"toolCallId":"tool-2","toolName":"read","state":"running"}"""))
        state.apply(piEvent("agent.tool", """{"toolCallId":"tool-3","toolName":"write","state":"running"}"""))

        val tools = state.snapshot().tools
        assertEquals(listOf("tool-2", "tool-3"), tools.map { it.toolCallId })
    }

    @Test
    fun boundsAlertsAndClearsState() {
        val state = TerminalAgentState(maxAlerts = 2)

        state.apply(piEvent("agent.alert", """{"kind":"provider","title":"one","body":"body","severity":"warning"}"""))
        state.apply(piEvent("agent.alert", """{"kind":"provider","title":"two","body":"body","severity":"warning"}"""))
        state.apply(piEvent("agent.alert", """{"kind":"provider","title":"three","body":"body","severity":"warning"}"""))
        assertEquals(listOf("two", "three"), state.snapshot().alerts.map { it.title })

        state.clear()
        assertNull(state.snapshot().run)
        assertEquals(emptyList<AgentAlertState>(), state.snapshot().alerts)
    }

    @Test
    fun stateInstancesAreIsolated() {
        val first = TerminalAgentState()
        val second = TerminalAgentState()

        first.apply(piEvent("agent.run", """{"state":"running"}"""))

        assertEquals("running", first.snapshot().run?.state)
        assertNull(second.snapshot().run)
    }

    private fun piEvent(eventName: String, data: String): TerminalOscEvent.Pi {
        val envelope = PiOscEnvelope(
            id = "evt-$eventName",
            ts = 1779200000000L,
            source = "agent",
            sessionId = "session-1",
            cwd = "/workspace",
            seq = 1,
            data = Json.parseToJsonElement(data).jsonObject,
        )
        return TerminalOscEvent.Pi(1, eventName, envelope)
    }
}
