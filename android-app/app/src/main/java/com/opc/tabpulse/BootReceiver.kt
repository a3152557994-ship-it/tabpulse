package com.opc.tabpulse

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            val app = context.applicationContext as? TabPulseApp ?: return
            val settings = app.repository.getSettings()
            if (settings.guardianEnabled && app.repository.getWatches().isNotEmpty()) {
                MonitorForegroundService.start(context)
            }
        }
    }
}
