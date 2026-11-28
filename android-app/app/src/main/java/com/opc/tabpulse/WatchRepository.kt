package com.opc.tabpulse

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class WatchRepository(
    private val context: Context,
    private val cookieVault: SessionCookieVault
) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val lock = Any()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val relayExecutor = Executors.newSingleThreadExecutor()
    private val isPollingRelay = AtomicBoolean(false)

    private val watches = ArrayList<WatchItem>()
    private val messages = ArrayList<MessageRecord>()
    private var settings = AppSettings()

    val catalogCategories: List<CatalogCategory>
    val catalogPlatforms: List<CatalogPlatform>

    init {
        val (cats, plats) = loadCatalogFromAssets()
        catalogCategories = cats
        catalogPlatforms = plats
        loadState()
        ensureRelayTokenInitialized()
    }

    private fun ensureRelayTokenInitialized() {
        synchronized(lock) {
            if (!settings.relayToken.matches(Regex("^rc_[a-zA-Z0-9]{16,48}$"))) {
                settings = settings.copy(relayToken = generateFreshRelayToken())
                persistLocked()
            }
        }
    }

    private fun generateFreshRelayToken(): String {
        val raw = (UUID.randomUUID().toString() + UUID.randomUUID().toString())
            .replace("-", "")
            .lowercase()
            .take(24)
        return "rc_$raw"
    }

    fun addListener(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun removeListener(listener: () -> Unit) {
        listeners.remove(listener)
    }

    private fun notifyChanged() {
        for (l in listeners) {
            runCatching { l() }
        }
    }

    fun notifyExternalStateChanged() {
        notifyChanged()
    }

    fun getWatches(): List<WatchItem> = synchronized(lock) { watches.toList() }

    fun getWatch(id: String): WatchItem? = synchronized(lock) { watches.firstOrNull { it.id == id } }

    fun getSettings(): AppSettings = synchronized(lock) { settings }

    fun getMessages(): List<MessageRecord> = synchronized(lock) { messages.toList() }

    fun totalUnreadCount(): Int = synchronized(lock) { watches.sumOf { it.unreadCount } }

    fun acceptPrivacyPolicy() {
        synchronized(lock) {
            settings = settings.copy(privacyAccepted = true)
            persistLocked()
        }
        notifyChanged()
    }

    fun dismissRiskBanner(watchId: String) {
        synchronized(lock) {
            val nextSet = LinkedHashSet(settings.dismissedRiskIds)
            nextSet.add(watchId)
            settings = settings.copy(dismissedRiskIds = nextSet)
            persistLocked()
        }
        notifyChanged()
    }

    fun resetRelayToken(): String {
        val fresh = generateFreshRelayToken()
        synchronized(lock) {
            settings = settings.copy(relayToken = fresh, lastRelayEventId = 0L)
            persistLocked()
        }
        notifyChanged()
        return fresh
    }

    fun addFromCatalog(platformId: String): Pair<WatchItem?, Boolean> {
        val item = catalogPlatforms.firstOrNull { it.id == platformId } ?: return Pair(null, false)
        return addPlatform(
            name = item.zh.ifBlank { item.en },
            rawUrl = item.url,
            category = item.cat,
            group = item.g,
            loginHint = item.loginHint,
            desktopUa = UrlHelpers.recommendDesktopUa(item.url, settings.desktopUaDefault),
            allowDuplicate = false
        )
    }

    fun addPlatform(
        name: String,
        rawUrl: String,
        category: String = "常用平台",
        group: String = "custom",
        loginHint: String = "打开页面登录，自动持久保持",
        desktopUa: Boolean? = null,
        allowDuplicate: Boolean = false,
        initialStatus: String = "idle"
    ): Pair<WatchItem?, Boolean> {
        val normalized = UrlHelpers.normalizeHttpUrl(rawUrl) ?: return Pair(null, false)
        val cleanName = name.trim().ifBlank { UrlHelpers.extractHost(normalized) }
        val compareKey = UrlHelpers.canonicalCompareKey(normalized)

        val created: WatchItem
        var isNew = false
        synchronized(lock) {
            if (!allowDuplicate) {
                val existing = watches.firstOrNull { UrlHelpers.canonicalCompareKey(it.url) == compareKey }
                if (existing != null) {
                    return Pair(existing, false)
                }
            }
            created = WatchItem(
                id = "w_${UUID.randomUUID().toString().replace("-", "").take(10)}",
                name = cleanName,
                url = normalized,
                category = category,
                group = group,
                loginHint = loginHint,
                desktopUa = desktopUa ?: UrlHelpers.recommendDesktopUa(normalized, settings.desktopUaDefault),
                status = initialStatus,
                lastCheckedAt = if (initialStatus == "ok") System.currentTimeMillis() else 0L,
                addedAt = System.currentTimeMillis()
            )
            watches.add(created)
            isNew = true
            persistLocked()
        }
        notifyChanged()
        return Pair(created, isNew)
    }

    fun removeWatch(watchId: String, extraUrl: String = ""): WatchItem? {
        val removed = synchronized(lock) {
            val idx = watches.indexOfFirst { it.id == watchId }
            if (idx < 0) return null
            val item = watches.removeAt(idx)
            persistLocked()
            item
        }
        cookieVault.clearForWatch(removed.url, extraUrl)
        NotificationHelper.cancelWatchNotification(context, watchId)
        notifyChanged()
        return removed
    }

    fun unbindWatch(watchId: String, extraUrl: String = ""): WatchItem? {
        val updated = synchronized(lock) {
            val idx = watches.indexOfFirst { it.id == watchId }
            if (idx < 0) return null
            val cur = watches[idx]
            val next = cur.copy(
                unreadCount = 0,
                status = "auth_expired",
                snippet = "已解绑登录，随时可重新登录",
                lastCheckedAt = System.currentTimeMillis(),
                lastAuthAlertAt = System.currentTimeMillis()
            )
            watches[idx] = next
            persistLocked()
            next
        }
        cookieVault.clearForWatch(updated.url, extraUrl)
        NotificationHelper.cancelWatchNotification(context, watchId)
        notifyChanged()
        return updated
    }

    fun toggleDesktopUa(watchId: String): WatchItem? {
        val updated = synchronized(lock) {
            val idx = watches.indexOfFirst { it.id == watchId }
            if (idx < 0) return null
            val next = watches[idx].copy(desktopUa = !watches[idx].desktopUa)
            watches[idx] = next
            persistLocked()
            next
        }
        notifyChanged()
        return updated
    }

    fun toggleMute(watchId: String): WatchItem? {
        val updated = synchronized(lock) {
            val idx = watches.indexOfFirst { it.id == watchId }
            if (idx < 0) return null
            val next = watches[idx].copy(muted = !watches[idx].muted)
            watches[idx] = next
            persistLocked()
            next
        }
        notifyChanged()
        return updated
    }

    fun markWatchOpened(watchId: String) {
        NotificationHelper.cancelWatchNotification(context, watchId)
    }

    fun updateSettings(mutator: (AppSettings) -> AppSettings): AppSettings {
        val updated = synchronized(lock) {
            settings = mutator(settings)
            persistLocked()
            settings
        }
        notifyChanged()
        return updated
    }

    fun clearMessageFeed() {
        synchronized(lock) {
            messages.clear()
            persistLocked()
        }
        notifyChanged()
    }

    /**
     * Zero-QR Cloud Relay Poller: pulls overseas server / Claude Code (CC) completion alerts!
     */
    fun pollRemoteRelayOnce(force: Boolean = false) {
        val snap = synchronized(lock) { settings }
        if (!snap.privacyAccepted || (!force && !snap.relayEnabled) || snap.relayToken.isBlank()) return
        if (!isPollingRelay.compareAndSet(false, true)) return

        relayExecutor.execute {
            try {
                val url = URL("$EDGE_ORIGIN/api/relay/pull/${snap.relayToken}?since=${snap.lastRelayEventId}")
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 7000
                    readTimeout = 7000
                    setRequestProperty("Accept", "application/json")
                }
                val code = conn.responseCode
                if (code == 200) {
                    val raw = conn.inputStream.bufferedReader().use { it.readText() }
                    val obj = JSONObject(raw)
                    val arr = obj.optJSONArray("events") ?: JSONArray()
                    val latestId = obj.optLong("latestId", snap.lastRelayEventId)

                    val freshAlerts = ArrayList<Triple<Long, String, String>>()
                    var changed = false
                    synchronized(lock) {
                        // Ensure token wasn't reset while request was in flight
                        if (settings.relayToken == snap.relayToken) {
                            var maxSeen = settings.lastRelayEventId
                            for (i in 0 until arr.length()) {
                                val ev = arr.getJSONObject(i)
                                val id = ev.optLong("id", 0L)
                                if (id <= settings.lastRelayEventId) continue
                                val title = ev.optString("title", "🤖 海外 CC 完工提醒")
                                val body = ev.optString("body", "任务已完成")
                                val src = ev.optString("source", "cc")
                                val ts = ev.optLong("createdAt", System.currentTimeMillis())
                                if (id > maxSeen) maxSeen = id
                                prependMessageLocked(
                                    MessageRecord(
                                        id = "cc_${id}_${ts}",
                                        watchId = "",
                                        watchName = title,
                                        unreadCount = if (src == "user-cmd") 0 else 1,
                                        snippet = body,
                                        kind = if (src == "user-cmd") "cc_user" else "cc",
                                        timestamp = ts
                                    )
                                )
                                if (src != "user-cmd") {
                                    freshAlerts.add(Triple(id, title, body))
                                }
                                changed = true
                            }
                            if (latestId > maxSeen) maxSeen = latestId
                            if (maxSeen > settings.lastRelayEventId) {
                                settings = settings.copy(lastRelayEventId = maxSeen)
                                changed = true
                            }
                            if (changed) persistLocked()
                        }
                    }

                    if (freshAlerts.isNotEmpty()) {
                        val quiet = !force && isQuietHourNow(getSettings().nightQuietEnabled)
                        if (!quiet) {
                            for ((id, title, body) in freshAlerts) {
                                NotificationHelper.notifyRemoteRelayEvent(context, id, title, body)
                            }
                        }
                        notifyChanged()
                    }
                }
                conn.disconnect()
            } catch (_: Throwable) {
                // Silent network retry on next tick
            } finally {
                isPollingRelay.set(false)
            }
        }
    }

    fun sendSelfTestRelayPing(onResult: (Boolean) -> Unit) {
        val snap = synchronized(lock) { settings }
        if (!snap.privacyAccepted || snap.relayToken.isBlank()) {
            onResult(false)
            return
        }
        relayExecutor.execute {
            val ok = runCatching {
                val url = URL("$EDGE_ORIGIN/api/relay/push/${snap.relayToken}")
                val payload = JSONObject().apply {
                    put("title", "✅ 海外 CC 通道自测成功！")
                    put("body", "免扫码直连正常！把绑定命令粘到海外服务器终端后，CC 干完活就会这样响铃弹窗通知你。")
                    put("source", "self-test")
                }.toString().toByteArray(Charsets.UTF_8)

                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    connectTimeout = 8000
                    readTimeout = 8000
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setFixedLengthStreamingMode(payload.size)
                }
                conn.outputStream.use { it.write(payload) }
                val code = conn.responseCode
                conn.disconnect()
                code in 200..299
            }.getOrDefault(false)

            if (ok) {
                pollRemoteRelayOnce(force = true)
            }
            onResult(ok)
        }
    }

    fun sendRemoteCommandToCc(prompt: String, onResult: (Boolean) -> Unit) {
        val cleanPrompt = prompt.trim()
        val snap = synchronized(lock) { settings }
        if (!snap.privacyAccepted || snap.relayToken.isBlank() || cleanPrompt.isBlank()) {
            onResult(false)
            return
        }
        relayExecutor.execute {
            val ok = runCatching {
                val url = URL("$EDGE_ORIGIN/api/relay/cmd/${snap.relayToken}")
                val payload = JSONObject().apply {
                    put("prompt", cleanPrompt)
                }.toString().toByteArray(Charsets.UTF_8)

                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    connectTimeout = 8000
                    readTimeout = 8000
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setFixedLengthStreamingMode(payload.size)
                }
                conn.outputStream.use { it.write(payload) }
                val code = conn.responseCode
                conn.disconnect()
                code in 200..299
            }.getOrDefault(false)

            if (ok) {
                pollRemoteRelayOnce(force = true)
                notifyChanged()
            }
            onResult(ok)
        }
    }

    fun handlePassiveEvent(watchId: String, event: PassiveEvent) {
        val now = System.currentTimeMillis()
        var notifyMsgWatch: WatchItem? = null
        var notifyAuthWatch: WatchItem? = null

        synchronized(lock) {
            val idx = watches.indexOfFirst { it.id == watchId }
            if (idx < 0) return
            val prev = watches[idx]

            if (event.authExpired) {
                val shouldAlertAuth = settings.notifyOnAuthExpired &&
                    !prev.muted &&
                    (now - prev.lastAuthAlertAt > 6L * 3600L * 1000L) &&
                    prev.status != "idle"
                val next = prev.copy(
                    status = "auth_expired",
                    unreadCount = 0,
                    pageTitle = event.pageTitle.ifBlank { prev.pageTitle },
                    lastCheckedAt = now,
                    lastAuthAlertAt = if (shouldAlertAuth) now else prev.lastAuthAlertAt
                )
                watches[idx] = next
                if (shouldAlertAuth) {
                    notifyAuthWatch = next
                    prependMessageLocked(
                        MessageRecord(
                            id = "m_${now}_${watchId}",
                            watchId = watchId,
                            watchName = next.name,
                            unreadCount = 0,
                            snippet = "需要重新登录以继续保持收消息",
                            kind = "auth",
                            timestamp = now
                        )
                    )
                }
                persistLocked()
            } else {
                val triggerAlert = UrlHelpers.shouldTriggerMessageAlert(
                    muted = prev.muted,
                    prevUnread = prev.unreadCount,
                    newUnread = event.unreadCount,
                    prevSnippet = prev.snippet,
                    newSnippet = event.snippet,
                    eventType = event.event
                )
                val next = prev.copy(
                    status = if (event.unreadCount > 0) "unread" else "ok",
                    unreadCount = event.unreadCount,
                    snippet = if (event.unreadCount > 0) {
                        event.snippet.ifBlank { prev.snippet }
                    } else {
                        ""
                    },
                    pageTitle = event.pageTitle.ifBlank { prev.pageTitle },
                    lastCheckedAt = now,
                    lastEventAt = if (triggerAlert) now else prev.lastEventAt
                )
                watches[idx] = next
                if (triggerAlert) {
                    notifyMsgWatch = next
                    prependMessageLocked(
                        MessageRecord(
                            id = "m_${now}_${watchId}",
                            watchId = watchId,
                            watchName = next.name,
                            unreadCount = next.unreadCount,
                            snippet = next.snippet.ifBlank { "收到 ${next.unreadCount} 条新消息" },
                            kind = "message",
                            timestamp = now
                        )
                    )
                }
                persistLocked()
            }
        }

        val quietNow = isQuietHourNow(settings.nightQuietEnabled)
        notifyMsgWatch?.let { w ->
            if (!quietNow) {
                NotificationHelper.notifyIncomingMessage(context, w, w.unreadCount, w.snippet)
            }
        }
        notifyAuthWatch?.let { w ->
            if (!quietNow) {
                NotificationHelper.notifyAuthExpired(context, w)
            }
        }

        notifyChanged()
    }

    fun isQuietHourNow(nightQuietEnabled: Boolean): Boolean {
        if (!nightQuietEnabled) return false
        val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        return hour >= 23 || hour < 7
    }

    fun buildStateJson(
        guardianRunning: Boolean,
        notificationsGranted: Boolean,
        batteryWhitelisted: Boolean
    ): String {
        return synchronized(lock) {
            val root = JSONObject()
            root.put("version", "5.8.0")
            root.put("edgeOrigin", EDGE_ORIGIN)
            root.put("guardianRunning", guardianRunning)
            root.put("notificationsGranted", notificationsGranted)
            root.put("batteryWhitelisted", batteryWhitelisted)
            root.put("totalUnread", watches.sumOf { it.unreadCount })
            root.put("settings", settings.toJson())

            val wArr = JSONArray()
            watches.forEach { w ->
                val obj = w.toJson()
                obj.put("hasSavedCookie", cookieVault.hasSavedSession(w.url))
                wArr.put(obj)
            }
            root.put("watches", wArr)

            val mArr = JSONArray()
            messages.take(40).forEach { mArr.put(it.toJson()) }
            root.put("messages", mArr)

            root.toString()
        }
    }

    fun buildCatalogJson(): String {
        val root = JSONObject()
        val cArr = JSONArray()
        catalogCategories.forEach { cArr.put(it.toJson()) }
        val pArr = JSONArray()
        catalogPlatforms.forEach { pArr.put(it.toJson()) }
        root.put("categories", cArr)
        root.put("platforms", pArr)
        return root.toString()
    }

    private fun prependMessageLocked(rec: MessageRecord) {
        messages.add(0, rec)
        while (messages.size > 60) {
            messages.removeAt(messages.size - 1)
        }
    }

    private fun loadState() {
        synchronized(lock) {
            watches.clear()
            messages.clear()
            runCatching {
                val wRaw = prefs.getString(KEY_WATCHES, "[]") ?: "[]"
                val arr = JSONArray(wRaw)
                for (i in 0 until arr.length()) {
                    val item = WatchItem.fromJson(arr.getJSONObject(i))
                    if (item.id.isNotBlank() && item.url.isNotBlank()) {
                        watches.add(item)
                    }
                }
            }
            runCatching {
                val mRaw = prefs.getString(KEY_MESSAGES, "[]") ?: "[]"
                val arr = JSONArray(mRaw)
                for (i in 0 until arr.length()) {
                    messages.add(MessageRecord.fromJson(arr.getJSONObject(i)))
                }
            }
            runCatching {
                val sRaw = prefs.getString(KEY_SETTINGS, null)
                if (!sRaw.isNullOrBlank()) {
                    settings = AppSettings.fromJson(JSONObject(sRaw))
                }
            }
        }
    }

    private fun persistLocked() {
        val wArr = JSONArray().apply { watches.forEach { put(it.toJson()) } }
        val mArr = JSONArray().apply { messages.forEach { put(it.toJson()) } }
        prefs.edit()
            .putString(KEY_WATCHES, wArr.toString())
            .putString(KEY_MESSAGES, mArr.toString())
            .putString(KEY_SETTINGS, settings.toJson().toString())
            .apply()
    }

    private fun loadCatalogFromAssets(): Pair<List<CatalogCategory>, List<CatalogPlatform>> {
        return runCatching {
            val raw = context.assets.open("catalog.json").bufferedReader().use { it.readText() }
            val root = JSONObject(raw)
            val cats = ArrayList<CatalogCategory>()
            val cArr = root.optJSONArray("categories") ?: JSONArray()
            for (i in 0 until cArr.length()) {
                cats.add(CatalogCategory.fromJson(cArr.getJSONObject(i)))
            }
            val plats = ArrayList<CatalogPlatform>()
            val pArr = root.optJSONArray("platforms") ?: JSONArray()
            for (i in 0 until pArr.length()) {
                plats.add(CatalogPlatform.fromJson(pArr.getJSONObject(i)))
            }
            Pair(cats, plats)
        }.getOrDefault(Pair(emptyList(), emptyList()))
    }

    companion object {
        const val EDGE_ORIGIN = "https://replyradar-edge.a3152557994.workers.dev"
        private const val PREFS_NAME = "tabpulse_state"
        private const val KEY_WATCHES = "watches_v1"
        private const val KEY_MESSAGES = "messages_v1"
        private const val KEY_SETTINGS = "settings_v1"
    }
}
