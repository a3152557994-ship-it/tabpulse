import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { renderQrSvg } from "./qr.mjs";

const HOME_DIR = os.homedir();
const EXTRA_BIN_DIRS = [
  path.join(HOME_DIR, ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(HOME_DIR, ".config", "tabpulse", "bin"),
];

function buildAugmentedPath() {
  const cur = process.env.PATH || "/usr/bin:/bin";
  return [...EXTRA_BIN_DIRS, cur].join(path.delimiter);
}

export function findExecutable(name) {
  const isWin = process.platform === "win32";
  const exts = isWin ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = [
    ...EXTRA_BIN_DIRS,
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
  ];
  for (const d of dirs) {
    for (const ext of exts) {
      const full = path.join(d, name + ext);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          if (!isWin) fs.accessSync(full, fs.constants.X_OK);
          return full;
        }
      } catch {
        // ignore inaccessible dir
      }
    }
  }
  return null;
}

// MARK: - Cryptographic Mobile Pairing Auth & Rate Limiter
const failedAttemptsByIp = new Map();

export function isLocalDesktopTrusted(req) {
  const remote = req.socket?.remoteAddress || "";
  const isLoopback =
    remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!isLoopback) return false;
  // Critical: cloudflared / ssh tunnel connects from 127.0.0.1 WITH forwarded headers or external Host!
  if (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.headers["cf-ray"] ||
    req.headers["x-real-ip"]
  ) {
    return false;
  }
  const secFetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  const origin = String(req.headers.origin || "");
  if (secFetchSite === "cross-site" && !origin.startsWith("chrome-extension://")) {
    return false;
  }
  const host = String(req.headers.host || "").trim().toLowerCase();
  if (!host) return true;
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

function getClientIp(req) {
  return (
    String(req.headers["cf-connecting-ip"] || "").trim() ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function checkMobileAuth(req, reqUrl, expectedToken) {
  const ip = getClientIp(req);
  const now = Date.now();
  const rec = failedAttemptsByIp.get(ip);
  if (rec && rec.count >= 8 && now - rec.lastAt < 10 * 60 * 1000) {
    return { ok: false, locked: true, error: "Too many invalid pairing attempts. Locked for 10 minutes." };
  }

  const queryTok = reqUrl.searchParams.get("t") || "";
  const headerTok =
    req.headers["x-tabpulse-token"] ||
    String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const cookies = parseCookies(req.headers.cookie);
  const cookieTok = cookies.tp_mob_tok || "";

  const candidate = queryTok || headerTok || cookieTok;
  if (expectedToken && safeEqual(candidate, expectedToken)) {
    failedAttemptsByIp.delete(ip);
    return { ok: true, fromQuery: Boolean(queryTok) };
  }

  if (candidate) {
    failedAttemptsByIp.set(ip, { count: (rec?.count || 0) + 1, lastAt: now });
  }
  return { ok: false, locked: false, error: "Mobile pairing token required. Scan QR code on desktop." };
}

export function getLanAddresses() {
  const nets = os.networkInterfaces();
  const list = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal) {
        list.push({ iface: name, ip: addr.address });
      }
    }
  }
  // Prefer standard LAN 192.168.x / 10.x / 172.x first, then Tailscale/VPN 100.x / 198.x
  list.sort((a, b) => {
    const score = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);
    return score(a.ip) - score(b.ip);
  });
  return list;
}

// MARK: - Cloudflared Quick Tunnel Manager + Permanent Edge Bookmark Sync (4G/5G Zero-VPN Encrypted HTTPS)
const EDGE_GATEWAY_ORIGIN = process.env.TABPULSE_EDGE_ORIGIN || "https://replyradar-edge.a3152557994.workers.dev";

class CloudflaredManager {
  constructor() {
    this.proc = null;
    this.publicUrl = "";
    this.permanentBaseUrl = "";
    this.status = "stopped"; // stopped | starting | running | error
    this.lastError = "";
    this.wantedRunning = false;
    this.lastPort = 17890;
    this.boxCreds = null; // { boxId, writeKey }
    this.reconnectTimer = null;
    this.syncTimer = null;
    this.onTunnelReconnected = null;
  }

  configureBoxCredentials(creds) {
    if (creds && creds.boxId && creds.writeKey) {
      this.boxCreds = creds;
      this.permanentBaseUrl = `${EDGE_GATEWAY_ORIGIN}/go/${creds.boxId}`;
    }
  }

  async syncPermanentGateway() {
    if (!this.publicUrl || !this.boxCreds?.boxId || !this.boxCreds?.writeKey) return null;
    if (process.env.TABPULSE_DISABLE_EXTERNAL_EFFECTS === "1") return null;
    try {
      const res = await fetch(`${EDGE_GATEWAY_ORIGIN}/api/tunnel/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boxId: this.boxCreds.boxId,
          writeKey: this.boxCreds.writeKey,
          targetOrigin: this.publicUrl,
        }),
      });
      const data = await res.json().catch(() => null);
      if (data?.ok && data.permanentUrl) {
        this.permanentBaseUrl = data.permanentUrl;
      }
      return data;
    } catch {
      return null;
    }
  }

  scheduleAutoReconnect() {
    if (!this.wantedRunning || process.env.TABPULSE_DISABLE_EXTERNAL_EFFECTS === "1") return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (!this.wantedRunning || (this.proc && this.status === "running")) return;
      const prevUrl = this.publicUrl;
      const res = await this.start(this.lastPort, { isReconnect: true });
      if (res.ok && res.publicUrl && res.publicUrl !== prevUrl && this.onTunnelReconnected) {
        this.onTunnelReconnected(res.publicUrl);
      }
    }, 6500);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  async ensureBinary() {
    const found = findExecutable("cloudflared");
    if (found) return found;

    const targetDir = path.join(HOME_DIR, ".config", "tabpulse", "bin");
    fs.mkdirSync(targetDir, { recursive: true });
    const isWin = process.platform === "win32";
    const binPath = path.join(targetDir, isWin ? "cloudflared.exe" : "cloudflared");
    if (fs.existsSync(binPath)) return binPath;

    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const assetName = isWin
      ? "cloudflared-windows-amd64.exe"
      : process.platform === "darwin"
        ? `cloudflared-darwin-${arch}.tgz`
        : "";
    const edgeUrl = assetName ? `${EDGE_GATEWAY_ORIGIN}/dl/${assetName}` : "";
    const ghUrl = isWin
      ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
      : process.platform === "darwin"
        ? `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`
        : `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;

    let rawBuf;
    try {
      rawBuf = edgeUrl ? await downloadHttpsBuffer(edgeUrl) : await downloadHttpsBuffer(ghUrl);
    } catch {
      rawBuf = await downloadHttpsBuffer(ghUrl);
    }
    if (ghUrl.endsWith(".tgz")) {
      const tarBuf = zlib.gunzipSync(rawBuf);
      const extracted = extractSingleFileFromTar(tarBuf, "cloudflared");
      fs.writeFileSync(binPath, extracted, { mode: 0o755 });
    } else {
      fs.writeFileSync(binPath, rawBuf, { mode: 0o755 });
    }
    return binPath;
  }

  async start(localPort = 17890, opts = {}) {
    this.wantedRunning = true;
    this.lastPort = localPort;
    if (this.proc && this.status === "running" && this.publicUrl) {
      return { ok: true, status: this.status, publicUrl: this.publicUrl };
    }
    this.stop({ keepWanted: true });
    this.status = "starting";
    this.lastError = "";

    const onConnected = () => {
      this.syncPermanentGateway().catch(() => {});
      clearInterval(this.syncTimer);
      this.syncTimer = setInterval(() => this.syncPermanentGateway().catch(() => {}), 10 * 60 * 1000);
      if (this.syncTimer.unref) this.syncTimer.unref();
    };

    // Primary: Built-in system SSH HTTPS tunnel (works out-of-the-box on macOS & Windows 10/11 AND passes Clash Fake-IP TUN!)
    const sshBin = findExecutable("ssh") || (process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "/usr/bin/ssh");
    if (sshBin && fs.existsSync(sshBin)) {
      const sshRes = await this.startSshTunnel(sshBin, localPort);
      if (sshRes.ok && sshRes.publicUrl) {
        onConnected();
        return sshRes;
      }
    }

    // Fallback: cloudflared HTTP/2 quick tunnel
    let bin;
    try {
      bin = await this.ensureBinary();
    } catch (err) {
      this.status = "error";
      this.lastError = `启动穿透失败: ${err.message}`;
      if (opts.isReconnect) this.scheduleAutoReconnect();
      return { ok: false, status: this.status, error: this.lastError };
    }

    return new Promise((resolve) => {
      let settled = false;
      const proc = spawn(
        bin,
        ["tunnel", "--protocol", "http2", "--no-autoupdate", "--url", `http://127.0.0.1:${localPort}`],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: buildAugmentedPath() } }
      );
      this.proc = proc;

      const onChunk = (buf) => {
        const text = buf.toString("utf-8");
        const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m && !this.publicUrl) {
          this.publicUrl = m[0];
          this.status = "running";
          onConnected();
          if (!settled) {
            settled = true;
            resolve({ ok: true, status: "running", publicUrl: this.publicUrl });
          }
        }
      };

      proc.stdout.on("data", onChunk);
      proc.stderr.on("data", onChunk);
      proc.on("exit", (code) => {
        if (this.proc === proc) {
          this.proc = null;
          this.status = "stopped";
          this.publicUrl = "";
          this.scheduleAutoReconnect();
        }
        if (!settled) {
          settled = true;
          resolve({ ok: false, status: "error", error: `tunnel exited (${code})` });
        }
      });

      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: Boolean(this.publicUrl), status: this.status, publicUrl: this.publicUrl });
        }
      }, 6500);
    });
  }

  startSshTunnel(sshBin, localPort) {
    return new Promise((resolve) => {
      let settled = false;
      const proc = spawn(
        sshBin,
        [
          "-T",
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
          "-o", "ServerAliveInterval=30",
          "-o", "ExitOnForwardFailure=yes",
          "-R", `80:127.0.0.1:${localPort}`,
          "nokey@localhost.run",
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      this.proc = proc;

      const onChunk = (buf) => {
        const text = buf.toString("utf-8");
        const m =
          text.match(/tunneled with tls termination,\s*(https:\/\/[a-z0-9.-]+\.lhr\.life)/i) ||
          text.match(/(https:\/\/[a-z0-9]{10,}\.lhr\.life)\b/i);
        const url = m ? m[1] : "";
        if (url && (!this.publicUrl || this.publicUrl !== url)) {
          this.publicUrl = url;
          this.status = "running";
          this.syncPermanentGateway().catch(() => {});
          if (!settled) {
            settled = true;
            resolve({ ok: true, status: "running", publicUrl: this.publicUrl });
          }
        }
      };

      proc.stdout.on("data", onChunk);
      proc.stderr.on("data", onChunk);
      proc.on("exit", () => {
        if (this.proc === proc) {
          this.proc = null;
          this.publicUrl = "";
          this.status = "stopped";
          this.scheduleAutoReconnect();
        }
        if (!settled) {
          settled = true;
          resolve({ ok: false, status: "stopped", publicUrl: "" });
        }
      });

      setTimeout(() => {
        if (!settled) {
          settled = true;
          if (!this.publicUrl) {
            try { proc.kill("SIGTERM"); } catch {}
            this.proc = null;
          }
          resolve({ ok: Boolean(this.publicUrl), status: this.status, publicUrl: this.publicUrl });
        }
      }, 6000);
    });
  }

  stop(opts = {}) {
    if (!opts.keepWanted) {
      this.wantedRunning = false;
      clearTimeout(this.reconnectTimer);
      clearInterval(this.syncTimer);
    }
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {}
      this.proc = null;
    }
    this.publicUrl = "";
    this.status = "stopped";
    return { ok: true, status: "stopped" };
  }

  getInfo(localPort, token, opts = {}) {
    const allowLan = Boolean(opts.allowLanDirect);
    const allLans = getLanAddresses();
    const lans = allowLan ? allLans : [];
    const lanUrl = lans.length ? `http://${lans[0].ip}:${localPort}/m?t=${token}` : `http://127.0.0.1:${localPort}/m?t=${token}`;
    const rawTunnelUrl = this.publicUrl ? `${this.publicUrl}/m?t=${token}` : "";
    const permanentMobileUrl =
      this.publicUrl && this.permanentBaseUrl ? `${this.permanentBaseUrl}?t=${token}` : "";
    const tunnelMobileUrl = permanentMobileUrl || rawTunnelUrl;
    const primaryUrl = tunnelMobileUrl || lanUrl;
    let qrSvg = "";
    try {
      qrSvg = renderQrSvg(primaryUrl, 210);
    } catch {}
    return {
      status: this.status,
      publicUrl: this.publicUrl,
      rawTunnelUrl,
      permanentMobileUrl,
      tunnelMobileUrl,
      lanUrl,
      allowLanDirect: allowLan,
      detectedLanIp: allLans[0]?.ip || "",
      allLanIps: lans.map((x) => `http://${x.ip}:${localPort}/m?t=${token}`),
      primaryUrl,
      qrSvg,
      lastError: this.lastError,
    };
  }
}

function downloadHttpsBuffer(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "TabPulse/3.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(downloadHttpsBuffer(res.headers.location, redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

function extractSingleFileFromTar(tarBuf, targetName) {
  let offset = 0;
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header[0] === 0) break;
    const rawName = header.subarray(0, 100).toString("utf-8").replace(/\0.*$/, "");
    const sizeOct = header.subarray(124, 136).toString("utf-8").replace(/\0.*$/, "").trim();
    const fileSize = parseInt(sizeOct || "0", 8) || 0;
    const dataStart = offset + 512;
    if (path.basename(rawName) === targetName && fileSize > 0) {
      return tarBuf.subarray(dataStart, dataStart + fileSize);
    }
    offset = dataStart + Math.ceil(fileSize / 512) * 512;
  }
  throw new Error(`${targetName} not found in archive`);
}

export const tunnelManager = new CloudflaredManager();

// MARK: - Claude Code (CC) / Codex / Opus / CLI Remote Session & Hook Engine
class AgentSessionEngine {
  constructor() {
    this.sessions = [];
    this.hookEvents = [];
    this.runningProcs = new Map();
    this.onTaskAlert = null;
  }

  detectAvailableAgents() {
    const candidates = [
      { id: "claude", label: "Claude Code (CC 官方终端)", bin: findExecutable("claude") },
      { id: "opus", label: "Claude Opus (Cursor Agent)", bin: findExecutable("opus") },
      { id: "codex", label: "OpenAI Codex CLI", bin: findExecutable("codex") },
      { id: "gemini", label: "Google Gemini CLI", bin: findExecutable("gemini") },
    ];
    return candidates.map((c) => ({ ...c, installed: Boolean(c.bin) }));
  }

  checkClaudeHookInstalled() {
    const settingsPath = path.join(HOME_DIR, ".claude", "settings.json");
    if (!fs.existsSync(settingsPath)) return false;
    try {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      return raw.includes("/api/cc/hook");
    } catch {
      return false;
    }
  }

  installClaudeHooks(localPort = 17890) {
    const claudeDir = path.join(HOME_DIR, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    let obj = {};
    if (fs.existsSync(settingsPath)) {
      try {
        obj = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) || {};
      } catch {
        obj = {};
      }
    }
    if (!obj.hooks || typeof obj.hooks !== "object") obj.hooks = {};

    const stopCmd = `curl -fsS -m 3 -X POST "http://127.0.0.1:${localPort}/api/cc/hook?event=Stop" -H "Content-Type: application/json" --data-binary @- >/dev/null 2>&1 || true`;
    const notifyCmd = `curl -fsS -m 3 -X POST "http://127.0.0.1:${localPort}/api/cc/hook?event=Notification" -H "Content-Type: application/json" --data-binary @- >/dev/null 2>&1 || true`;

    const ensureHook = (eventName, cmd) => {
      const arr = Array.isArray(obj.hooks[eventName]) ? obj.hooks[eventName] : [];
      const already = JSON.stringify(arr).includes("/api/cc/hook");
      if (!already) {
        arr.push({ matcher: "", hooks: [{ type: "command", command: cmd }] });
      }
      obj.hooks[eventName] = arr;
    };

    ensureHook("Stop", stopCmd);
    ensureHook("Notification", notifyCmd);
    fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2), "utf-8");
    return { ok: true, settingsPath };
  }

  recordHookEvent(eventType, payload = {}) {
    const cwd = payload.cwd || payload.project_dir || "";
    const msg =
      payload.message ||
      payload.last_assistant_message ||
      payload.reason ||
      (eventType === "Stop" ? "Claude Code 当前终端任务已执行完毕，等待下一步指令" : "Claude Code 正在等待您的确认或输入");
    const entry = {
      id: `hk_${Date.now().toString(36)}`,
      eventType,
      cwd,
      summary: String(msg).slice(0, 260),
      sessionId: payload.session_id || "",
      createdAt: new Date().toISOString(),
    };
    this.hookEvents.unshift(entry);
    if (this.hookEvents.length > 40) this.hookEvents.length = 40;

    if (this.onTaskAlert) {
      this.onTaskAlert({
        title: eventType === "Stop" ? "✅ 电脑端 Claude Code 任务已完成" : "🔔 Claude Code 等待您的确认",
        summary: `${cwd ? `[${path.basename(cwd)}] ` : ""}${entry.summary}`,
        targetKey: "cc:hooks",
      });
    }
    return entry;
  }

  createSession({ name, agent = "claude", cwd = "" } = {}) {
    if (agent === "shell") {
      throw new Error("出于系统安全保护，已禁止创建原生系统 Shell 远程终端会话");
    }
    const agents = this.detectAvailableAgents();
    const chosen = agents.find((a) => a.id === agent && a.installed) || agents.find((a) => a.installed) || agents[0];
    const resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : HOME_DIR;
    const session = {
      id: `cc_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`,
      name: String(name || `${chosen.label} (${path.basename(resolvedCwd)})`).trim(),
      agent: chosen.id,
      agentLabel: chosen.label,
      cwd: resolvedCwd,
      status: "idle", // idle | running | done | error
      turnCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    this.sessions.unshift(session);
    if (this.sessions.length > 30) this.sessions.length = 30;
    return session;
  }

  listState(localPort = 17890) {
    return {
      agents: this.detectAvailableAgents(),
      claudeHookInstalled: this.checkClaudeHookInstalled(),
      hookEvents: this.hookEvents.slice(0, 15),
      sessions: this.sessions,
      localPort,
    };
  }

  sendPrompt(sessionId, promptText) {
    let session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      session = this.createSession({});
    }
    if (session.status === "running") {
      throw new Error("当前会话正在执行上一条任务，请等待完成或先点击停止");
    }
    const cleanPrompt = String(promptText || "").trim();
    if (!cleanPrompt) throw new Error("请输入指令内容");

    session.status = "running";
    session.updatedAt = new Date().toISOString();
    session.messages.push({
      role: "user",
      text: cleanPrompt,
      at: session.updatedAt,
    });
    const replyMsg = {
      role: "assistant",
      text: "⏳ 正在电脑固定网络环境下执行...\n",
      at: new Date().toISOString(),
    };
    session.messages.push(replyMsg);

    const { bin, args } = this.buildCommand(session, cleanPrompt);
    session.turnCount += 1;

    const proc = spawn(bin, args, {
      cwd: session.cwd,
      env: { ...process.env, PATH: buildAugmentedPath(), FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.runningProcs.set(session.id, proc);

    let outputBuf = "";
    const appendChunk = (chunk) => {
      const str = chunk.toString("utf-8");
      outputBuf += str;
      if (outputBuf.length > 48000) {
        outputBuf = outputBuf.slice(-48000);
      }
      replyMsg.text = outputBuf;
      session.updatedAt = new Date().toISOString();
    };

    proc.stdout.on("data", appendChunk);
    proc.stderr.on("data", appendChunk);
    proc.on("error", (err) => {
      this.runningProcs.delete(session.id);
      session.status = "error";
      replyMsg.text = (outputBuf ? outputBuf + "\n" : "") + `❌ 启动失败: ${err.message}`;
      session.updatedAt = new Date().toISOString();
    });
    proc.on("close", (code) => {
      this.runningProcs.delete(session.id);
      session.status = code === 0 ? "done" : "error";
      if (!outputBuf.trim()) {
        replyMsg.text = code === 0 ? "✅ 执行完成（无额外文本输出）" : `⚠️ 进程退出码: ${code}`;
      }
      replyMsg.exitCode = code;
      session.updatedAt = new Date().toISOString();

      if (this.onTaskAlert) {
        const tail = replyMsg.text.trim().replace(/\s+/g, " ").slice(-140);
        this.onTaskAlert({
          title: code === 0 ? `✅ [${session.name}] 任务已完成` : `⚠️ [${session.name}] 执行结束 (code ${code})`,
          summary: tail || "点击手机端红点进入查看详情并继续发送下一条指令",
          sessionId: session.id,
          targetKey: `cc:${session.id}`,
        });
      }
    });

    return session;
  }

  stopSession(sessionId) {
    const proc = this.runningProcs.get(sessionId);
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      this.runningProcs.delete(sessionId);
    }
    const s = this.sessions.find((x) => x.id === sessionId);
    if (s && s.status === "running") {
      s.status = "idle";
      s.updatedAt = new Date().toISOString();
    }
    return { ok: true };
  }

  buildCommand(session, prompt) {
    const agents = this.detectAvailableAgents();
    const found = agents.find((a) => a.id === session.agent && a.installed);
    if (session.agent === "claude" && found?.bin) {
      const args = session.turnCount > 0 ? ["-c", "-p", prompt] : ["-p", prompt];
      return { bin: found.bin, args };
    }
    if (session.agent === "opus" && found?.bin) {
      return { bin: found.bin, args: [prompt] };
    }
    if (session.agent === "codex" && found?.bin) {
      return { bin: found.bin, args: ["exec", "--skip-git-repo-check", prompt] };
    }
    if (session.agent === "gemini" && found?.bin) {
      return { bin: found.bin, args: ["-p", prompt] };
    }
    throw new Error("未检测到已安装的受信任 AI 命令行工具（Claude Code / Codex / Gemini），已拦截裸 Shell 执行");
  }
}

export const agentEngine = new AgentSessionEngine();

// MARK: - Desktop Native WebView Relay Queue (Snapshot + Remote Click + Fixed-IP Reply)
class DesktopWebRelay {
  constructor() {
    this.pendingTasks = [];
    this.waiters = new Map();
    this.lastSnapshots = new Map();
    this.lastBridgeSeenAt = 0;
  }

  isDesktopConnected() {
    return Date.now() - this.lastBridgeSeenAt < 12000;
  }

  enqueueCommand(cmd, timeoutMs = 8000) {
    const taskId = `br_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
    const fullCmd = { taskId, ...cmd, createdAt: Date.now() };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(taskId);
        this.pendingTasks = this.pendingTasks.filter((t) => t.taskId !== taskId);
        const cached = cmd.watchId ? this.lastSnapshots.get(cmd.watchId) : null;
        resolve({
          ok: false,
          timeout: true,
          error: "电脑端《消息总管》窗口未响应，请确认电脑端软件处于运行状态",
          ...(cached ? { cachedSnapshot: cached } : {}),
        });
      }, timeoutMs);
      this.waiters.set(taskId, { resolve, timer, watchId: cmd.watchId });
      this.pendingTasks.push(fullCmd);
    });
  }

  pollNextCommands() {
    this.lastBridgeSeenAt = Date.now();
    const batch = this.pendingTasks.splice(0, 5);
    return batch;
  }

  submitCommandResult(taskId, result = {}) {
    this.lastBridgeSeenAt = Date.now();
    if (result.watchId && (Array.isArray(result.messages) || result.extractedText)) {
      this.lastSnapshots.set(result.watchId, {
        pageTitle: result.pageTitle || "",
        currentUrl: result.currentUrl || "",
        authRequired: Boolean(result.authRequired),
        threads: Array.isArray(result.threads) ? result.threads : [],
        messages: Array.isArray(result.messages) ? result.messages : [],
        extractedText: result.extractedText || "",
        capturedAt: new Date().toISOString(),
      });
    }
    const w = this.waiters.get(taskId);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(taskId);
      w.resolve({ ok: true, ...result });
    }
    return { ok: true };
  }

  getCachedSnapshot(watchId) {
    return this.lastSnapshots.get(watchId) || null;
  }
}

export const desktopRelay = new DesktopWebRelay();
