import Cocoa
import CryptoKit
import Foundation
import UserNotifications
import WebKit
#if MAS_BUILD
import StoreKit
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

enum WebhookDispatcher {
    static func send(webhookUrlStr: String, siteName: String, unreadCount: Int, snippet: String, siteUrl: String) {
        let trimmed = webhookUrlStr.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return }
        let title = isChineseSystem
            ? "🔔【消息总管】\(siteName) 有 \(unreadCount) 条新消息"
            : "🔔 [ReplyRadar] \(unreadCount) new unread in \(siteName)"
        let cleanSnippet = snippet.isEmpty ? siteUrl : "\(snippet)\n\(siteUrl)"
        let fullText = "\(title)\n\(cleanSnippet)"

        // Bark GET-style push URL support (https://api.day.app/<key>)
        if trimmed.contains("api.day.app/") && trimmed.split(separator: "/").count == 3 {
            let tEnc = title.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "ReplyRadar"
            let bEnc = cleanSnippet.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""
            if let barkURL = URL(string: "\(trimmed)/\(tEnc)/\(bEnc)") {
                URLSession.shared.dataTask(with: barkURL).resume()
                return
            }
        }

        var req = URLRequest(url: url, timeoutInterval: 8.0)
        req.httpMethod = "POST"
        req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")

        let payload: [String: Any]
        if trimmed.contains("feishu.cn") || trimmed.contains("larksuite.com") {
            payload = ["msg_type": "text", "content": ["text": fullText]]
        } else if trimmed.contains("qyapi.weixin.qq.com") {
            payload = ["msgtype": "text", "text": ["content": fullText]]
        } else if trimmed.contains("discord.com/api/webhooks") {
            payload = ["content": fullText]
        } else if trimmed.contains("sctapi.ftqq.com") {
            payload = ["title": title, "desp": cleanSnippet]
        } else {
            // Slack + generic JSON webhooks
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
        URLSession.shared.dataTask(with: req).resume()
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
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           obj["watches"] is [[String: Any]] {
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
            "version": "2.0.0",
            "license": NSNull(),
            "settings": ["webhookUrl": "", "radarKeywords": "Shopify", "lang": isChineseSystem ? "zh" : "en", "termsAcceptedAt": NSNull()],
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
            "version": "2.0.0",
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
    var workspaceRootView: NSView?
    var workspaceHostView: NSView?
    var accountSwitcherPopup: NSPopUpButton?
    var quickReplyPopup: NSPopUpButton?
    var toolbarStatusLabel: NSTextField?
    var loginWebView: WKWebView?
    var liveTabs: [String: WKWebView] = [:]
    var tabMeta: [String: (name: String, url: String, profileUuid: String)] = [:]
    var webViewToWatchId: [ObjectIdentifier: String] = [:]
    var activeLoginWatchId: String?
    var activeHomeURL: String?
    var statusItem: NSStatusItem!
    var sentinelTimer: Timer?
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

        dashboardWebView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 780), configuration: cfg)
        dashboardWebView.uiDelegate = self
        mainWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        mainWindow.center()
        mainWindow.title = isChineseSystem
            ? "消息总管 — 多平台未读消息提醒与找单盒子"
            : "ReplyRadar — All-in-One Unread Inbox & Buyer Lead Alerts"
        mainWindow.isReleasedWhenClosed = false
        mainWindow.contentView = dashboardWebView
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func setupSilentProbeWebView() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        probeWebView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: cfg)
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
        var req = URLRequest(url: healthURL, timeoutInterval: 1.2)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            DispatchQueue.main.async {
                if let http = resp as? HTTPURLResponse, http.statusCode == 200, data != nil {
                    self?.useExternalHub = true
                    self?.dashboardWebView.load(URLRequest(url: URL(string: "http://127.0.0.1:17890/")!))
                } else {
                    self?.useExternalHub = false
                    self?.loadStandaloneUI()
                }
            }
        }.resume()
        #endif
    }

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
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
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

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let targetURL = navigationAction.request.url else { return nil }
        if webView == loginWebView {
            loginWebView?.load(URLRequest(url: targetURL))
            return nil
        }
        if targetURL.host == "127.0.0.1" || targetURL.host == "localhost" || targetURL.isFileURL {
            openLoginSheet(urlStr: targetURL.absoluteString, name: isChineseSystem ? "高成交回复话术库" : "Cold-Reply Playbook", watchId: "")
        } else {
            NSWorkspace.shared.open(targetURL)
        }
        return nil
    }

    // MARK: - Unified Multi-Account Workspace Window + Top Toolbar + 1-Click Spintax Quick Replies
    func ensureWorkspaceWindow() {
        if loginWindow != nil { return }
        let winW: CGFloat = 1160
        let winH: CGFloat = 780
        let barH: CGFloat = 44

        let root = NSView(frame: NSRect(x: 0, y: 0, width: winW, height: winH))
        root.autoresizingMask = [.width, .height]

        let toolbar = NSView(frame: NSRect(x: 0, y: winH - barH, width: winW, height: barH))
        toolbar.autoresizingMask = [.width, .minYMargin]
        toolbar.wantsLayer = true
        toolbar.layer?.backgroundColor = NSColor(calibratedRed: 0.95, green: 0.96, blue: 0.98, alpha: 1.0).cgColor

        func makeBtn(_ title: String, x: CGFloat, w: CGFloat, action: Selector) -> NSButton {
            let b = NSButton(frame: NSRect(x: x, y: 7, width: w, height: 30))
            b.title = title
            b.bezelStyle = .rounded
            b.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
            b.target = self
            b.action = action
            return b
        }

        toolbar.addSubview(makeBtn("←", x: 10, w: 38, action: #selector(wsBack)))
        toolbar.addSubview(makeBtn("→", x: 50, w: 38, action: #selector(wsForward)))
        toolbar.addSubview(makeBtn("↻", x: 90, w: 38, action: #selector(wsReload)))
        toolbar.addSubview(makeBtn(isChineseSystem ? "🏠 消息页" : "🏠 Inbox", x: 132, w: 86, action: #selector(wsGoHome)))

        let accPop = NSPopUpButton(frame: NSRect(x: 224, y: 7, width: 250, height: 30), pullsDown: false)
        accPop.font = NSFont.systemFont(ofSize: 12.5, weight: .semibold)
        accPop.target = self
        accPop.action = #selector(wsSwitchAccountChanged(_:))
        toolbar.addSubview(accPop)
        accountSwitcherPopup = accPop

        let qrPop = NSPopUpButton(frame: NSRect(x: 482, y: 7, width: 250, height: 30), pullsDown: true)
        qrPop.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
        qrPop.target = self
        qrPop.action = #selector(wsQuickReplyPicked(_:))
        toolbar.addSubview(qrPop)
        quickReplyPopup = qrPop

        let statusLbl = NSTextField(labelWithString: isChineseSystem ? "🛡️ 独立防串号隔离仓运行中" : "🛡️ Isolated Cookie Sandbox")
        statusLbl.frame = NSRect(x: 740, y: 13, width: 270, height: 18)
        statusLbl.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        statusLbl.textColor = NSColor(calibratedRed: 0.08, green: 0.50, blue: 0.24, alpha: 1.0)
        statusLbl.lineBreakMode = .byTruncatingTail
        toolbar.addSubview(statusLbl)
        toolbarStatusLabel = statusLbl

        let dashBtn = makeBtn(isChineseSystem ? "📊 回总控台" : "📊 Dashboard", x: winW - 116, w: 106, action: #selector(showMainWindow))
        dashBtn.autoresizingMask = [.minXMargin]
        toolbar.addSubview(dashBtn)

        let host = NSView(frame: NSRect(x: 0, y: 0, width: winW, height: winH - barH))
        host.autoresizingMask = [.width, .height]

        root.addSubview(host)
        root.addSubview(toolbar)

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: winW, height: winH),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        win.center()
        win.isReleasedWhenClosed = false
        win.delegate = self
        win.contentView = root

        workspaceRootView = root
        workspaceHostView = host
        loginWindow = win
    }

    @objc func wsBack() { loginWebView?.goBack() }
    @objc func wsForward() { loginWebView?.goForward() }
    @objc func wsReload() { loginWebView?.reload() }
    @objc func wsGoHome() {
        if let h = activeHomeURL, let u = URL(string: h) {
            loginWebView?.load(URLRequest(url: u))
        }
    }

    func refreshWorkspaceToolbarMenus() {
        let st = StandaloneStore.shared.loadState()
        let watches = (st["watches"] as? [[String: Any]]) ?? []
        for w in watches {
            if let wid = w["id"] as? String, let nm = w["name"] as? String, let u = w["url"] as? String {
                let pUuid = (w["profileUuid"] as? String) ?? ""
                tabMeta[wid] = (name: nm, url: u, profileUuid: pUuid)
            }
        }

        if let pop = accountSwitcherPopup {
            pop.removeAllItems()
            var orderedIds = Array(liveTabs.keys).sorted()
            for w in watches {
                if let wid = w["id"] as? String, !orderedIds.contains(wid) {
                    orderedIds.append(wid)
                }
            }
            for wid in orderedIds {
                guard let meta = tabMeta[wid] else { continue }
                let isLive = liveTabs[wid] != nil
                let title = isLive ? "🟢 \(meta.name)" : "⚪ \(meta.name)"
                pop.addItem(withTitle: title)
                pop.lastItem?.representedObject = wid
                if wid == activeLoginWatchId {
                    pop.select(pop.lastItem)
                }
            }
            if pop.numberOfItems == 0 {
                pop.addItem(withTitle: isChineseSystem ? "当前临时窗口" : "Workspace Preview")
            }
        }

        if let qrPop = quickReplyPopup {
            qrPop.removeAllItems()
            qrPop.addItem(withTitle: isChineseSystem ? "⚡ 点此抽词复制防封快捷话术..." : "⚡ Copy Spintax Quick Reply...")
            let qrs = (st["quickReplies"] as? [[String: Any]]) ?? []
            for item in qrs {
                let t = (item["title"] as? String) ?? "话术"
                let body = (item["body"] as? String) ?? ""
                qrPop.addItem(withTitle: "📋 \(t)")
                qrPop.lastItem?.representedObject = body
            }
        }
    }

    @objc func wsSwitchAccountChanged(_ sender: NSPopUpButton) {
        guard let wid = sender.selectedItem?.representedObject as? String,
              let meta = tabMeta[wid] else { return }
        openLoginSheet(urlStr: meta.url, name: meta.name, watchId: wid, profileUuidStr: meta.profileUuid, isolated: true)
    }

    @objc func wsQuickReplyPicked(_ sender: NSPopUpButton) {
        guard let rawBody = sender.selectedItem?.representedObject as? String, !rawBody.isEmpty else { return }
        let spun = resolveSpintaxSwift(rawBody)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(spun, forType: .string)
        toolbarStatusLabel?.stringValue = isChineseSystem
            ? "✅ 已复制变体话术，直接按 Cmd+V 粘贴！"
            : "✅ Spintax variation copied — press Cmd+V!"
    }

    func openLoginSheet(urlStr: String, name: String, watchId: String = "", profileUuidStr: String = "", isolated: Bool = true) {
        guard let u = URL(string: urlStr) else { return }

        // Park previously visible account WebView back into backgroundTabsContainer so it NEVER gets detached!
        if let prevId = activeLoginWatchId, prevId != watchId, let prevWV = liveTabs[prevId] {
            parkWebViewInBackground(prevWV)
        } else if activeLoginWatchId == nil, let prevTemp = loginWebView {
            prevTemp.removeFromSuperview()
        }

        activeLoginWatchId = watchId.isEmpty ? nil : watchId
        activeHomeURL = urlStr
        if !watchId.isEmpty {
            tabMeta[watchId] = (name: name, url: urlStr, profileUuid: profileUuidStr)
        }

        let wv: WKWebView
        if !watchId.isEmpty, let existing = liveTabs[watchId] {
            existing.removeFromSuperview()
            wv = existing
        } else {
            let cfg = WKWebViewConfiguration()
            if isolated, !watchId.isEmpty, #available(macOS 14.0, *) {
                let targetUUID = UUID(uuidString: profileUuidStr) ?? deterministicProfileUUID(watchId)
                cfg.websiteDataStore = WKWebsiteDataStore(forIdentifier: targetUUID)
            } else {
                cfg.websiteDataStore = .default()
            }
            cfg.userContentController.add(self, name: "tabpulsePassive")
            if let obsURL = Bundle.main.url(forResource: "passive-observer", withExtension: "js"),
               let obsJS = try? String(contentsOf: obsURL, encoding: .utf8) {
                let us = WKUserScript(source: obsJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
                cfg.userContentController.addUserScript(us)
            }
            let created = WKWebView(frame: NSRect(x: 0, y: 0, width: 1160, height: 736), configuration: cfg)
            created.uiDelegate = self
            created.load(URLRequest(url: u))
            if !watchId.isEmpty {
                liveTabs[watchId] = created
                webViewToWatchId[ObjectIdentifier(created)] = watchId
            }
            wv = created
        }
        loginWebView = wv

        ensureWorkspaceWindow()
        if let host = workspaceHostView {
            wv.frame = host.bounds
            wv.autoresizingMask = [.width, .height]
            host.addSubview(wv)
        }
        refreshWorkspaceToolbarMenus()
        toolbarStatusLabel?.stringValue = isChineseSystem
            ? "🛡️ 独立防串号隔离仓：\(name)"
            : "🛡️ Isolated Sandbox: \(name)"

        loginWindow?.title = isChineseSystem
            ? "消息总管 · 多账号安全工作台 — \(name)（关掉窗口后后台照常安静听新消息）"
            : "ReplyRadar · Multi-Account Workspace — \(name) (Keeps listening passively when closed)"
        loginWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closedWin = notification.object as? NSWindow, closedWin == loginWindow else { return }
        if let wid = activeLoginWatchId, let liveWV = liveTabs[wid] {
            activeLoginWatchId = nil
            parkWebViewInBackground(liveWV)
        }
    }

    // MARK: - WKScriptMessageHandler Bridge
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "tabpulsePassive" {
            guard let srcWV = message.webView,
                  let wid = webViewToWatchId[ObjectIdentifier(srcWV)],
                  let payload = message.body as? [String: Any] else { return }
            let count = (payload["unreadCount"] as? Int) ?? 0
            let snippet = (payload["snippet"] as? String) ?? ""
            handlePassiveEvent(watchId: wid, unreadCount: count, snippet: snippet)
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
            openLoginSheet(urlStr: url, name: name, watchId: id, profileUuidStr: pUuid, isolated: iso)
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
            let url = (payload?["url"] as? String) ?? ""
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
        replyCallback(reqId, ["ok": false, "error": "unknown route"])
    }

    func updateMenuBadge(from summary: [String: Any]) {
        let stats = summary["stats"] as? [String: Any]
        let unread = (stats?["unreadMessagesTotal"] as? Int) ?? 0
        DispatchQueue.main.async {
            if isChineseSystem {
                self.statusItem?.button?.title = unread > 0 ? "🔴 \(unread) 未读" : "🔔 消息"
            } else {
                self.statusItem?.button?.title = unread > 0 ? "🔴 \(unread) Unread" : "🔔 Inbox"
            }
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

    func handlePassiveEvent(watchId: String, unreadCount: Int, snippet: String) {
        if useExternalHub, let repURL = URL(string: "http://127.0.0.1:17890/api/report") {
            var req = URLRequest(url: repURL)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any] = ["id": watchId, "unreadCount": unreadCount, "snippet": snippet, "authExpired": false]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
                self?.notifyDashboardProbeDone(id: watchId, name: watchId, unreadCount: unreadCount, authExpired: false)
            }.resume()
            DispatchQueue.main.async {
                if unreadCount > 0 {
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
                if unreadCount > 0 {
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
                notifyDashboardProbeDone(id: watchId, name: siteName, unreadCount: unreadCount, authExpired: false)
            }
        }
    }

    // MARK: - Silent Background WebKit Sentinel
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
                DispatchQueue.main.async {
                    self?.currentProbeTargetId = id
                    self?.currentProbeTargetName = name
                    self?.probeWebView.load(URLRequest(url: targetURL))
                }
            }.resume()
        } else {
            let st = StandaloneStore.shared.loadState()
            let watches = (st["watches"] as? [[String: Any]]) ?? []
            let nowISO = ISO8601DateFormatter().string(from: Date())
            let candidate = watches.first { w in
                let wid = (w["id"] as? String) ?? ""
                if !targetId.isEmpty { return wid == targetId }
                let status = (w["status"] as? String) ?? "idle"
                if status == "paused" || (!forceImmediate && status == "auth_expired") { return false }
                if forceImmediate { return true }
                let next = (w["nextCheckAt"] as? String) ?? ""
                return next.isEmpty || next <= nowISO
            }
            if let c = candidate, let id = c["id"] as? String, let uStr = c["url"] as? String, let u = URL(string: uStr) {
                currentProbeTargetId = id
                currentProbeTargetName = (c["name"] as? String) ?? id
                probeWebView.load(URLRequest(url: u))
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
