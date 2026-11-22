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
    }, 3800);
    if (this.watchTimer.unref) this.watchTimer.unref();
  }

  async pollOnce() {
    const st = await this.getDesktopState();
    if (!st.ok) return st;

    // 1. Check Dock unread badge increases across ALL running desktop apps (WeChat, QQ, Telegram, Antigravity, Mail, etc.)
    const currentKeys = new Set();
    for (const b of st.badges || []) {
      const key = b.bundleId || b.name;
      currentKeys.add(key);
      const prev = this.lastBadges.get(key) || "";
      const cur = String(b.badge || "");
      this.lastBadges.set(key, cur);

      const prevNum = parseInt(prev, 10) || 0;
      const curNum = parseInt(cur, 10) || (cur ? 1 : 0);
      if (cur && cur !== prev && curNum >= prevNum) {
        const entry = {
          id: `da_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
          kind: "badge",
          appName: b.name,
          badge: cur,
          text: `${b.name} 图标出现未读红点 (${cur})`,
          at: new Date().toISOString(),
        };
        this.pushAlertEntry(entry);
      }
    }
    for (const oldKey of Array.from(this.lastBadges.keys())) {
      if (!currentKeys.has(oldKey)) this.lastBadges.delete(oldKey);
    }

    // 2. Check live Notification Center banners popping up from ANY desktop software
    const banners = st.banners || [];
    if (banners.length >= 1) {
      const joined = banners.slice(0, 4).join(" · ");
      if (joined.length >= 3 && !this.seenBanners.has(joined)) {
        this.seenBanners.add(joined);
        if (this.seenBanners.size > 120) {
          const first = this.seenBanners.values().next().value;
          this.seenBanners.delete(first);
        }
        const entry = {
          id: `bn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
          kind: "banner",
          appName: banners[0] || "系统通知",
          badge: "新弹窗",
          text: joined,
          at: new Date().toISOString(),
        };
        this.pushAlertEntry(entry);
      }
    }
    return st;
  }

  pushAlertEntry(entry) {
    // Ignore our own notifications to avoid feedback loops
    if (entry.appName.includes("消息总管") || entry.appName.includes("ReplyRadar") || entry.text.includes("消息总管")) {
      return;
    }
    this.recentAlerts.unshift(entry);
    if (this.recentAlerts.length > 50) this.recentAlerts.length = 50;
    if (this.onDesktopAlert) {
      this.onDesktopAlert({
        title: `🖥️【电脑软件提醒】${entry.appName}`,
        summary: entry.text,
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
        return {
          ...parsed,
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

  async captureWindow(windowId) {
    if (process.platform === "darwin") {
      const bin = resolveMacHelperBin();
      if (!bin) return { ok: false, error: "mac-desktop-helper missing" };
      const { stdout } = await execFileAsync(bin, ["capture", String(Number(windowId) || 0)], {
        timeout: 8000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return JSON.parse(stdout.trim() || "{}");
    }
    if (process.platform === "win32") {
      return await this.captureWindowsScreen(windowId);
    }
    return { ok: false, error: "unsupported platform" };
  }

  async performWindowAction(windowId, body = {}) {
    const wid = String(Number(windowId) || 0);
    const type = body.type || "capture";
    if (process.platform === "darwin") {
      const bin = resolveMacHelperBin();
      if (!bin) return { ok: false, error: "mac-desktop-helper missing" };

      if (type === "click") {
        const xr = String(Math.max(0.01, Math.min(0.99, Number(body.xRatio) || 0.5)));
        const yr = String(Math.max(0.01, Math.min(0.99, Number(body.yRatio) || 0.5)));
        const { stdout } = await execFileAsync(bin, ["click", wid, xr, yr], {
          timeout: 8000,
          maxBuffer: 8 * 1024 * 1024,
        });
        return JSON.parse(stdout.trim() || "{}");
      }

      if (type === "scroll") {
        const lines = Number(body.dy) > 0 ? "-6" : "6";
        const { stdout } = await execFileAsync(bin, ["scroll", wid, lines], {
          timeout: 8000,
          maxBuffer: 8 * 1024 * 1024,
        });
        return JSON.parse(stdout.trim() || "{}");
      }

      if (type === "type") {
        const b64 = Buffer.from(String(body.text || ""), "utf-8").toString("base64");
        const mode = body.submitMode === "cmd_enter" ? "cmd_enter" : body.submitMode === "none" ? "none" : "enter";
        const { stdout } = await execFileAsync(bin, ["type", wid, b64, mode], {
          timeout: 10000,
          maxBuffer: 8 * 1024 * 1024,
        });
        return JSON.parse(stdout.trim() || "{}");
      }

      return await this.captureWindow(wid);
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

  // Windows 10/11 Native Process Window Enumeration & Capture via PowerShell .NET
  async getWindowsDesktopState() {
    const ps = `
      $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } | Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle
      $wins = @()
      foreach ($p in $procs) {
        $wins += @{ windowId = [int64]$p.MainWindowHandle; pid = $p.Id; appName = $p.ProcessName; title = $p.MainWindowTitle; bundleId = $p.ProcessName }
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

  async captureWindowsScreen(hwnd) {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class WinApi {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        }
"@
      [WinApi]::SetForegroundWindow([IntPtr]${Number(hwnd) || 0}) | Out-Null
      Start-Sleep -Milliseconds 180
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $b64 = [Convert]::ToBase64String($ms.ToArray())
      @{ ok = $true; windowId = ${Number(hwnd) || 0}; imageDataUrl = "data:image/jpeg;base64," + $b64 } | ConvertTo-Json -Compress
    `;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", ps], {
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim() || "{}");
  }

  async performWindowsAction(hwnd, body = {}) {
    if (body.type === "type" && body.text) {
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
    return await this.captureWindowsScreen(hwnd);
  }
}

export const desktopMonitor = new DesktopSoftwareMonitor();
