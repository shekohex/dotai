package com.coder.pi

import android.util.Log
import io.sentry.Sentry
import io.sentry.SentryAttributes
import io.sentry.SentryLevel
import io.sentry.SentryLogLevel
import io.sentry.logger.SentryLogParameters
import kotlinx.coroutines.CancellationException

object SentryAppLogger {
    private const val Tag = "CoderPi"

    fun debug(
        message: String,
        attributes: Map<String, Any?> = emptyMap(),
    ) = log(SentryLogLevel.DEBUG, message, attributes)

    fun info(
        message: String,
        attributes: Map<String, Any?> = emptyMap(),
    ) = log(SentryLogLevel.INFO, message, attributes)

    fun warn(
        message: String,
        attributes: Map<String, Any?> = emptyMap(),
        throwable: Throwable? = null,
    ) = log(SentryLogLevel.WARN, message, attributes, throwable)

    fun error(
        message: String,
        attributes: Map<String, Any?> = emptyMap(),
        throwable: Throwable? = null,
        capture: Boolean = true,
    ) {
        log(SentryLogLevel.ERROR, message, attributes, throwable)
        if (capture && throwable != null && throwable !is CancellationException) {
            Sentry.captureException(throwable)
        }
    }

    private fun log(
        level: SentryLogLevel,
        message: String,
        attributes: Map<String, Any?>,
        throwable: Throwable? = null,
    ) {
        val sanitizedAttributes = sanitizeAttributes(attributes, throwable)
        val parameters = SentryLogParameters.create(SentryAttributes.fromMap(sanitizedAttributes)).apply { origin = "app" }
        Sentry.logger().log(level, parameters, message.take(240))
        addBreadcrumb(level, message, sanitizedAttributes)
        logcat(level, message, throwable)
    }

    private fun sanitizeAttributes(
        attributes: Map<String, Any?>,
        throwable: Throwable?,
    ): Map<String, Any> =
        buildMap {
            attributes.forEach { (key, value) ->
                if (value != null) put(key, sanitizeAttributeValue(value))
            }
            if (throwable != null) {
                put("exception.type", throwable::class.java.name)
                throwable.message?.takeIf { it.isNotBlank() }?.let { put("exception.message", it.take(300)) }
            }
        }

    private fun sanitizeAttributeValue(value: Any): Any =
        when (value) {
            is Boolean, is Int, is Long, is Float, is Double -> value
            else -> value.toString().take(300)
        }

    private fun addBreadcrumb(
        level: SentryLogLevel,
        message: String,
        attributes: Map<String, Any>,
    ) {
        val breadcrumbLevel =
            when (level) {
                SentryLogLevel.TRACE, SentryLogLevel.DEBUG -> SentryLevel.DEBUG
                SentryLogLevel.INFO -> SentryLevel.INFO
                SentryLogLevel.WARN -> SentryLevel.WARNING
                SentryLogLevel.ERROR -> SentryLevel.ERROR
                SentryLogLevel.FATAL -> SentryLevel.FATAL
            }
        SentryBreadcrumbs.log(message, attributes, breadcrumbLevel)
    }

    private fun logcat(
        level: SentryLogLevel,
        message: String,
        throwable: Throwable?,
    ) {
        when (level) {
            SentryLogLevel.TRACE, SentryLogLevel.DEBUG -> Log.d(Tag, message, throwable)
            SentryLogLevel.INFO -> Log.i(Tag, message, throwable)
            SentryLogLevel.WARN -> Log.w(Tag, message, throwable)
            SentryLogLevel.ERROR, SentryLogLevel.FATAL -> Log.e(Tag, message, throwable)
        }
    }
}
