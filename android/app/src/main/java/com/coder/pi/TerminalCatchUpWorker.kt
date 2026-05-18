package com.coder.pi

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

class TerminalCatchUpWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val store = CoderSessionStore(applicationContext)
        if (store.loadSession() == null) return Result.success()
        ContextCompat.startForegroundService(applicationContext, Intent(applicationContext, TerminalConnectionService::class.java))
        store.appendDebugLog("terminal catch-up requested foreground terminal service")
        return Result.success()
    }

    companion object {
        private const val WorkName = "terminal_catch_up"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<TerminalCatchUpWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(WorkName, ExistingPeriodicWorkPolicy.UPDATE, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WorkName)
        }
    }
}
