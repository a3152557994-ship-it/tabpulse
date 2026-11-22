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
  // Critical: cloudflared connects from 127.0.0.1 WITH cf-connecting-ip / x-forwarded-for or external Host!
  if (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["cf-ray"]) {
    return false;
  }
  const host = String(req.headers.host || "").toLowerCase();
  if (!host) return true;
  return host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("[::1]");
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

// MARK: - Cloudflared Quick Tunnel Manager (4G/5G Zero-VPN Encrypted HTTPS)
class CloudflaredManager {
  constructor() {
    this.proc = null;
    this.publicUrl = "";
    this.status = "stopped"; // stopped | starting | running | error
    this.lastError = "";
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
    const dlUrl = isWin
      ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
      : process.platform === "darwin"
        ? `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`
        : `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;

    const rawBuf = await downloadHttpsBuffer(dlUrl);
    if (dlUrl.endsWith(".tgz")) {
      const tarBuf = zlib.gunzipSync(rawBuf);
      const extracted = extractSingleFileFromTar(tarBuf, "cloudflared");
      fs.writeFileSync(binPath, extracted, { mode: 0o755 });
    } else {
      fs.writeFileSync(binPath, rawBuf, { mode: 0o755 });
    }
    return binPath;
  }

  async start(localPort = 17890) {
    if (this.proc && this.status === "running" && this.publicUrl) {
      return { ok: true, status: this.status, publicUrl: this.publicUrl };
    }
    this.stop();
    this.status = "starting";
    this.lastError = "";

    let bin;
    try {
      bin = await this.ensureBinary();
    } catch (err) {
      this.status = "error";
      this.lastError = `下载穿透组件失败: ${err.message}`;
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
          if (!this.publicUrl) {
            this.status = "error";
            this.lastError = `cloudflared exited (${code})`;
          } else {
            this.status = "stopped";
            this.publicUrl = "";
          }
        }
        if (!settled) {
          settled = true;
          resolve({ ok: false, status: this.status, error: this.lastError || "tunnel exited" });
        }
      });

      setTimeout(() => {
        if (!settled) {
          settled = true;
          if (this.publicUrl) {
            resolve({ ok: true, status: "running", publicUrl: this.publicUrl });
          } else {
            resolve({ ok: true, status: "starting", publicUrl: "" });
          }
        }
      }, 6500);
    });
  }

  stop() {
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

  getInfo(localPort, token) {
    const lans = getLanAddresses();
    const lanUrl = lans.length ? `http://${lans[0].ip}:${localPort}/m?t=${token}` : `http://127.0.0.1:${localPort}/m?t=${token}`;
    const tunnelMobileUrl = this.publicUrl ? `${this.publicUrl}/m?t=${token}` : "";
    const primaryUrl = tunnelMobileUrl || lanUrl;
    let qrSvg = "";
    try {
      qrSvg = renderQrSvg(primaryUrl, 210);
    } catch {}
    return {
      status: this.status,
      publicUrl: this.publicUrl,
      tunnelMobileUrl,
      lanUrl,
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
      { id: "shell", label: "本地终端命令 (Zsh / PowerShell)", bin: process.platform === "win32" ? "powershell.exe" : "/bin/zsh" },
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
      });
    }
    return entry;
  }

  createSession({ name, agent = "claude", cwd = "" } = {}) {
    const agents = this.detectAvailableAgents();
    const chosen = agents.find((a) => a.id === agent && a.installed) || agents.find((a) => a.installed) || agents[agents.length - 1];
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
          summary: tail || "点击手机端链接查看详情并继续发送下一条指令",
          sessionId: session.id,
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
    if (process.platform === "win32") {
      return { bin: "powershell.exe", args: ["-NoProfile", "-Command", prompt] };
    }
    return { bin: "/bin/zsh", args: ["-lc", prompt] };
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
    if (result.watchId && result.imageDataUrl) {
      this.lastSnapshots.set(result.watchId, {
        imageDataUrl: result.imageDataUrl,
        pageTitle: result.pageTitle || "",
        currentUrl: result.currentUrl || "",
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
