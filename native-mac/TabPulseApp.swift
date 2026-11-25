import Cocoa
import CryptoKit
import Foundation
import UserNotifications
import WebKit
#if MAS_BUILD
import StoreKit
#else
import Network
#endif

func resolveSpintaxSwift(_ raw: String) -> String {
    guard let regex = try? NSRegularExpression(pattern: "\\{([^{}]+)\\}") else { return raw }
    var result = raw
    while let match = regex.firstMatch(in: result, range: NSRange(result.startIndex..., in: result)),
          let fullRange = Range(match.range(at: 0), in: result),
          let innerRange = Range(match.range(at: 1), in: result) {
        let options = result[innerRange]
            .split(separator: "|")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let chosen = options.randomElement() ?? ""
        result.replaceSubrange(fullRange, with: chosen)
    }
    return result
}

let SAFARI_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15"

enum WebhookDispatcher {
    static func normalizePushInput(_ raw: String) -> (mode: String, target: String) {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return ("none", "") }
        if s.uppercased().hasPrefix("SCT") && !s.contains("/") {
            return ("serverchan", "https://sctapi.ftqq.com/\(s).send")
        }
        if s.range(of: "^[0-9a-fA-F]{32}$", options: .regularExpression) != nil {
            return ("pushplus", s)
        }
        if s.range(of: "^[A-Za-z0-9]{20,28}$", options: .regularExpression) != nil && !s.hasPrefix("TP1") {
            return ("bark", "https://api.day.app/\(s)")
        }
        if s.hasPrefix("http://") || s.hasPrefix("https://") {
            return ("url", s)
        }
        return ("invalid", "")
    }

    private static func evaluatePushResponse(data: Data?, resp: URLResponse?, err: Error?, channel: String) -> (Bool, String, String) {
        if let e = err { return (false, channel, e.localizedDescription) }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code < 200 || code >= 300 { return (false, channel, "HTTP \(code)") }
        if let d = data, let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
            if (channel == "PushPlus" || channel == "Bark"), let c = obj["code"] as? Int, c != 200 {
                let m = (obj["msg"] as? String) ?? (obj["message"] as? String) ?? "\(channel) 错误 (\(c))"
                return (false, channel, m)
            }
            if (channel == "Server酱" || channel == "飞书"), let c = obj["code"] as? Int, c != 0 {
                let m = (obj["message"] as? String) ?? (obj["msg"] as? String) ?? "\(channel) 错误 (\(c))"
                return (false, channel, m)
            }
            if let ec = obj["errcode"] as? Int, ec != 0 {
                let m = (obj["errmsg"] as? String) ?? "\(channel) 错误 (\(ec))"
                return (false, channel, m)
            }
        }
        return (true, channel, "")
    }

    static func send(webhookUrlStr: String, siteName: String, unreadCount: Int, snippet: String, siteUrl: String, completion: ((Bool, String, String) -> Void)? = nil) {
        let norm = normalizePushInput(webhookUrlStr)
        if norm.mode == "none" {
            completion?(false, "none", "未填写推送口令")
            return
        }
        if norm.mode == "invalid" {
            completion?(false, "invalid", "格式不正确：请粘贴 32 位 PushPlus 口令、SCT SendKey、Bark 码或 https:// 链接")
            return
        }
        let title = isChineseSystem
            ? "🔔【消息总管】\(siteName) 有 \(unreadCount) 条新消息"
            : "🔔 [ReplyRadar] \(unreadCount) new unread in \(siteName)"
        let cleanSnippet = snippet.isEmpty ? siteUrl : "\(snippet)\n\(siteUrl)"
        let fullText = "\(title)\n\(cleanSnippet)"

        if norm.mode == "pushplus", let ppURL = URL(string: "https://www.pushplus.plus/send") {
            var req = URLRequest(url: ppURL, timeoutInterval: 8.0)
            req.httpMethod = "POST"
            req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [
                "token": norm.target,
                "title": title,
                "content": cleanSnippet,
                "template": "txt"
            ])
            URLSession.shared.dataTask(with: req) { d, r, e in
                let res = evaluatePushResponse(data: d, resp: r, err: e, channel: "PushPlus")
                completion?(res.0, res.1, res.2)
            }.resume()
            return
        }

        let trimmed = norm.target
        guard let url = URL(string: trimmed) else {
            completion?(false, "invalid", "无效链接")
            return
        }

        // Bark GET-style push URL support (https://api.day.app/<key>)
        if trimmed.contains("api.day.app/") && trimmed.split(separator: "/").count == 3 {
            let tEnc = title.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "ReplyRadar"
            let bEnc = cleanSnippet.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""
            if let barkURL = URL(string: "\(trimmed)/\(tEnc)/\(bEnc)") {
                URLSession.shared.dataTask(with: barkURL) { d, r, e in
                    let res = evaluatePushResponse(data: d, resp: r, err: e, channel: "Bark")
                    completion?(res.0, res.1, res.2)
                }.resume()
                return
            }
        }

        var req = URLRequest(url: url, timeoutInterval: 8.0)
        req.httpMethod = "POST"
        req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")

        let channelName: String
        let payload: [String: Any]
        if trimmed.contains("feishu.cn") || trimmed.contains("larksuite.com") {
            channelName = "飞书"
            payload = ["msg_type": "text", "content": ["text": fullText]]
        } else if trimmed.contains("qyapi.weixin.qq.com") {
            channelName = "企业微信"
            payload = ["msgtype": "text", "text": ["content": fullText]]
        } else if trimmed.contains("oapi.dingtalk.com") {
            channelName = "钉钉"
            payload = ["msgtype": "text", "text": ["content": "【消息总管】\(fullText)"]]
        } else if trimmed.contains("discord.com/api/webhooks") {
            channelName = "Discord"
            payload = ["content": fullText]
        } else if trimmed.contains("sctapi.ftqq.com") {
            channelName = "Server酱"
            payload = ["title": title, "desp": cleanSnippet]
        } else {
            channelName = "Webhook"
            payload = [
                "text": fullText,
                "title": title,
                "site": siteName,
                "unreadCount": unreadCount,
                "snippet": snippet,
                "url": siteUrl
            ]
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        URLSession.shared.dataTask(with: req) { d, r, e in
            let res = evaluatePushResponse(data: d, resp: r, err: e, channel: channelName)
            completion?(res.0, res.1, res.2)
        }.resume()
    }
}

func deterministicProfileUUID(_ seed: String) -> UUID {
    let digest = Insecure.SHA1.hash(data: Data("tabpulse-profile:\(seed)".utf8))
    var bytes = Array(digest.prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x40
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    return UUID(uuid: (
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15]
    ))
}

// MARK: - Ed25519 Offline License Verifier (Matches hub/license.mjs)
struct LicenseVerifier {
    static let publicKeyHex = "7953c20694277c090b5a4d3e7544a478223fa1bad98c5d1ff0dd6ca6a1f00244"

    static func hexToData(_ hex: String) -> Data? {
        var data = Data()
        var idx = hex.startIndex
        while idx < hex.endIndex {
            let next = hex.index(idx, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            guard let byte = UInt8(hex[idx..<next], radix: 16) else { return nil }
            data.append(byte)
            idx = next
        }
        return data
    }

    static func base64UrlDecode(_ str: String) -> Data? {
        var base64 = str.replacingOccurrences(of: "-", with: "+")
                        .replacingOccurrences(of: "_", with: "/")
        let rem = base64.count % 4
        if rem > 0 {
            base64 += String(repeating: "=", count: 4 - rem)
        }
        return Data(base64Encoded: base64)
    }

    static func verify(_ rawKey: String) -> [String: Any] {
        let trimmed = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, parts[0] == "TP1" else {
            return ["valid": false, "plan": "free", "error": "激活码格式无效（应以 TP1. 开头）"]
        }
        guard let payloadData = base64UrlDecode(parts[1]),
              let sigData = base64UrlDecode(parts[2]),
              sigData.count == 64,
              let pubRaw = hexToData(publicKeyHex),
              let pubKey = try? Curve25519.Signing.PublicKey(rawRepresentation: pubRaw) else {
            return ["valid": false, "plan": "free", "error": "激活码编码或公钥无效"]
        }
        guard pubKey.isValidSignature(sigData, for: payloadData) else {
            return ["valid": false, "plan": "free", "error": "激活码签名校验未通过"]
        }
        guard let obj = (try? JSONSerialization.jsonObject(with: payloadData)) as? [String: Any] else {
            return ["valid": false, "plan": "free", "error": "激活码数据损坏"]
        }
        let plan = (obj["p"] as? String) ?? "lifetime"
        let serial = (obj["s"] as? String) ?? ""
        if let expStr = obj["e"] as? String, !expStr.isEmpty {
            let fmt = DateFormatter()
            fmt.dateFormat = "yyyy-MM-dd"
            fmt.timeZone = TimeZone(secondsFromGMT: 0)
            if let expDate = fmt.date(from: expStr), expDate.timeIntervalSinceNow < -86400 {
                return ["valid": false, "plan": "free", "expired": true, "error": "激活码已于 \(expStr) 到期"]
            }
            return ["valid": true, "plan": plan, "serial": serial, "expiresAt": expStr]
        }
        return ["valid": true, "plan": plan, "serial": serial, "expiresAt": NSNull()]
    }
}

let isChineseSystem: Bool = {
    let first = Locale.preferredLanguages.first?.lowercased() ?? "en"
    return first.hasPrefix("zh")
}()

// MARK: - Standalone Local Store (Zero Node.js Required for Customers)
final class StandaloneStore {
    static let shared = StandaloneStore()
    let stateURL: URL

    init() {
        if let envFile = ProcessInfo.processInfo.environment["TABPULSE_STANDALONE_STATE"] {
            stateURL = URL(fileURLWithPath: envFile)
        } else {
            let appSup = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            let dir = appSup.appendingPathComponent("TabPulse", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            stateURL = dir.appendingPathComponent("state.json")
        }
    }

    func loadState() -> [String: Any] {
        if let data = try? Data(contentsOf: stateURL),
           var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           obj["watches"] is [[String: Any]] {
            var dirty = false
            if (obj["mobileToken"] as? String ?? "").count < 16 {
                obj["mobileToken"] = UUID().uuidString.replacingOccurrences(of: "-", with: "")
                dirty = true
            }
            if !(obj["tunnelBoxId"] as? String ?? "").hasPrefix("bx_") {
                obj["tunnelBoxId"] = "bx_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(20).lowercased()
                dirty = true
            }
            if (obj["tunnelWriteKey"] as? String ?? "").count < 16 {
                obj["tunnelWriteKey"] = UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.prefix(8)
                dirty = true
            }
            if dirty { saveState(obj) }
            return obj
        }
        let defaultWatches: [[String: Any]] = isChineseSystem ? [
            [
                "id": "xianyu-im",
                "name": "闲鱼网页版买家咨询",
                "url": "https://www.goofish.com/im",
                "category": "主力阵地",
                "publishTier": "red",
                "contextSummary": "商品与服务买家私信实时提醒",
                "baseIntervalMinutes": 60,
                "status": "idle",
                "unreadCount": 0,
                "snippet": "",
                "lastDraft": "",
                "lastFingerprint": "",
                "nextCheckAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
            ],
            [
                "id": "xhs-creator",
                "name": "小红书创作者消息",
                "url": "https://creator.xiaohongshu.com/new/home",
                "category": "主力阵地",
                "publishTier": "red",
                "contextSummary": "笔记评论与合作私信提醒",
                "baseIntervalMinutes": 60,
                "status": "idle",
                "unreadCount": 0,
                "snippet": "",
                "lastDraft": "",
                "lastFingerprint": "",
                "nextCheckAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
            ]
        ] : [
            [
                "id": "reddit-inbox",
                "name": "Reddit Inbox & Buyer DMs",
                "url": "https://www.reddit.com/message/unread/",
                "category": "接单外包",
                "publishTier": "red",
                "contextSummary": "Inbound freelance & SaaS buyer replies",
                "baseIntervalMinutes": 60,
                "status": "idle",
                "unreadCount": 0,
                "snippet": "",
                "lastDraft": "",
                "lastFingerprint": "",
                "nextCheckAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
            ],
            [
                "id": "github-notifications",
                "name": "GitHub Notifications",
                "url": "https://github.com/notifications",
                "category": "开发者商店",
                "publishTier": "green",
                "contextSummary": "Customer issues, bounties & repo mentions",
                "baseIntervalMinutes": 45,
                "status": "idle",
                "unreadCount": 0,
                "snippet": "",
                "lastDraft": "",
                "lastFingerprint": "",
                "nextCheckAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(1800))
            ]
        ]
        let defaultQuickReplies: [[String: Any]] = [
            [
                "id": "qr_greet",
                "category": "售前秒回",
                "title": "闲鱼/小红书首句秒回（带防重变体）",
                "body": "{你好呀|哈喽|嗨亲}~ 看到你的留言啦！这款{目前还在的|现在可以直接拍|今天就能安排}，请问你是{自用还是商用|什么时候需要用到}呢？我给你发对应实拍细节~"
            ],
            [
                "id": "qr_quote",
                "category": "外包报价",
                "title": "接单清边界一口价话术",
                "body": "{你好|哈喽}！刚仔细看了你的需求，核心关键是先把交付清单定清防返工。我近期刚做过同类项目，包含：{1. 全套源码与部署|1. 成品交付与调试} + 7天免费售后保障，一口价透明无增项，需要我发个演示给你看下吗？"
            ],
            [
                "id": "qr_safe_contact",
                "category": "防封导流",
                "title": "平台内合规发资料引导（零违禁词）",
                "body": "{放心哈|没问题的}，咱们全程在平台内沟通留痕保障双方权益！如果文件比较大，你拍下后我在订单说明里把完整说明文档发你~"
            ],
            [
                "id": "qr_en_pitch",
                "category": "Global Freelance",
                "title": "Reddit / Upwork Fast Scope Reply",
                "body": "{Hey there|Hi|Hello}! Just read through your post — I shipped a very similar setup recently and know the exact edge cases to watch out for. Happy to share a 3-bullet fixed-price scope {today|right away} if you're still looking!"
            ]
        ]
        let initial: [String: Any] = [
            "version": "5.4.0",
            "license": NSNull(),
            "mobileToken": UUID().uuidString.replacingOccurrences(of: "-", with: ""),
            "tunnelBoxId": "bx_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(20).lowercased(),
            "tunnelWriteKey": UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.prefix(8),
            "settings": ["webhookUrl": "", "radarKeywords": "Shopify", "lang": isChineseSystem ? "zh" : "en", "preventSleep": false, "tunnelAutoStart": false, "termsAcceptedAt": NSNull()],
            "watches": defaultWatches,
            "quickReplies": defaultQuickReplies
        ]
        saveState(initial)
        return initial
    }

    func saveState(_ state: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted]) else { return }
        try? data.write(to: stateURL, options: .atomic)
    }

    func computeNextCheckISO(baseMinutes: Int) -> String {
        let jitter = 0.75 + Double.random(in: 0...0.5)
        let mins = max(5, Int(Double(max(5, baseMinutes)) * jitter))
        var target = Date().addingTimeInterval(Double(mins * 60))
        let cal = Calendar.current
        let hour = cal.component(.hour, from: target)
        if hour >= 0 && hour < 8 {
            var comps = cal.dateComponents([.year, .month, .day], from: target)
            comps.hour = 8
            comps.minute = Int.random(in: 5...42)
            if let morning = cal.date(from: comps) {
                target = morning
            }
        }
        return ISO8601DateFormatter().string(from: target)
    }

    func publicSummary() -> [String: Any] {
        let st = loadState()
        let watches = (st["watches"] as? [[String: Any]]) ?? []
        let quickReplies = (st["quickReplies"] as? [[String: Any]]) ?? []
        let unreadList = watches.filter { ($0["status"] as? String) == "unread" }
        let authList = watches.filter { ($0["status"] as? String) == "auth_expired" }
        let pausedList = watches.filter { ($0["status"] as? String) == "paused" }
        let unreadTotal = unreadList.reduce(0) { $0 + (($1["unreadCount"] as? Int) ?? 0) }

        var licOut: [String: Any] = ["valid": false, "plan": "free"]
        if let licObj = st["license"] as? [String: Any] {
            if (licObj["iapUnlocked"] as? Bool) == true {
                licOut = ["valid": true, "plan": (licObj["plan"] as? String) ?? "lifetime", "serial": "APPLE-IAP"]
            } else if let key = licObj["key"] as? String {
                licOut = LicenseVerifier.verify(key)
            }
        }

        return [
            "version": "5.4.0",
            "license": licOut,
            "settings": (st["settings"] as? [String: Any]) ?? ["webhookUrl": "", "lang": isChineseSystem ? "zh" : "en", "termsAcceptedAt": NSNull()],
            "stats": [
                "total": watches.count,
                "unreadCount": unreadList.count,
                "unreadMessagesTotal": unreadTotal,
                "authExpiredCount": authList.count,
                "pausedCount": pausedList.count,
                "activeCount": watches.count - pausedList.count
            ],
            "watches": watches,
            "quickReplies": quickReplies
        ]
    }
}

// MARK: - Live Buyer-Intent Scanner for Standalone Mode
final class NativeLeadScanner {
    static func scan(query: String, completion: @escaping ([String: Any]) -> Void) {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Shopify" : query
        let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "Shopify"
        let group = DispatchGroup()
        let lock = NSLock()
        var items: [[String: Any]] = []

        func fetchJSON(_ urlStr: String, handler: @escaping (Any) -> Void) {
            guard let u = URL(string: urlStr) else { return }
            group.enter()
            var req = URLRequest(url: u, timeoutInterval: 6.0)
            req.setValue("TabPulse-macOS/0.2", forHTTPHeaderField: "User-Agent")
            URLSession.shared.dataTask(with: req) { data, _, _ in
                defer { group.leave() }
                if let d = data, let obj = try? JSONSerialization.jsonObject(with: d) {
                    handler(obj)
                }
            }.resume()
        }

        fetchJSON("https://svc.eleduck.com/api/v1/posts?page=1") { obj in
            guard let dict = obj as? [String: Any], let posts = dict["posts"] as? [[String: Any]] else { return }
            let qLower = q.lowercased()
            let hasZh = q.range(of: "[\\u4e00-\\u9fa5]", options: .regularExpression) != nil
            lock.lock()
            for p in posts {
                let title = ((p["full_title"] as? String) ?? (p["title"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if title.isEmpty || title.contains("社区规则") || title.contains("个人接单") { continue }
                let summary = ((p["summary"] as? String) ?? "").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                let hay = "\(title) \(summary)".lowercased()
                if !hay.contains(qLower) && !(hasZh && (hay.contains("远程") || hay.contains("外包") || hay.contains("招") || hay.contains("合作"))) { continue }
                let pid = (p["id"] as? String) ?? ""
                let pub = (p["published_at"] as? String) ?? ISO8601DateFormatter().string(from: Date())
                items.append([
                    "source": "电鸭社区 · 远程/外包",
                    "title": title,
                    "snippet": String(summary.prefix(160)),
                    "url": "https://eleduck.com/posts/\(pid)",
                    "publishedAt": pub,
                    "intentScore": 92
                ])
            }
            lock.unlock()
        }

        fetchJSON("https://api.pullpush.io/reddit/search/submission/?q=\(enc)+hiring&size=6&sort=desc") { obj in
            guard let dict = obj as? [String: Any], let arr = dict["data"] as? [[String: Any]] else { return }
            lock.lock()
            for r in arr {
                guard let title = r["title"] as? String, !title.isEmpty else { continue }
                let sub = (r["subreddit"] as? String) ?? "reddit"
                let perm = (r["permalink"] as? String) ?? ""
                let body = String(((r["selftext"] as? String) ?? "").prefix(160))
                let created = (r["created_utc"] as? Double) ?? Date().timeIntervalSince1970
                items.append([
                    "source": "Reddit r/\(sub)",
                    "title": title,
                    "snippet": body,
                    "url": perm.isEmpty ? "https://www.reddit.com" : "https://www.reddit.com\(perm)",
                    "publishedAt": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: created)),
                    "intentScore": 86
                ])
            }
            lock.unlock()
        }

        fetchJSON("https://hn.algolia.com/api/v1/search_by_date?query=\(enc)+hiring+freelance&tags=(story,comment)&hitsPerPage=6") { obj in
            guard let dict = obj as? [String: Any], let hits = dict["hits"] as? [[String: Any]] else { return }
            lock.lock()
            for h in hits {
                let title = (h["title"] as? String) ?? (h["story_title"] as? String) ?? "Hacker News Thread"
                let oid = (h["objectID"] as? String) ?? ""
                let comment = ((h["comment_text"] as? String) ?? "").replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
                let created = (h["created_at_i"] as? Double) ?? Date().timeIntervalSince1970
                items.append([
                    "source": "Hacker News",
                    "title": title,
                    "snippet": String(comment.prefix(160)),
                    "url": "https://news.ycombinator.com/item?id=\(oid)",
                    "publishedAt": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: created)),
                    "intentScore": 82
                ])
            }
            lock.unlock()
        }

        group.notify(queue: .main) {
            completion([
                "ok": true,
                "query": q,
                "leads": Array(items.prefix(12))
            ])
        }
    }
}

// MARK: - Main App Delegate (Window + Menu Bar + Silent WebKit Probe)
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    var mainWindow: NSWindow!
    var dashboardWebView: WKWebView!
    var probeHostWindow: NSWindow!
    var backgroundTabsContainer: NSView!
    var probeWebView: WKWebView!
    var loginWindow: NSWindow?
    var popOutWindows: [String: NSWindow] = [:]
    var windowToWatchId: [ObjectIdentifier: String] = [:]
    var workspaceRootView: NSView?
    var workspaceSidebarStack: NSStackView?
    var workspaceHostView: NSView?
    var workspaceTitleLabel: NSTextField?
    var accountSwitcherPopup: NSPopUpButton?
    var quickReplyPopup: NSPopUpButton?
    var toolbarStatusLabel: NSTextField?
    var cachedExternalState: [String: Any]?
    var didWarmUpPassiveTabs = false
    var loginWebView: WKWebView?
    var liveTabs: [String: WKWebView] = [:]
    var tabMeta: [String: (name: String, url: String, profileUuid: String)] = [:]
    var webViewToWatchId: [ObjectIdentifier: String] = [:]
    var activeLoginWatchId: String?
    var activeHomeURL: String?
    var isDockedInMainWindow = false
    var statusItem: NSStatusItem!
    var sentinelTimer: Timer?
    var bridgeTimer: Timer?
    #if !MAS_BUILD
    var spawnedHubProcess: Process?
    #endif
    var useExternalHub = false
    var currentProbeTargetId: String?
    var currentProbeTargetName: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        setupMainMenu()
        setupStatusBar()
        setupMainWindow()
        setupSilentProbeWebView()
        detectHubAndLoadDashboard()

        sentinelTimer = Timer.scheduledTimer(withTimeInterval: 55.0, repeats: true) { [weak self] _ in
            self?.runSilentCheckCycle()
        }
        #if !MAS_BUILD
        bridgeTimer = Timer.scheduledTimer(withTimeInterval: 0.75, repeats: true) { [weak self] _ in
            self?.pollHubBridgeCommands()
        }
        #endif
    }

    func applicationWillTerminate(_ notification: Notification) {
        #if !MAS_BUILD
        spawnedHubProcess?.terminate()
        StandaloneMobileGateway.shared.stopAll()
        #endif
    }

    func postLocalNotification(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(identifier: "tp-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func setupMainMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: isChineseSystem ? "打开《消息总管》主界面" : "Open ReplyRadar", action: #selector(showMainWindow), keyEquivalent: "1")
        appMenu.addItem(withTitle: isChineseSystem ? "立即检查一次后台消息" : "Check Inboxes Now", action: #selector(triggerCheckMenu), keyEquivalent: "r")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: isChineseSystem ? "退出消息总管" : "Quit ReplyRadar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: isChineseSystem ? "编辑" : "Edit")
        editMenu.addItem(withTitle: isChineseSystem ? "撤销" : "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: isChineseSystem ? "剪切" : "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: isChineseSystem ? "复制" : "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: isChineseSystem ? "粘贴" : "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: isChineseSystem ? "全选" : "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    func setupStatusBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = isChineseSystem ? "🔔 消息" : "🔔 Inbox"
        let menu = NSMenu()
        menu.addItem(withTitle: isChineseSystem ? "打开消息总管主窗口" : "Open ReplyRadar Dashboard", action: #selector(showMainWindow), keyEquivalent: "")
        menu.addItem(withTitle: isChineseSystem ? "⚡ 立即检查后台消息" : "⚡ Check Inboxes Now", action: #selector(triggerCheckMenu), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: isChineseSystem ? "退出消息总管" : "Quit ReplyRadar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        statusItem.menu = menu
    }

    func setupMainWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.userContentController.add(self, name: "tabpulse")

        dashboardWebView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1220, height: 790), configuration: cfg)
        dashboardWebView.uiDelegate = self
        mainWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1220, height: 790),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        mainWindow.minSize = NSSize(width: 940, height: 600)
        mainWindow.center()
        mainWindow.title = isChineseSystem ? "消息总管" : "ReplyRadar"
        mainWindow.isReleasedWhenClosed = false
        mainWindow.contentView = dashboardWebView
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func setupSilentProbeWebView() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
        probeWebView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: cfg)
        probeWebView.customUserAgent = SAFARI_DESKTOP_UA
        probeWebView.navigationDelegate = self

        backgroundTabsContainer = NSView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800))
        backgroundTabsContainer.addSubview(probeWebView)

        // Host inside a real backing NSWindow so ALL background liveTabs keep active WebSockets & DOM timers simultaneously!
        probeHostWindow = NSWindow(
            contentRect: NSRect(x: -10000, y: -10000, width: 1280, height: 800),
            styleMask: [.titled],
            backing: .buffered,
            defer: true
        )
        probeHostWindow.isReleasedWhenClosed = false
        probeHostWindow.contentView = backgroundTabsContainer
    }

    func parkWebViewInBackground(_ wv: WKWebView) {
        wv.removeFromSuperview()
        wv.frame = NSRect(x: 0, y: 0, width: 1280, height: 800)
        backgroundTabsContainer.addSubview(wv)
    }

    func detectHubAndLoadDashboard() {
        #if MAS_BUILD
        useExternalHub = false
        loadStandaloneUI()
        refreshStoreKitEntitlements()
        return
        #else
        guard let healthURL = URL(string: "http://127.0.0.1:17890/api/health") else {
            loadStandaloneUI()
            return
        }
        var req = URLRequest(url: healthURL, timeoutInterval: 1.0)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            DispatchQueue.main.async {
                if let http = resp as? HTTPURLResponse, http.statusCode == 200, data != nil {
                    self?.useExternalHub = true
                    self?.syncExternalHubState { [weak self] in
                        self?.warmUpPassiveRedTabsIfNeeded()
                    }
                    self?.dashboardWebView.load(URLRequest(url: URL(string: "http://127.0.0.1:17890/")!))
                } else if self?.trySpawnBundledNodeHub() == true {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
                        self?.useExternalHub = true
                        self?.syncExternalHubState { [weak self] in
                            self?.warmUpPassiveRedTabsIfNeeded()
                        }
                        self?.dashboardWebView.load(URLRequest(url: URL(string: "http://127.0.0.1:17890/")!))
                    }
                } else {
                    self?.useExternalHub = false
                    StandaloneMobileGateway.shared.start(appDelegate: self)
                    self?.loadStandaloneUI()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                        self?.warmUpPassiveRedTabsIfNeeded()
                    }
                }
            }
        }.resume()
        #endif
    }

    #if !MAS_BUILD
    func findLocalNodeBinary() -> String? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        var candidates = [
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.fnm/aliases/default/bin/node",
            "/usr/bin/node"
        ]
        let nvmDir = "\(home)/.nvm/versions/node"
        if let vers = try? fm.contentsOfDirectory(atPath: nvmDir).sorted().reversed() {
            for v in vers {
                candidates.insert("\(nvmDir)/\(v)/bin/node", at: 0)
            }
        }
        return candidates.first(where: { fm.isExecutableFile(atPath: $0) })
    }

    func trySpawnBundledNodeHub() -> Bool {
        guard let nodeBin = findLocalNodeBinary(),
              let srvURL = Bundle.main.url(forResource: "server", withExtension: "mjs", subdirectory: "app-server/hub") else {
            return false
        }
        let repoDataPath = "/Users/wang/OPC/projects/tabpulse/data/state.json"
        let defaultDataPath: String
        if FileManager.default.fileExists(atPath: repoDataPath) {
            defaultDataPath = repoDataPath
        } else {
            let appSup = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            let dir = appSup.appendingPathComponent("TabPulse", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            defaultDataPath = dir.appendingPathComponent("state.json").path
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodeBin)
        p.arguments = [srvURL.path]
        var env = ProcessInfo.processInfo.environment
        if env["TABPULSE_DATA_FILE"] == nil {
            env["TABPULSE_DATA_FILE"] = defaultDataPath
        }
        env["TABPULSE_PORT"] = "17890"
        p.environment = env
        do {
            try p.run()
            spawnedHubProcess = p
            return true
        } catch {
            return false
        }
    }
    #endif

    func loadStandaloneUI() {
        #if MAS_BUILD
        let modeSrc = "window.__TABPULSE_STANDALONE_MODE = true; window.__TABPULSE_MAS_MODE = true;"
        #else
        let modeSrc = "window.__TABPULSE_STANDALONE_MODE = true;"
        #endif
        let script = WKUserScript(
            source: modeSrc,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        dashboardWebView.configuration.userContentController.addUserScript(script)
        if let htmlURL = Bundle.main.url(forResource: "index", withExtension: "html") {
            dashboardWebView.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())
        }
    }

    @objc func showMainWindow() {
        returnToDashboard()
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func returnToDashboard() {
        if isDockedInMainWindow {
            if let wid = activeLoginWatchId, let liveWV = liveTabs[wid] {
                activeLoginWatchId = nil
                parkWebViewInBackground(liveWV)
            } else {
                loginWebView?.removeFromSuperview()
            }
            isDockedInMainWindow = false
            dashboardWebView.frame = mainWindow.contentLayoutRect
            mainWindow.contentView = dashboardWebView
            mainWindow.title = isChineseSystem ? "消息总管" : "ReplyRadar"
            dashboardWebView.evaluateJavaScript("if(window.refreshState) window.refreshState();", completionHandler: nil)
        } else {
            mainWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc func popOutWorkspaceWindow() {
        guard let wv = loginWebView else { return }
        let wid = activeLoginWatchId ?? "temp-\(Int(Date().timeIntervalSince1970))"
        let metaName = workspaceTitleLabel?.stringValue ?? (tabMeta[wid]?.name ?? "会话窗口")

        activeLoginWatchId = nil
        loginWebView = nil
        isDockedInMainWindow = false
        dashboardWebView.frame = mainWindow.contentLayoutRect
        mainWindow.contentView = dashboardWebView
        mainWindow.title = isChineseSystem ? "消息总管" : "ReplyRadar"

        if let existingWin = popOutWindows[wid] {
            wv.removeFromSuperview()
            if let host = existingWin.contentView?.subviews.first(where: { $0.identifier?.rawValue == "popHost" }) {
                wv.frame = host.bounds
                wv.autoresizingMask = [.width, .height]
                host.addSubview(wv)
            }
            existingWin.makeKeyAndOrderFront(nil)
            return
        }

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        win.minSize = NSSize(width: 720, height: 500)
        win.center()
        win.title = isChineseSystem ? "消息总管 · 独立多开窗 — \(metaName)" : "ReplyRadar — \(metaName)"
        win.isReleasedWhenClosed = false
        win.delegate = self

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 1080, height: 760))
        container.autoresizingMask = [.width, .height]

        let bar = NSView(frame: NSRect(x: 0, y: 722, width: 1080, height: 38))
        bar.autoresizingMask = [.width, .minYMargin]
        bar.wantsLayer = true
        bar.layer?.backgroundColor = NSColor(calibratedRed: 0.97, green: 0.98, blue: 0.99, alpha: 1.0).cgColor

        let reloadBtn = NSButton(title: isChineseSystem ? "↻ 刷新页面" : "↻ Reload", target: wv, action: #selector(WKWebView.reload(_:)))
        reloadBtn.frame = NSRect(x: 12, y: 5, width: 92, height: 28)
        reloadBtn.bezelStyle = .rounded
        bar.addSubview(reloadBtn)

        let tipLbl = NSTextField(labelWithString: isChineseSystem ? "🔒 独立防串号多开窗（关闭窗口后后台仍静默收消息）" : "🔒 Isolated Sandbox Window")
        tipLbl.frame = NSRect(x: 114, y: 10, width: 460, height: 18)
        tipLbl.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        tipLbl.textColor = NSColor(calibratedRed: 0.02, green: 0.59, blue: 0.41, alpha: 1.0)
        bar.addSubview(tipLbl)

        let host = NSView(frame: NSRect(x: 0, y: 0, width: 1080, height: 722))
        host.identifier = NSUserInterfaceItemIdentifier("popHost")
        host.autoresizingMask = [.width, .height]

        wv.removeFromSuperview()
        wv.frame = host.bounds
        wv.autoresizingMask = [.width, .height]
        host.addSubview(wv)

        container.addSubview(host)
        container.addSubview(bar)
        win.contentView = container

        popOutWindows[wid] = win
        windowToWatchId[ObjectIdentifier(win)] = wid
        win.makeKeyAndOrderFront(nil)
    }

    @objc func triggerCheckMenu() {
        runSilentCheckCycle(forceImmediate: true)
    }

    // MARK: - WKUIDelegate Native Alert / Confirm / Prompt Dialogs
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = isChineseSystem ? "消息总管提示" : "ReplyRadar Notice"
        alert.informativeText = message
        alert.addButton(withTitle: isChineseSystem ? "确定" : "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = isChineseSystem ? "请确认操作" : "Confirm Action"
        alert.informativeText = message
        alert.addButton(withTitle: isChineseSystem ? "确定" : "Confirm")
        alert.addButton(withTitle: isChineseSystem ? "取消" : "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 26))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input
        alert.addButton(withTitle: isChineseSystem ? "确定" : "OK")
        alert.addButton(withTitle: isChineseSystem ? "取消" : "Cancel")
        if alert.runModal() == .alertFirstButtonReturn {
            completionHandler(input.stringValue)
        } else {
            completionHandler(nil)
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.prompt = isChineseSystem ? "选择发送" : "Choose"
        if panel.runModal() == .OK {
            completionHandler(panel.urls)
        } else {
            completionHandler(nil)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let targetURL = navigationAction.request.url else { return nil }
        if webView == loginWebView || webViewToWatchId[ObjectIdentifier(webView)] != nil {
            webView.load(URLRequest(url: targetURL))
            return nil
        }
        if targetURL.host == "127.0.0.1" || targetURL.host == "localhost" || targetURL.isFileURL {
            openLoginSheet(urlStr: targetURL.absoluteString, name: isChineseSystem ? "高成交回复话术库" : "Cold-Reply Playbook", watchId: "", dockInMain: true)
        } else {
            NSWorkspace.shared.open(targetURL)
        }
        return nil
    }

    // MARK: - Split-View Direct Chat (Left Channel Rail + Clean Top Bar + Isolated WebView)
    func syncExternalHubState(completion: (() -> Void)? = nil) {
        guard useExternalHub, let u = URL(string: "http://127.0.0.1:17890/api/state") else {
            completion?()
            return
        }
        URLSession.shared.dataTask(with: u) { [weak self] data, _, _ in
            if let d = data, let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
                DispatchQueue.main.async {
                    self?.cachedExternalState = obj
                    self?.updateMenuBadge(from: obj)
                    self?.refreshWorkspaceToolbarMenus()
                    completion?()
                }
            } else {
                DispatchQueue.main.async { completion?() }
            }
        }.resume()
    }

    func activeStateSnapshot() -> [String: Any] {
        if useExternalHub, let ext = cachedExternalState {
            return ext
        }
        return StandaloneStore.shared.loadState()
    }

    func iconPrefixForPlatform(_ name: String, _ url: String) -> String {
        let s = "\(name) \(url)".lowercased()
        if s.contains("闲鱼") || s.contains("goofish") { return "🐟" }
        if s.contains("小红书") || s.contains("xiaohongshu") { return "📕" }
        if s.contains("电鸭") || s.contains("eleduck") { return "⚡" }
        if s.contains("v2ex") { return "💬" }
        if s.contains("知乎") || s.contains("zhihu") { return "📘" }
        if s.contains("x.com") || s.contains("twitter") || s.contains("x (") { return "𝕏" }
        if s.contains("github") { return "🐙" }
        if s.contains("apple") || s.contains("app store") || s.contains("appstore") { return "" }
        if s.contains("makerworld") || s.contains("拓竹") { return "🧩" }
        if s.contains("reddit") { return "🎯" }
        if s.contains("upwork") { return "💼" }
        if s.contains("product hunt") || s.contains("producthunt") { return "🚀" }
        return "•"
    }

    func ensureWorkspaceViews() {
        if workspaceRootView != nil { return }
        let winW: CGFloat = 1220
        let winH: CGFloat = 790
        let sideW: CGFloat = 212
        let barH: CGFloat = 44

        let root = NSView(frame: NSRect(x: 0, y: 0, width: winW, height: winH))
        root.autoresizingMask = [.width, .height]

        // Left Native Sidebar Rail
        let sidebar = NSView(frame: NSRect(x: 0, y: 0, width: sideW, height: winH))
        sidebar.autoresizingMask = [.height, .maxXMargin]
        sidebar.wantsLayer = true
        sidebar.layer?.backgroundColor = NSColor(calibratedRed: 0.973, green: 0.980, blue: 0.988, alpha: 1.0).cgColor

        let sideBorder = NSView(frame: NSRect(x: sideW - 1, y: 0, width: 1, height: winH))
        sideBorder.autoresizingMask = [.height, .minXMargin]
        sideBorder.wantsLayer = true
        sideBorder.layer?.backgroundColor = NSColor(calibratedRed: 0.886, green: 0.910, blue: 0.941, alpha: 1.0).cgColor
        sidebar.addSubview(sideBorder)

        let backBtn = NSButton(frame: NSRect(x: 12, y: winH - 46, width: sideW - 24, height: 32))
        backBtn.autoresizingMask = [.minYMargin, .width]
        backBtn.title = isChineseSystem ? "⊞ 返回工作台总览" : "⊞ Back to Dashboard"
        backBtn.bezelStyle = .rounded
        backBtn.font = NSFont.systemFont(ofSize: 12.5, weight: .semibold)
        backBtn.target = self
        backBtn.action = #selector(returnToDashboard)
        sidebar.addSubview(backBtn)

        let secLabel = NSTextField(labelWithString: isChineseSystem ? "切换会话平台" : "CHANNELS")
        secLabel.frame = NSRect(x: 16, y: winH - 72, width: sideW - 32, height: 16)
        secLabel.autoresizingMask = [.minYMargin, .width]
        secLabel.font = NSFont.systemFont(ofSize: 11, weight: .bold)
        secLabel.textColor = NSColor(calibratedRed: 0.58, green: 0.64, blue: 0.72, alpha: 1.0)
        sidebar.addSubview(secLabel)

        let scroll = NSScrollView(frame: NSRect(x: 8, y: 10, width: sideW - 17, height: winH - 86))
        scroll.autoresizingMask = [.height, .width]
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.edgeInsets = NSEdgeInsets(top: 2, left: 2, bottom: 8, right: 2)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let docView = NSView(frame: NSRect(x: 0, y: 0, width: sideW - 18, height: winH - 86))
        docView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: docView.topAnchor),
            stack.leadingAnchor.constraint(equalTo: docView.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: docView.trailingAnchor)
        ])
        scroll.documentView = docView
        sidebar.addSubview(scroll)
        workspaceSidebarStack = stack

        // Right Top Toolbar (Auto Layout Stack so resizing NEVER overlaps!)
        let toolbar = NSView(frame: NSRect(x: sideW, y: winH - barH, width: winW - sideW, height: barH))
        toolbar.autoresizingMask = [.width, .minYMargin]
        toolbar.wantsLayer = true
        toolbar.layer?.backgroundColor = NSColor.white.cgColor

        let barBottomBorder = NSView(frame: NSRect(x: 0, y: 0, width: winW - sideW, height: 1))
        barBottomBorder.autoresizingMask = [.width, .maxYMargin]
        barBottomBorder.wantsLayer = true
        barBottomBorder.layer?.backgroundColor = NSColor(calibratedRed: 0.886, green: 0.910, blue: 0.941, alpha: 1.0).cgColor
        toolbar.addSubview(barBottomBorder)

        func makeNavBtn(_ title: String, action: Selector, width: CGFloat? = nil) -> NSButton {
            let b = NSButton(title: title, target: self, action: action)
            b.bezelStyle = .rounded
            b.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
            if let w = width {
                b.widthAnchor.constraint(equalToConstant: w).isActive = true
            }
            return b
        }

        let bBack = makeNavBtn("‹", action: #selector(wsBack), width: 30)
        let bFwd = makeNavBtn("›", action: #selector(wsForward), width: 30)
        let bReload = makeNavBtn("↻", action: #selector(wsReload), width: 32)
        let bHome = makeNavBtn(isChineseSystem ? "🏠 消息页" : "🏠 Inbox", action: #selector(wsGoHome))

        let titleLbl = NSTextField(labelWithString: "")
        titleLbl.font = NSFont.systemFont(ofSize: 13.5, weight: .bold)
        titleLbl.textColor = NSColor(calibratedRed: 0.06, green: 0.09, blue: 0.16, alpha: 1.0)
        titleLbl.lineBreakMode = .byTruncatingTail
        titleLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        workspaceTitleLabel = titleLbl

        let statusLbl = NSTextField(labelWithString: isChineseSystem ? "🔒 独立防串号隔离" : "🔒 Isolated Sandbox")
        statusLbl.font = NSFont.systemFont(ofSize: 11.5, weight: .semibold)
        statusLbl.textColor = NSColor(calibratedRed: 0.02, green: 0.59, blue: 0.41, alpha: 1.0)
        statusLbl.lineBreakMode = .byTruncatingTail
        statusLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        toolbarStatusLabel = statusLbl

        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)

        let qrPop = NSPopUpButton(frame: .zero, pullsDown: true)
        qrPop.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        qrPop.target = self
        qrPop.action = #selector(wsQuickReplyPicked(_:))
        qrPop.widthAnchor.constraint(lessThanOrEqualToConstant: 210).isActive = true
        quickReplyPopup = qrPop

        let popBtn = makeNavBtn(isChineseSystem ? "↗ 独立窗口" : "↗ Pop Out", action: #selector(popOutWorkspaceWindow))

        let hStack = NSStackView(views: [bBack, bFwd, bReload, bHome, titleLbl, statusLbl, spacer, qrPop, popBtn])
        hStack.orientation = .horizontal
        hStack.alignment = .centerY
        hStack.spacing = 6
        hStack.translatesAutoresizingMaskIntoConstraints = false
        toolbar.addSubview(hStack)
        NSLayoutConstraint.activate([
            hStack.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 12),
            hStack.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -12),
            hStack.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor)
        ])

        let host = NSView(frame: NSRect(x: sideW, y: 0, width: winW - sideW, height: winH - barH))
        host.autoresizingMask = [.width, .height]

        root.addSubview(host)
        root.addSubview(toolbar)
        root.addSubview(sidebar)

        workspaceRootView = root
        workspaceHostView = host
    }

    @objc func wsBack() { loginWebView?.goBack() }
    @objc func wsForward() { loginWebView?.goForward() }
    @objc func wsReload() { loginWebView?.reload() }
    @objc func wsGoHome() {
        if let h = activeHomeURL, let u = URL(string: h) {
            loginWebView?.load(URLRequest(url: u))
        }
    }

    @objc func wsSidebarChannelClicked(_ sender: NSButton) {
        guard let wid = sender.identifier?.rawValue,
              let meta = tabMeta[wid] else { return }
        openLoginSheet(urlStr: meta.url, name: meta.name, watchId: wid, profileUuidStr: meta.profileUuid, isolated: true, dockInMain: isDockedInMainWindow)
    }

    func refreshWorkspaceToolbarMenus() {
        let st = activeStateSnapshot()
        let watches = (st["watches"] as? [[String: Any]]) ?? []
        var unreadMap: [String: Int] = [:]
        var orderedIds: [String] = []

        for w in watches {
            if let wid = w["id"] as? String, let nm = w["name"] as? String, let u = w["url"] as? String {
                let pUuid = (w["profileUuid"] as? String) ?? ""
                tabMeta[wid] = (name: nm, url: u, profileUuid: pUuid)
                if (w["status"] as? String) == "unread" {
                    unreadMap[wid] = max(1, (w["unreadCount"] as? Int) ?? 1)
                }
                orderedIds.append(wid)
            }
        }
        for wid in liveTabs.keys.sorted() where !orderedIds.contains(wid) {
            orderedIds.append(wid)
        }

        if let stack = workspaceSidebarStack {
            stack.arrangedSubviews.forEach { v in
                stack.removeArrangedSubview(v)
                v.removeFromSuperview()
            }
            for wid in orderedIds {
                guard let meta = tabMeta[wid] else { continue }
                let isCurrent = (wid == activeLoginWatchId)
                let unread = unreadMap[wid] ?? 0
                let ico = iconPrefixForPlatform(meta.name, meta.url)
                let badgeSuffix = unread > 0 ? "  🔴\(unread)" : ""
                let btn = NSButton(title: " \(ico)  \(meta.name)\(badgeSuffix)", target: self, action: #selector(wsSidebarChannelClicked(_:)))
                btn.identifier = NSUserInterfaceItemIdentifier(wid)
                btn.isBordered = false
                btn.alignment = .left
                btn.lineBreakMode = .byTruncatingTail
                btn.wantsLayer = true
                btn.layer?.cornerRadius = 7
                if isCurrent {
                    btn.layer?.backgroundColor = NSColor(calibratedRed: 0.878, green: 0.918, blue: 1.0, alpha: 1.0).cgColor
                    btn.contentTintColor = NSColor(calibratedRed: 0.11, green: 0.31, blue: 0.85, alpha: 1.0)
                    btn.font = NSFont.systemFont(ofSize: 12.5, weight: .bold)
                } else {
                    btn.layer?.backgroundColor = NSColor.clear.cgColor
                    btn.contentTintColor = unread > 0
                        ? NSColor(calibratedRed: 0.82, green: 0.12, blue: 0.15, alpha: 1.0)
                        : NSColor(calibratedRed: 0.22, green: 0.27, blue: 0.34, alpha: 1.0)
                    btn.font = NSFont.systemFont(ofSize: 12.5, weight: unread > 0 ? .bold : .medium)
                }
                btn.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    btn.widthAnchor.constraint(equalToConstant: 190),
                    btn.heightAnchor.constraint(equalToConstant: 30)
                ])
                stack.addArrangedSubview(btn)
            }
            if let docView = stack.superview {
                let neededH = max(CGFloat(orderedIds.count) * 34.0 + 16.0, docView.superview?.bounds.height ?? 400)
                docView.frame.size.height = neededH
            }
        }

        if let qrPop = quickReplyPopup {
            qrPop.removeAllItems()
            qrPop.addItem(withTitle: isChineseSystem ? "⚡ 填入防封话术" : "⚡ Insert Quick Reply")
            let qrs = (st["quickReplies"] as? [[String: Any]]) ?? []
            for item in qrs {
                let t = (item["title"] as? String) ?? (item["titleZh"] as? String) ?? "话术"
                let body = (item["body"] as? String) ?? (item["template"] as? String) ?? (item["textZh"] as? String) ?? ""
                if !body.isEmpty {
                    qrPop.addItem(withTitle: "⚡ \(t)")
                    qrPop.lastItem?.representedObject = body
                }
            }
        }
    }

    @objc func wsSwitchAccountChanged(_ sender: NSPopUpButton) {
        guard let wid = sender.selectedItem?.representedObject as? String,
              let meta = tabMeta[wid] else { return }
        openLoginSheet(urlStr: meta.url, name: meta.name, watchId: wid, profileUuidStr: meta.profileUuid, isolated: true, dockInMain: isDockedInMainWindow)
    }

    func injectTextIntoWebView(_ wv: WKWebView, text: String, autoSubmit: Bool = false, completion: ((Bool) -> Void)? = nil) {
        guard let strData = try? JSONSerialization.data(withJSONObject: [text]),
              let arrLiteral = String(data: strData, encoding: .utf8) else {
            completion?(false)
            return
        }
        let submitFlag = autoSubmit ? "true" : "false"
        let js = """
        (function() {
          const msg = (\(arrLiteral))[0];
          const wantSubmit = \(submitFlag);
          function isVisible(el) {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 24 || r.height < 14) return false;
            const st = window.getComputedStyle(el);
            return st.display !== 'none' && st.visibility !== 'hidden';
          }
          let target = document.activeElement;
          const isEditable = (el) => el && !el.disabled && !el.readOnly && (
            el.tagName === 'TEXTAREA' ||
            (el.tagName === 'INPUT' && !['checkbox','radio','button','submit','file','hidden','search'].includes((el.type || '').toLowerCase())) ||
            el.isContentEditable ||
            el.getAttribute('role') === 'textbox'
          );
          if (!isEditable(target) || !isVisible(target)) {
            const cands = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"], input:not([type])'))
              .filter(el => isEditable(el) && isVisible(el));
            // Prefer bottom-most main chat composer (x > 20% of viewport width if multiple)
            cands.sort((a, b) => {
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              return (rb.top + (rb.left > window.innerWidth * 0.2 ? 200 : 0)) - (ra.top + (ra.left > window.innerWidth * 0.2 ? 200 : 0));
            });
            target = cands[0] || null;
          }
          if (!target) return { injected: false, submitted: false };
          target.focus();
          if (target.isContentEditable || target.getAttribute('role') === 'textbox') {
            try {
              const sel = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(target);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            } catch (e) {}
            try {
              target.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: msg, bubbles: true, cancelable: true }));
            } catch (e) {}
            const okExec = document.execCommand('insertText', false, msg);
            if (!okExec || !(target.innerText || '').includes(msg.slice(0, 6))) {
              target.textContent = (target.textContent ? target.textContent + ' ' : '') + msg;
            }
            target.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: msg, bubbles: true }));
          } else {
            const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            const nextVal = (target.value ? target.value + ' ' : '') + msg;
            if (setter) setter.call(target, nextVal); else target.value = nextVal;
            target.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: msg, bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (wantSubmit) {
            setTimeout(() => {
              const tr = target.getBoundingClientRect();
              const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], [data-testid*="send" i], [class*="send" i]')).filter(isVisible);
              const sendBtn = btns.find(b => {
                if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
                const t = ((b.innerText || b.value || b.getAttribute('aria-label') || b.getAttribute('title') || '') + '').trim();
                const cls = (b.className && typeof b.className === 'string') ? b.className : '';
                const tid = b.getAttribute('data-testid') || '';
                if (/^(发送|回复|Send|Submit|Reply|Post)$/i.test(t)) return true;
                if (/send-btn|im-send|btn-send|chat-send|msg-send/i.test(cls + ' ' + tid)) {
                  const br = b.getBoundingClientRect();
                  return Math.abs(br.bottom - tr.bottom) < 160;
                }
                return false;
              });
              if (sendBtn) {
                sendBtn.click();
              } else {
                const evInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
                target.dispatchEvent(new KeyboardEvent('keydown', evInit));
                target.dispatchEvent(new KeyboardEvent('keypress', evInit));
                target.dispatchEvent(new KeyboardEvent('keyup', evInit));
              }
            }, 140);
          }
          return { injected: true, submitted: wantSubmit };
        })();
        """
        wv.evaluateJavaScript(js) { res, _ in
            let ok = ((res as? [String: Any])?["injected"] as? Bool) ?? false
            completion?(ok)
        }
    }

    @objc func wsQuickReplyPicked(_ sender: NSPopUpButton) {
        guard let rawBody = sender.selectedItem?.representedObject as? String, !rawBody.isEmpty else { return }
        let spun = resolveSpintaxSwift(rawBody)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(spun, forType: .string)
        if let wv = loginWebView {
            injectTextIntoWebView(wv, text: spun, autoSubmit: false) { [weak self] injected in
                DispatchQueue.main.async {
                    if injected {
                        self?.toolbarStatusLabel?.stringValue = isChineseSystem
                            ? "✅ 已自动填入聊天输入框（确认无误点发送即可）！"
                            : "✅ Auto-filled into chat input box!"
                    } else {
                        self?.toolbarStatusLabel?.stringValue = isChineseSystem
                            ? "✅ 已复制变体话术，点一下聊天框按 Cmd+V 粘贴！"
                            : "✅ Copied variation — click input & press Cmd+V!"
                    }
                }
            }
        }
    }

    func getOrCreateLiveWebView(watchId: String, urlStr: String, name: String, profileUuidStr: String = "", isolated: Bool = true) -> WKWebView? {
        guard let u = URL(string: urlStr) else { return nil }
        if !watchId.isEmpty {
            tabMeta[watchId] = (name: name, url: urlStr, profileUuid: profileUuidStr)
        }
        if !watchId.isEmpty, let existing = liveTabs[watchId] {
            return existing
        }
        let cfg = WKWebViewConfiguration()
        if isolated, !watchId.isEmpty, #available(macOS 14.0, *) {
            let targetUUID = UUID(uuidString: profileUuidStr) ?? deterministicProfileUUID(watchId)
            cfg.websiteDataStore = WKWebsiteDataStore(forIdentifier: targetUUID)
        } else {
            cfg.websiteDataStore = .default()
        }
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
        cfg.userContentController.add(self, name: "tabpulsePassive")
        if let obsURL = Bundle.main.url(forResource: "passive-observer", withExtension: "js"),
           let obsJS = try? String(contentsOf: obsURL, encoding: .utf8) {
            let us = WKUserScript(source: obsJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            cfg.userContentController.addUserScript(us)
        }
        let created = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 736), configuration: cfg)
        created.customUserAgent = SAFARI_DESKTOP_UA
        created.uiDelegate = self
        created.load(URLRequest(url: u))
        if !watchId.isEmpty {
            liveTabs[watchId] = created
            webViewToWatchId[ObjectIdentifier(created)] = watchId
            parkWebViewInBackground(created)
        }
        return created
    }

    func openLoginSheet(urlStr: String, name: String, watchId: String = "", profileUuidStr: String = "", isolated: Bool = true, dockInMain: Bool = true) {
        if let prevId = activeLoginWatchId, prevId != watchId, let prevWV = liveTabs[prevId] {
            parkWebViewInBackground(prevWV)
        } else if activeLoginWatchId == nil, let prevTemp = loginWebView {
            prevTemp.removeFromSuperview()
        }

        activeLoginWatchId = watchId.isEmpty ? nil : watchId
        activeHomeURL = urlStr
        guard let wv = getOrCreateLiveWebView(watchId: watchId, urlStr: urlStr, name: name, profileUuidStr: profileUuidStr, isolated: isolated) else { return }
        wv.removeFromSuperview()
        loginWebView = wv

        ensureWorkspaceViews()
        if let host = workspaceHostView {
            wv.frame = host.bounds
            wv.autoresizingMask = [.width, .height]
            host.addSubview(wv)
        }
        workspaceTitleLabel?.stringValue = name
        toolbarStatusLabel?.stringValue = isChineseSystem ? "🔒 独立防串号隔离中" : "🔒 Isolated Sandbox"
        refreshWorkspaceToolbarMenus()
        if useExternalHub {
            syncExternalHubState()
        }

        if dockInMain, let root = workspaceRootView {
            loginWindow?.orderOut(nil)
            isDockedInMainWindow = true
            root.frame = mainWindow.contentLayoutRect
            mainWindow.contentView = root
            mainWindow.title = isChineseSystem ? "消息总管 — \(name)" : "ReplyRadar — \(name)"
            mainWindow.makeKeyAndOrderFront(nil)
        } else if let root = workspaceRootView {
            isDockedInMainWindow = false
            if loginWindow == nil {
                let win = NSWindow(
                    contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
                    styleMask: [.titled, .closable, .resizable, .miniaturizable],
                    backing: .buffered,
                    defer: false
                )
                win.minSize = NSSize(width: 920, height: 580)
                win.center()
                win.isReleasedWhenClosed = false
                win.delegate = self
                loginWindow = win
            }
            root.frame = NSRect(x: 0, y: 0, width: 1200, height: 780)
            loginWindow?.contentView = root
            loginWindow?.title = isChineseSystem ? "消息总管 — \(name)" : "ReplyRadar — \(name)"
            loginWindow?.makeKeyAndOrderFront(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closedWin = notification.object as? NSWindow else { return }
        if let wid = windowToWatchId.removeValue(forKey: ObjectIdentifier(closedWin)) {
            popOutWindows.removeValue(forKey: wid)
            if let liveWV = liveTabs[wid] {
                parkWebViewInBackground(liveWV)
            }
            return
        }
        if closedWin == loginWindow {
            if let wid = activeLoginWatchId, let liveWV = liveTabs[wid] {
                activeLoginWatchId = nil
                parkWebViewInBackground(liveWV)
            }
        }
    }

    #if !MAS_BUILD
    // MARK: - Mobile Remote Live Screen & Fixed-IP Reply Bridge
    var isPollingBridge = false

    func pollHubBridgeCommands() {
        guard useExternalHub, !isPollingBridge,
              let pollURL = URL(string: "http://127.0.0.1:17890/api/bridge/poll") else { return }
        isPollingBridge = true
        URLSession.shared.dataTask(with: pollURL) { [weak self] data, _, _ in
            defer { self?.isPollingBridge = false }
            guard let d = data,
                  let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
                  let cmds = obj["commands"] as? [[String: Any]],
                  !cmds.isEmpty else { return }
            DispatchQueue.main.async {
                for cmd in cmds {
                    self?.executeBridgeCommand(cmd)
                }
            }
        }.resume()
    }

    func executeBridgeCommand(_ cmd: [String: Any]) {
        let taskId = (cmd["taskId"] as? String) ?? ""
        let type = (cmd["type"] as? String) ?? "snapshot"
        let watchId = (cmd["watchId"] as? String) ?? ""
        let urlStr = (cmd["url"] as? String) ?? ""
        let name = (cmd["name"] as? String) ?? watchId
        let pUuid = (cmd["profileUuid"] as? String) ?? ""

        let wasCold = liveTabs[watchId] == nil
        guard let wv = getOrCreateLiveWebView(watchId: watchId, urlStr: urlStr, name: name, profileUuidStr: pUuid, isolated: true) else {
            postBridgeResult(taskId: taskId, watchId: watchId, payload: ["error": "Invalid URL"])
            return
        }

        if type == "reload" {
            wv.reload()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                self.captureAndPostSnapshot(wv: wv, taskId: taskId, watchId: watchId, extra: [:])
            }
            return
        }

        if type == "scroll" {
            let dy = (cmd["dy"] as? Double) ?? 300
            let scrollJS = """
            (function() {
              const scrollers = Array.from(document.querySelectorAll('*')).filter(el => el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 160);
              scrollers.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
              if (scrollers[0]) scrollers[0].scrollBy(0, \(dy));
              window.scrollBy(0, \(dy));
            })();
            """
            wv.evaluateJavaScript(scrollJS) { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    self.captureAndPostSnapshot(wv: wv, taskId: taskId, watchId: watchId, extra: [:])
                }
            }
            return
        }

        if type == "click" {
            let xr = (cmd["xRatio"] as? Double) ?? 0.5
            let yr = (cmd["yRatio"] as? Double) ?? 0.5
            let clickJS = """
            (function() {
              const x = Math.round(window.innerWidth * \(xr));
              const y = Math.round(window.innerHeight * \(yr));
              const el = document.elementFromPoint(x, y);
              if (!el) return false;
              el.focus && el.focus();
              ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(t => {
                el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
              });
              return true;
            })();
            """
            wv.evaluateJavaScript(clickJS) { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.captureAndPostSnapshot(wv: wv, taskId: taskId, watchId: watchId, extra: [:])
                }
            }
            return
        }

        if type == "peekImage" {
            let delay = wasCold ? 1.8 : 0.1
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                self.captureWebViewJpegDataUrl(wv: wv) { dataUrl in
                    if let d = dataUrl {
                        self.postBridgeResult(taskId: taskId, watchId: watchId, payload: ["ok": true, "dataUrl": d])
                    } else {
                        self.postBridgeResult(taskId: taskId, watchId: watchId, payload: ["ok": false, "error": "画面生成失败"])
                    }
                }
            }
            return
        }

        if type == "reply" {
            let text = (cmd["text"] as? String) ?? ""
            let autoSub = (cmd["autoSubmit"] as? Bool) ?? true
            injectTextIntoWebView(wv, text: text, autoSubmit: autoSub) { injected in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
                    self.captureAndPostSnapshot(wv: wv, taskId: taskId, watchId: watchId, extra: ["injected": injected])
                }
            }
            return
        }

        let delay = wasCold ? 2.2 : 0.15
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            self.captureAndPostSnapshot(wv: wv, taskId: taskId, watchId: watchId, extra: [:])
        }
    }

    func captureAndPostSnapshot(wv: WKWebView, taskId: String, watchId: String, extra: [String: Any]) {
        let domExtractorJS = """
        (function() {
          const vw = Math.max(1, window.innerWidth || 1000);
          const vh = Math.max(1, window.innerHeight || 700);
          const seen = new Set();
          const threads = [];
          const messages = [];

          const isVisible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 12 || r.height < 10 || r.bottom < 0 || r.top > vh * 1.5) return false;
            const st = window.getComputedStyle(el);
            return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
          };

          const authRequired = Boolean(document.querySelector('input[type="password"]')) || /(login|signin|sign-in|passport|扫码登录|请登录)/i.test(location.href + ' ' + document.title);

          // Extract left-sidebar threads & main-pane leaf text blocks without any screenshot
          const candidates = document.querySelectorAll('li, article, p, [class*="msg" i], [class*="message" i], [class*="chat" i], [class*="item" i], [class*="comment" i], [class*="notify" i], [role="listitem"], h3, h4, div');
          for (const el of candidates) {
            if (!isVisible(el)) continue;
            // Skip huge wrapper divs that contain many child blocks
            if (el.tagName === 'DIV' && el.children.length > 3) continue;
            const raw = (el.innerText || '').trim().replace(/\\s+/g, ' ');
            if (raw.length < 2 || raw.length > 900 || seen.has(raw)) continue;
            const r = el.getBoundingClientRect();
            if (r.top < 38) continue;
            seen.add(raw);

            const relX = r.left / vw;
            const cxRatio = Math.max(0.02, Math.min(0.98, (r.left + r.width * 0.5) / vw));
            const cyRatio = Math.max(0.02, Math.min(0.98, (r.top + r.height * 0.5) / vh));
            if (relX < 0.28 && r.width < vw * 0.38 && raw.length <= 42 && threads.length < 16) {
              threads.push({ label: raw, xRatio: cxRatio, yRatio: cyRatio });
            } else {
              const isMe = ((r.left + r.width * 0.5) / vw) > 0.62 || /mine|self|right|me|outbound/i.test(el.className || '');
              messages.push({ text: raw, isMe });
            }
            if (messages.length >= 45) break;
          }

          if (messages.length === 0 && document.body) {
            const lines = (document.body.innerText || '').split('\\n').map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 600).slice(0, 30);
            for (const l of lines) messages.push({ text: l, isMe: false });
          }

          return { threads, messages, authRequired };
        })();
        """
        wv.evaluateJavaScript(domExtractorJS) { [weak self] res, _ in
            let dict = (res as? [String: Any]) ?? [:]
            var payload = extra
            payload["pageTitle"] = wv.title ?? ""
            payload["currentUrl"] = wv.url?.absoluteString ?? ""
            payload["threads"] = dict["threads"] ?? []
            payload["messages"] = dict["messages"] ?? []
            payload["authRequired"] = dict["authRequired"] ?? false
            self?.postBridgeResult(taskId: taskId, watchId: watchId, payload: payload)
        }
    }

    func captureWebViewJpegDataUrl(wv: WKWebView, completion: @escaping (String?) -> Void) {
        let snapCfg = WKSnapshotConfiguration()
        snapCfg.snapshotWidth = 920
        wv.takeSnapshot(with: snapCfg) { img, _ in
            guard let nsImg = img,
                  let tiff = nsImg.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.56]) else {
                completion(nil)
                return
            }
            completion("data:image/jpeg;base64,\(jpg.base64EncodedString())")
        }
    }

    func extractDomSnapshotDict(wv: WKWebView, completion: @escaping ([String: Any]) -> Void) {
        let domExtractorJS = """
        (function() {
          const vw = Math.max(1, window.innerWidth || 1000);
          const vh = Math.max(1, window.innerHeight || 700);
          const seen = new Set();
          const threads = [];
          const messages = [];
          const isVisible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 12 || r.height < 10 || r.bottom < 0 || r.top > vh * 1.5) return false;
            const st = window.getComputedStyle(el);
            return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
          };
          const authRequired = Boolean(document.querySelector('input[type="password"]')) || /(login|signin|sign-in|passport|扫码登录|请登录)/i.test(location.href + ' ' + document.title);
          const candidates = document.querySelectorAll('li, article, p, [class*="msg" i], [class*="message" i], [class*="chat" i], [class*="item" i], [class*="comment" i], [class*="notify" i], [role="listitem"], h3, h4, div');
          for (const el of candidates) {
            if (!isVisible(el)) continue;
            if (el.tagName === 'DIV' && el.children.length > 3) continue;
            const raw = (el.innerText || '').trim().replace(/\\s+/g, ' ');
            if (raw.length < 2 || raw.length > 900 || seen.has(raw)) continue;
            const r = el.getBoundingClientRect();
            if (r.top < 38) continue;
            seen.add(raw);
            const relX = r.left / vw;
            const cxRatio = Math.max(0.02, Math.min(0.98, (r.left + r.width * 0.5) / vw));
            const cyRatio = Math.max(0.02, Math.min(0.98, (r.top + r.height * 0.5) / vh));
            if (relX < 0.28 && r.width < vw * 0.38 && raw.length <= 42 && threads.length < 16) {
              threads.push({ label: raw, xRatio: cxRatio, yRatio: cyRatio });
            } else {
              const isMe = ((r.left + r.width * 0.5) / vw) > 0.62 || /mine|self|right|me|outbound/i.test(el.className || '');
              messages.push({ text: raw, isMe });
            }
            if (messages.length >= 45) break;
          }
          if (messages.length === 0 && document.body) {
            const lines = (document.body.innerText || '').split('\\n').map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 600).slice(0, 30);
            for (const l of lines) messages.push({ text: l, isMe: false });
          }
          return { threads, messages, authRequired };
        })();
        """
        wv.evaluateJavaScript(domExtractorJS) { res, _ in
            let dict = (res as? [String: Any]) ?? [:]
            completion([
                "ok": true,
                "pageTitle": wv.title ?? "",
                "currentUrl": wv.url?.absoluteString ?? "",
                "threads": dict["threads"] ?? [],
                "messages": dict["messages"] ?? [],
                "authRequired": dict["authRequired"] ?? false
            ])
        }
    }

    func postBridgeResult(taskId: String, watchId: String, payload: [String: Any]) {
        guard let resURL = URL(string: "http://127.0.0.1:17890/api/bridge/result") else { return }
        var body = payload
        body["taskId"] = taskId
        body["watchId"] = watchId
        var req = URLRequest(url: resURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req).resume()
    }
    #endif

    // MARK: - WKScriptMessageHandler Bridge
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "tabpulsePassive" {
            guard let srcWV = message.webView,
                  let wid = webViewToWatchId[ObjectIdentifier(srcWV)],
                  let payload = message.body as? [String: Any] else { return }
            let count = (payload["unreadCount"] as? Int) ?? 0
            let snippet = (payload["snippet"] as? String) ?? ""
            let authExp = (payload["authExpired"] as? Bool) ?? false
            handlePassiveEvent(watchId: wid, unreadCount: count, snippet: snippet, authExpired: authExp)
            return
        }

        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        if action == "openLoginSheet" {
            let url = (body["url"] as? String) ?? ""
            let name = (body["name"] as? String) ?? "平台"
            let id = (body["id"] as? String) ?? ""
            let pUuid = (body["profileUuid"] as? String) ?? ""
            let iso = (body["isolatedProfile"] as? Bool) ?? true
            let dock = (body["dockInMain"] as? Bool) ?? true
            openLoginSheet(urlStr: url, name: name, watchId: id, profileUuidStr: pUuid, isolated: iso, dockInMain: dock)
            return
        }
        #if MAS_BUILD
        if action == "purchaseIap" {
            let pid = (body["productId"] as? String) ?? "com.yanghe.replyradar.pro.lifetime"
            handleMasPurchase(productId: pid)
            return
        }
        if action == "restoreIap" {
            handleMasRestore()
            return
        }
        #endif
        if action == "checkNow" {
            let tid = (body["targetId"] as? String) ?? ""
            runSilentCheckCycle(forceImmediate: true, targetId: tid)
            return
        }
        if action == "openPlaybook" {
            if let u = Bundle.main.url(forResource: "cold-reply-playbook", withExtension: "html") {
                openLoginSheet(urlStr: u.absoluteString, name: "高成交率破冰话术库", watchId: "")
            }
            return
        }
        if action == "api" {
            let reqId = (body["reqId"] as? String) ?? ""
            let method = (body["method"] as? String) ?? "GET"
            let path = (body["path"] as? String) ?? ""
            let payload = body["body"] as? [String: Any]
            handleStandaloneAPI(reqId: reqId, method: method, path: path, payload: payload)
        }
    }

    func replyCallback(_ reqId: String, _ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let jsonStr = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            self.dashboardWebView.evaluateJavaScript("window.__resolveNativeCallback('\(reqId)', \(jsonStr));", completionHandler: nil)
        }
    }

    func handleStandaloneAPI(reqId: String, method: String, path: String, payload: [String: Any]?) {
        if path == "/api/state" {
            let sum = StandaloneStore.shared.publicSummary()
            updateMenuBadge(from: sum)
            replyCallback(reqId, sum)
            return
        }
        if path == "/api/presets" {
            if let u = Bundle.main.url(forResource: "presets", withExtension: "json"),
               let d = try? Data(contentsOf: u),
               let arr = try? JSONSerialization.jsonObject(with: d) {
                replyCallback(reqId, ["ok": true, "packs": arr])
            } else {
                replyCallback(reqId, ["ok": true, "packs": []])
            }
            return
        }
        if path.hasPrefix("/api/scan-leads") {
            let comps = URLComponents(string: "http://local\(path)")
            let q = comps?.queryItems?.first(where: { $0.name == "q" })?.value ?? "Shopify"
            NativeLeadScanner.scan(query: q) { res in
                self.replyCallback(reqId, res)
            }
            return
        }
        if path == "/api/license/activate" {
            let key = (payload?["key"] as? String) ?? ""
            let check = LicenseVerifier.verify(key)
            if (check["valid"] as? Bool) == true {
                var st = StandaloneStore.shared.loadState()
                st["license"] = ["key": key, "activatedAt": ISO8601DateFormatter().string(from: Date())]
                StandaloneStore.shared.saveState(st)
                replyCallback(reqId, ["ok": true, "license": check])
            } else {
                replyCallback(reqId, ["ok": false, "error": (check["error"] as? String) ?? "无效激活码"])
            }
            return
        }
        if path == "/api/settings" {
            var st = StandaloneStore.shared.loadState()
            var set = (st["settings"] as? [String: Any]) ?? [:]
            if let wh = payload?["webhookUrl"] as? String { set["webhookUrl"] = wh }
            if let ta = payload?["termsAcceptedAt"] as? String { set["termsAcceptedAt"] = ta }
            if let ps = payload?["preventSleep"] as? Bool {
                set["preventSleep"] = ps
                #if !MAS_BUILD
                StandaloneMobileGateway.shared.syncPreventSleep(ps)
                #endif
            }
            st["settings"] = set
            StandaloneStore.shared.saveState(st)
            replyCallback(reqId, ["ok": true, "settings": set])
            return
        }
        if method == "POST" && path == "/api/quick-replies" {
            var st = StandaloneStore.shared.loadState()
            let list = (payload?["quickReplies"] as? [[String: Any]]) ?? []
            st["quickReplies"] = Array(list.prefix(300))
            StandaloneStore.shared.saveState(st)
            refreshWorkspaceToolbarMenus()
            replyCallback(reqId, ["ok": true, "quickReplies": st["quickReplies"] ?? []])
            return
        }
        if method == "POST" && path == "/api/watches" {
            var st = StandaloneStore.shared.loadState()
            var watches = (st["watches"] as? [[String: Any]]) ?? []
            var url = ((payload?["url"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !url.isEmpty && !url.lowercased().hasPrefix("http://") && !url.lowercased().hasPrefix("https://") {
                url = "https://\(url)"
            }
            let id = (payload?["id"] as? String) ?? "watch-\(Int(Date().timeIntervalSince1970))-\(Int.random(in: 100...999))"
            let mins = (payload?["baseIntervalMinutes"] as? Int) ?? 60
            let allowDup = (payload?["allowDuplicateUrl"] as? Bool) ?? false
            let pUuid = deterministicProfileUUID(id).uuidString.lowercased()
            let newItem: [String: Any] = [
                "id": id,
                "name": (payload?["name"] as? String) ?? url,
                "url": url,
                "category": (payload?["category"] as? String) ?? "接单外包",
                "publishTier": (payload?["publishTier"] as? String) ?? "yellow",
                "isolatedProfile": true,
                "profileUuid": pUuid,
                "contextSummary": (payload?["contextSummary"] as? String) ?? "",
                "baseIntervalMinutes": mins,
                "status": "idle",
                "unreadCount": 0,
                "snippet": "",
                "lastDraft": "",
                "nextCheckAt": StandaloneStore.shared.computeNextCheckISO(baseMinutes: mins)
            ]
            if let idx = watches.firstIndex(where: { ($0["id"] as? String) == id || (!allowDup && ($0["url"] as? String) == url) }) {
                watches[idx] = newItem
            } else {
                watches.append(newItem)
            }
            st["watches"] = watches
            StandaloneStore.shared.saveState(st)
            refreshWorkspaceToolbarMenus()
            replyCallback(reqId, ["ok": true, "watch": newItem])
            return
        }
        if method == "DELETE" && path.hasPrefix("/api/watches/") {
            let rawId = String(path.dropFirst("/api/watches/".count)).removingPercentEncoding ?? ""
            if let wv = liveTabs.removeValue(forKey: rawId) {
                wv.removeFromSuperview()
                webViewToWatchId.removeValue(forKey: ObjectIdentifier(wv))
            }
            tabMeta.removeValue(forKey: rawId)
            var st = StandaloneStore.shared.loadState()
            var watches = (st["watches"] as? [[String: Any]]) ?? []
            watches.removeAll { ($0["id"] as? String) == rawId }
            st["watches"] = watches
            StandaloneStore.shared.saveState(st)
            refreshWorkspaceToolbarMenus()
            replyCallback(reqId, ["ok": true, "deleted": true])
            return
        }
        if method == "POST" && path.hasSuffix("/resolve") {
            let mid = path.replacingOccurrences(of: "/api/watches/", with: "").replacingOccurrences(of: "/resolve", with: "")
            let rawId = mid.removingPercentEncoding ?? mid
            let act = (payload?["action"] as? String) ?? "resolve"
            var st = StandaloneStore.shared.loadState()
            var watches = (st["watches"] as? [[String: Any]]) ?? []
            if let idx = watches.firstIndex(where: { ($0["id"] as? String) == rawId }) {
                if act == "pause" {
                    watches[idx]["status"] = "paused"
                } else {
                    watches[idx]["status"] = "idle"
                    watches[idx]["unreadCount"] = 0
                    watches[idx]["snippet"] = ""
                }
                st["watches"] = watches
                StandaloneStore.shared.saveState(st)
            }
            replyCallback(reqId, ["ok": true])
            return
        }
        if method == "POST" && path.hasSuffix("/draft") {
            let mid = path.replacingOccurrences(of: "/api/watches/", with: "").replacingOccurrences(of: "/draft", with: "")
            let rawId = mid.removingPercentEncoding ?? mid
            let draft = (payload?["draft"] as? String) ?? ""
            var st = StandaloneStore.shared.loadState()
            var watches = (st["watches"] as? [[String: Any]]) ?? []
            if let idx = watches.firstIndex(where: { ($0["id"] as? String) == rawId }) {
                watches[idx]["lastDraft"] = draft
                st["watches"] = watches
                StandaloneStore.shared.saveState(st)
            }
            replyCallback(reqId, ["ok": true])
            return
        }
        if path == "/api/desktop/state" {
            #if !MAS_BUILD
            if let helperURL = Bundle.main.url(forResource: "mac-desktop-helper", withExtension: nil, subdirectory: "app-server/bin") {
                DispatchQueue.global(qos: .userInitiated).async {
                    let p = Process()
                    p.executableURL = helperURL
                    p.arguments = ["list"]
                    let pipe = Pipe()
                    p.standardOutput = pipe
                    p.standardError = FileHandle.nullDevice
                    try? p.run()
                    let outData = pipe.fileHandleForReading.readDataToEndOfFile()
                    p.waitUntilExit()
                    if let obj = (try? JSONSerialization.jsonObject(with: outData)) as? [String: Any] {
                        self.replyCallback(reqId, obj)
                    } else {
                        self.replyCallback(reqId, ["ok": true, "windows": [], "badges": [], "recentAlerts": []])
                    }
                }
                return
            }
            #endif
            replyCallback(reqId, ["ok": true, "windows": [], "badges": [], "recentAlerts": []])
            return
        }
        if path == "/api/open-extension-dir" {
            #if !MAS_BUILD
            if let extURL = Bundle.main.resourceURL?.appendingPathComponent("app-server/extension"),
               FileManager.default.fileExists(atPath: extURL.path) {
                NSWorkspace.shared.activateFileViewerSelecting([extURL])
                replyCallback(reqId, ["ok": true, "dir": extURL.path])
                return
            }
            #endif
            replyCallback(reqId, ["ok": false, "error": "extension dir unavailable"])
            return
        }
        if path == "/api/push/test" {
            let st = StandaloneStore.shared.loadState()
            let savedWh = ((st["settings"] as? [String: Any])?["webhookUrl"] as? String) ?? ""
            let wh = ((payload?["webhookUrl"] as? String) ?? savedWh).trimmingCharacters(in: .whitespacesAndNewlines)
            postLocalNotification(
                title: isChineseSystem ? "🔔 消息总管锁屏推送测试" : "🔔 ReplyRadar Push Test",
                body: isChineseSystem ? "电脑本地通知与外部手机推送通道已触发！" : "Notification test triggered!"
            )
            if wh.isEmpty {
                replyCallback(reqId, ["ok": false, "error": isChineseSystem ? "请先粘贴推送口令或链接" : "Please enter push token or URL"])
                return
            }
            WebhookDispatcher.send(
                webhookUrlStr: wh,
                siteName: isChineseSystem ? "推送测试" : "Push Test",
                unreadCount: 1,
                snippet: isChineseSystem ? "恭喜！您的手机锁屏强提醒已成功打通，来客户消息时手机息屏也会立刻响铃！" : "Mobile lock-screen alert is live!",
                siteUrl: "https://a3152557994-ship-it.github.io/tabpulse/"
            ) { ok, channel, err in
                self.replyCallback(reqId, ["ok": ok, "channel": channel, "error": err, "webhookConfigured": true])
            }
            return
        }
        if path == "/api/mobile/info" {
            #if !MAS_BUILD
            replyCallback(reqId, StandaloneMobileGateway.shared.currentPairingInfo())
            #else
            replyCallback(reqId, [
                "ok": false,
                "standaloneHint": isChineseSystem
                    ? "App Store 沙盒版在「软件设置」填入免费微信 PushPlus 口令或 Bark 码，即可锁屏秒收手机通知！"
                    : "Configure Webhook/Bark in Settings for instant phone push alerts."
            ])
            #endif
            return
        }
        if method == "POST" && path == "/api/mobile/tunnel" {
            #if !MAS_BUILD
            let act = (payload?["action"] as? String) ?? "start"
            StandaloneMobileGateway.shared.handleTunnelAction(act) { info in
                self.replyCallback(reqId, info)
            }
            #else
            replyCallback(reqId, ["ok": false])
            #endif
            return
        }
        if path == "/api/cc/state" || path == "/api/ai-clients/status" || path == "/api/ai-butler/state" {
            replyCallback(reqId, ["ok": true, "sessions": [], "agents": [], "clients": [], "events": [], "suggestions": [:]])
            return
        }
        replyCallback(reqId, ["ok": false, "error": "unknown route"])
    }

    @objc func openUnreadFromMenu(_ sender: NSMenuItem) {
        guard let wid = sender.representedObject as? String,
              let meta = tabMeta[wid] else {
            showMainWindow()
            return
        }
        openLoginSheet(urlStr: meta.url, name: meta.name, watchId: wid, profileUuidStr: meta.profileUuid, isolated: true, dockInMain: true)
    }

    func updateMenuBadge(from summary: [String: Any]) {
        let stats = summary["stats"] as? [String: Any]
        let unread = (stats?["unreadMessagesTotal"] as? Int) ?? 0
        let watches = (summary["watches"] as? [[String: Any]]) ?? []
        let unreadWatches = watches.filter { ($0["status"] as? String) == "unread" }
        for w in watches {
            if let wid = w["id"] as? String, let nm = w["name"] as? String, let u = w["url"] as? String {
                let pUuid = (w["profileUuid"] as? String) ?? ""
                tabMeta[wid] = (name: nm, url: u, profileUuid: pUuid)
            }
        }
        DispatchQueue.main.async {
            if isChineseSystem {
                self.statusItem?.button?.title = unread > 0 ? "🔴 \(unread) 未读" : "🔔 消息"
            } else {
                self.statusItem?.button?.title = unread > 0 ? "🔴 \(unread) Unread" : "🔔 Inbox"
            }
            let menu = NSMenu()
            if !unreadWatches.isEmpty {
                for w in unreadWatches.prefix(8) {
                    let wid = (w["id"] as? String) ?? ""
                    let nm = (w["name"] as? String) ?? wid
                    let cnt = max(1, (w["unreadCount"] as? Int) ?? 1)
                    let item = NSMenuItem(title: "🔴 \(nm) (\(cnt))", action: #selector(self.openUnreadFromMenu(_:)), keyEquivalent: "")
                    item.target = self
                    item.representedObject = wid
                    menu.addItem(item)
                }
                menu.addItem(NSMenuItem.separator())
            }
            menu.addItem(withTitle: isChineseSystem ? "打开消息总管主界面" : "Open ReplyRadar Dashboard", action: #selector(self.showMainWindow), keyEquivalent: "")
            menu.addItem(withTitle: isChineseSystem ? "⚡ 立即检查后台消息" : "⚡ Check Inboxes Now", action: #selector(self.triggerCheckMenu), keyEquivalent: "")
            menu.addItem(NSMenuItem.separator())
            menu.addItem(withTitle: isChineseSystem ? "退出消息总管" : "Quit ReplyRadar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
            self.statusItem?.menu = menu
        }
    }

    #if MAS_BUILD
    func sendMasJsResult(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: d, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            self.dashboardWebView.evaluateJavaScript("if(window.__onMasIapResult) window.__onMasIapResult(\(s));", completionHandler: nil)
        }
    }

    func refreshStoreKitEntitlements() {
        Task {
            for await result in Transaction.currentEntitlements {
                if case .verified(let tx) = result {
                    if tx.productID == "com.yanghe.replyradar.pro.lifetime" || tx.productID == "com.yanghe.replyradar.pro.yearly" {
                        var st = StandaloneStore.shared.loadState()
                        st["license"] = ["iapUnlocked": true, "plan": "lifetime", "productId": tx.productID]
                        StandaloneStore.shared.saveState(st)
                    }
                }
            }
        }
    }

    func handleMasPurchase(productId: String) {
        Task {
            do {
                let products = try await Product.products(for: [productId])
                guard let product = products.first else {
                    sendMasJsResult(["ok": false, "error": isChineseSystem ? "商品正在同步审核中，请稍后再试" : "Product syncing with App Store"])
                    return
                }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    if case .verified(let tx) = verification {
                        await tx.finish()
                        var st = StandaloneStore.shared.loadState()
                        st["license"] = ["iapUnlocked": true, "plan": "lifetime", "productId": tx.productID]
                        StandaloneStore.shared.saveState(st)
                        sendMasJsResult(["ok": true])
                    } else {
                        sendMasJsResult(["ok": false, "error": "Verification failed"])
                    }
                case .userCancelled:
                    sendMasJsResult(["ok": false, "error": isChineseSystem ? "已取消支付" : "Purchase cancelled"])
                default:
                    sendMasJsResult(["ok": false, "error": isChineseSystem ? "交易处理中" : "Purchase pending"])
                }
            } catch {
                sendMasJsResult(["ok": false, "error": error.localizedDescription])
            }
        }
    }

    func handleMasRestore() {
        Task {
            do {
                try await AppStore.sync()
                var unlocked = false
                for await result in Transaction.currentEntitlements {
                    if case .verified(let tx) = result,
                       (tx.productID == "com.yanghe.replyradar.pro.lifetime" || tx.productID == "com.yanghe.replyradar.pro.yearly") {
                        unlocked = true
                        var st = StandaloneStore.shared.loadState()
                        st["license"] = ["iapUnlocked": true, "plan": "lifetime", "productId": tx.productID]
                        StandaloneStore.shared.saveState(st)
                    }
                }
                sendMasJsResult(unlocked
                    ? ["ok": true]
                    : ["ok": false, "error": isChineseSystem ? "未找到可恢复的购买记录" : "No previous purchases found"])
            } catch {
                sendMasJsResult(["ok": false, "error": error.localizedDescription])
            }
        }
    }
    #endif

    func warmUpPassiveRedTabsIfNeeded() {
        guard !didWarmUpPassiveTabs else { return }
        didWarmUpPassiveTabs = true
        let st = activeStateSnapshot()
        let watches = (st["watches"] as? [[String: Any]]) ?? []
        let redTargets = watches.filter { w in
            let tier = (w["publishTier"] as? String) ?? "yellow"
            let status = (w["status"] as? String) ?? "idle"
            return tier == "red" && status != "paused" && status != "auth_expired"
        }
        for (idx, w) in redTargets.enumerated() {
            guard let wid = w["id"] as? String,
                  let urlStr = w["url"] as? String,
                  let name = w["name"] as? String else { continue }
            let pUuid = (w["profileUuid"] as? String) ?? ""
            let delay = 2.0 + Double(idx) * 1.8
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self, self.liveTabs[wid] == nil else { return }
                _ = self.getOrCreateLiveWebView(watchId: wid, urlStr: urlStr, name: name, profileUuidStr: pUuid, isolated: true)
            }
        }
    }

    func handlePassiveEvent(watchId: String, unreadCount: Int, snippet: String, authExpired: Bool = false) {
        if authExpired && activeLoginWatchId != watchId {
            if let parkedWV = liveTabs.removeValue(forKey: watchId) {
                parkedWV.removeFromSuperview()
                webViewToWatchId.removeValue(forKey: ObjectIdentifier(parkedWV))
            }
        }
        let resolvedName = tabMeta[watchId]?.name ?? watchId

        if useExternalHub, let repURL = URL(string: "http://127.0.0.1:17890/api/report") {
            var req = URLRequest(url: repURL)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any] = ["id": watchId, "unreadCount": unreadCount, "snippet": snippet, "authExpired": authExpired]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
                self?.syncExternalHubState()
                self?.notifyDashboardProbeDone(id: watchId, name: resolvedName, unreadCount: unreadCount, authExpired: authExpired)
            }.resume()
            DispatchQueue.main.async {
                if unreadCount > 0 && !authExpired {
                    self.statusItem?.button?.title = isChineseSystem ? "🔴 \(unreadCount) 未读" : "🔴 \(unreadCount) Unread"
                }
            }
        } else {
            var st = StandaloneStore.shared.loadState()
            var watches = (st["watches"] as? [[String: Any]]) ?? []
            if let idx = watches.firstIndex(where: { ($0["id"] as? String) == watchId }) {
                let prevUnread = (watches[idx]["unreadCount"] as? Int) ?? 0
                let prevFp = (watches[idx]["lastFingerprint"] as? String) ?? ""
                let siteName = (watches[idx]["name"] as? String) ?? watchId
                let siteUrl = (watches[idx]["url"] as? String) ?? ""
                let fp = "\(unreadCount)::\(snippet)"
                watches[idx]["lastCheckedAt"] = ISO8601DateFormatter().string(from: Date())
                if authExpired {
                    watches[idx]["status"] = "auth_expired"
                    watches[idx]["unreadCount"] = 0
                } else if unreadCount > 0 {
                    watches[idx]["status"] = "unread"
                    watches[idx]["unreadCount"] = unreadCount
                    watches[idx]["snippet"] = snippet
                    watches[idx]["lastFingerprint"] = fp
                    if unreadCount > prevUnread || fp != prevFp {
                        NSSound.beep()
                        postLocalNotification(
                            title: isChineseSystem ? "🔴 \(siteName) 有 \(unreadCount) 条新消息" : "🔴 \(unreadCount) Unread in \(siteName)",
                            body: snippet.isEmpty ? siteUrl : snippet
                        )
                        let wh = ((st["settings"] as? [String: Any])?["webhookUrl"] as? String) ?? ""
                        WebhookDispatcher.send(webhookUrlStr: wh, siteName: siteName, unreadCount: unreadCount, snippet: snippet, siteUrl: siteUrl)
                    }
                } else {
                    watches[idx]["status"] = "idle"
                    watches[idx]["unreadCount"] = 0
                    watches[idx]["lastFingerprint"] = ""
                }
                st["watches"] = watches
                StandaloneStore.shared.saveState(st)
                updateMenuBadge(from: StandaloneStore.shared.publicSummary())
                notifyDashboardProbeDone(id: watchId, name: siteName, unreadCount: unreadCount, authExpired: authExpired)
            }
        }
    }

    // MARK: - Silent Background WebKit Sentinel (Bound to Per-Watch Isolated Cookie Store!)
    func loadUrlInIsolatedProbe(watchId: String, profileUuidStr: String, url: URL) {
        probeWebView?.stopLoading()
        probeWebView?.navigationDelegate = nil
        probeWebView?.removeFromSuperview()

        let cfg = WKWebViewConfiguration()
        if !watchId.isEmpty, #available(macOS 14.0, *) {
            let targetUUID = UUID(uuidString: profileUuidStr) ?? deterministicProfileUUID(watchId)
            cfg.websiteDataStore = WKWebsiteDataStore(forIdentifier: targetUUID)
        } else {
            cfg.websiteDataStore = .default()
        }
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true

        let nextProbe = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: cfg)
        nextProbe.customUserAgent = SAFARI_DESKTOP_UA
        nextProbe.navigationDelegate = self
        probeWebView = nextProbe
        backgroundTabsContainer.addSubview(nextProbe)
        nextProbe.load(URLRequest(url: url))
    }

    func runSilentCheckCycle(forceImmediate: Bool = false, targetId: String = "") {
        guard currentProbeTargetId == nil else { return }
        if !forceImmediate {
            let hour = Calendar.current.component(.hour, from: Date())
            if hour >= 0 && hour < 8 { return } // Night anti-ban protection
        }

        if useExternalHub {
            var q = forceImmediate ? "?force=1" : ""
            if !targetId.isEmpty {
                let enc = targetId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? targetId
                q = "?force=1&id=\(enc)"
            }
            guard let dueURL = URL(string: "http://127.0.0.1:17890/api/due\(q)") else { return }
            URLSession.shared.dataTask(with: dueURL) { [weak self] data, _, _ in
                guard let d = data,
                      let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
                      let due = obj["due"] as? [[String: Any]],
                      let first = due.first,
                      let id = first["id"] as? String,
                      let urlStr = first["url"] as? String,
                      let targetURL = URL(string: urlStr) else { return }
                let name = (first["name"] as? String) ?? id
                let pUuid = (first["profileUuid"] as? String) ?? ""
                DispatchQueue.main.async {
                    self?.currentProbeTargetId = id
                    self?.currentProbeTargetName = name
                    self?.loadUrlInIsolatedProbe(watchId: id, profileUuidStr: pUuid, url: targetURL)
                }
            }.resume()
        } else {
            let st = StandaloneStore.shared.loadState()
            let watches = (st["watches"] as? [[String: Any]]) ?? []
            let nowISO = ISO8601DateFormatter().string(from: Date())
            let candidate = watches.first { w in
                let wid = (w["id"] as? String) ?? ""
                if !targetId.isEmpty { return wid == targetId }
                let tier = (w["publishTier"] as? String) ?? "yellow"
                let status = (w["status"] as? String) ?? "idle"
                if status == "paused" || (!forceImmediate && (status == "auth_expired" || tier == "red")) { return false }
                if forceImmediate { return true }
                let next = (w["nextCheckAt"] as? String) ?? ""
                return next.isEmpty || next <= nowISO
            }
            if let c = candidate, let id = c["id"] as? String, let uStr = c["url"] as? String, let u = URL(string: uStr) {
                let pUuid = (c["profileUuid"] as? String) ?? ""
                currentProbeTargetId = id
                currentProbeTargetName = (c["name"] as? String) ?? id
                loadUrlInIsolatedProbe(watchId: id, profileUuidStr: pUuid, url: u)
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView == probeWebView, let targetId = currentProbeTargetId else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.8) { [weak self] in
            self?.extractUnreadFromProbe(targetId: targetId)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if webView == probeWebView {
            currentProbeTargetId = nil
            currentProbeTargetName = nil
        }
    }

    func notifyDashboardProbeDone(id: String, name: String, unreadCount: Int, authExpired: Bool) {
        let info: [String: Any] = [
            "id": id,
            "name": name,
            "unreadCount": unreadCount,
            "authExpired": authExpired
        ]
        if let d = try? JSONSerialization.data(withJSONObject: info),
           let s = String(data: d, encoding: .utf8) {
            DispatchQueue.main.async {
                self.dashboardWebView.evaluateJavaScript("if(window.__onNativeProbeFinished) window.__onNativeProbeFinished(\(s));", completionHandler: nil)
            }
        }
    }

    func extractUnreadFromProbe(targetId: String) {
        let targetName = currentProbeTargetName ?? targetId
        guard let probeURL = Bundle.main.url(forResource: "probe", withExtension: "js"),
              let js = try? String(contentsOf: probeURL, encoding: .utf8) else {
            currentProbeTargetId = nil
            currentProbeTargetName = nil
            return
        }
        probeWebView.evaluateJavaScript(js) { [weak self] res, _ in
            guard let self = self else { return }
            defer {
                self.currentProbeTargetId = nil
                self.currentProbeTargetName = nil
            }
            guard let report = res as? [String: Any] else { return }
            let unreadCount = (report["unreadCount"] as? Int) ?? 0
            let authExpired = (report["authExpired"] as? Bool) ?? false
            let snippet = (report["snippet"] as? String) ?? ""

            if self.useExternalHub, let repURL = URL(string: "http://127.0.0.1:17890/api/report") {
                var req = URLRequest(url: repURL)
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                var body = report
                body["id"] = targetId
                req.httpBody = try? JSONSerialization.data(withJSONObject: body)
                URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
                    self?.notifyDashboardProbeDone(id: targetId, name: targetName, unreadCount: unreadCount, authExpired: authExpired)
                }.resume()
                DispatchQueue.main.async {
                    if unreadCount > 0 { self.statusItem?.button?.title = "🔴 \(unreadCount) 未读" }
                }
            } else {
                var st = StandaloneStore.shared.loadState()
                var watches = (st["watches"] as? [[String: Any]]) ?? []
                if let idx = watches.firstIndex(where: { ($0["id"] as? String) == targetId }) {
                    let prevUnread = (watches[idx]["unreadCount"] as? Int) ?? 0
                    let prevFp = (watches[idx]["lastFingerprint"] as? String) ?? ""
                    let siteUrl = (watches[idx]["url"] as? String) ?? ""
                    let fp = "\(unreadCount)::\(snippet)"
                    let mins = (watches[idx]["baseIntervalMinutes"] as? Int) ?? 60
                    watches[idx]["nextCheckAt"] = StandaloneStore.shared.computeNextCheckISO(baseMinutes: mins)
                    watches[idx]["lastCheckedAt"] = ISO8601DateFormatter().string(from: Date())
                    if authExpired {
                        watches[idx]["status"] = "auth_expired"
                    } else if unreadCount > 0 {
                        watches[idx]["status"] = "unread"
                        watches[idx]["unreadCount"] = unreadCount
                        watches[idx]["snippet"] = snippet
                        watches[idx]["lastFingerprint"] = fp
                        if unreadCount > prevUnread || fp != prevFp {
                            NSSound.beep()
                            self.postLocalNotification(
                                title: isChineseSystem ? "🔴 \(targetName) 有 \(unreadCount) 条新消息" : "🔴 \(unreadCount) Unread in \(targetName)",
                                body: snippet.isEmpty ? siteUrl : snippet
                            )
                            let wh = ((st["settings"] as? [String: Any])?["webhookUrl"] as? String) ?? ""
                            WebhookDispatcher.send(webhookUrlStr: wh, siteName: targetName, unreadCount: unreadCount, snippet: snippet, siteUrl: siteUrl)
                        }
                    } else {
                        watches[idx]["status"] = "idle"
                        watches[idx]["unreadCount"] = 0
                        watches[idx]["lastFingerprint"] = ""
                    }
                    st["watches"] = watches
                    StandaloneStore.shared.saveState(st)
                    self.updateMenuBadge(from: StandaloneStore.shared.publicSummary())
                    self.notifyDashboardProbeDone(id: targetId, name: targetName, unreadCount: unreadCount, authExpired: authExpired)
                }
            }
        }
    }
}

#if !MAS_BUILD
// MARK: - Zero-Node Native Mobile Gateway (NWListener + SSH Tunnel + Edge Permanent Bookmark + Caffeinate)
final class StandaloneMobileGateway {
    static let shared = StandaloneMobileGateway()
    private let edgeOrigin = "https://replyradar-edge.a3152557994.workers.dev"
    private var listener: NWListener?
    private weak var appDelegate: AppDelegate?
    private var port: UInt16 = 17890
    private var sshProc: Process?
    private var caffeinateProc: Process?
    private var publicUrl: String = ""
    private var tunnelStatus: String = "stopped"
    private var wantedTunnel: Bool = false

    func start(appDelegate: AppDelegate?) {
        self.appDelegate = appDelegate
        let st = StandaloneStore.shared.loadState()
        let set = (st["settings"] as? [String: Any]) ?? [:]
        syncPreventSleep((set["preventSleep"] as? Bool) ?? false)

        if listener == nil {
            for candidatePort: UInt16 in [17890, 17891, 17892] {
                if let nwPort = NWEndpoint.Port(rawValue: candidatePort),
                   let l = try? NWListener(using: .tcp, on: nwPort) {
                    self.port = candidatePort
                    self.listener = l
                    l.newConnectionHandler = { [weak self] conn in
                        self?.handleConnection(conn)
                    }
                    l.start(queue: DispatchQueue.global(qos: .userInitiated))
                    break
                }
            }
        }

        if (set["tunnelAutoStart"] as? Bool) == true {
            DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) {
                self.startSshTunnel(completion: nil)
            }
        }
    }

    func stopAll() {
        wantedTunnel = false
        sshProc?.terminate()
        sshProc = nil
        caffeinateProc?.terminate()
        caffeinateProc = nil
        listener?.cancel()
        listener = nil
    }

    func syncPreventSleep(_ enabled: Bool) {
        if enabled && caffeinateProc == nil {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/caffeinate")
            p.arguments = ["-di", "-w", "\(ProcessInfo.processInfo.processIdentifier)"]
            try? p.run()
            caffeinateProc = p
        } else if !enabled, let p = caffeinateProc {
            p.terminate()
            caffeinateProc = nil
        }
    }

    private func getLanIP() -> String {
        var address = "127.0.0.1"
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr {
            var ptr: UnsafeMutablePointer<ifaddrs>? = firstAddr
            while let cur = ptr {
                let interface = cur.pointee
                if interface.ifa_addr.pointee.sa_family == UInt8(AF_INET) {
                    let name = String(cString: interface.ifa_name)
                    if name != "lo0" {
                        var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                        getnameinfo(interface.ifa_addr, socklen_t(interface.ifa_addr.pointee.sa_len), &hostname, socklen_t(hostname.count), nil, socklen_t(0), NI_NUMERICHOST)
                        let ip = String(cString: hostname)
                        if ip.hasPrefix("192.168.") || ip.hasPrefix("10.") || ip.hasPrefix("172.") {
                            address = ip
                            if ip.hasPrefix("192.168.") { break }
                        }
                    }
                }
                ptr = interface.ifa_next
            }
            freeifaddrs(ifaddr)
        }
        return address
    }

    func currentPairingInfo() -> [String: Any] {
        let st = StandaloneStore.shared.loadState()
        let tok = (st["mobileToken"] as? String) ?? ""
        let boxId = (st["tunnelBoxId"] as? String) ?? ""
        let set = (st["settings"] as? [String: Any]) ?? [:]
        let lanUrl = "http://\(getLanIP()):\(port)/m?t=\(tok)"
        let permUrl = (!publicUrl.isEmpty && !boxId.isEmpty) ? "\(edgeOrigin)/go/\(boxId)?t=\(tok)" : ""
        let rawTun = !publicUrl.isEmpty ? "\(publicUrl)/m?t=\(tok)" : ""
        let tunUrl = !permUrl.isEmpty ? permUrl : rawTun
        let primary = !tunUrl.isEmpty ? tunUrl : lanUrl
        return [
            "ok": true,
            "status": tunnelStatus,
            "publicUrl": publicUrl,
            "permanentMobileUrl": permUrl,
            "tunnelMobileUrl": tunUrl,
            "lanUrl": lanUrl,
            "primaryUrl": primary,
            "preventSleep": (set["preventSleep"] as? Bool) ?? false
        ]
    }

    func handleTunnelAction(_ action: String, completion: @escaping ([String: Any]) -> Void) {
        var st = StandaloneStore.shared.loadState()
        var set = (st["settings"] as? [String: Any]) ?? [:]
        if action == "rotateToken" {
            st["mobileToken"] = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            StandaloneStore.shared.saveState(st)
            completion(currentPairingInfo())
            return
        }
        if action == "stop" {
            wantedTunnel = false
            set["tunnelAutoStart"] = false
            st["settings"] = set
            StandaloneStore.shared.saveState(st)
            sshProc?.terminate()
            sshProc = nil
            publicUrl = ""
            tunnelStatus = "stopped"
            completion(currentPairingInfo())
            return
        }
        wantedTunnel = true
        set["tunnelAutoStart"] = true
        set["preventSleep"] = true
        st["settings"] = set
        StandaloneStore.shared.saveState(st)
        syncPreventSleep(true)
        startSshTunnel {
            completion(self.currentPairingInfo())
        }
    }

    private func syncEdgePermanentBookmark() {
        let st = StandaloneStore.shared.loadState()
        guard !publicUrl.isEmpty,
              let boxId = st["tunnelBoxId"] as? String,
              let writeKey = st["tunnelWriteKey"] as? String,
              let u = URL(string: "\(edgeOrigin)/api/tunnel/sync") else { return }
        var req = URLRequest(url: u, timeoutInterval: 8.0)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "boxId": boxId,
            "writeKey": writeKey,
            "targetOrigin": publicUrl
        ])
        URLSession.shared.dataTask(with: req).resume()
    }

    private func startSshTunnel(completion: (() -> Void)?) {
        if sshProc != nil && tunnelStatus == "running" && !publicUrl.isEmpty {
            completion?()
            return
        }
        sshProc?.terminate()
        sshProc = nil
        publicUrl = ""
        tunnelStatus = "starting"

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        p.arguments = ["-T", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes", "-R", "80:127.0.0.1:\(port)", "nokey@localhost.run"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe

        var settled = false
        let settleOnce = {
            if !settled {
                settled = true
                completion?()
            }
        }

        pipe.fileHandleForReading.readabilityHandler = { [weak self] fh in
            let data = fh.availableData
            if data.isEmpty { return }
            guard let self = self, let txt = String(data: data, encoding: .utf8) else { return }
            if let r = txt.range(of: "https://[a-zA-Z0-9.-]+\\.lhr\\.life", options: .regularExpression) {
                let found = String(txt[r])
                if self.publicUrl != found {
                    self.publicUrl = found
                    self.tunnelStatus = "running"
                    self.syncEdgePermanentBookmark()
                    settleOnce()
                }
            }
        }
        p.terminationHandler = { [weak self] proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            guard let self = self else { return }
            if self.sshProc === proc {
                self.sshProc = nil
                self.publicUrl = ""
                self.tunnelStatus = "stopped"
                if self.wantedTunnel {
                    DispatchQueue.global().asyncAfter(deadline: .now() + 6.0) {
                        if self.wantedTunnel { self.startSshTunnel(completion: nil) }
                    }
                }
            }
            settleOnce()
        }
        do {
            try p.run()
            sshProc = p
        } catch {
            tunnelStatus = "error"
            settleOnce()
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 6.2) {
            settleOnce()
        }
    }

    private func handleConnection(_ conn: NWConnection) {
        conn.start(queue: DispatchQueue.global(qos: .userInitiated))
        var buffer = Data()
        func readLoop() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, err in
                if let d = data, !d.isEmpty { buffer.append(d) }
                if let sepRange = buffer.range(of: Data("\r\n\r\n".utf8)) {
                    let headerData = buffer.subdata(in: 0..<sepRange.lowerBound)
                    let headerStr = String(data: headerData, encoding: .utf8) ?? ""
                    var contentLen = 0
                    for line in headerStr.split(separator: "\r\n") {
                        if line.lowercased().hasPrefix("content-length:") {
                            contentLen = Int(line.dropFirst(15).trimmingCharacters(in: .whitespaces)) ?? 0
                        }
                    }
                    let bodyStart = sepRange.upperBound
                    if buffer.count - bodyStart >= contentLen {
                        let bodyData = buffer.subdata(in: bodyStart..<(bodyStart + contentLen))
                        self?.dispatchHttpRequest(conn: conn, headerStr: headerStr, bodyData: bodyData)
                        return
                    }
                }
                if isComplete || err != nil {
                    conn.cancel()
                    return
                }
                readLoop()
            }
        }
        readLoop()
    }

    private func sendHttp(conn: NWConnection, status: Int, contentType: String, body: Data, extraHeaders: [String: String] = [:]) {
        let statusText = status == 200 ? "OK" : status == 201 ? "Created" : status == 401 ? "Unauthorized" : status == 404 ? "Not Found" : "OK"
        var head = "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n"
        for (k, v) in extraHeaders { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }

    private func sendJson(conn: NWConnection, status: Int = 200, obj: [String: Any], extraHeaders: [String: String] = [:]) {
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"ok\":false}".utf8)
        sendHttp(conn: conn, status: status, contentType: "application/json; charset=utf-8", body: data, extraHeaders: extraHeaders)
    }

    private func dispatchHttpRequest(conn: NWConnection, headerStr: String, bodyData: Data) {
        let lines = headerStr.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let first = lines.first else { conn.cancel(); return }
        let parts = first.split(separator: " ")
        guard parts.count >= 2 else { conn.cancel(); return }
        let method = String(parts[0])
        let rawTarget = String(parts[1])
        let comps = URLComponents(string: "http://127.0.0.1\(rawTarget)")
        let pathname = comps?.path ?? "/"

        var headers: [String: String] = [:]
        for l in lines.dropFirst() {
            if let idx = l.firstIndex(of: ":") {
                let k = l[..<idx].trimmingCharacters(in: .whitespaces).lowercased()
                let v = l[l.index(after: idx)...].trimmingCharacters(in: .whitespaces)
                headers[k] = v
            }
        }

        if pathname == "/api/health" {
            sendJson(conn: conn, obj: ["ok": true, "version": "5.4.0", "standalone": true])
            return
        }
        if pathname == "/sw.js",
           let u = Bundle.main.url(forResource: "sw", withExtension: "js", subdirectory: "app-server/hub/ui"),
           let d = try? Data(contentsOf: u) {
            sendHttp(conn: conn, status: 200, contentType: "application/javascript; charset=utf-8", body: d, extraHeaders: ["Service-Worker-Allowed": "/"])
            return
        }
        if pathname == "/mobile-icon.svg" {
            let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><rect width=\"512\" height=\"512\" rx=\"112\" fill=\"#2563eb\"/><circle cx=\"356\" cy=\"156\" r=\"56\" fill=\"#ef4444\"/></svg>"
            sendHttp(conn: conn, status: 200, contentType: "image/svg+xml; charset=utf-8", body: Data(svg.utf8))
            return
        }

        let st = StandaloneStore.shared.loadState()
        let expectedTok = (st["mobileToken"] as? String) ?? ""
        let queryTok = comps?.queryItems?.first(where: { $0.name == "t" })?.value ?? ""
        let headerTok = headers["x-tabpulse-token"] ?? ""
        var cookieTok = ""
        if let ck = headers["cookie"] {
            for seg in ck.split(separator: ";") {
                let kv = seg.trimmingCharacters(in: .whitespaces).split(separator: "=", maxSplits: 1)
                if kv.count == 2 && kv[0] == "tp_mob_tok" {
                    cookieTok = String(kv[1]).removingPercentEncoding ?? String(kv[1])
                }
            }
        }
        let providedTok = !queryTok.isEmpty ? queryTok : (!headerTok.isEmpty ? headerTok : cookieTok)
        if !expectedTok.isEmpty && providedTok != expectedTok {
            let gate = "<!doctype html><html lang='zh-CN'><meta charset='utf-8'/><meta name='viewport' content='width=device-width,initial-scale=1'/><body style='background:#0f172a;color:#fff;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;margin:0'><div style='padding:24px;text-align:center'><h2>🔒 请用手机扫描电脑端《消息总管》二维码进入</h2></div></body></html>"
            sendHttp(conn: conn, status: 401, contentType: "text/html; charset=utf-8", body: Data(gate.utf8))
            return
        }
        var extraH: [String: String] = [:]
        if !queryTok.isEmpty {
            extraH["Set-Cookie"] = "tp_mob_tok=\(expectedTok); Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"
        }

        if pathname == "/" || pathname == "/m" {
            if let u = Bundle.main.url(forResource: "mobile", withExtension: "html", subdirectory: "app-server/hub/ui"),
               let d = try? Data(contentsOf: u) {
                sendHttp(conn: conn, status: 200, contentType: "text/html; charset=utf-8", body: d, extraHeaders: extraH)
                return
            }
        }
        if pathname == "/api/events-stream" {
            let sse = "data: {\"kind\":\"connected\"}\n\n"
            sendHttp(conn: conn, status: 200, contentType: "text/event-stream; charset=utf-8", body: Data(sse.utf8), extraHeaders: extraH)
            return
        }
        if pathname == "/api/state" {
            var sum = StandaloneStore.shared.publicSummary()
            if var sObj = sum["settings"] as? [String: Any] {
                sObj["webhookUrl"] = ""
                sum["settings"] = sObj
            }
            sendJson(conn: conn, obj: sum, extraHeaders: extraH)
            return
        }
        if pathname == "/api/cc/state" || pathname == "/api/ai-inbox/state" || pathname == "/api/ai-butler/state" {
            sendJson(conn: conn, obj: ["ok": true, "sessions": [], "hookEvents": [], "agents": [], "channels": [], "suggestions": [:], "events": []], extraHeaders: extraH)
            return
        }
        if pathname == "/api/desktop/state" {
            if let helperURL = Bundle.main.url(forResource: "mac-desktop-helper", withExtension: nil, subdirectory: "app-server/bin") {
                let p = Process()
                p.executableURL = helperURL
                p.arguments = ["list"]
                let pipe = Pipe()
                p.standardOutput = pipe
                p.standardError = FileHandle.nullDevice
                try? p.run()
                let out = pipe.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                if let obj = (try? JSONSerialization.jsonObject(with: out)) as? [String: Any] {
                    sendJson(conn: conn, obj: obj, extraHeaders: extraH)
                    return
                }
            }
            sendJson(conn: conn, obj: ["ok": true, "windows": [], "badges": [], "recentAlerts": []], extraHeaders: extraH)
            return
        }
        let bodyJson = (try? JSONSerialization.jsonObject(with: bodyData)) as? [String: Any]

        if method == "POST" && pathname.hasSuffix("/resolve") {
            let rawId = (pathname.replacingOccurrences(of: "/api/watches/", with: "").replacingOccurrences(of: "/resolve", with: "")).removingPercentEncoding ?? ""
            var cur = StandaloneStore.shared.loadState()
            var watches = (cur["watches"] as? [[String: Any]]) ?? []
            if let idx = watches.firstIndex(where: { ($0["id"] as? String) == rawId }) {
                watches[idx]["status"] = "idle"
                watches[idx]["unreadCount"] = 0
                cur["watches"] = watches
                StandaloneStore.shared.saveState(cur)
            }
            sendJson(conn: conn, obj: ["ok": true])
            return
        }

        if pathname.hasPrefix("/api/remote/tab/"), let del = appDelegate {
            let tail = String(pathname.dropFirst("/api/remote/tab/".count))
            let segs = tail.split(separator: "/", maxSplits: 1).map(String.init)
            if segs.count == 2 {
                let wid = segs[0].removingPercentEncoding ?? segs[0]
                let op = segs[1]
                let watches = (StandaloneStore.shared.loadState()["watches"] as? [[String: Any]]) ?? []
                guard let w = watches.first(where: { ($0["id"] as? String) == wid }),
                      let uStr = w["url"] as? String,
                      let nm = w["name"] as? String else {
                    sendJson(conn: conn, status: 404, obj: ["ok": false, "error": "watch not found"])
                    return
                }
                let pUuid = (w["profileUuid"] as? String) ?? ""
                DispatchQueue.main.async {
                    let wasCold = del.liveTabs[wid] == nil
                    guard let wv = del.getOrCreateLiveWebView(watchId: wid, urlStr: uStr, name: nm, profileUuidStr: pUuid, isolated: true) else {
                        self.sendJson(conn: conn, obj: ["ok": false, "error": "invalid url"])
                        return
                    }
                    if op == "snapshot" {
                        DispatchQueue.main.asyncAfter(deadline: .now() + (wasCold ? 1.8 : 0.1)) {
                            del.extractDomSnapshotDict(wv: wv) { snap in
                                self.sendJson(conn: conn, obj: snap)
                            }
                        }
                    } else if op == "peek-image" {
                        DispatchQueue.main.asyncAfter(deadline: .now() + (wasCold ? 1.8 : 0.1)) {
                            del.captureWebViewJpegDataUrl(wv: wv) { dUrl in
                                if let d = dUrl {
                                    self.sendJson(conn: conn, obj: ["ok": true, "dataUrl": d])
                                } else {
                                    self.sendJson(conn: conn, obj: ["ok": false, "error": "画面提取失败"])
                                }
                            }
                        }
                    } else if op == "action" && method == "POST" {
                        let txt = (bodyJson?["text"] as? String) ?? ""
                        del.injectTextIntoWebView(wv, text: txt, autoSubmit: true) { ok in
                            self.sendJson(conn: conn, obj: ["ok": ok, "injected": ok])
                        }
                    } else {
                        self.sendJson(conn: conn, obj: ["ok": true])
                    }
                }
                return
            }
        }

        sendJson(conn: conn, obj: ["ok": true])
    }
}
#endif

// MARK: - CLI Self-Test & Entrypoint
let args = CommandLine.arguments
if args.contains("--self-test") {
    let bad = LicenseVerifier.verify("TP1.fake.fake")
    assert((bad["valid"] as? Bool) == false, "Invalid license must fail")
    let spun = resolveSpintaxSwift("{你好|哈喽}世界")
    assert(spun == "你好世界" || spun == "哈喽世界", "Spintax resolver failed")
    if let idx = args.firstIndex(of: "--verify-key"), idx + 1 < args.count {
        let good = LicenseVerifier.verify(args[idx + 1])
        guard (good["valid"] as? Bool) == true else {
            fputs("KEY_VERIFY_FAILED: \(good)\n", stderr)
            exit(2)
        }
    }
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("tp-selftest-\(UUID().uuidString).json")
    setenv("TABPULSE_STANDALONE_STATE", tmp.path, 1)
    let store = StandaloneStore()
    let summary = store.publicSummary()
    try? FileManager.default.removeItem(at: tmp)
    guard let watches = summary["watches"] as? [[String: Any]], watches.count == 2,
          let qrs = summary["quickReplies"] as? [[String: Any]], qrs.count >= 4 else {
        fputs("STANDALONE_STORE_FAILED\n", stderr)
        exit(3)
    }
    print("SELFTEST_OK")
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
