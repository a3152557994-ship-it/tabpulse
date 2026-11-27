package com.opc.tabpulse

import android.app.Application
import android.content.ComponentCallbacks2

class TabPulseApp : Application() {
    lateinit var cookieVault: SessionCookieVault
        private set
    lateinit var repository: WatchRepository
        private set
    lateinit var monitorPool: BackgroundMonitorPool
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        NotificationHelper.ensureChannels(this)
        cookieVault = SessionCookieVault(this)
        cookieVault.enableGlobalPersistence()
        cookieVault.restoreAll()

        repository = WatchRepository(this, cookieVault)
        monitorPool = BackgroundMonitorPool(this, repository, cookieVault)
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) {
            monitorPool.trimInactiveViews()
        }
    }

    companion object {
        @Volatile
        lateinit var instance: TabPulseApp
            private set
    }
}
