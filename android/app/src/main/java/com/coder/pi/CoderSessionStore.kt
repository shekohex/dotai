package com.coder.pi

import android.content.Context
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID

class CoderSessionStore(context: Context) {
    private val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
    private val securePreferences = EncryptedSharedPreferences.create(
        context,
        "coder_session",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    private val localPreferences = context.getSharedPreferences("coder_workspace_state", Context.MODE_PRIVATE)

    fun loadSession(): Pair<String, String>? {
        val baseUrl = securePreferences.getString("base_url", null)
        val token = securePreferences.getString("token", null)
        return if (baseUrl.isNullOrBlank() || token.isNullOrBlank()) null else baseUrl to token
    }

    fun saveSession(baseUrl: String, token: String) {
        securePreferences.edit { putString("base_url", baseUrl).putString("token", token) }
    }

    fun clearSession() {
        securePreferences.edit { clear() }
    }

    fun workspaceState(baseUrl: String, userId: String, workspaceId: String): CoderLocalWorkspaceState {
        val key = stateKey(baseUrl, userId, workspaceId)
        return CoderLocalWorkspaceState(
            alias = localPreferences.getString("$key.alias", null),
            pinned = localPreferences.getBoolean("$key.pinned", false),
            iconUri = localPreferences.getString("$key.icon", null),
        )
    }

    fun saveAlias(baseUrl: String, userId: String, workspaceId: String, alias: String) {
        localPreferences.edit { putString("${stateKey(baseUrl, userId, workspaceId)}.alias", alias.takeIf { it.isNotBlank() }) }
    }

    fun savePinned(baseUrl: String, userId: String, workspaceId: String, pinned: Boolean) {
        localPreferences.edit { putBoolean("${stateKey(baseUrl, userId, workspaceId)}.pinned", pinned) }
    }

    fun saveIcon(baseUrl: String, userId: String, workspaceId: String, uri: String) {
        localPreferences.edit { putString("${stateKey(baseUrl, userId, workspaceId)}.icon", uri) }
    }

    fun reconnectToken(baseUrl: String, userId: String, workspaceId: String, agentId: String, ttlMillis: Long = reconnectTokenTtlMillis): CoderReconnectToken {
        val key = reconnectKey(baseUrl, userId, workspaceId, agentId)
        val now = System.currentTimeMillis()
        val existingId = localPreferences.getString("$key.id", null)
        val lastUsedAt = localPreferences.getLong("$key.last_used_at", 0L)
        val id = if (existingId != null && now - lastUsedAt <= ttlMillis) existingId else UUID.randomUUID().toString()
        localPreferences.edit { putString("$key.id", id).putLong("$key.last_used_at", now) }
        return CoderReconnectToken(id, now)
    }

    fun hideInactive(): Boolean = localPreferences.getBoolean("hide_inactive", false)

    fun saveHideInactive(value: Boolean) {
        localPreferences.edit { putBoolean("hide_inactive", value) }
    }

    fun workspaceRefreshIntervalMillis(): Long = localPreferences.getLong("workspace_refresh_interval", 60_000L)

    fun saveWorkspaceRefreshIntervalMillis(value: Long) {
        localPreferences.edit { putLong("workspace_refresh_interval", value) }
    }

    fun appendDebugLog(message: String, nowMillis: Long = System.currentTimeMillis()) {
        val safeMessage = safeDebugLogMessage(message)
        val next = (debugLogs() + "${nowMillis}|$safeMessage").takeLast(160)
        localPreferences.edit { putString("debug_logs", next.joinToString("\n")) }
    }

    fun debugLogs(): List<String> = localPreferences.getString("debug_logs", "").orEmpty().lines().filter { it.isNotBlank() }

    fun clearDebugLogs() {
        localPreferences.edit { remove("debug_logs") }
    }

    fun saveActiveTerminal(metadata: CoderActiveTerminalMetadata) {
        val prefix = activeTerminalStorageKey(metadata.baseUrl, metadata.userId, metadata.workspaceId, metadata.agentId, metadata.command)
        val keys = activeTerminalKeys().toMutableSet()
        keys.add(prefix)
        localPreferences.edit {
            putString("active_terminals", keys.joinToString("\n"))
            putString("$prefix.base_url", metadata.baseUrl)
            putString("$prefix.user_id", metadata.userId)
            putString("$prefix.workspace_id", metadata.workspaceId)
            putString("$prefix.workspace_name", metadata.workspaceName)
            putString("$prefix.agent_id", metadata.agentId)
            putString("$prefix.agent_name", metadata.agentName)
            putString("$prefix.command", metadata.command)
            putString("$prefix.reconnect_id", metadata.reconnectId)
            putLong("$prefix.updated_at", metadata.updatedAtMillis)
            putString("$prefix.preview", safePreviewText(metadata.preview).take(600))
            putBoolean("$prefix.detached", metadata.detached)
        }
    }

    fun activeTerminals(baseUrl: String, userId: String, ttlMillis: Long = reconnectTokenTtlMillis): List<CoderActiveTerminalMetadata> {
        val now = System.currentTimeMillis()
        return activeTerminalKeys().mapNotNull { prefix ->
            val metadata = CoderActiveTerminalMetadata(
                baseUrl = localPreferences.getString("$prefix.base_url", null) ?: return@mapNotNull null,
                userId = localPreferences.getString("$prefix.user_id", null) ?: return@mapNotNull null,
                workspaceId = localPreferences.getString("$prefix.workspace_id", null) ?: return@mapNotNull null,
                workspaceName = localPreferences.getString("$prefix.workspace_name", null) ?: return@mapNotNull null,
                agentId = localPreferences.getString("$prefix.agent_id", null) ?: return@mapNotNull null,
                agentName = localPreferences.getString("$prefix.agent_name", null) ?: return@mapNotNull null,
                command = localPreferences.getString("$prefix.command", null) ?: return@mapNotNull null,
                reconnectId = localPreferences.getString("$prefix.reconnect_id", null) ?: return@mapNotNull null,
                updatedAtMillis = localPreferences.getLong("$prefix.updated_at", 0L),
                preview = localPreferences.getString("$prefix.preview", "").orEmpty(),
                detached = localPreferences.getBoolean("$prefix.detached", false),
            )
            metadata.takeIf { it.baseUrl == baseUrl && it.userId == userId && now - it.updatedAtMillis <= ttlMillis }
        }.sortedByDescending { it.updatedAtMillis }
    }

    fun updateActiveTerminalDetached(baseUrl: String, userId: String, workspaceId: String, agentId: String, command: String, detached: Boolean) {
        val prefix = activeTerminalStorageKey(baseUrl, userId, workspaceId, agentId, command)
        if (!activeTerminalKeys().contains(prefix)) return
        localPreferences.edit { putBoolean("$prefix.detached", detached).putLong("$prefix.updated_at", System.currentTimeMillis()) }
    }

    fun isActiveTerminalDetached(baseUrl: String, userId: String, workspaceId: String, agentId: String, command: String): Boolean {
        val prefix = activeTerminalStorageKey(baseUrl, userId, workspaceId, agentId, command)
        return activeTerminalKeys().contains(prefix) && localPreferences.getBoolean("$prefix.detached", false)
    }

    fun removeActiveTerminal(baseUrl: String, userId: String, workspaceId: String, agentId: String, command: String) {
        val prefix = activeTerminalStorageKey(baseUrl, userId, workspaceId, agentId, command)
        val keys = activeTerminalKeys().filterNot { it == prefix }
        localPreferences.edit {
            putString("active_terminals", keys.joinToString("\n"))
            remove("$prefix.base_url")
            remove("$prefix.user_id")
            remove("$prefix.workspace_id")
            remove("$prefix.workspace_name")
            remove("$prefix.agent_id")
            remove("$prefix.agent_name")
            remove("$prefix.command")
            remove("$prefix.reconnect_id")
            remove("$prefix.updated_at")
            remove("$prefix.preview")
            remove("$prefix.detached")
        }
    }

    fun clearActiveTerminals(baseUrl: String, userId: String) {
        val matches = activeTerminals(baseUrl, userId, Long.MAX_VALUE)
        matches.forEach { removeActiveTerminal(it.baseUrl, it.userId, it.workspaceId, it.agentId, it.command) }
    }

    private fun stateKey(baseUrl: String, userId: String, workspaceId: String) = "${baseUrl.hashCode()}.$userId.$workspaceId"

    private fun reconnectKey(baseUrl: String, userId: String, workspaceId: String, agentId: String) = "${stateKey(baseUrl, userId, workspaceId)}.$agentId.reconnect"

    private fun activeTerminalKeys(): Set<String> = localPreferences.getString("active_terminals", "").orEmpty().lines().filter { it.isNotBlank() }.toSet()

    private fun activeTerminalStorageKey(baseUrl: String, userId: String, workspaceId: String, agentId: String, command: String) = activeTerminalKey(stateKey(baseUrl, userId, workspaceId), agentId, command)

    companion object {
        fun activeTerminalKey(stateKey: String, agentId: String, command: String) = "$stateKey.$agentId.${command.hashCode()}.active"

        fun safeDebugLogMessage(value: String): String {
            return value
                .replace(Regex("Coder-Session-Token=[^\\s&]+", RegexOption.IGNORE_CASE), "Coder-Session-Token=<hidden>")
                .replace(Regex("(token|password|secret|reconnect|command)=([^\\s&]+)", RegexOption.IGNORE_CASE), "$1=<hidden>")
                .replace(Regex("https?://[^\\s]+"), "<url>")
                .replace(Regex("wss?://[^\\s]+"), "<url>")
                .take(220)
        }

        fun safePreviewText(value: String): String {
            return value
                .replace(Regex("Coder-Session-Token=[^\\s&]+", RegexOption.IGNORE_CASE), "Coder-Session-Token=<hidden>")
                .replace(Regex("(token|password|secret|reconnect|command)=([^\\s&]+)", RegexOption.IGNORE_CASE), "$1=<hidden>")
                .replace(Regex("https?://[^\\s]+"), "<url>")
                .replace(Regex("wss?://[^\\s]+"), "<url>")
        }

        private const val reconnectTokenTtlMillis = 1000L * 60L * 60L * 24L * 7L
    }
}
