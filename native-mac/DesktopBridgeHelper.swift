import ApplicationServices
import Cocoa
import CoreGraphics
import Foundation

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
    "通知中心", "Notification Center", "NotificationCenter", "DockDoor"
]

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
        if width < 160 || height < 120 { continue }

        let wid = (w[kCGWindowNumber as String] as? Int) ?? 0
        let pid = (w[kCGWindowOwnerPID as String] as? pid_t) ?? 0
        let title = (w[kCGWindowName as String] as? String) ?? ""
        let lowerTitle = title.lowercased()
        if title.contains("密钥") || title.contains("令牌") || title.contains("密码") || title.contains("库存") || lowerTitle.contains("password") || lowerTitle.contains("secret") {
            continue
        }
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

    // Installed /Applications list for remote 1-tap launch
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

func captureWindowBase64(_ wid: Int) -> [String: Any] {
    guard let info = findWindowInfo(wid) else {
        return ["ok": false, "error": "该软件窗口已关闭或最小化，请返回列表重新选择"]
    }
    let owner = (info[kCGWindowOwnerName as String] as? String) ?? ""
    let title = (info[kCGWindowName as String] as? String) ?? ""
    let tmpPath = NSTemporaryDirectory() + "tp-cap-\(wid)-\(UUID().uuidString.prefix(6)).jpg"
    defer { try? FileManager.default.removeItem(atPath: tmpPath) }

    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-o", "-t", "jpg", "-l", "\(wid)", tmpPath]
    try? p.run()
    p.waitUntilExit()

    guard let rawData = try? Data(contentsOf: URL(fileURLWithPath: tmpPath)),
          let nsImg = NSImage(data: rawData) else {
        return ["ok": false, "error": "抓取窗口画面失败，请确认已开启屏幕录制权限"]
    }

    // Resize to max 960px wide for fast 5G loading
    let origSize = nsImg.size
    let maxW: CGFloat = 960
    let scale = origSize.width > maxW ? (maxW / origSize.width) : 1.0
    let targetSize = NSSize(width: max(1, round(origSize.width * scale)), height: max(1, round(origSize.height * scale)))

    let smallImg = NSImage(size: targetSize)
    smallImg.lockFocus()
    nsImg.draw(in: NSRect(origin: .zero, size: targetSize), from: NSRect(origin: .zero, size: origSize), operation: .copy, fraction: 1.0)
    smallImg.unlockFocus()

    guard let tiff = smallImg.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.68]) else {
        return ["ok": false, "error": "编码画面失败"]
    }

    return [
        "ok": true,
        "windowId": wid,
        "appName": owner,
        "title": title,
        "imageDataUrl": "data:image/jpeg;base64," + jpg.base64EncodedString()
    ]
}

func activateWindowOwner(_ info: [String: Any]) {
    if let pid = info[kCGWindowOwnerPID as String] as? pid_t,
       let app = NSRunningApplication(processIdentifier: pid) {
        app.activate(options: [.activateIgnoringOtherApps])
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

case "capture":
    let wid = args.count > 2 ? (Int(args[2]) ?? 0) : 0
    jsonOut(captureWindowBase64(wid))

case "click":
    let wid = args.count > 2 ? (Int(args[2]) ?? 0) : 0
    let xr = args.count > 3 ? (Double(args[3]) ?? 0.5) : 0.5
    let yr = args.count > 4 ? (Double(args[4]) ?? 0.5) : 0.5
    guard let info = findWindowInfo(wid),
          let b = info[kCGWindowBounds as String] as? [String: CGFloat] else {
        jsonOut(["ok": false, "error": "窗口不存在"])
        exit(0)
    }
    activateWindowOwner(info)
    let px = (b["X"] ?? 0) + (b["Width"] ?? 100) * CGFloat(max(0.01, min(0.99, xr)))
    let py = (b["Y"] ?? 0) + (b["Height"] ?? 100) * CGFloat(max(0.01, min(0.99, yr)))
    postMouseClick(at: CGPoint(x: px, y: py))
    usleep(380_000)
    jsonOut(captureWindowBase64(wid))

case "scroll":
    let wid = args.count > 2 ? (Int(args[2]) ?? 0) : 0
    let dy = args.count > 3 ? (Int32(args[3]) ?? -5) : -5
    if let info = findWindowInfo(wid),
       let b = info[kCGWindowBounds as String] as? [String: CGFloat] {
        activateWindowOwner(info)
        let cx = (b["X"] ?? 0) + (b["Width"] ?? 200) * 0.5
        let cy = (b["Y"] ?? 0) + (b["Height"] ?? 200) * 0.5
        let src = CGEventSource(stateID: .hidSystemState)
        if let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: cx, y: cy), mouseButton: .left) {
            move.post(tap: .cghidEventTap)
        }
        if let wheel = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0) {
            wheel.post(tap: .cghidEventTap)
        }
        usleep(320_000)
    }
    jsonOut(captureWindowBase64(wid))

case "type":
    let wid = args.count > 2 ? (Int(args[2]) ?? 0) : 0
    let b64 = args.count > 3 ? args[3] : ""
    let submitMode = args.count > 4 ? args[4] : "enter"
    guard let info = findWindowInfo(wid),
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
    if !text.isEmpty {
        postKeyCombo(keyCode: 9, flags: .maskCommand) // Cmd+V
        usleep(140_000)
    }
    if submitMode == "enter" {
        postKeyCombo(keyCode: 36, flags: []) // Return
    } else if submitMode == "cmd_enter" {
        postKeyCombo(keyCode: 36, flags: .maskCommand) // Cmd+Return
    }
    usleep(480_000)
    if let old = prevText {
        pb.clearContents()
        pb.setString(old, forType: .string)
    }
    var out = captureWindowBase64(wid)
    out["typed"] = true
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

default:
    jsonOut(["ok": false, "error": "unknown command"])
}
