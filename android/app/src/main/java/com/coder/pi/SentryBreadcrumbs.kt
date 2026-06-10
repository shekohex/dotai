package com.coder.pi

import io.sentry.Breadcrumb
import io.sentry.Sentry
import io.sentry.SentryLevel

object SentryBreadcrumbs {
    fun app(message: String, data: Map<String, Any?> = emptyMap()) = add("app", message, data = data)

    fun api(message: String, data: Map<String, Any?> = emptyMap()) = add("api", message, data = data)

    fun terminal(message: String, data: Map<String, Any?> = emptyMap(), level: SentryLevel = SentryLevel.INFO) = add("terminal", message, level, data)

    fun speech(message: String, data: Map<String, Any?> = emptyMap(), level: SentryLevel = SentryLevel.INFO) = add("speech", message, level, data)

    fun notification(message: String, data: Map<String, Any?> = emptyMap(), level: SentryLevel = SentryLevel.INFO) = add("notification", message, level, data)

    fun feedback(message: String, data: Map<String, Any?> = emptyMap()) = add("feedback", message, data = data)

    fun log(message: String, data: Map<String, Any?> = emptyMap(), level: SentryLevel = SentryLevel.INFO) = add("log", message, level, data)

    private fun add(
        category: String,
        message: String,
        level: SentryLevel = SentryLevel.INFO,
        data: Map<String, Any?> = emptyMap(),
    ) {
        val breadcrumb = Breadcrumb().apply {
            this.category = category
            this.message = message.take(120)
            this.level = level
            data.forEach { (key, value) -> if (value != null) setData(key, value.toString().take(160)) }
        }
        Sentry.addBreadcrumb(breadcrumb)
    }
}
