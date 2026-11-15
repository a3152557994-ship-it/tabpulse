import Cocoa
import CryptoKit
import Foundation
import WebKit

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
        let initial: [String: Any] = [
            "version": "0.2.0",
            "license": NSNull(),
            "settings": ["webhookUrl": "", "radarKeywords": "Shopify", "lang": "zh"],
            "watches": [
                [
                    "id": "v2ex-notifications",
                    "name": "V2EX 未读消息提醒",
                    "url": "https://www.v2ex.com/notifications",
                    "category": "接单外包",
                    "publishTier": "yellow",
                    "contextSummary": "外包与分享创造节点客户回复提醒",
                    "baseIntervalMinutes": 60,
                    "status": "idle",
                    "unreadCount": 0,
                    "snippet": "",
                    "lastDraft": "",
                    "lastFingerprint": "",
                    "nextCheckAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(300))
                ],
                [
                    "id": "reddit-inbox",
                    "name": "Reddit Inbox & Buyer Replies",
                    "url": "https://www.reddit.com/message/unread/",
                    "category": "接单外包",
                    "publishTier": "red",
                    "contextSummary": "Global freelance & SaaS buyer DMs",
                    "baseIntervalMinutes": 45,
                    "status": "idle",
                    "unreadCount": 0,
                    "snippet": "",
                    "lastDraft": "",
                    "lastFingerprint": "",
                    "nextCheckAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(600))
                ]
            ]
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
        let unreadList = watches.filter { ($0["status"] as? String) == "unread" }
        let authList = watches.filter { ($0["status"] as? String) == "auth_expired" }
        let pausedList = watches.filter { ($0["status"] as? String) == "paused" }
        let unreadTotal = unreadList.reduce(0) { $0 + (($1["unreadCount"] as? Int) ?? 0) }

        var licOut: [String: Any] = ["valid": false, "plan": "free"]
        if let licObj = st["license"] as? [String: Any], let key = licObj["key"] as? String {
            licOut = LicenseVerifier.verify(key)
        }

        return [
            "version": "0.2.0",
            "license": licOut,
            "settings": (st["settings"] as? [String: Any]) ?? ["webhookUrl": "", "lang": "zh"],
            "stats": [
                "total": watches.count,
                "unreadCount": unreadList.count,
                "unreadMessagesTotal": unreadTotal,
                "authExpiredCount": authList.count,
                "pausedCount": pausedList.count,
                "activeCount": watches.count - pausedList.count
            ],
            "watches": watches
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
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var mainWindow: NSWindow!
    var dashboardWebView: WKWebView!
    var probeWebView: WKWebView!
    var loginWindow: NSWindow?
    var statusItem: NSStatusItem!
    var sentinelTimer: Timer?
    var useExternalHub = false
    var currentProbeTargetId: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()
        setupStatusBar()
        setupMainWindow()
        setupSilentProbeWebView()
        detectHubAndLoadDashboard()

        sentinelTimer = Timer.scheduledTimer(withTimeInterval: 55.0, repeats: true) { [weak self] _ in
            self?.runSilentCheckCycle()
        }
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
        appMenu.addItem(withTitle: "打开万站回音主控台", action: #selector(showMainWindow), keyEquivalent: "1")
        appMenu.addItem(withTitle: "立即静默巡检一次", action: #selector(triggerCheckMenu), keyEquivalent: "r")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 万站回音 TabPulse", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    func setupStatusBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🔔 回音"
        let menu = NSMenu()
        menu.addItem(withTitle: "打开主控台与商机扫描器", action: #selector(showMainWindow), keyEquivalent: "")
        menu.addItem(withTitle: "⚡ 立即后台静默巡检", action: #selector(triggerCheckMenu), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "退出 TabPulse", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        statusItem.menu = menu
    }

    func setupMainWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.userContentController.add(self, name: "tabpulse")

        dashboardWebView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 780), configuration: cfg)
        mainWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        mainWindow.center()
        mainWindow.title = "万站回音 · TabPulse (原生免浏览器独立版 v0.2.0)"
        mainWindow.isReleasedWhenClosed = false
        mainWindow.contentView = dashboardWebView
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func setupSilentProbeWebView() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        probeWebView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: cfg)
        probeWebView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15"
        probeWebView.navigationDelegate = self
    }

    func detectHubAndLoadDashboard() {
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
    }

    func loadStandaloneUI() {
        let script = WKUserScript(
            source: "window.__TABPULSE_STANDALONE_MODE = true;",
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

    func openLoginSheet(urlStr: String, name: String) {
        guard let u = URL(string: urlStr) else { return }
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1020, height: 720), configuration: cfg)
        wv.customUserAgent = probeWebView.customUserAgent
        wv.load(URLRequest(url: u))

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1020, height: 720),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        win.center()
        win.title = "内置安全登录与回复窗 — \(name)（登录态仅保存在你本机）"
        win.isReleasedWhenClosed = false
        win.contentView = wv
        win.makeKeyAndOrderFront(nil)
        loginWindow = win
    }

    // MARK: - WKScriptMessageHandler Bridge
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        if action == "openLoginSheet" {
            let url = (body["url"] as? String) ?? ""
            let name = (body["name"] as? String) ?? "平台"
            openLoginSheet(urlStr: url, name: name)
            return
        }
        if action == "checkNow" {
            runSilentCheckCycle(forceImmediate: true)
            return
        }
        if action == "openPlaybook" {
            if let u = Bundle.main.url(forResource: "cold-reply-playbook", withExtension: "html") {
                openLoginSheet(urlStr: u.absoluteString, name: "高成交率破冰话术库")
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
            st["settings"] = set
            StandaloneStore.shared.saveState(st)
            replyCallback(reqId, ["ok": true, "settings": set])
            return
        }
        if method == "POST" && path == "/api/watches" {
            var st = StandaloneStore.shared.loadState()
            var watches = (st["watches"] as? [[String: Any]]) ?? []
            let url = (payload?["url"] as? String) ?? ""
            let id = (payload?["id"] as? String) ?? "watch-\(Int(Date().timeIntervalSince1970))-\(Int.random(in: 100...999))"
            let mins = (payload?["baseIntervalMinutes"] as? Int) ?? 60
            let newItem: [String: Any] = [
                "id": id,
                "name": (payload?["name"] as? String) ?? url,
                "url": url,
                "category": (payload?["category"] as? String) ?? "接单外包",
                "publishTier": (payload?["publishTier"] as? String) ?? "yellow",
                "contextSummary": (payload?["contextSummary"] as? String) ?? "",
                "baseIntervalMinutes": mins,
                "status": "idle",
                "unreadCount": 0,
                "snippet": "",
                "lastDraft": "",
                "nextCheckAt": StandaloneStore.shared.computeNextCheckISO(baseMinutes: mins)
            ]
            if let idx = watches.firstIndex(where: { ($0["id"] as? String) == id || ($0["url"] as? String) == url }) {
                watches[idx] = newItem
            } else {
                watches.append(newItem)
            }
            st["watches"] = watches
            StandaloneStore.shared.saveState(st)
            replyCallback(reqId, ["ok": true, "watch": newItem])
            return
        }
        if method == "DELETE" && path.hasPrefix("/api/watches/") {
            let rawId = String(path.dropFirst("/api/watches/".count)).removingPercentEncoding ?? ""
            var st = StandaloneStore.shared.loadState()
            var watches = (st["watches"] as? [[String: Any]]) ?? []
            watches.removeAll { ($0["id"] as? String) == rawId }
            st["watches"] = watches
            StandaloneStore.shared.saveState(st)
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
            self.statusItem?.button?.title = unread > 0 ? "🔴 \(unread) 未读" : "🔔 回音"
        }
    }

    // MARK: - Silent Background WebKit Sentinel
    func runSilentCheckCycle(forceImmediate: Bool = false) {
        guard currentProbeTargetId == nil else { return }
        if !forceImmediate {
            let hour = Calendar.current.component(.hour, from: Date())
            if hour >= 0 && hour < 8 { return } // Night anti-ban protection
        }

        if useExternalHub {
            guard let dueURL = URL(string: "http://127.0.0.1:17890/api/due") else { return }
            URLSession.shared.dataTask(with: dueURL) { [weak self] data, _, _ in
                guard let d = data,
                      let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
                      let due = obj["due"] as? [[String: Any]],
                      let first = due.first,
                      let id = first["id"] as? String,
                      let urlStr = first["url"] as? String,
                      let targetURL = URL(string: urlStr) else { return }
                DispatchQueue.main.async {
                    self?.currentProbeTargetId = id
                    self?.probeWebView.load(URLRequest(url: targetURL))
                }
            }.resume()
        } else {
            let st = StandaloneStore.shared.loadState()
            let watches = (st["watches"] as? [[String: Any]]) ?? []
            let nowISO = ISO8601DateFormatter().string(from: Date())
            let candidate = watches.first { w in
                let status = (w["status"] as? String) ?? "idle"
                if status == "paused" || status == "auth_expired" { return false }
                if forceImmediate { return true }
                let next = (w["nextCheckAt"] as? String) ?? ""
                return next.isEmpty || next <= nowISO
            }
            if let c = candidate, let id = c["id"] as? String, let uStr = c["url"] as? String, let u = URL(string: uStr) {
                currentProbeTargetId = id
                probeWebView.load(URLRequest(url: u))
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView == probeWebView, let targetId = currentProbeTargetId else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.5) { [weak self] in
            self?.extractUnreadFromProbe(targetId: targetId)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if webView == probeWebView { currentProbeTargetId = nil }
    }

    func extractUnreadFromProbe(targetId: String) {
        guard let probeURL = Bundle.main.url(forResource: "probe", withExtension: "js"),
              let js = try? String(contentsOf: probeURL, encoding: .utf8) else {
            currentProbeTargetId = nil
            return
        }
        probeWebView.evaluateJavaScript(js) { [weak self] res, _ in
            guard let self = self else { return }
            defer { self.currentProbeTargetId = nil }
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
                URLSession.shared.dataTask(with: req).resume()
                if unreadCount > 0 { self.statusItem?.button?.title = "🔴 \(unreadCount) 未读" }
            } else {
                var st = StandaloneStore.shared.loadState()
                var watches = (st["watches"] as? [[String: Any]]) ?? []
                if let idx = watches.firstIndex(where: { ($0["id"] as? String) == targetId }) {
                    let mins = (watches[idx]["baseIntervalMinutes"] as? Int) ?? 60
                    watches[idx]["nextCheckAt"] = StandaloneStore.shared.computeNextCheckISO(baseMinutes: mins)
                    if authExpired {
                        watches[idx]["status"] = "auth_expired"
                    } else if unreadCount > 0 {
                        watches[idx]["status"] = "unread"
                        watches[idx]["unreadCount"] = unreadCount
                        watches[idx]["snippet"] = snippet
                        NSSound.beep()
                    } else {
                        watches[idx]["status"] = "idle"
                        watches[idx]["unreadCount"] = 0
                    }
                    st["watches"] = watches
                    StandaloneStore.shared.saveState(st)
                    self.updateMenuBadge(from: StandaloneStore.shared.publicSummary())
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
    guard let watches = summary["watches"] as? [[String: Any]], watches.count == 2 else {
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
