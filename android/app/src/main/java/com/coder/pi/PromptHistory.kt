package com.coder.pi

import android.content.Context
import androidx.core.content.edit
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID

@Serializable
data class PromptHistoryEntry(
    val id: String,
    val text: String,
    val createdAt: Long,
    val workspaceId: String = "",
    val workspaceName: String = "",
    val terminalId: String = "",
)

class PromptHistoryStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun entries(): List<PromptHistoryEntry> =
        runCatching { historyJson.decodeFromString<List<PromptHistoryEntry>>(preferences.getString(ENTRIES_KEY, "[]").orEmpty()) }
            .getOrDefault(emptyList())
            .take(retentionLimit())

    fun record(
        text: String,
        context: TerminalNotificationContext?,
        createdAt: Long = System.currentTimeMillis(),
        id: String = UUID.randomUUID().toString(),
    ) {
        val cleanText = text.trimEnd()
        if (cleanText.isBlank()) return
        val entry =
            PromptHistoryEntry(
                id = id,
                text = cleanText,
                createdAt = createdAt,
                workspaceId = context?.workspaceId.orEmpty(),
                workspaceName = context?.workspaceDisplayName?.ifBlank { context.workspaceName }.orEmpty(),
                terminalId = context?.terminalId.orEmpty(),
            )
        save(prependPromptHistory(entries(), entry, retentionLimit()))
    }

    fun delete(id: String) = save(entries().filterNot { it.id == id })

    fun clear() = save(emptyList())

    fun retentionLimit(): Int = preferences.getInt(RETENTION_KEY, DEFAULT_RETENTION).coerceIn(MIN_RETENTION, MAX_RETENTION)

    fun setRetentionLimit(limit: Int) {
        val safeLimit = limit.coerceIn(MIN_RETENTION, MAX_RETENTION)
        preferences.edit { putInt(RETENTION_KEY, safeLimit) }
        save(entries().take(safeLimit))
    }

    private fun save(entries: List<PromptHistoryEntry>) {
        preferences.edit { putString(ENTRIES_KEY, historyJson.encodeToString(entries.take(retentionLimit()))) }
    }

    companion object {
        const val DEFAULT_RETENTION = 50
        const val MIN_RETENTION = 10
        const val MAX_RETENTION = 200
        private const val PREFERENCES_NAME = "prompt_history"
        private const val ENTRIES_KEY = "entries"
        private const val RETENTION_KEY = "retention"
        private val historyJson = Json { ignoreUnknownKeys = true }
    }
}

internal fun prependPromptHistory(
    existing: List<PromptHistoryEntry>,
    entry: PromptHistoryEntry,
    limit: Int,
): List<PromptHistoryEntry> =
    buildList {
        add(entry)
        existing.filterNot { it.text == entry.text && it.workspaceId == entry.workspaceId && it.terminalId == entry.terminalId }.forEach(::add)
    }.take(limit.coerceAtLeast(0))

internal fun filterPromptHistory(
    entries: List<PromptHistoryEntry>,
    query: String,
    workspaceId: String? = null,
    terminalId: String? = null,
): List<PromptHistoryEntry> {
    val normalizedQuery = query.trim()
    return entries.filter { entry ->
        (workspaceId.isNullOrBlank() || entry.workspaceId == workspaceId) &&
            (terminalId.isNullOrBlank() || entry.terminalId == terminalId) &&
            (normalizedQuery.isBlank() || entry.text.contains(normalizedQuery, ignoreCase = true) || entry.workspaceName.contains(normalizedQuery, ignoreCase = true))
    }
}
