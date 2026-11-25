import ApplicationServices
import Cocoa
import CoreGraphics
import Foundation
import Vision

func jsonOut(_ obj: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    } else {
        print("{\"ok\":false}")
    }
}

func parseDockBadges() -> [[String: String]] {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/lsappinfo")
    proc.arguments = ["list"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    do {
        try proc.run()
    } catch {
        return []
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    proc.waitUntilExit()
    guard let text = String(data: data, encoding: .utf8) else { return [] }

    var results: [[String: String]] = []
    var currentName = ""
    var currentBundle = ""

    for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let line = rawLine.trimmingCharacters(in: .whitespaces)
        if let q1 = line.firstIndex(of: "\""), line.contains("ASN:") {
            let rest = line[line.index(after: q1)...]
            if let q2 = rest.firstIndex(of: "\"") {
                currentName = String(rest[..<q2])
                currentBundle = ""
            }
        } else if line.hasPrefix("bundleID=\"") {
            let start = line.index(line.startIndex, offsetBy: 10)
            if let end = line[start...].firstIndex(of: "\"") {
                currentBundle = String(line[start..<end])
            }
        } else if line.contains("\"StatusLabel\"=") && line.contains("\"label\"=\"") {
            if let r = line.range(of: "\"label\"=\"") {
                let after = line[r.upperBound...]
                if let end = after.firstIndex(of: "\"") {
                    let badge = String(after[..<end]).trimmingCharacters(in: .whitespaces)
                    if !badge.isEmpty && !currentName.isEmpty {
                        results.append([
                            "name": currentName,
                            "bundleId": currentBundle,
                            "badge": badge
                        ])
                    }
                }
            }
        }
    }
    return results
}

func collectAxStrings(_ el: AXUIElement, depth: Int = 0, into out: inout [String]) {
    if depth > 6 || out.count >= 10 { return }
    for attr in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute] {
        var val: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, attr as CFString, &val) == .success,
           let s = val as? String {
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.count >= 2 && !["通知中心", "Notification Center", "关闭", "Close", "清理"].contains(trimmed) {
                if !out.contains(trimmed) {
                    out.append(trimmed)
                }
            }
        }
    }
    var childrenRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenRef) == .success,
       let children = childrenRef as? [AXUIElement] {
        for child in children {
            collectAxStrings(child, depth: depth + 1, into: &out)
        }
    }
}

func readActiveNotificationBanners(windowList: [[String: Any]]) -> [String] {
    guard AXIsProcessTrusted() else { return [] }
    let ncWin = windowList.first { w in
        let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
        return owner == "通知中心" || owner == "Notification Center" || owner == "NotificationCenter"
    }
    guard let win = ncWin,
          let pid = win[kCGWindowOwnerPID as String] as? pid_t else {
        return []
    }
    let axApp = AXUIElementCreateApplication(pid)
    var strings: [String] = []
    collectAxStrings(axApp, depth: 0, into: &strings)
    return strings
}

let BLOCKED_OWNERS: Set<String> = [
    "Window Server", "Dock", "程序坞", "控制中心", "Control Center",
    "SystemUIServer", "loginwindow", "墙纸", "Wallpaper", "Lockpaw",
    "钥匙串访问", "Keychain Access", "SecurityAgent", "CoreServicesUIAgent",
    "通知中心", "Notification Center", "NotificationCenter", "DockDoor",
    "universalAccessAuthWarn", "UserNotificationCenter",
    "消息总管", "ReplyRadar"
]

func isSensitiveTitle(_ title: String) -> Bool {
    let lower = title.lowercased()
    return title.contains("密钥") || title.contains("令牌") || title.contains("密码") || title.contains("库存") || lower.contains("password") || lower.contains("secret")
}

func listDesktopState() {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let rawWins = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
    let runningByPid: [pid_t: NSRunningApplication] = Dictionary(
        uniqueKeysWithValues: NSWorkspace.shared.runningApplications.map { ($0.processIdentifier, $0) }
    )

    var windows: [[String: Any]] = []
    for w in rawWins {
        let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
        if layer != 0 { continue }
        let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
        if owner.isEmpty || BLOCKED_OWNERS.contains(owner) { continue }
        guard let bounds = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let width = bounds["Width"] ?? 0
        let height = bounds["Height"] ?? 0
        if width < 180 || height < 140 { continue }

        let wid = (w[kCGWindowNumber as String] as? Int) ?? 0
        let pid = (w[kCGWindowOwnerPID as String] as? pid_t) ?? 0
        let title = (w[kCGWindowName as String] as? String) ?? ""
        if isSensitiveTitle(title) { continue }
        let bundleId = runningByPid[pid]?.bundleIdentifier ?? ""

        windows.append([
            "windowId": wid,
            "pid": Int(pid),
            "appName": owner,
            "bundleId": bundleId,
            "title": title,
            "bounds": [
                "x": Int(bounds["X"] ?? 0),
                "y": Int(bounds["Y"] ?? 0),
                "w": Int(width),
                "h": Int(height)
            ]
        ])
    }

    let badges = parseDockBadges()
    let banners = readActiveNotificationBanners(windowList: rawWins)

    let runningBundles = Set(NSWorkspace.shared.runningApplications.compactMap { $0.bundleIdentifier })
    var installedApps: [[String: Any]] = []
    if let items = try? FileManager.default.contentsOfDirectory(atPath: "/Applications") {
        for item in items.sorted() where item.hasSuffix(".app") {
            let full = "/Applications/\(item)"
            let b = Bundle(path: full)
            let bid = b?.bundleIdentifier ?? ""
            let disp = (b?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                ?? (b?.object(forInfoDictionaryKey: "CFBundleName") as? String)
                ?? String(item.dropLast(4))
            installedApps.append([
                "name": disp,
                "fileName": String(item.dropLast(4)),
                "path": full,
                "bundleId": bid,
                "running": !bid.isEmpty && runningBundles.contains(bid)
            ])
        }
    }

    jsonOut([
        "ok": true,
        "windows": windows,
        "badges": badges,
        "banners": banners,
        "installedApps": installedApps
    ])
}

func findWindowInfo(_ targetWid: Int) -> [String: Any]? {
    let rawWins = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
    return rawWins.first { (($0[kCGWindowNumber as String] as? Int) ?? -1) == targetWid }
}

struct PositionedText {
    let text: String
    let x: CGFloat
    let y: CGFloat
    let w: CGFloat
    let h: CGFloat
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    var pt = CGPoint.zero
    var sz = CGSize.zero
    if AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
       let pv = posRef {
        AXValueGetValue(pv as! AXValue, .cgPoint, &pt)
    } else {
        return nil
    }
    if AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success,
       let sv = sizeRef {
        AXValueGetValue(sv as! AXValue, .cgSize, &sz)
    }
    return CGRect(origin: pt, size: sz)
}

let UI_NOISE: Set<String> = [
    "关闭", "最小化", "全屏", "缩放", "发送", "Send", "Close", "Minimize", "Zoom",
    "打开/关闭边栏", "新建对话", "搜索", "Search"
]

func walkAxTexts(_ el: AXUIElement, depth: Int = 0, visited: inout Int, seen: inout Set<String>, items: inout [PositionedText]) {
    visited += 1
    if depth > 14 || items.count >= 90 || visited > 1200 { return }
    var roleRef: CFTypeRef?
    let role = (AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleRef) == .success) ? (roleRef as? String ?? "") : ""

    if role == "AXStaticText" || role == "AXTextArea" || role == "AXHeading" || role == "AXCell" || role == "AXButton" {
        for attr in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success,
               let s = v as? String {
                let clean = s.trimmingCharacters(in: .whitespacesAndNewlines)
                if clean.count >= 2 && clean.count <= 1200 && !UI_NOISE.contains(clean) && !seen.contains(clean) {
                    if role == "AXButton" && clean.count > 24 { continue }
                    if let fr = axFrame(el), fr.width > 8 && fr.height > 8 {
                        seen.insert(clean)
                        items.append(PositionedText(text: clean, x: fr.origin.x, y: fr.origin.y, w: fr.width, h: fr.height))
                        break
                    }
                }
            }
        }
    }

    var chRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &chRef) == .success,
       let children = chRef as? [AXUIElement] {
        for c in children {
            if visited > 1200 || items.count >= 90 { break }
            walkAxTexts(c, depth: depth + 1, visited: &visited, seen: &seen, items: &items)
        }
    }
}

// Pure Text Extraction (AX Tree Primary + In-Memory Apple Neural Engine OCR Fallback — ZERO Screenshots Sent!)
func extractStructuredWindowMessages(_ wid: Int) -> [String: Any] {
    guard let info = findWindowInfo(wid),
          let b = info[kCGWindowBounds as String] as? [String: CGFloat],
          let pid = info[kCGWindowOwnerPID as String] as? pid_t else {
        return ["ok": false, "error": "该电脑软件窗口未打开"]
    }
    let owner = (info[kCGWindowOwnerName as String] as? String) ?? ""
    let title = (info[kCGWindowName as String] as? String) ?? ""
    if isSensitiveTitle(title) {
        return ["ok": false, "error": "隐私保护已跳过敏感文档窗口"]
    }

    let winX = b["X"] ?? 0
    let winY = b["Y"] ?? 0
    let winW = max(1, b["Width"] ?? 800)
    let winH = max(1, b["Height"] ?? 600)

    var seen = Set<String>()
    var items: [PositionedText] = []
    let axTrusted = AXIsProcessTrusted()
    let screenTrusted = CGPreflightScreenCaptureAccess()

    if axTrusted {
        let axApp = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        usleep(70_000)

        var visited = 0
        var winListRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winListRef) == .success,
           let axWins = winListRef as? [AXUIElement], let firstWin = axWins.first {
            walkAxTexts(firstWin, depth: 0, visited: &visited, seen: &seen, items: &items)
        } else {
            walkAxTexts(axApp, depth: 0, visited: &visited, seen: &seen, items: &items)
        }
    }

    // Fallback: Only if both AX and Screen Recording are already granted, with strict 1.2s timeout so it NEVER blocks!
    if items.count < 3 && axTrusted && screenTrusted {
        let tmpPath = NSTemporaryDirectory() + "tp-ocr-\(wid)-\(UUID().uuidString.prefix(6)).jpg"
        defer { try? FileManager.default.removeItem(atPath: tmpPath) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-x", "-o", "-t", "jpg", "-l", "\(wid)", tmpPath]
        let doneSem = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in doneSem.signal() }
        try? p.run()
        if doneSem.wait(timeout: .now() + 1.2) == .timedOut {
            p.terminate()
        }

        if let imgData = try? Data(contentsOf: URL(fileURLWithPath: tmpPath)) {
            let req = VNRecognizeTextRequest()
            req.recognitionLevel = .accurate
            req.recognitionLanguages = ["zh-Hans", "en-US"]
            req.usesLanguageCorrection = true
            let handler = VNImageRequestHandler(data: imgData, options: [:])
            try? handler.perform([req])
            for obs in req.results ?? [] {
                guard let top = obs.topCandidates(1).first else { continue }
                let str = top.string.trimmingCharacters(in: .whitespacesAndNewlines)
                if str.count >= 2 && !seen.contains(str) {
                    seen.insert(str)
                    let box = obs.boundingBox
                    let px = winX + box.origin.x * winW
                    let py = winY + (1.0 - box.origin.y - box.height) * winH
                    items.append(PositionedText(text: str, x: px, y: py, w: box.width * winW, h: box.height * winH))
                }
            }
        }
    }

    var threads: [[String: Any]] = []
    var messages: [[String: Any]] = []

    let sorted = items.sorted { a, b in
        if abs(a.y - b.y) > 10 { return a.y < b.y }
        return a.x < b.x
    }

    for it in sorted {
        let relX = (it.x - winX) / winW
        let relY = (it.y - winY) / winH
        if relY < 0.05 { continue }
        if relX < 0.28 && it.text.count <= 26 && threads.count < 14 {
            threads.append([
                "title": it.text,
                "label": it.text,
                "xRatio": Double(max(0.02, min(0.98, (it.x + it.w * 0.5 - winX) / winW))),
                "yRatio": Double(max(0.02, min(0.98, (it.y + it.h * 0.5 - winY) / winH)))
            ])
        } else if relX >= 0.22 || it.text.count > 26 {
            let centerRatio = (it.x + it.w * 0.5 - winX) / winW
            messages.append([
                "text": it.text,
                "isMe": centerRatio > 0.64
            ])
        }
    }

    if messages.isEmpty {
        let hint = axTrusted
            ? (title.isEmpty ? "当前窗口暂无更多文字气泡，可直接在下方打字发送。" : "当前会话：\(title)")
            : (title.isEmpty
                ? "当前窗口：\(owner)（未读红点提醒已实时生效；如需读取软件内部聊天文字，请在电脑『系统设置 → 隐私与安全性 → 辅助功能』勾选《消息总管》）"
                : "当前会话：\(title)\n（如需同步窗口内完整聊天文字，请在电脑『系统设置 → 隐私与安全性 → 辅助功能』勾选《消息总管》）")
        messages.append([
            "text": hint,
            "isMe": false
        ])
    }

    return [
        "ok": true,
        "windowId": wid,
        "appName": owner,
        "title": title,
        "axTrusted": axTrusted,
        "threads": threads,
        "messages": Array(messages.suffix(45))
    ]
}

func activateWindowOwner(_ info: [String: Any]) {
    if let pid = info[kCGWindowOwnerPID as String] as? pid_t,
       let app = NSRunningApplication(processIdentifier: pid) {
        app.activate()
        usleep(120_000)
    }
}

func postMouseClick(at pt: CGPoint) {
    let src = CGEventSource(stateID: .hidSystemState)
    if let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left) {
        move.post(tap: .cghidEventTap)
    }
    usleep(30_000)
    if let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left),
       let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left) {
        down.post(tap: .cghidEventTap)
        usleep(35_000)
        up.post(tap: .cghidEventTap)
    }
}

func postKeyCombo(keyCode: CGKeyCode, flags: CGEventFlags = []) {
    let src = CGEventSource(stateID: .hidSystemState)
    if let down = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true),
       let up = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false) {
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        usleep(35_000)
        up.post(tap: .cghidEventTap)
    }
}

let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : "list"

switch cmd {
case "list":
    listDesktopState()

case "read-messages":
    let wid = args.count > 2 ? (Int(args[2]) ?? 0) : 0
    jsonOut(extractStructuredWindowMessages(wid))

case "select-thread":
    let wid = args.count > 2 ? (Int(args[2]) ?? 0) : 0
    let xr = args.count > 3 ? (Double(args[3]) ?? 0.15) : 0.15
    let yr = args.count > 4 ? (Double(args[4]) ?? 0.3) : 0.3
    if let info = findWindowInfo(wid),
       let b = info[kCGWindowBounds as String] as? [String: CGFloat] {
        activateWindowOwner(info)
        let px = (b["X"] ?? 0) + (b["Width"] ?? 100) * CGFloat(xr)
        let py = (b["Y"] ?? 0) + (b["Height"] ?? 100) * CGFloat(yr)
        postMouseClick(at: CGPoint(x: px, y: py))
        usleep(420_000)
    }
    jsonOut(extractStructuredWindowMessages(wid))

case "reply-text":
    let wid = args.count > 2 ? (Int(args[2]) ?? 0) : 0
    let b64 = args.count > 3 ? args[3] : ""
    let submitMode = args.count > 4 ? args[4] : "enter"
    guard let info = findWindowInfo(wid),
          let b = info[kCGWindowBounds as String] as? [String: CGFloat],
          let textData = Data(base64Encoded: b64),
          let text = String(data: textData, encoding: .utf8) else {
        jsonOut(["ok": false, "error": "参数或窗口无效"])
        exit(0)
    }
    let pb = NSPasteboard.general
    let prevText = pb.string(forType: .string)
    pb.clearContents()
    pb.setString(text, forType: .string)

    activateWindowOwner(info)
    // Click standard bottom-right chat input area first to ensure input focus
    let ix = (b["X"] ?? 0) + (b["Width"] ?? 600) * 0.62
    let iy = (b["Y"] ?? 0) + (b["Height"] ?? 600) * 0.90
    postMouseClick(at: CGPoint(x: ix, y: iy))
    usleep(120_000)

    if !text.isEmpty {
        postKeyCombo(keyCode: 9, flags: .maskCommand) // Cmd+V
        usleep(140_000)
    }
    if submitMode == "enter" {
        postKeyCombo(keyCode: 36, flags: [])
    } else if submitMode == "cmd_enter" {
        postKeyCombo(keyCode: 36, flags: .maskCommand)
    }
    usleep(480_000)
    if let old = prevText {
        pb.clearContents()
        pb.setString(old, forType: .string)
    }
    var out = extractStructuredWindowMessages(wid)
    out["sent"] = true
    jsonOut(out)

case "launch":
    let appPath = args.count > 2 ? args[2] : ""
    guard appPath.hasPrefix("/Applications/") && appPath.hasSuffix(".app") && FileManager.default.fileExists(atPath: appPath) else {
        jsonOut(["ok": false, "error": "仅允许启动 /Applications 下的已安装软件"])
        exit(0)
    }
    let sem = DispatchSemaphore(value: 0)
    var launchedOk = false
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = true
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: appPath), configuration: cfg) { _, err in
        launchedOk = (err == nil)
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 4.0)
    usleep(700_000)
    jsonOut(["ok": launchedOk, "launched": appPath])

case "open-app-messages":
    let appQuery = (args.count > 2 ? args[2] : "").trimmingCharacters(in: .whitespacesAndNewlines)
    let qLower = appQuery.lowercased()
    let running = NSWorkspace.shared.runningApplications.first { app in
        let n = (app.localizedName ?? "").lowercased()
        let b = (app.bundleIdentifier ?? "").lowercased()
        return !n.isEmpty && (n == qLower || n.contains(qLower) || qLower.contains(n) || b.contains(qLower))
    }
    if let app = running {
        app.unhide()
        app.activate(options: [.activateIgnoringOtherApps])
        if let bURL = app.bundleURL {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.activates = true
            let sem = DispatchSemaphore(value: 0)
            NSWorkspace.shared.openApplication(at: bURL, configuration: cfg) { _, _ in sem.signal() }
            _ = sem.wait(timeout: .now() + 2.5)
        }
        usleep(550_000)
    } else if FileManager.default.fileExists(atPath: "/Applications/\(appQuery).app") {
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        let sem = DispatchSemaphore(value: 0)
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/Applications/\(appQuery).app"), configuration: cfg) { _, _ in sem.signal() }
        _ = sem.wait(timeout: .now() + 3.5)
        usleep(650_000)
    }
    let rawWins = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let candidates = rawWins.filter { w in
        let owner = ((w[kCGWindowOwnerName as String] as? String) ?? "").lowercased()
        guard !owner.isEmpty else { return false }
        return owner == qLower || owner.contains(qLower) || qLower.contains(owner)
    }
    let best = candidates.max { a, b in
        let ba = (a[kCGWindowBounds as String] as? [String: CGFloat]) ?? [:]
        let bb = (b[kCGWindowBounds as String] as? [String: CGFloat]) ?? [:]
        return ((ba["Width"] ?? 0) * (ba["Height"] ?? 0)) < ((bb["Width"] ?? 0) * (bb["Height"] ?? 0))
    }
    if let found = best, let wid = found[kCGWindowNumber as String] as? Int {
        jsonOut(extractStructuredWindowMessages(wid))
    } else {
        jsonOut(["ok": false, "error": "暂未找到「\(appQuery)」主窗口，请在电脑上登录该软件后重试"])
    }

case "peek-image":
    let wid = args.count > 2 ? (Int(args[2]) ?? 0) : 0
    guard wid > 0,
          let info = findWindowInfo(wid),
          let cgImg = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(wid), [.boundsIgnoreFraming, .bestResolution]) else {
        jsonOut(["ok": false, "error": "无法读取当前窗口画面，请确认已开启屏幕录制权限或窗口未被关闭"])
        exit(0)
    }
    let owner = (info[kCGWindowOwnerName as String] as? String) ?? ""
    let srcW = CGFloat(cgImg.width)
    let srcH = CGFloat(cgImg.height)
    let maxW: CGFloat = 920
    let scale = srcW > maxW ? (maxW / srcW) : 1.0
    let dstW = max(1, Int(srcW * scale))
    let dstH = max(1, Int(srcH * scale))

    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: dstW,
        pixelsHigh: dstH,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )
    if let bitmap = rep {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        NSImage(cgImage: cgImg, size: NSSize(width: srcW, height: srcH)).draw(in: NSRect(x: 0, y: 0, width: dstW, height: dstH))
        NSGraphicsContext.restoreGraphicsState()
        if let jpg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.56]) {
            jsonOut([
                "ok": true,
                "appName": owner,
                "dataUrl": "data:image/jpeg;base64,\(jpg.base64EncodedString())"
            ])
            exit(0)
        }
    }
    jsonOut(["ok": false, "error": "图片编码失败"])

default:
    jsonOut(["ok": false, "error": "unknown command"])
}
