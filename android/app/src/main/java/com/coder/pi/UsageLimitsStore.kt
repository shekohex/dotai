package com.coder.pi

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException

class UsageLimitsCredentialStore(
    context: Context,
) {
    private val appContext = context.applicationContext
    private val preferences = securePreferences(context)

    init {
        if (!preferences.contains("cliproxy.base_url")) {
            preferences.edit { putString("cliproxy.base_url", defaultCliproxyEndpoints()) }
        }
    }

    fun cliproxyBaseUrl(): String = preferences.getString("cliproxy.base_url", "").orEmpty()

    fun cliproxyBaseUrls(): List<String> = cliproxyBaseUrl().cliproxyBaseUrlAliases()

    fun cliproxyApiKey(): String = preferences.getString("cliproxy.api_key", "").orEmpty()

    fun saveCliproxy(
        baseUrls: List<String>,
        apiKey: String,
    ) = preferences.edit {
        putString(
            "cliproxy.base_url",
            baseUrls
                .mapNotNull { it.normalizeCliproxyBaseUrl() }
                .filter { it.isAllowedCliproxyEndpoint() }
                .distinct()
                .joinToString("\n"),
        )
        putString("cliproxy.api_key", apiKey.trim())
    }

    fun saveCliproxyKey(apiKey: String) = preferences.edit { apiKey.trim().takeIf { it.isNotBlank() }?.let { putString("cliproxy.api_key", it) } }

    fun saveCliproxyEndpoints(baseUrls: List<String>) =
        preferences.edit {
            putString(
                "cliproxy.base_url",
                baseUrls
                    .mapNotNull { it.normalizeCliproxyBaseUrl() }
                    .filter { it.isAllowedCliproxyEndpoint() }
                    .distinct()
                    .joinToString("\n"),
            )
        }

    fun providerApiKey(providerId: String): String = preferences.getString("provider.$providerId.api_key", "").orEmpty()

    fun providerBaseUrl(providerId: String): String = preferences.getString("provider.$providerId.base_url", "").orEmpty()

    fun saveProvider(
        providerId: String,
        apiKey: String,
        baseUrl: String,
    ) = preferences.edit {
        apiKey.trim().takeIf { it.isNotBlank() }?.let { putString("provider.$providerId.api_key", it) }
        putString("provider.$providerId.base_url", baseUrl.trim().trimEnd('/'))
    }

    fun cliproxyLabel(): String = if (cliproxyApiKey().isBlank()) "Not set" else "${cliproxyBaseUrls().size} endpoints"

    fun providerLabel(providerId: String): String = if (providerApiKey(providerId).isBlank() && providerBaseUrl(providerId).isBlank()) "Not set" else "Set"

    fun providersSummary(): String {
        val enabled = UsageLimitsRepository.providers.count { providerEnabled(it.id) }
        return "$enabled/${UsageLimitsRepository.providers.size}"
    }

    fun providerEnabled(providerId: String): Boolean = preferences.getBoolean("provider.$providerId.enabled", true)

    fun selectedAccountFile(providerId: String): String = preferences.getString("provider.$providerId.account_file", "").orEmpty()

    fun saveSelectedAccountFile(
        providerId: String,
        fileName: String,
    ) = preferences.edit { putString("provider.$providerId.account_file", fileName) }

    fun saveProviderEnabled(
        providerId: String,
        enabled: Boolean,
    ) = preferences.edit { putBoolean("provider.$providerId.enabled", enabled) }

    fun displayMode(): UsageDisplayMode = if (preferences.getString("display.mode", "left") == "used") UsageDisplayMode.Used else UsageDisplayMode.Left

    fun saveDisplayMode(mode: UsageDisplayMode) = preferences.edit { putString("display.mode", if (mode == UsageDisplayMode.Used) "used" else "left") }

    fun resetTimeFormat(): UsageResetTimeFormat = if (preferences.getString("display.reset", "relative") == "absolute") UsageResetTimeFormat.Absolute else UsageResetTimeFormat.Relative

    fun saveResetTimeFormat(format: UsageResetTimeFormat) = preferences.edit { putString("display.reset", if (format == UsageResetTimeFormat.Absolute) "absolute" else "relative") }

    fun showPace(): Boolean = preferences.getBoolean("display.show_pace", true)

    fun saveShowPace(show: Boolean) = preferences.edit { putBoolean("display.show_pace", show) }

    fun hideAccountLabels(): Boolean = preferences.getBoolean("display.hide_account_labels", false)

    fun saveHideAccountLabels(hide: Boolean) = preferences.edit { putBoolean("display.hide_account_labels", hide) }

    fun autoRefreshMinutes(): Int = preferences.getInt("display.auto_refresh_minutes", 5)

    fun saveAutoRefreshMinutes(minutes: Int) = preferences.edit { putInt("display.auto_refresh_minutes", minutes) }

    fun lastRefreshAtMillis(): Long = preferences.getLong("refresh.last_at_millis", 0L)

    fun saveLastRefreshAtMillis(value: Long) = preferences.edit { putLong("refresh.last_at_millis", value) }

    fun cacheFile(providerId: String): File = File(File(appContext.filesDir, "usage_limits_cache").apply { mkdirs() }, "$providerId.json")
}

private fun String.cliproxyBaseUrlAliases(): List<String> =
    lines()
        .mapNotNull { it.normalizeCliproxyBaseUrl() }
        .filter { it.isAllowedCliproxyEndpoint() }
        .distinct()

private fun defaultCliproxyEndpoints(): String =
    listOf(
        "http://192.168.1.116:8317",
        "http://100.100.1.116:8317",
        "https://ai-gateway.0iq.xyz/proxy",
    ).joinToString("\n")

fun String.normalizeCliproxyBaseUrl(): String? {
    val trimmed = trim()
    if (trimmed.isBlank()) return null
    val withProtocol = if (trimmed.startsWith("http://", true) || trimmed.startsWith("https://", true)) trimmed else "http://$trimmed"
    return withProtocol.trimEnd('/').removeSuffix("/v0/management").takeIf { it.isNotBlank() }
}

fun String.isAllowedCliproxyEndpoint(): Boolean {
    if (startsWith("https://", ignoreCase = true)) return true
    if (!startsWith("http://", ignoreCase = true)) return false
    val host = removePrefix("http://").substringBefore('/').substringBefore(':')
    if (host == "localhost" || host == "127.0.0.1") return true
    val parts = host.split('.').mapNotNull { it.toIntOrNull() }
    if (parts.size != 4) return false
    if (parts[0] == 10) return true
    if (parts[0] == 172 && parts[1] in 16..31) return true
    if (parts[0] == 192 && parts[1] == 168) return true
    return parts[0] == 100 && parts[1] in 64..127
}

private fun securePreferences(context: Context): SharedPreferences =
    try {
        val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(context, "usage_limits_secure", masterKey, EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    } catch (error: Exception) {
        if (error !is GeneralSecurityException && error !is IOException && error !is SecurityException && error !is IllegalStateException) throw error
        context.deleteSharedPreferences("usage_limits_secure")
        val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(context, "usage_limits_secure", masterKey, EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    }
