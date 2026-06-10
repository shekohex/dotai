package com.coder.pi

import kotlinx.coroutines.CancellationException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.nio.channels.ClosedChannelException

object AppFailureClassifier {
    fun isExpectedCancellation(error: Throwable): Boolean = error.anyCause { it is CancellationException }

    fun isTransientNetwork(error: Throwable): Boolean =
        error.anyCause {
            it is UnknownHostException ||
                it is SocketTimeoutException ||
                it is ConnectException ||
                it is NoRouteToHostException ||
                it is ClosedChannelException ||
                it is SocketException && it.message.orEmpty().contains("connection abort", ignoreCase = true)
        }

    fun shouldCapture(error: Throwable): Boolean = !isExpectedCancellation(error) && !isTransientNetwork(error)

    private fun Throwable.anyCause(matches: (Throwable) -> Boolean): Boolean {
        var current: Throwable? = this
        while (current != null) {
            if (matches(current)) return true
            current = current.cause
        }
        return false
    }
}
