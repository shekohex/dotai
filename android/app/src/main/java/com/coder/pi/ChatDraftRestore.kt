package com.coder.pi

fun appendRestoredChatDraft(currentDraft: String, restoredDraft: String): String {
    if (restoredDraft.isBlank()) return currentDraft
    if (currentDraft.isBlank()) return restoredDraft
    return currentDraft.trimEnd() + "\n\n" + restoredDraft.trimStart()
}
