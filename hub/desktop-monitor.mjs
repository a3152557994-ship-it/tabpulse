import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function resolveMacHelperBin() {
  const candidates = [
    path.join(PROJECT_ROOT, "bin", "mac-desktop-helper"),
    path.resolve(__dirname, "..", "bin", "mac-desktop-helper"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

class DesktopSoftwareMonitor {
  constructor() {
    this.recentAlerts = [];
    this.appMessagesLog = new Map(); // appName -> [{ text, at, isMe }]
    this.appUnreadCounts = new Map(); // appName -> number
    this.lastBadges = new Map();
    this.seenBanners = new Set();
    this.watchTimer = null;
    this.onDesktopAlert = null;
    this.cachedState = { windows: [], badges: [], banners: [], installedApps: [] };
  }

  startBackgroundWatcher() {
    if (this.watchTimer || process.env.TABPULSE_DISABLE_EXTERNAL_EFFECTS === "1") return;
    this.watchTimer = setInterval(() => {
      this.pollOnce().catch(() => {});
    }, 3500);
    if (this.watchTimer.unref) this.watchTimer.unref();
  }

  async pollOnce() {
    const st = await this.getDesktopState();
    if (!st.ok) return st;

    const currentKeys = new Set();
    for (const b of st.badges || []) {
      const key = b.bundleId || b.name;
      currentKeys.add(key);
      const prev = this.lastBadges.get(key) || "";
      const cur = String(b.badge || "");
      this.lastBadges.set(key, cur);

      const prevNum = parseInt(prev, 10) || 0;
      const curNum = parseInt(cur, 10) || (cur ? 1 : 0);
      this.appUnreadCounts.set(b.name, curNum);

      if (cur && cur !== prev && curNum > prevNum) {
        this.pushAlertEntry({
          id: `da_${Date.now().toString(36)}`,
          kind: "badge",
          appName: b.name,
          badge: cur,
          text: `收到 ${cur} 条未读新消息`,
          at: new Date().toISOString(),
        });
      }
    }
    for (const oldKey of Array.from(this.lastBadges.keys())) {
      if (!currentKeys.has(oldKey)) this.lastBadges.delete(oldKey);
    }

    const banners = st.banners || [];
    if (banners.length >= 1) {
      const appName = banners[0] || "桌面通知";
      const bodyText = banners.slice(1).join(" · ") || banners[0];
      const fp = `${appName}::${bodyText}`;
      if (bodyText.length >= 2 && !this.seenBanners.has(fp)) {
        this.seenBanners.add(fp);
        if (this.seenBanners.size > 150) {
          const first = this.seenBanners.values().next().value;
          this.seenBanners.delete(first);
        }
        const prevCnt = this.appUnreadCounts.get(appName) || 0;
        this.appUnreadCounts.set(appName, prevCnt + 1);
        this.recordAppLog(appName, bodyText, false);
        this.pushAlertEntry({
          id: `bn_${Date.now().toString(36)}`,
          kind: "banner",
          appName,
          badge: String(prevCnt + 1),
          text: bodyText,
          at: new Date().toISOString(),
        });
      }
    }
    return st;
  }

  recordAppLog(appName, text, isMe = false) {
    const arr = this.appMessagesLog.get(appName) || [];
    arr.push({ text, isMe, at: new Date().toISOString() });
    if (arr.length > 40) arr.shift();
    this.appMessagesLog.set(appName, arr);
  }

  clearAppUnread(appName) {
    if (appName) this.appUnreadCounts.set(appName, 0);
    return { ok: true };
  }

  pushAlertEntry(entry) {
    if (entry.appName.includes("消息总管") || entry.appName.includes("ReplyRadar") || entry.text.includes("消息总管")) {
      return;
    }
    this.recentAlerts.unshift(entry);
    if (this.recentAlerts.length > 50) this.recentAlerts.length = 50;
    if (this.onDesktopAlert) {
      this.onDesktopAlert({
        title: `🔔 ${entry.appName} 新消息`,
        summary: entry.text,
        targetKey: `app:${entry.appName}`,
      });
    }
  }

  async getDesktopState() {
    if (process.platform === "darwin") {
      const bin = resolveMacHelperBin();
      if (!bin) return { ok: false, windows: [], badges: [], recentAlerts: this.recentAlerts, installedApps: [] };
      try {
        const { stdout } = await execFileAsync(bin, ["list"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
        const parsed = JSON.parse(stdout.trim() || "{}");
        this.cachedState = parsed;

        const badgeByApp = {};
        for (const b of parsed.badges || []) {
          badgeByApp[b.name] = parseInt(b.badge, 10) || 1;
          if (b.bundleId) badgeByApp[b.bundleId] = parseInt(b.badge, 10) || 1;
        }
        const BROWSER_NAMES = new Set(["Google Chrome", "Safari", "Brave Browser", "Arc", "Firefox", "Microsoft Edge"]);
        const AUX_TITLE_RE = /^(快捷键|设置|偏好设置|关于|Shortcuts|Settings|Preferences|About)$/i;
        const IM_AI_RE = /(微信|WeChat|QQ|千牛|旺旺|飞书|Lark|钉钉|DingTalk|企业微信|WeCom|Telegram|Discord|Slack|WhatsApp|信息|Messages|邮件|Mail|Claude|Cursor|Antigravity|Gemini|Windsurf)/i;

        const bestByApp = new Map();
        for (const w of parsed.windows || []) {
          const appName = String(w.appName || "").trim();
          if (!appName) continue;
          const bw = Number(w.bounds?.w) || 0;
          const bh = Number(w.bounds?.h) || 0;
          if (bw > 0 && bh > 0 && (bw < 300 || bh < 200)) continue;
          const title = String(w.title || "").trim();
          if (title && AUX_TITLE_RE.test(title)) continue;

          const unread =
            badgeByApp[w.bundleId] ||
            badgeByApp[appName] ||
            this.appUnreadCounts.get(appName) ||
            0;
          const isTargetApp = IM_AI_RE.test(appName) || IM_AI_RE.test(w.bundleId || "");
          if (!isTargetApp && unread === 0) continue;
          if (BROWSER_NAMES.has(appName) && unread === 0) continue;

          const logs = this.appMessagesLog.get(appName) || [];
          const lastSnippet = logs.length
            ? logs[logs.length - 1].text
            : unread > 0
              ? `收到 ${unread} 条未读红点消息，支持手机随身读字秒回`
              : "程序坞角标与系统通知静默看护中（0 注入安全）";
          const area = bw * bh;
          const candidate = {
            ...w,
            unreadCount: unread,
            snippet: lastSnippet,
            isMessagingOrAi: isTargetApp,
            _area: area,
          };

          const existing = bestByApp.get(appName);
          if (
            !existing ||
            candidate.unreadCount > existing.unreadCount ||
            (candidate.unreadCount === existing.unreadCount && candidate._area > existing._area)
          ) {
            bestByApp.set(appName, candidate);
          }
        }

        const enrichedWindows = Array.from(bestByApp.values())
          .map(({ _area, ...rest }) => rest)
          .sort((a, b) => {
            if ((b.unreadCount > 0) !== (a.unreadCount > 0)) return b.unreadCount > 0 ? 1 : -1;
            if (Boolean(b.isMessagingOrAi) !== Boolean(a.isMessagingOrAi)) return b.isMessagingOrAi ? 1 : -1;
            return String(a.appName).localeCompare(String(b.appName));
          });

        return {
          ...parsed,
          windows: enrichedWindows,
          recentAlerts: this.recentAlerts.slice(0, 25),
        };
      } catch (err) {
        return { ok: false, error: err.message, ...this.cachedState, recentAlerts: this.recentAlerts.slice(0, 25) };
      }
    }

    if (process.platform === "win32") {
      return await this.getWindowsDesktopState();
    }
    return { ok: false, windows: [], badges: [], recentAlerts: [], installedApps: [] };
  }

  async readWindowMessages(windowId) {
    if (process.platform === "darwin") {
      const bin = resolveMacHelperBin();
      if (!bin) return { ok: false, error: "mac-desktop-helper missing" };
      const { stdout } = await execFileAsync(bin, ["read-messages", String(Number(windowId) || 0)], {
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout.trim() || "{}");
      if (parsed.appName) {
        this.clearAppUnread(parsed.appName);
        const bannerHist = this.appMessagesLog.get(parsed.appName) || [];
        if (bannerHist.length) {
          parsed.bannerHistory = bannerHist;
        }
      }
      return parsed;
    }
    if (process.platform === "win32") {
      return await this.readWindowsMessages(windowId);
    }
    return { ok: false, error: "unsupported platform" };
  }

  async performWindowAction(windowId, body = {}) {
    const wid = String(Number(windowId) || 0);
    const type = body.type || "read";
    if (process.platform === "darwin") {
      const bin = resolveMacHelperBin();
      if (!bin) return { ok: false, error: "mac-desktop-helper missing" };

      if (type === "selectThread") {
        const xr = String(Math.max(0.01, Math.min(0.99, Number(body.xRatio) || 0.12)));
        const yr = String(Math.max(0.01, Math.min(0.99, Number(body.yRatio) || 0.3)));
        const { stdout } = await execFileAsync(bin, ["select-thread", wid, xr, yr], {
          timeout: 8000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return JSON.parse(stdout.trim() || "{}");
      }

      if (type === "reply") {
        const text = String(body.text || "");
        const b64 = Buffer.from(text, "utf-8").toString("base64");
        const mode = body.submitMode === "cmd_enter" ? "cmd_enter" : "enter";
        const { stdout } = await execFileAsync(bin, ["reply-text", wid, b64, mode], {
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const out = JSON.parse(stdout.trim() || "{}");
        if (out.appName && text) {
          this.recordAppLog(out.appName, text, true);
        }
        return out;
      }

      return await this.readWindowMessages(wid);
    }

    if (process.platform === "win32") {
      return await this.performWindowsAction(wid, body);
    }
    return { ok: false, error: "unsupported platform" };
  }

  async launchApp(appPath) {
    if (process.platform === "darwin") {
      const bin = resolveMacHelperBin();
      if (!bin) return { ok: false, error: "mac-desktop-helper missing" };
      const { stdout } = await execFileAsync(bin, ["launch", String(appPath || "")], { timeout: 8000 });
      return JSON.parse(stdout.trim() || "{}");
    }
    return { ok: false, error: "unsupported" };
  }

  async getWindowsDesktopState() {
    const ps = `
      $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } | Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle
      $wins = @()
      foreach ($p in $procs) {
        $wins += @{ windowId = [int64]$p.MainWindowHandle; pid = $p.Id; appName = $p.ProcessName; title = $p.MainWindowTitle; snippet = $p.MainWindowTitle; unreadCount = 0 }
      }
      @{ ok = $true; windows = $wins; badges = @(); installedApps = @() } | ConvertTo-Json -Depth 4 -Compress
    `;
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 6000 });
      const parsed = JSON.parse(stdout.trim() || "{}");
      return { ...parsed, recentAlerts: this.recentAlerts.slice(0, 25) };
    } catch (err) {
      return { ok: false, error: err.message, windows: [], badges: [], recentAlerts: [] };
    }
  }

  async readWindowsMessages(hwnd) {
    const ps = `
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${Number(hwnd) || 0})
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
      $nodes = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      $msgs = @()
      foreach ($n in $nodes) {
        $nm = $n.Current.Name
        if ($nm -and $nm.Length -ge 2) { $msgs += @{ text = $nm; isMe = $false } }
        if ($msgs.Count -ge 40) { break }
      }
      @{ ok = $true; windowId = ${Number(hwnd) || 0}; appName = $el.Current.Name; threads = @(); messages = $msgs } | ConvertTo-Json -Depth 4 -Compress
    `;
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 8000 });
      return JSON.parse(stdout.trim() || "{}");
    } catch (err) {
      return { ok: false, error: err.message, messages: [], threads: [] };
    }
  }

  async performWindowsAction(hwnd, body = {}) {
    if (body.type === "reply" && body.text) {
      const b64 = Buffer.from(String(body.text), "utf-8").toString("base64");
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          public class WinApi { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }
"@
        [WinApi]::SetForegroundWindow([IntPtr]${Number(hwnd) || 0}) | Out-Null
        Start-Sleep -Milliseconds 150
        $txt = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
        [System.Windows.Forms.Clipboard]::SetText($txt)
        [System.Windows.Forms.SendKeys]::SendWait('^v{ENTER}')
      `;
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 6000 });
    }
    return await this.readWindowsMessages(hwnd);
  }
}

export const desktopMonitor = new DesktopSoftwareMonitor();
