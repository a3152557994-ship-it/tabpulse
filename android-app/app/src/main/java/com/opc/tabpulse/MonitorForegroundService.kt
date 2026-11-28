package com.opc.tabpulse

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

class MonitorForegroundService : Service() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var tickCount = 0

    private val repoListener: () -> Unit = {
        mainHandler.post { updateGuardianNotification() }
    }

    private val tickRunnable = object : Runnable {
        override fun run() {
            val app = TabPulseApp.instance
            val settings = app.repository.getSettings()
            if (!settings.guardianEnabled || !settings.privacyAccepted) {
                stopSelf()
                return
            }
            tickCount += 1
            val runKeepAlive = (tickCount % 6 == 0)
            app.monitorPool.warmUpWatches(runKeepAlivePing = runKeepAlive)
            app.repository.pollRemoteRelayOnce()
            updateGuardianNotification()

            val delayMs = (settings.pollIntervalSec.coerceIn(20, 300) * 1000L)
            mainHandler.postDelayed(this, delayMs)
        }
    }

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        TabPulseApp.instance.repository.addListener(repoListener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            isRunning = false
            TabPulseApp.instance.repository.updateSettings { it.copy(guardianEnabled = false) }
            TabPulseApp.instance.repository.notifyExternalStateChanged()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val app = TabPulseApp.instance
        val notif = NotificationHelper.buildGuardianNotification(
            this,
            app.repository.getWatches().size,
            app.repository.totalUnreadCount()
        )
        ServiceCompat.startForeground(
            this,
            NotificationHelper.GUARDIAN_NOTIFICATION_ID,
            notif,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
        isRunning = true
        app.repository.notifyExternalStateChanged()

        mainHandler.removeCallbacks(tickRunnable)
        mainHandler.postDelayed(tickRunnable, 1500L)
        return START_STICKY
    }

    private fun updateGuardianNotification() {
        if (!isRunning) return
        val app = TabPulseApp.instance
        val notif = NotificationHelper.buildGuardianNotification(
            this,
            app.repository.getWatches().size,
            app.repository.totalUnreadCount()
        )
        runCatching {
            NotificationManagerCompat.from(this).notify(NotificationHelper.GUARDIAN_NOTIFICATION_ID, notif)
        }
    }

    override fun onDestroy() {
        isRunning = false
        mainHandler.removeCallbacks(tickRunnable)
        TabPulseApp.instance.repository.removeListener(repoListener)
        TabPulseApp.instance.monitorPool.snapshotAllCookies()
        TabPulseApp.instance.repository.notifyExternalStateChanged()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "com.opc.tabpulse.ACTION_START_GUARDIAN"
        const val ACTION_STOP = "com.opc.tabpulse.ACTION_STOP_GUARDIAN"

        @Volatile
        var isRunning: Boolean = false
            private set

        fun start(context: Context) {
            val intent = Intent(context, MonitorForegroundService::class.java).apply {
                action = ACTION_START
            }
            runCatching {
                ContextCompat.startForegroundService(context, intent)
            }
        }

        fun stop(context: Context) {
            runCatching {
                context.stopService(Intent(context, MonitorForegroundService::class.java))
            }
        }
    }
}
