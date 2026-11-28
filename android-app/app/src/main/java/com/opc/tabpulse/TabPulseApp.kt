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

    @Volatile
    private var cookiesRestored = false

    override fun onCreate() {
        super.onCreate()
        instance = this
        NotificationHelper.ensureChannels(this)
        cookieVault = SessionCookieVault(this)
        repository = WatchRepository(this, cookieVault)
        monitorPool = BackgroundMonitorPool(this, repository, cookieVault)

        // Store privacy compliance: only initialize CookieManager after user accepts privacy policy!
        if (repository.getSettings().privacyAccepted) {
            ensureCookiesInitialized()
        }
    }

    fun ensureCookiesInitialized() {
        if (cookiesRestored) return
        cookiesRestored = true
        cookieVault.enableGlobalPersistence()
        cookieVault.restoreAll()
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
