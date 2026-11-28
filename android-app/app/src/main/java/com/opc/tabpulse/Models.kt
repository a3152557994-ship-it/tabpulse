package com.opc.tabpulse

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder
import java.util.Locale

data class CatalogCategory(
    val id: String,
    val labelZh: String,
    val labelEn: String
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("labelZh", labelZh)
        put("labelEn", labelEn)
    }

    companion object {
        fun fromJson(obj: JSONObject): CatalogCategory = CatalogCategory(
            id = obj.optString("id", "all"),
            labelZh = obj.optString("labelZh", ""),
            labelEn = obj.optString("labelEn", "")
        )
    }
}

data class CatalogPlatform(
    val id: String,
    val g: String,
    val hot: Boolean,
    val niche: Boolean,
    val zh: String,
    val en: String,
    val url: String,
    val cat: String,
    val tier: String,
    val loginHint: String,
    val kw: String
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("g", g)
        put("hot", hot)
        put("niche", niche)
        put("zh", zh)
        put("en", en)
        put("url", url)
        put("cat", cat)
        put("tier", tier)
        put("loginHint", loginHint)
        put("kw", kw)
        put("highRiskSingleEnd", UrlHelpers.isHighRiskSingleEndPlatform(zh, url))
    }

    companion object {
        fun fromJson(obj: JSONObject): CatalogPlatform = CatalogPlatform(
            id = obj.optString("id", ""),
            g = obj.optString("g", "social"),
            hot = obj.optBoolean("hot", false),
            niche = obj.optBoolean("niche", false),
            zh = obj.optString("zh", ""),
            en = obj.optString("en", ""),
            url = obj.optString("url", ""),
            cat = obj.optString("cat", "常用平台"),
            tier = obj.optString("tier", "yellow"),
            loginHint = obj.optString("loginHint", "打开页面登录，自动持久保持"),
            kw = obj.optString("kw", "")
        )
    }
}

data class WatchItem(
    val id: String,
    val name: String,
    val url: String,
    val category: String = "常用平台",
    val group: String = "custom",
    val loginHint: String = "支持扫码、验证码或账号密码登录",
    val desktopUa: Boolean = true,
    val unreadCount: Int = 0,
    val status: String = "idle", // idle | ok | unread | auth_expired | loading
    val snippet: String = "",
    val pageTitle: String = "",
    val lastEventAt: Long = 0L,
    val lastCheckedAt: Long = 0L,
    val lastAuthAlertAt: Long = 0L,
    val muted: Boolean = false,
    val addedAt: Long = System.currentTimeMillis()
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("name", name)
        put("url", url)
        put("category", category)
        put("group", group)
        put("loginHint", loginHint)
        put("desktopUa", desktopUa)
        put("unreadCount", unreadCount)
        put("status", status)
        put("snippet", snippet)
        put("pageTitle", pageTitle)
        put("lastEventAt", lastEventAt)
        put("lastCheckedAt", lastCheckedAt)
        put("lastAuthAlertAt", lastAuthAlertAt)
        put("muted", muted)
        put("addedAt", addedAt)
        put("highRiskSingleEnd", UrlHelpers.isHighRiskSingleEndPlatform(name, url))
    }

    companion object {
        fun fromJson(obj: JSONObject): WatchItem = WatchItem(
            id = obj.optString("id", ""),
            name = obj.optString("name", "未命名平台"),
            url = obj.optString("url", ""),
            category = obj.optString("category", "常用平台"),
            group = obj.optString("group", "custom"),
            loginHint = obj.optString("loginHint", "支持扫码、验证码或账号密码登录"),
            desktopUa = obj.optBoolean("desktopUa", true),
            unreadCount = obj.optInt("unreadCount", 0),
            status = obj.optString("status", "idle"),
            snippet = obj.optString("snippet", ""),
            pageTitle = obj.optString("pageTitle", ""),
            lastEventAt = obj.optLong("lastEventAt", 0L),
            lastCheckedAt = obj.optLong("lastCheckedAt", 0L),
            lastAuthAlertAt = obj.optLong("lastAuthAlertAt", 0L),
            muted = obj.optBoolean("muted", false),
            addedAt = obj.optLong("addedAt", System.currentTimeMillis())
        )
    }
}

data class MessageRecord(
    val id: String,
    val watchId: String,
    val watchName: String,
    val unreadCount: Int,
    val snippet: String,
    val kind: String, // message | auth | cc
    val timestamp: Long
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("watchId", watchId)
        put("watchName", watchName)
        put("unreadCount", unreadCount)
        put("snippet", snippet)
        put("kind", kind)
        put("timestamp", timestamp)
    }

    companion object {
        fun fromJson(obj: JSONObject): MessageRecord = MessageRecord(
            id = obj.optString("id", ""),
            watchId = obj.optString("watchId", ""),
            watchName = obj.optString("watchName", ""),
            unreadCount = obj.optInt("unreadCount", 0),
            snippet = obj.optString("snippet", ""),
            kind = obj.optString("kind", "message"),
            timestamp = obj.optLong("timestamp", System.currentTimeMillis())
        )
    }
}

data class AppSettings(
    val privacyAccepted: Boolean = false,
    val guardianEnabled: Boolean = true,
    val pollIntervalSec: Int = 45,
    val desktopUaDefault: Boolean = true,
    val nightQuietEnabled: Boolean = false,
    val notifyOnAuthExpired: Boolean = true,
    val maxLiveTabs: Int = 5,
    val relayEnabled: Boolean = true,
    val relayToken: String = "",
    val lastRelayEventId: Long = 0L,
    val dismissedRiskIds: Set<String> = emptySet(),
    val companionUrl: String = ""
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("privacyAccepted", privacyAccepted)
        put("guardianEnabled", guardianEnabled)
        put("pollIntervalSec", pollIntervalSec)
        put("desktopUaDefault", desktopUaDefault)
        put("nightQuietEnabled", nightQuietEnabled)
        put("notifyOnAuthExpired", notifyOnAuthExpired)
        put("maxLiveTabs", maxLiveTabs)
        put("relayEnabled", relayEnabled)
        put("relayToken", relayToken)
        put("lastRelayEventId", lastRelayEventId)
        put("dismissedRiskIds", JSONArray().apply { dismissedRiskIds.forEach { put(it) } })
        put("companionUrl", companionUrl)
    }

    companion object {
        fun fromJson(obj: JSONObject): AppSettings {
            val dismissed = LinkedHashSet<String>()
            val arr = obj.optJSONArray("dismissedRiskIds")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val v = arr.optString(i, "")
                    if (v.isNotBlank()) dismissed.add(v)
                }
            }
            return AppSettings(
                privacyAccepted = obj.optBoolean("privacyAccepted", false),
                guardianEnabled = obj.optBoolean("guardianEnabled", true),
                pollIntervalSec = obj.optInt("pollIntervalSec", 45).coerceIn(15, 300),
                desktopUaDefault = obj.optBoolean("desktopUaDefault", true),
                nightQuietEnabled = obj.optBoolean("nightQuietEnabled", false),
                notifyOnAuthExpired = obj.optBoolean("notifyOnAuthExpired", true),
                maxLiveTabs = obj.optInt("maxLiveTabs", 5).coerceIn(2, 8),
                relayEnabled = obj.optBoolean("relayEnabled", true),
                relayToken = obj.optString("relayToken", ""),
                lastRelayEventId = obj.optLong("lastRelayEventId", 0L),
                dismissedRiskIds = dismissed,
                companionUrl = obj.optString("companionUrl", "")
            )
        }
    }
}

data class PassiveEvent(
    val event: String,
    val authExpired: Boolean,
    val unreadCount: Int,
    val snippet: String,
    val pageTitle: String
) {
    companion object {
        fun fromJsonString(raw: String): PassiveEvent? = runCatching {
            val obj = JSONObject(raw)
            PassiveEvent(
                event = obj.optString("event", "mutation"),
                authExpired = obj.optBoolean("authExpired", false),
                unreadCount = obj.optInt("unreadCount", 0).coerceAtLeast(0),
                snippet = obj.optString("snippet", "").trim().take(160),
                pageTitle = obj.optString("pageTitle", "").trim().take(120)
            )
        }.getOrNull()
    }
}

object UrlHelpers {
    private val MULTI_PART_TLDS = setOf(
        "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
        "co.uk", "org.uk", "co.jp", "com.hk", "com.tw", "com.sg", "com.au"
    )

    private val MOBILE_FIRST_HOSTS = setOf(
        "m.weibo.cn", "mobile.twitter.com", "m.toutiao.com", "m.bilibili.com"
    )

    private val HIGH_RISK_DOMAINS = listOf(
        "goofish.com", "taobao.com", "tmall.com", "1688.com", "alibaba.com",
        "pinduoduo.com", "yangkeduo.com", "jinritemai.com", "douyin.com",
        "xiaohongshu.com", "zhipin.com", "weixin.qq.com", "kuaishou.com",
        "weibo.com", "weibo.cn", "zhihu.com", "58.com", "liepin.com", "lagou.com"
    )

    private val HIGH_RISK_NAMES = listOf(
        "闲鱼", "千牛", "淘宝", "天猫", "拼多多", "抖店", "飞鸽", "抖音",
        "小红书", "BOSS", "微信", "视频号", "公众号", "快手", "微博", "知乎"
    )

    private val SEARCH_ENGINE_HOSTS = listOf(
        "bing.com", "baidu.com", "sogou.com", "so.com", "google.com"
    )

    fun isHighRiskSingleEndPlatform(name: String, rawUrl: String): Boolean {
        val host = extractHost(rawUrl)
        if (HIGH_RISK_DOMAINS.any { host == it || host.endsWith(".$it") }) return true
        val lowerName = name.lowercase(Locale.ROOT)
        return HIGH_RISK_NAMES.any { lowerName.contains(it.lowercase(Locale.ROOT)) }
    }

    fun isSearchEnginePage(rawUrl: String): Boolean {
        val host = extractHost(rawUrl)
        if (host.isBlank()) return true
        return SEARCH_ENGINE_HOSTS.any { host == it || host.endsWith(".$it") }
    }

    fun buildSearchOfficialUrl(keyword: String): String {
        val q = "${keyword.trim()} 官网 登录"
        val enc = runCatching { URLEncoder.encode(q, "UTF-8") }.getOrDefault(keyword.trim())
        return "https://cn.bing.com/search?q=$enc"
    }

    /**
     * Extracts (titleHint, normalizedUrl) from messy shared strings like:
     * "【转转卖家后台】快来查看 https://seller.zhuanzhuan.com/ 立即点击"
     */
    fun extractFirstHttpUrl(rawText: String): Pair<String, String>? {
        val text = rawText.trim()
        if (text.isEmpty()) return null
        val regex = Regex("https?://[^\\s\"'<>\\u3000\\uff0c\\u3002\\uff01\\uff1b）)\\]]+", RegexOption.IGNORE_CASE)
        val match = regex.find(text) ?: return null
        val rawUrl = match.value.trimEnd('.', ',', ';', ')', ']', '！', '。', '，')
        val normalized = normalizeHttpUrl(rawUrl) ?: return null

        val leftover = text.replace(match.value, " ")
            .replace(Regex("[【】\\[\\]《》<>「」]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(24)
        val titleHint = leftover.ifBlank { extractHost(normalized).removePrefix("www.") }
        return Pair(titleHint, normalized)
    }

    fun cleanCapturedPageTitle(rawTitle: String?, rawUrl: String): String {
        val t = (rawTitle ?: "").trim()
            .replace(Regex("\\s*[-_|—·]\\s*(登录|首页|官方网站|官网|Sign in|Log in).*$", RegexOption.IGNORE_CASE), "")
            .trim()
            .take(28)
        return t.ifBlank { extractHost(rawUrl).removePrefix("www.").ifBlank { "自定义平台" } }
    }

    fun normalizeHttpUrl(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        val candidate = if (trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true)
        ) {
            trimmed
        } else {
            "https://$trimmed"
        }
        val viaUri = runCatching {
            val uri = URI(candidate)
            val scheme = uri.scheme?.lowercase(Locale.ROOT)
            val host = uri.host?.lowercase(Locale.ROOT)
            if ((scheme == "http" || scheme == "https") && !host.isNullOrBlank() && host.contains(".")) {
                candidate
            } else null
        }.getOrNull()
        if (viaUri != null) return viaUri

        return runCatching {
            val u = java.net.URL(candidate)
            val scheme = u.protocol?.lowercase(Locale.ROOT)
            val host = u.host?.lowercase(Locale.ROOT)
            if ((scheme == "http" || scheme == "https") && !host.isNullOrBlank() && host.contains(".")) {
                candidate
            } else null
        }.getOrNull()
    }

    fun extractHost(rawUrl: String): String {
        val h1 = runCatching { URI(rawUrl).host?.lowercase(Locale.ROOT).orEmpty() }.getOrDefault("")
        if (h1.isNotBlank()) return h1
        return runCatching { java.net.URL(rawUrl).host?.lowercase(Locale.ROOT).orEmpty() }.getOrDefault("")
    }

    fun extractOrigin(rawUrl: String): String {
        val o1 = runCatching {
            val uri = URI(rawUrl)
            val scheme = uri.scheme?.lowercase(Locale.ROOT)
            val host = uri.host?.lowercase(Locale.ROOT)
            if (!scheme.isNullOrBlank() && !host.isNullOrBlank()) {
                val port = if (uri.port > 0 && uri.port != 80 && uri.port != 443) ":${uri.port}" else ""
                "$scheme://$host$port"
            } else ""
        }.getOrDefault("")
        if (o1.isNotBlank()) return o1

        return runCatching {
            val u = java.net.URL(rawUrl)
            val scheme = u.protocol?.lowercase(Locale.ROOT) ?: return@runCatching ""
            val host = u.host?.lowercase(Locale.ROOT) ?: return@runCatching ""
            if (host.isBlank()) return@runCatching ""
            val port = if (u.port > 0 && u.port != 80 && u.port != 443) ":${u.port}" else ""
            "$scheme://$host$port"
        }.getOrDefault("")
    }

    fun extractRootDomain(host: String): String {
        val clean = host.trim().lowercase(Locale.ROOT).trimEnd('.')
        if (clean.isEmpty()) return ""
        if (clean.matches(Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+$")) || !clean.contains('.')) {
            return clean
        }
        val parts = clean.split('.').filter { it.isNotBlank() }
        if (parts.size <= 2) return clean
        val lastTwo = "${parts[parts.size - 2]}.${parts[parts.size - 1]}"
        return if (MULTI_PART_TLDS.contains(lastTwo) && parts.size >= 3) {
            "${parts[parts.size - 3]}.$lastTwo"
        } else {
            lastTwo
        }
    }

    fun recommendDesktopUa(rawUrl: String, defaultDesktop: Boolean): Boolean {
        val host = extractHost(rawUrl)
        if (MOBILE_FIRST_HOSTS.any { host == it || host.endsWith(".$it") }) return false
        return defaultDesktop
    }

    fun canonicalCompareKey(rawUrl: String): String {
        val k1 = runCatching {
            val uri = URI(rawUrl.trim())
            val host = uri.host?.lowercase(Locale.ROOT)?.removePrefix("www.").orEmpty()
            if (host.isNotBlank()) {
                val path = (uri.path ?: "").trimEnd('/')
                "$host$path"
            } else ""
        }.getOrDefault("")
        if (k1.isNotBlank()) return k1

        return runCatching {
            val u = java.net.URL(rawUrl.trim())
            val host = u.host?.lowercase(Locale.ROOT)?.removePrefix("www.").orEmpty()
            val path = (u.path ?: "").trimEnd('/')
            if (host.isNotBlank()) "$host$path" else rawUrl.trim().lowercase(Locale.ROOT)
        }.getOrDefault(rawUrl.trim().lowercase(Locale.ROOT))
    }

    fun buildPromotedCookieHeader(name: String, value: String, rootDomain: String?, secure: Boolean): String {
        val sb = StringBuilder()
        sb.append(name).append("=").append(value)
        sb.append("; Path=/; Max-Age=31536000")
        if (!rootDomain.isNullOrBlank()) {
            sb.append("; Domain=.").append(rootDomain)
        }
        if (secure) {
            sb.append("; Secure")
        }
        return sb.toString()
    }

    fun buildExpiredCookieHeader(name: String, rootDomain: String?, secure: Boolean): String {
        val sb = StringBuilder()
        sb.append(name).append("=; Path=/; Max-Age=0")
        if (!rootDomain.isNullOrBlank()) {
            sb.append("; Domain=.").append(rootDomain)
        }
        if (secure || name.startsWith("__Secure-") || name.startsWith("__Host-")) {
            sb.append("; Secure")
        }
        return sb.toString()
    }

    fun parseCookiePairs(cookieHeader: String?): Map<String, String> {
        if (cookieHeader.isNullOrBlank()) return emptyMap()
        val result = LinkedHashMap<String, String>()
        cookieHeader.split(';').forEach { segment ->
            val trimmed = segment.trim()
            val eqIdx = trimmed.indexOf('=')
            if (eqIdx > 0) {
                val k = trimmed.substring(0, eqIdx).trim()
                val v = trimmed.substring(eqIdx + 1).trim()
                if (k.isNotEmpty()) {
                    result[k] = v
                }
            }
        }
        return result
    }

    fun shouldTriggerMessageAlert(
        muted: Boolean,
        prevUnread: Int,
        newUnread: Int,
        prevSnippet: String,
        newSnippet: String,
        eventType: String
    ): Boolean {
        if (muted || newUnread <= 0) return false
        if (newUnread > prevUnread) return true
        if (eventType == "notification" && newSnippet.isNotBlank() && newSnippet != prevSnippet) return true
        return false
    }

    fun jsonArrayOfStrings(items: List<String>): JSONArray = JSONArray().apply {
        items.forEach { put(it) }
    }
}
