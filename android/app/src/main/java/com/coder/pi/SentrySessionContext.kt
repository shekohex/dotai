package com.coder.pi

import androidx.core.net.toUri
import io.sentry.Sentry
import io.sentry.protocol.User

object SentrySessionContext {
    fun applySession(session: CoderSession) {
        Sentry.setUser(
            User().apply {
                id = session.user.id
                username = session.user.username
                email = session.user.email.takeIf { it.isNotBlank() }
                name = session.user.name?.takeIf { it.isNotBlank() }
            },
        )
        Sentry.setTag("coder.host", session.baseUrl.toUri().host.orEmpty())
        Sentry.setAttribute("coder.user_id", session.user.id)
        Sentry.setAttribute("coder.username", session.user.username)
        SentryAppLogger.info("sentry session context applied", mapOf("userId" to session.user.id, "host" to session.baseUrl.toUri().host.orEmpty()))
    }

    fun clearSession() {
        Sentry.setUser(null)
        Sentry.removeTag("coder.host")
        Sentry.removeAttribute("coder.user_id")
        Sentry.removeAttribute("coder.username")
        SentryAppLogger.info("sentry session context cleared")
    }
}
