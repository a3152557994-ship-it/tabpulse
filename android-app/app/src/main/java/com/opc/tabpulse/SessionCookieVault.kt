package com.opc.tabpulse

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebStorage
import org.json.JSONObject

/**
 * Persists & promotes session-only cookies so logged-in platforms stay signed in
 * across process kills and device reboots, until the user explicitly taps "解绑".
 */
class SessionCookieVault(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun enableGlobalPersistence() {
        runCatching {
            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.flush()
        }
    }

    fun snapshotForUrl(rawUrl: String) {
        val origin = UrlHelpers.extractOrigin(rawUrl)
        val host = UrlHelpers.extractHost(rawUrl)
        if (origin.isBlank() || host.isBlank()) return
        val rootDomain = UrlHelpers.extractRootDomain(host)

        runCatching {
            val cm = CookieManager.getInstance()
            val merged = LinkedHashMap<String, String>()
            val targets = linkedSetOf(rawUrl, origin)
            if (rootDomain.isNotBlank() && rootDomain != host) {
                targets.add("https://$rootDomain/")
            }
            for (target in targets) {
                val raw = cm.getCookie(target)
                merged.putAll(UrlHelpers.parseCookiePairs(raw))
            }
            if (merged.isEmpty()) return

            val entryKey = vaultKey(rootDomain.ifBlank { host })
            val existingObj = runCatching {
                JSONObject(prefs.getString(entryKey, "{}") ?: "{}")
            }.getOrDefault(JSONObject())
            val cookiesObj = existingObj.optJSONObject("cookies") ?: JSONObject()
            for ((k, v) in merged) {
                cookiesObj.put(k, v)
            }
            existingObj.put("origin", origin)
            existingObj.put("host", host)
            existingObj.put("rootDomain", rootDomain)
            existingObj.put("updatedAt", System.currentTimeMillis())
            existingObj.put("cookies", cookiesObj)

            prefs.edit().putString(entryKey, existingObj.toString()).apply()
            cm.flush()
        }
    }

    fun restoreForUrl(rawUrl: String) {
        val host = UrlHelpers.extractHost(rawUrl)
        if (host.isBlank()) return
        val rootDomain = UrlHelpers.extractRootDomain(host)
        val entryKey = vaultKey(rootDomain.ifBlank { host })
        val savedRaw = prefs.getString(entryKey, null) ?: return
        restoreEntry(savedRaw)
    }

    fun restoreAll() {
        runCatching {
            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            for ((k, v) in prefs.all) {
                if (k.startsWith(KEY_PREFIX) && v is String) {
                    restoreEntry(v)
                }
            }
            cm.flush()
        }
    }

    private fun restoreEntry(savedRaw: String) {
        runCatching {
            val obj = JSONObject(savedRaw)
            val origin = obj.optString("origin", "")
            val host = obj.optString("host", "")
            val rootDomain = obj.optString("rootDomain", "")
            val cookiesObj = obj.optJSONObject("cookies") ?: return
            if (origin.isBlank()) return

            val secure = origin.startsWith("https://", ignoreCase = true)
            val cm = CookieManager.getInstance()
            val keys = cookiesObj.keys()
            while (keys.hasNext()) {
                val name = keys.next()
                val value = cookiesObj.optString(name, "")
                if (name.isBlank()) continue
                val hostHeader = UrlHelpers.buildPromotedCookieHeader(name, value, null, secure)
                cm.setCookie(origin, hostHeader)
                if (rootDomain.isNotBlank() && rootDomain != host && !rootDomain.matches(Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+$"))) {
                    val domainHeader = UrlHelpers.buildPromotedCookieHeader(name, value, rootDomain, secure)
                    cm.setCookie("https://$rootDomain/", domainHeader)
                }
            }
            cm.flush()
        }
    }

    /**
     * Explicit user unbind: removes vaulted session cookies + expires active cookies + clears origin storage.
     */
    fun clearForWatch(rawUrl: String) {
        val origin = UrlHelpers.extractOrigin(rawUrl)
        val host = UrlHelpers.extractHost(rawUrl)
        val rootDomain = UrlHelpers.extractRootDomain(host)
        val entryKey = vaultKey(rootDomain.ifBlank { host })

        val cookieNames = LinkedHashSet<String>()
        runCatching {
            val savedRaw = prefs.getString(entryKey, null)
            if (savedRaw != null) {
                val cookiesObj = JSONObject(savedRaw).optJSONObject("cookies")
                if (cookiesObj != null) {
                    val it = cookiesObj.keys()
                    while (it.hasNext()) cookieNames.add(it.next())
                }
            }
        }
        prefs.edit().remove(entryKey).apply()

        runCatching {
            val cm = CookieManager.getInstance()
            val targets = linkedSetOf<String>()
            if (rawUrl.isNotBlank()) targets.add(rawUrl)
            if (origin.isNotBlank()) targets.add(origin)
            if (rootDomain.isNotBlank()) targets.add("https://$rootDomain/")
            for (t in targets) {
                cookieNames.addAll(UrlHelpers.parseCookiePairs(cm.getCookie(t)).keys)
            }
            for (name in cookieNames) {
                for (t in targets) {
                    cm.setCookie(t, "$name=; Path=/; Max-Age=0")
                }
                if (rootDomain.isNotBlank() && !rootDomain.matches(Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+$"))) {
                    cm.setCookie("https://$rootDomain/", "$name=; Domain=.$rootDomain; Path=/; Max-Age=0")
                    if (origin.isNotBlank()) {
                        cm.setCookie(origin, "$name=; Domain=.$rootDomain; Path=/; Max-Age=0")
                    }
                }
            }
            cm.flush()
        }

        if (origin.isNotBlank()) {
            runCatching { WebStorage.getInstance().deleteOrigin(origin) }
        }
    }

    fun hasSavedSession(rawUrl: String): Boolean {
        val host = UrlHelpers.extractHost(rawUrl)
        if (host.isBlank()) return false
        val rootDomain = UrlHelpers.extractRootDomain(host)
        return prefs.contains(vaultKey(rootDomain.ifBlank { host }))
    }

    private fun vaultKey(domain: String): String = "$KEY_PREFIX${domain.lowercase()}"

    companion object {
        private const val PREFS_NAME = "tabpulse_cookie_vault"
        private const val KEY_PREFIX = "dom_"
    }
}
