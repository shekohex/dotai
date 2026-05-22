package com.coder.pi

data class PendingChatSubmitStash(
    val text: String,
    val baselineSeq: Long?,
)

fun appendRestoredChatDraft(
    currentDraft: String,
    restoredDraft: String,
): String {
    if (restoredDraft.isBlank()) return currentDraft
    if (currentDraft.isBlank()) return restoredDraft
    return currentDraft.trimEnd() + "\n\n" + restoredDraft.trimStart()
}

fun TerminalAgentStateSnapshot.latestAgentSeq(): Long? =
    listOfNotNull(
        hello?.seq,
        session?.event?.seq,
        run?.event?.seq,
        turn?.event?.seq,
        progress?.event?.seq,
        compaction?.event?.seq,
        tools.maxOfOrNull { it.event.seq ?: Long.MIN_VALUE }?.takeIf { it != Long.MIN_VALUE },
        alerts.maxOfOrNull { it.event.seq ?: Long.MIN_VALUE }?.takeIf { it != Long.MIN_VALUE },
    ).maxOrNull()

fun observedAgentEventAcceptsPendingSubmit(
    pending: PendingChatSubmitStash,
    eventSeq: Long?,
): Boolean {
    val baseline = pending.baselineSeq ?: return true
    return eventSeq == null || eventSeq > baseline
}
