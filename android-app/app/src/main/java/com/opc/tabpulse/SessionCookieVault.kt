package com.opc.tabpulse

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebStorage
import org.json.JSONObject

/**
 * Persists & promotes session-only cookies per host so logged-in platforms stay signed in
 * across process kills and device reboots, without cross-subdomain collisions or overwriting
 * live rotated tokens, until the user explicitly taps "解绑".
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
            val domainPairs = if (rootDomain.isNotBlank() && rootDomain != host && !isIpv4(rootDomain)) {
                UrlHelpers.parseCookiePairs(cm.getCookie("https://$rootDomain/"))
            } else {
                emptyMap()
            }
            val originPairs = LinkedHashMap<String, String>()
            originPairs.putAll(UrlHelpers.parseCookiePairs(cm.getCookie(origin)))
            originPairs.putAll(UrlHelpers.parseCookiePairs(cm.getCookie(rawUrl)))

            // Separate host-only cookies from root-domain cookies to prevent duplicate Cookie headers
            val hostOnlyPairs = LinkedHashMap<String, String>()
            for ((k, v) in originPairs) {
                if (domainPairs[k] != v) {
                    hostOnlyPairs[k] = v
                }
            }
            if (hostOnlyPairs.isEmpty() && domainPairs.isEmpty()) return

            val entryObj = JSONObject().apply {
                put("origin", origin)
                put("host", host)
                put("rootDomain", rootDomain)
                put("updatedAt", System.currentTimeMillis())
                put("hostOnlyCookies", JSONObject().apply { hostOnlyPairs.forEach { (k, v) -> put(k, v) } })
                put("domainCookies", JSONObject().apply { domainPairs.forEach { (k, v) -> put(k, v) } })
            }

            prefs.edit().putString(vaultKey(host), entryObj.toString()).apply()
            cm.flush()
        }
    }

    fun restoreForUrl(rawUrl: String) {
        val host = UrlHelpers.extractHost(rawUrl)
        if (host.isBlank()) return
        val savedRaw = prefs.getString(vaultKey(host), null) ?: return
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
            if (origin.isBlank() || host.isBlank()) return

            val secure = origin.startsWith("https://", ignoreCase = true)
            val cm = CookieManager.getInstance()

            // Only seed cookies that are currently MISSING in CookieManager (never clobber live rotated sessions!)
            val liveOriginCookies = UrlHelpers.parseCookiePairs(cm.getCookie(origin))
            val hostOnlyObj = obj.optJSONObject("hostOnlyCookies")
            if (hostOnlyObj != null) {
                val keys = hostOnlyObj.keys()
                while (keys.hasNext()) {
                    val name = keys.next()
                    val value = hostOnlyObj.optString(name, "")
                    if (name.isBlank() || liveOriginCookies.containsKey(name)) continue
                    cm.setCookie(origin, UrlHelpers.buildPromotedCookieHeader(name, value, null, secure))
                }
            }

            val domainObj = obj.optJSONObject("domainCookies")
            if (domainObj != null && rootDomain.isNotBlank() && !isIpv4(rootDomain)) {
                val rootUrl = "https://$rootDomain/"
                val liveDomainCookies = UrlHelpers.parseCookiePairs(cm.getCookie(rootUrl))
                val keys = domainObj.keys()
                while (keys.hasNext()) {
                    val name = keys.next()
                    val value = domainObj.optString(name, "")
                    if (name.isBlank() || liveDomainCookies.containsKey(name) || liveOriginCookies.containsKey(name)) continue
                    cm.setCookie(rootUrl, UrlHelpers.buildPromotedCookieHeader(name, value, rootDomain, true))
                }
            }
            cm.flush()
        }
    }

    /**
     * Explicit user unbind: removes vaulted session cookies + expires active cookies (including
     * __Secure- / __Host- prefixed cookies) + clears origin storage for both base and redirected URLs.
     */
    fun clearForWatch(rawUrl: String, extraUrl: String = "") {
        val urls = listOf(rawUrl, extraUrl).map { it.trim() }.filter { it.isNotBlank() }.distinct()
        for (u in urls) {
            clearSingleUrl(u)
        }
        runCatching { CookieManager.getInstance().flush() }
    }

    private fun clearSingleUrl(rawUrl: String) {
        val origin = UrlHelpers.extractOrigin(rawUrl)
        val host = UrlHelpers.extractHost(rawUrl)
        if (host.isBlank()) return
        val rootDomain = UrlHelpers.extractRootDomain(host)
        val entryKey = vaultKey(host)

        val cookieNames = LinkedHashSet<String>()
        runCatching {
            val savedRaw = prefs.getString(entryKey, null)
            if (savedRaw != null) {
                val obj = JSONObject(savedRaw)
                for (field in listOf("hostOnlyCookies", "domainCookies", "cookies")) {
                    val sub = obj.optJSONObject(field) ?: continue
                    val it = sub.keys()
                    while (it.hasNext()) cookieNames.add(it.next())
                }
            }
        }
        prefs.edit().remove(entryKey).apply()

        val secure = origin.startsWith("https://", ignoreCase = true)
        runCatching {
            val cm = CookieManager.getInstance()
            val targets = linkedSetOf(rawUrl)
            if (origin.isNotBlank()) targets.add(origin)
            val rootUrl = if (rootDomain.isNotBlank() && !isIpv4(rootDomain)) "https://$rootDomain/" else ""
            if (rootUrl.isNotBlank()) targets.add(rootUrl)

            for (t in targets) {
                cookieNames.addAll(UrlHelpers.parseCookiePairs(cm.getCookie(t)).keys)
            }
            for (name in cookieNames) {
                val hostExpire = UrlHelpers.buildExpiredCookieHeader(name, null, secure)
                if (origin.isNotBlank()) cm.setCookie(origin, hostExpire)
                cm.setCookie(rawUrl, hostExpire)
                // Also expire non-secure variant for http fallback
                if (secure) {
                    if (origin.isNotBlank()) cm.setCookie(origin, UrlHelpers.buildExpiredCookieHeader(name, null, false))
                }
                if (rootDomain.isNotBlank() && !isIpv4(rootDomain) && !name.startsWith("__Host-")) {
                    val domExpireSecure = UrlHelpers.buildExpiredCookieHeader(name, rootDomain, true)
                    val domExpirePlain = UrlHelpers.buildExpiredCookieHeader(name, rootDomain, false)
                    cm.setCookie(rootUrl, domExpireSecure)
                    cm.setCookie(rootUrl, domExpirePlain)
                    if (origin.isNotBlank()) {
                        cm.setCookie(origin, domExpireSecure)
                        cm.setCookie(origin, domExpirePlain)
                    }
                }
            }
        }

        if (origin.isNotBlank()) {
            runCatching { WebStorage.getInstance().deleteOrigin(origin) }
        }
    }

    fun hasSavedSession(rawUrl: String): Boolean {
        val host = UrlHelpers.extractHost(rawUrl)
        if (host.isBlank()) return false
        return prefs.contains(vaultKey(host))
    }

    private fun isIpv4(host: String): Boolean = host.matches(Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+$"))

    private fun vaultKey(host: String): String = "$KEY_PREFIX${host.lowercase()}"

    companion object {
        private const val PREFS_NAME = "tabpulse_cookie_vault_v2"
        private const val KEY_PREFIX = "host_"
    }
}
