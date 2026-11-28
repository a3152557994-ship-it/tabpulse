import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLATFORM_CATALOG, PLATFORM_CATALOG_CATEGORIES } from "../seed/platform-catalog.mjs";
import { PRESET_PACKS } from "../seed/preset-packs.mjs";
import { aiButler } from "./ai-butler.mjs";
import { aiInbox } from "./ai-inbox.mjs";
import { installAiClient, listAiClientsStatus } from "./ai-installer.mjs";
import { desktopMonitor } from "./desktop-monitor.mjs";
import {
  agentEngine,
  checkMobileAuth,
  desktopRelay,
  getLanAddresses,
  isLocalDesktopTrusted,
  tunnelManager,
} from "./mobile-bridge.mjs";
import {
  notifyAgentAlert,
  notifyAuthExpired,
  notifyUnread,
  sendCustomerWebhook,
  sendEmailPushNotification,
} from "./notifier.mjs";
import { scanBuyerLeads } from "./scanner.mjs";
import {
  activateLicenseKey,
  broadcastMobileWebPush,
  deleteWatch,
  getDueWatches,
  getMobileToken,
  getPublicSummary,
  getTunnelBoxCredentials,
  getVapidPublicKey,
  loadState,
  recordProbeReport,
  resolveWatch,
  rotateMobileToken,
  savePushSubscription,
  saveQuickReplies,
  saveReplyDraft,
  unbindWatch,
  updateSettings,
  upsertWatch,
} from "./store.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const INDEX_HTML_PATH = path.join(__dirname, "ui", "index.html");
const MOBILE_HTML_PATH = path.join(__dirname, "ui", "mobile.html");
const SW_JS_PATH = path.join(__dirname, "ui", "sw.js");
const LLMS_TXT_PATH = path.join(PROJECT_ROOT, "llms.txt");
const PLAYBOOK_HTML_PATH = path.join(PROJECT_ROOT, "docs", "cold-reply-playbook.html");

const MOBILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#2563eb"/><circle cx="256" cy="256" r="154" fill="none" stroke="#93c5fd" stroke-width="14" opacity="0.55"/><path d="M256 128c-60 0-108 48-108 108v58l-24 28v18h264v-18l-24-28v-58c0-60-48-108-108-108zm0 264c24 0 44-18 44-40h-88c0 22 20 40 44 40z" fill="#fff"/><circle cx="356" cy="156" r="46" fill="#ef4444" stroke="#fff" stroke-width="12"/></svg>`;

function escapeHtmlServer(raw = "") {
  return String(raw).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function isAllowedDesktopOrigin(origin) {
  if (!origin) return false;
  return (
    /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin) ||
    /^chrome-extension:\/\/[a-z0-9-]+$/i.test(origin)
  );
}

function isSameHostOrigin(origin, req) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host.toLowerCase() === String(req.headers.host || "").toLowerCase();
  } catch {
    return false;
  }
}

function sendJson(res, statusCode, payload, corsOrigin, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders,
  };
  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-TabPulse-Token";
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, contentType, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders,
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 4 * 1024 * 1024) {
      throw new Error("payload too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function currentMobileLink(localPort) {
  const tok = getMobileToken();
  const st = loadState();
  const info = tunnelManager.getInfo(localPort, tok, { allowLanDirect: Boolean(st.settings?.allowLanDirect) });
  return info.primaryUrl;
}

function renderPairGateHtml(errorMsg = "", boxPrefix = "") {
  const safeErr = escapeHtmlServer(errorMsg);
  const cleanPrefix = /^\/box\/bx_[a-zA-Z0-9]{10,36}$/.test(String(boxPrefix || "")) ? String(boxPrefix) : "";
  const formAction = `${cleanPrefix}/m`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="referrer" content="no-referrer"/><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/><title>消息总管 · 手机安全配对</title><style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#0f172a;color:#f8fafc;display:grid;place-items:center;min-height:100vh;padding:20px}form{background:#1e293b;border:1px solid #334155;border-radius:18px;padding:24px;width:100%;max-width:360px;box-sizing:border-box}h1{font-size:19px;margin:0 0 8px}p{font-size:13px;color:#94a3b8;line-height:1.5;margin:0 0 16px}input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #475569;background:#0f172a;color:#fff;font-size:14px;margin-bottom:12px}button{width:100%;padding:12px;border-radius:10px;border:none;background:#2563eb;color:#fff;font-weight:700;font-size:15px}</style></head><body><form method="GET" action="${formAction}"><h1>🔒 消息总管 · 手机随身端</h1><p>请在电脑端打开《消息总管》点击左下角「📲 手机随身收件箱」直接扫码进入，或在下方粘贴配对密钥：</p>${safeErr ? `<p style="color:#f87171">${safeErr}</p>` : ""}<input name="t" placeholder="粘贴电脑端配对密钥..." required /><button type="submit">验证并进入手机工作台</button></form></body></html>`;
}

export function createHubServer(options = {}) {
  const serverPortRef = { port: Number(options.port || process.env.TABPULSE_PORT || 17890) };
  const sseClients = new Set();

  function broadcastLiveAlert(payload) {
    const line = `data: ${JSON.stringify({ ts: Date.now(), ...payload })}\n\n`;
    for (const clientRes of Array.from(sseClients)) {
      try {
        clientRes.write(line);
      } catch {
        sseClients.delete(clientRes);
      }
    }
  }

  const sseKeepAlive = setInterval(() => {
    for (const clientRes of Array.from(sseClients)) {
      try {
        clientRes.write(": keepalive\n\n");
      } catch {
        sseClients.delete(clientRes);
      }
    }
  }, 18000);
  if (sseKeepAlive.unref) sseKeepAlive.unref();

  agentEngine.onTaskAlert = ({ title, summary, targetKey }) => {
    const st = loadState();
    const link = currentMobileLink(serverPortRef.port);
    broadcastLiveAlert({ kind: "cc", title, body: summary, targetKey: targetKey || "cc:latest" });
    notifyAgentAlert({ title, summary, targetKey: targetKey || "cc:latest" }, st.settings || {}, link).catch(() => {});
  };

  desktopMonitor.onDesktopAlert = async ({ title, summary, targetKey }) => {
    const st = loadState();
    const link = currentMobileLink(serverPortRef.port);
    const appLabel = String(title || "电脑软件").replace(/^🔔\s*|\s*新消息$/g, "");
    const butlerOut = await aiButler
      .runAiTriage(
        {
          sourceType: "desktop_app",
          platformName: appLabel,
          targetKey: targetKey || `app:${appLabel}`,
          snippet: summary || "",
          unreadCount: 1,
        },
        st.settings || {}
      )
      .catch(() => ({ enabled: false }));
    if (butlerOut?.enabled && butlerOut?.ok && butlerOut?.isSpam) {
      return; // AI Assistant filtered junk promo automatically!
    }
    const enrichedSummary = butlerOut?.suggestion?.summary
      ? `🧠 AI助理：${butlerOut.suggestion.summary}`
      : summary;
    broadcastLiveAlert({ kind: "app", title, body: enrichedSummary, targetKey: targetKey || "" });
    notifyAgentAlert({ title, summary: enrichedSummary, targetKey: targetKey || "" }, st.settings || {}, link).catch(
      () => {}
    );
  };

  aiInbox.onAiAlert = ({ title, summary, targetKey }) => {
    const st = loadState();
    const link = currentMobileLink(serverPortRef.port);
    broadcastLiveAlert({ kind: "ai", title, body: summary, targetKey: targetKey || "" });
    notifyAgentAlert({ title, summary, targetKey: targetKey || "" }, st.settings || {}, link).catch(() => {});
  };
  desktopMonitor.startBackgroundWatcher();

  // Configure Permanent Edge Bookmark Box + Anti-Sleep Caffeinate Keeper
  tunnelManager.configureBoxCredentials(getTunnelBoxCredentials());
  let caffeinateProc = null;
  function syncPreventSleepState(wantPreventSleep) {
    if (process.env.TABPULSE_DISABLE_EXTERNAL_EFFECTS === "1" || process.platform !== "darwin") return;
    if (wantPreventSleep && !caffeinateProc) {
      if (fs.existsSync("/usr/bin/caffeinate")) {
        import("node:child_process").then(({ spawn }) => {
          if (caffeinateProc) return;
          caffeinateProc = spawn("/usr/bin/caffeinate", ["-di", "-w", String(process.pid)], { stdio: "ignore" });
          caffeinateProc.on("exit", () => {
            caffeinateProc = null;
          });
          if (caffeinateProc.unref) caffeinateProc.unref();
        });
      }
    } else if (!wantPreventSleep && caffeinateProc) {
      try {
        caffeinateProc.kill("SIGTERM");
      } catch {}
      caffeinateProc = null;
    }
  }

  tunnelManager.onTunnelReconnected = () => {
    const st = loadState();
    const link = currentMobileLink(serverPortRef.port);
    if (st.settings?.webhookUrl) {
      sendCustomerWebhook(
        st.settings.webhookUrl,
        "🔄 消息总管出门穿透已自动重连",
        "家里电脑网络已恢复在线，您手机保存的固定书签可继续正常收发消息。",
        link
      ).catch(() => {});
    }
  };

  if (process.env.TABPULSE_DISABLE_EXTERNAL_EFFECTS !== "1") {
    const bootState = loadState();
    syncPreventSleepState(Boolean(bootState.settings?.preventSleep));
    if (bootState.settings?.tunnelAutoStart) {
      setTimeout(() => {
        tunnelManager.configureBoxCredentials(getTunnelBoxCredentials());
        tunnelManager.start(serverPortRef.port).catch(() => {});
      }, 1200).unref?.();
    }
  }

  const handleRequest = async (req, res) => {
    const secFetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
    const origin = req.headers.origin;
    if (secFetchSite === "cross-site" && !String(origin || "").startsWith("chrome-extension://")) {
      sendJson(res, 403, { ok: false, error: "cross-site request blocked" }, "");
      return;
    }

    const localTrusted = isLocalDesktopTrusted(req);
    const corsOrigin = localTrusted
      ? isAllowedDesktopOrigin(origin)
        ? origin
        : ""
      : isSameHostOrigin(origin, req)
        ? origin || ""
        : "";

    if (req.method === "OPTIONS") {
      if (origin && !corsOrigin) {
        sendJson(res, 403, { error: "origin not allowed" }, "");
        return;
      }
      res.writeHead(204, {
        ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-TabPulse-Token",
      });
      res.end();
      return;
    }

    if (origin && !corsOrigin) {
      sendJson(res, 403, { error: "origin not allowed" }, "");
      return;
    }

    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = reqUrl.pathname;

    try {
      // Public lightweight endpoints
      if (req.method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, { ok: true, version: "5.7.0", desktopBridge: desktopRelay.isDesktopConnected() }, corsOrigin);
        return;
      }
      if (req.method === "GET" && pathname === "/sw.js") {
        sendText(res, 200, "application/javascript; charset=utf-8", fs.readFileSync(SW_JS_PATH, "utf-8"), {
          "Service-Worker-Allowed": "/",
        });
        return;
      }
      if (req.method === "GET" && pathname === "/llms.txt") {
        sendText(res, 200, "text/plain; charset=utf-8", fs.readFileSync(LLMS_TXT_PATH, "utf-8"));
        return;
      }
      if (req.method === "GET" && pathname === "/mobile-icon.svg") {
        sendText(res, 200, "image/svg+xml; charset=utf-8", MOBILE_ICON_SVG);
        return;
      }
      if (req.method === "GET" && pathname === "/manifest.webmanifest") {
        sendJson(
          res,
          200,
          {
            name: "消息总管 · 手机随身版",
            short_name: "消息总管",
            start_url: "/m",
            display: "standalone",
            background_color: "#0f172a",
            theme_color: "#0f172a",
            icons: [{ src: "/mobile-icon.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" }],
          },
          corsOrigin
        );
        return;
      }

      // Enforce cryptographic pairing auth on ALL non-local requests!
      let authCookieHeader = {};
      if (!localTrusted) {
        const expectedTok = getMobileToken();
        const auth = checkMobileAuth(req, reqUrl, expectedTok);
        if (!auth.ok) {
          if (pathname === "/" || pathname === "/m") {
            const boxPrefix = String(req.headers["x-tabpulse-box-prefix"] || "");
            sendText(res, auth.locked ? 429 : 401, "text/html; charset=utf-8", renderPairGateHtml(auth.error, boxPrefix));
          } else {
            sendJson(res, auth.locked ? 429 : 401, { ok: false, error: auth.error }, corsOrigin);
          }
          return;
        }
        if (auth.fromQuery) {
          const isHttps = req.headers["x-forwarded-proto"] === "https" || Boolean(req.headers["cf-ray"]);
          authCookieHeader = {
            "Set-Cookie": `tp_mob_tok=${encodeURIComponent(expectedTok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${isHttps ? "; Secure" : ""}`,
          };
        }
      }

      // Serve Mobile Pocket App (/m) or redirect external / to /m
      if (req.method === "GET" && pathname === "/m") {
        const html = fs.readFileSync(MOBILE_HTML_PATH, "utf-8");
        sendText(res, 200, "text/html; charset=utf-8", html, authCookieHeader);
        return;
      }

      if (req.method === "GET" && pathname === "/") {
        if (!localTrusted) {
          const html = fs.readFileSync(MOBILE_HTML_PATH, "utf-8");
          sendText(res, 200, "text/html; charset=utf-8", html, authCookieHeader);
          return;
        }
        const html = fs.readFileSync(INDEX_HTML_PATH, "utf-8");
        sendText(res, 200, "text/html; charset=utf-8", html);
        return;
      }

      if (req.method === "GET" && pathname === "/bonus/cold-reply-playbook") {
        const html = fs.readFileSync(PLAYBOOK_HTML_PATH, "utf-8");
        sendText(res, 200, "text/html; charset=utf-8", html, authCookieHeader);
        return;
      }

      if (req.method === "GET" && pathname === "/api/events-stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
          ...authCookieHeader,
        });
        res.write(`data: ${JSON.stringify({ kind: "connected", ts: Date.now() })}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      // Desktop-only mobile pairing management routes (never exposed over tunnel)
      if (pathname === "/api/mobile/info" || pathname === "/api/mobile/tunnel") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "desktop only" }, corsOrigin);
          return;
        }
        if (req.method === "GET" && pathname === "/api/mobile/info") {
          tunnelManager.configureBoxCredentials(getTunnelBoxCredentials());
          const tok = getMobileToken();
          const st = loadState();
          const allowLanDirect = Boolean(st.settings?.allowLanDirect);
          sendJson(
            res,
            200,
            {
              ok: true,
              ...tunnelManager.getInfo(serverPortRef.port, tok, { allowLanDirect }),
              preventSleep: Boolean(st.settings?.preventSleep),
              tunnelAutoStart: Boolean(st.settings?.tunnelAutoStart),
              desktopBridgeConnected: desktopRelay.isDesktopConnected(),
            },
            corsOrigin
          );
          return;
        }
        if (req.method === "POST" && pathname === "/api/mobile/tunnel") {
          const body = await readJsonBody(req);
          tunnelManager.configureBoxCredentials(getTunnelBoxCredentials());
          if (body.action === "start") {
            updateSettings({ tunnelAutoStart: true, preventSleep: true });
            syncPreventSleepState(true);
            await tunnelManager.start(serverPortRef.port);
          } else if (body.action === "stop") {
            updateSettings({ tunnelAutoStart: false });
            tunnelManager.stop();
          } else if (body.action === "rotateToken") {
            rotateMobileToken();
          } else if (body.action === "toggleLan") {
            const nextLan = Boolean(body.allowLanDirect);
            updateSettings({ allowLanDirect: nextLan });
            syncLanBridgeServer(nextLan);
          } else if (body.action === "emergencyLock") {
            updateSettings({ tunnelAutoStart: false, allowLanDirect: false });
            tunnelManager.stop();
            syncLanBridgeServer(false);
            rotateMobileToken();
          }
          const tok = getMobileToken();
          const st = loadState();
          const allowLanDirect = Boolean(st.settings?.allowLanDirect);
          sendJson(
            res,
            200,
            {
              ok: true,
              ...tunnelManager.getInfo(serverPortRef.port, tok, { allowLanDirect }),
              preventSleep: Boolean(st.settings?.preventSleep),
              tunnelAutoStart: Boolean(st.settings?.tunnelAutoStart),
              desktopBridgeConnected: desktopRelay.isDesktopConnected(),
            },
            corsOrigin
          );
          return;
        }
      }

      // Desktop Native WebKit Bridge routes (local loopback only)
      if (pathname === "/api/bridge/poll" && req.method === "GET") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false }, "");
          return;
        }
        sendJson(
          res,
          200,
          {
            ok: true,
            commands: desktopRelay.pollNextCommands(),
            notices: desktopRelay.drainNativeNotices(),
          },
          corsOrigin
        );
        return;
      }
      if (pathname === "/api/bridge/result" && req.method === "POST") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false }, "");
          return;
        }
        const body = await readJsonBody(req);
        sendJson(res, 200, desktopRelay.submitCommandResult(body.taskId, body), corsOrigin);
        return;
      }

      // AI Personal Butler (Instant Event-to-AI Triage & Auto-Drafting) routes
      if (pathname === "/api/ai-butler/state" && req.method === "GET") {
        const since = Number(reqUrl.searchParams.get("since") || 0);
        const st = loadState();
        sendJson(
          res,
          200,
          {
            ...aiButler.getEventsSince(since),
            enabled: Boolean(st.settings?.aiButlerEnabled),
            provider: st.settings?.aiButlerProvider || "codex",
            providers: localTrusted ? aiButler.detectAvailableProviders() : [],
          },
          corsOrigin,
          authCookieHeader
        );
        return;
      }
      if (pathname === "/api/ai-butler/simulate" && req.method === "POST") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "desktop only" }, corsOrigin);
          return;
        }
        const body = await readJsonBody(req);
        const st = loadState();
        const firstWatch = st.watches[0] || { id: "demo", name: "闲鱼买家咨询" };
        const out = await aiButler.runAiTriage(
          {
            sourceType: "web",
            platformName: body.platformName || firstWatch.name,
            targetKey: body.targetKey || `web:${firstWatch.id}`,
            snippet: body.snippet || "你好老板，请问这个软件苹果Mac和Windows电脑都能用吗？拍下多久发货？",
            contextSummary: firstWatch.contextSummary || "",
            unreadCount: 1,
          },
          { ...st.settings, aiButlerEnabled: true, aiButlerProvider: body.provider || st.settings?.aiButlerProvider || "rule_fast" }
        );
        sendJson(res, 200, { ok: true, ...out }, corsOrigin);
        return;
      }

      // AI-First Plug-and-Play Inbox & 1-Tap Mobile Approval (MCP + Webhook) routes
      if (pathname === "/api/ai-inbox/state" && req.method === "GET") {
        sendJson(res, 200, { ok: true, channels: aiInbox.listChannels() }, corsOrigin, authCookieHeader);
        return;
      }
      if (pathname === "/api/ai-inbox/push" && req.method === "POST") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "local AI only" }, corsOrigin);
          return;
        }
        const body = await readJsonBody(req);
        const out = aiInbox.pushNotification(body);
        sendJson(res, 200, out, corsOrigin);
        return;
      }
      if (pathname === "/api/ai-inbox/ask" && req.method === "POST") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "local AI only" }, corsOrigin);
          return;
        }
        const body = await readJsonBody(req);
        const out = await aiInbox.askHumanAndWait(body);
        sendJson(res, 200, out, corsOrigin);
        return;
      }
      if (pathname === "/api/ai-inbox/reply" && req.method === "POST") {
        const body = await readJsonBody(req);
        const out = aiInbox.submitHumanReply(body);
        sendJson(res, out.ok ? 200 : 400, out, corsOrigin);
        return;
      }
      if (pathname === "/api/ai-inbox/pull" && req.method === "POST") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "local AI only" }, corsOrigin);
          return;
        }
        const body = await readJsonBody(req);
        sendJson(res, 200, aiInbox.pullPendingRepliesForAi(body), corsOrigin);
        return;
      }
      if (pathname === "/api/ai-inbox/clear-unread" && req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, 200, aiInbox.clearChannelUnread(body.channelId || ""), corsOrigin);
        return;
      }

      // Desktop 1-Click Local AI Client Auto-Installer routes
      if (pathname === "/api/ai-clients/status" && req.method === "GET") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "desktop only" }, corsOrigin);
          return;
        }
        sendJson(res, 200, listAiClientsStatus({ localPort: serverPortRef.port }), corsOrigin);
        return;
      }
      if (pathname === "/api/ai-clients/install" && req.method === "POST") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "desktop only" }, corsOrigin);
          return;
        }
        const body = await readJsonBody(req);
        if (body.clientId === "all") {
          const st = listAiClientsStatus({ localPort: serverPortRef.port });
          const results = [];
          for (const c of st.clients) {
            if (c.detected) results.push(installAiClient(c.id, { localPort: serverPortRef.port }));
          }
          sendJson(res, 200, { ok: true, results, ...listAiClientsStatus({ localPort: serverPortRef.port }) }, corsOrigin);
          return;
        }
        const resInst = installAiClient(body.clientId || "", { localPort: serverPortRef.port });
        sendJson(
          res,
          resInst.ok ? 200 : 400,
          { ...resInst, ...listAiClientsStatus({ localPort: serverPortRef.port }) },
          corsOrigin
        );
        return;
      }

      // Claude Code (CC) & Local AI Remote Session routes
      if (pathname === "/api/cc/hook" && req.method === "POST") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false }, "");
          return;
        }
        const evName = reqUrl.searchParams.get("event") || "Stop";
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {}
        const entry = agentEngine.recordHookEvent(evName, body);
        sendJson(res, 200, { ok: true, entry }, corsOrigin);
        return;
      }
      if (pathname === "/api/cc/install-hooks" && req.method === "POST") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "desktop only" }, corsOrigin);
          return;
        }
        sendJson(res, 200, agentEngine.installClaudeHooks(serverPortRef.port), corsOrigin);
        return;
      }
      if (pathname === "/api/cc/state" && req.method === "GET") {
        sendJson(res, 200, { ok: true, ...agentEngine.listState(serverPortRef.port) }, corsOrigin, authCookieHeader);
        return;
      }
      if (pathname === "/api/cc/sessions" && req.method === "POST") {
        if (!localTrusted && !loadState().settings?.allowRemoteAiCli) {
          sendJson(res, 403, { ok: false, error: "出于安全保护，默认禁止手机外网新建本机终端会话（如需使用请在电脑端开启授权）" }, corsOrigin);
          return;
        }
        const body = await readJsonBody(req);
        const session = agentEngine.createSession(body);
        sendJson(res, 201, { ok: true, session }, corsOrigin);
        return;
      }
      const ccSendMatch = pathname.match(/^\/api\/cc\/sessions\/([^/]+)\/send$/);
      if (ccSendMatch && req.method === "POST") {
        if (!localTrusted && !loadState().settings?.allowRemoteAiCli) {
          sendJson(res, 403, { ok: false, error: "出于安全保护，默认禁止手机外网执行本机终端命令" }, corsOrigin);
          return;
        }
        const sid = decodeURIComponent(ccSendMatch[1]);
        const body = await readJsonBody(req);
        const session = agentEngine.sendPrompt(sid, body.prompt || "");
        sendJson(res, 200, { ok: true, session }, corsOrigin);
        return;
      }
      const ccStopMatch = pathname.match(/^\/api\/cc\/sessions\/([^/]+)\/stop$/);
      if (ccStopMatch && req.method === "POST") {
        if (!localTrusted && !loadState().settings?.allowRemoteAiCli) {
          sendJson(res, 403, { ok: false, error: "remote cli disabled" }, corsOrigin);
          return;
        }
        const sid = decodeURIComponent(ccStopMatch[1]);
        sendJson(res, 200, agentEngine.stopSession(sid), corsOrigin);
        return;
      }

      if (pathname === "/api/open-extension-dir" && req.method === "POST") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "desktop only" }, corsOrigin);
          return;
        }
        const extDir = path.join(PROJECT_ROOT, "extension");
        const { execFile } = await import("node:child_process");
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
        execFile(opener, [extDir], () => {});
        sendJson(res, 200, { ok: true, path: extDir }, corsOrigin);
        return;
      }

      // Mobile Web Push (VAPID) routes
      if (pathname === "/api/push/vapid-public-key" && req.method === "GET") {
        sendJson(res, 200, { ok: true, publicKey: getVapidPublicKey() }, corsOrigin, authCookieHeader);
        return;
      }
      if (pathname === "/api/push/subscribe" && req.method === "POST") {
        const body = await readJsonBody(req);
        const out = savePushSubscription(body.subscription || body);
        sendJson(res, out.ok ? 200 : 400, out, corsOrigin);
        return;
      }
      if (pathname === "/api/push/test" && req.method === "POST") {
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {}
        const st = loadState();
        const link = currentMobileLink(serverPortRef.port);
        const title = "🔔 消息总管通知全链路测试";
        const summary = "提醒已打通！电脑弹窗与手机消息推送均正常，点进红点就能直接看消息并回复。";
        desktopRelay.pushNativeNotice({ title, body: summary, targetKey: "" });
        const pushOut = await broadcastMobileWebPush({ title, body: summary, targetKey: "" });
        const explicitTarget = typeof body.webhookUrl === "string" ? body.webhookUrl.trim() : "";
        const targetToUse = explicitTarget || st.settings?.webhookUrl || "";
        let webhookOut = null;
        if (targetToUse) {
          webhookOut = await sendCustomerWebhook(targetToUse, title, summary, link);
        }
        let emailOut = null;
        const emailCfg = body.emailPush || st.settings?.emailPush;
        if (emailCfg && emailCfg.enabled && emailCfg.user && emailCfg.pass) {
          emailOut = await sendEmailPushNotification(
            emailCfg,
            title,
            link ? `${summary}\n\n📱 手机随身收件箱直达：${link}` : summary
          );
        }
        if (explicitTarget) {
          sendJson(
            res,
            200,
            {
              ok: Boolean(webhookOut?.ok),
              channel: webhookOut?.channel || "",
              error: webhookOut?.error || "",
              desktopNoticeQueued: desktopRelay.isDesktopConnected(),
              webPush: pushOut,
              webhook: webhookOut,
              email: emailOut,
            },
            corsOrigin
          );
          return;
        }
        sendJson(
          res,
          200,
          {
            ok: true,
            channel: webhookOut?.channel || (emailOut?.ok ? "Email" : pushOut?.sent > 0 ? "WebPush" : "Local"),
            desktopNoticeQueued: desktopRelay.isDesktopConnected(),
            webPush: pushOut,
            webhook: webhookOut,
            email: emailOut,
          },
          corsOrigin
        );
        return;
      }

      // Native Desktop Software Monitor & Pure-Text Message Sync routes
      if (pathname === "/api/desktop/state" && req.method === "GET") {
        const dst = await desktopMonitor.getDesktopState();
        sendJson(res, 200, dst, corsOrigin, authCookieHeader);
        return;
      }
      if (pathname === "/api/desktop/launch" && req.method === "POST") {
        const body = await readJsonBody(req);
        const out = await desktopMonitor.launchApp(body.path || "");
        sendJson(res, 200, out, corsOrigin);
        return;
      }
      if (pathname === "/api/desktop/clear-unread" && req.method === "POST") {
        const body = await readJsonBody(req);
        const out = desktopMonitor.clearAppUnread(body.appName || "");
        sendJson(res, 200, out, corsOrigin);
        return;
      }
      const deskMsgMatch = pathname.match(/^\/api\/desktop\/window\/(\d+)\/(?:messages|capture)$/);
      if (deskMsgMatch && req.method === "GET") {
        const appNameParam = reqUrl.searchParams.get("app") || "";
        const out = await desktopMonitor.readWindowMessages(deskMsgMatch[1], appNameParam);
        sendJson(res, 200, out, corsOrigin);
        return;
      }
      const deskPeekMatch = pathname.match(/^\/api\/desktop\/window\/(\d+)\/peek-image$/);
      if (deskPeekMatch && req.method === "GET") {
        const appNameParam = reqUrl.searchParams.get("app") || "";
        const out = await desktopMonitor.peekWindowImage(deskPeekMatch[1], appNameParam);
        sendJson(res, 200, out, corsOrigin);
        return;
      }

      const tabPeekMatch = pathname.match(/^\/api\/remote\/tab\/([^/]+)\/peek-image$/);
      if (tabPeekMatch && req.method === "GET") {
        const wid = decodeURIComponent(tabPeekMatch[1]);
        const watch = loadState().watches.find((w) => w.id === wid);
        if (!watch) {
          sendJson(res, 404, { ok: false, error: "watch not found" }, corsOrigin);
          return;
        }
        const out = await desktopRelay.enqueueCommand(
          {
            type: "peekImage",
            watchId: wid,
            url: watch.url,
            name: watch.name,
            profileUuid: watch.profileUuid || "",
          },
          10000
        );
        sendJson(res, 200, out, corsOrigin);
        return;
      }

      const deskActMatch = pathname.match(/^\/api\/desktop\/window\/(\d+)\/action$/);
      if (deskActMatch && req.method === "POST") {
        const body = await readJsonBody(req);
        const out = await desktopMonitor.performWindowAction(deskActMatch[1], body);
        sendJson(res, 200, out, corsOrigin);
        return;
      }

      // Remote Tab Live Snapshot, Mobile Direct Login, Unbind & Fixed-IP Reply Injection routes
      const loginStateMatch = pathname.match(/^\/api\/remote\/tab\/([^/]+)\/login-state$/);
      if (loginStateMatch && req.method === "GET") {
        const wid = decodeURIComponent(loginStateMatch[1]);
        const watch = loadState().watches.find((w) => w.id === wid);
        if (!watch) {
          sendJson(res, 404, { ok: false, error: "watch not found" }, corsOrigin);
          return;
        }
        const out = await desktopRelay.enqueueCommand(
          {
            type: "loginState",
            watchId: wid,
            url: watch.url,
            name: watch.name,
            profileUuid: watch.profileUuid || "",
          },
          12000
        );
        sendJson(res, 200, out, corsOrigin);
        return;
      }

      const tabUnbindMatch = pathname.match(/^\/api\/remote\/tab\/([^/]+)\/unbind$/);
      if (tabUnbindMatch && req.method === "POST") {
        const wid = decodeURIComponent(tabUnbindMatch[1]);
        const watch = loadState().watches.find((w) => w.id === wid);
        if (!watch) {
          sendJson(res, 404, { ok: false, error: "watch not found" }, corsOrigin);
          return;
        }
        const relayOut = await desktopRelay.enqueueCommand(
          {
            type: "unbind",
            watchId: wid,
            url: watch.url,
            name: watch.name,
            profileUuid: watch.profileUuid || "",
          },
          8000
        );
        const updated = unbindWatch(wid);
        sendJson(res, 200, { ok: true, watch: updated, relay: relayOut }, corsOrigin);
        return;
      }

      const snapMatch = pathname.match(/^\/api\/remote\/tab\/([^/]+)\/snapshot$/);
      if (snapMatch && req.method === "GET") {
        const wid = decodeURIComponent(snapMatch[1]);
        const watch = loadState().watches.find((w) => w.id === wid);
        if (!watch) {
          sendJson(res, 404, { ok: false, error: "watch not found" }, corsOrigin);
          return;
        }
        const out = await desktopRelay.enqueueCommand({
          type: "snapshot",
          watchId: wid,
          url: watch.url,
          name: watch.name,
          profileUuid: watch.profileUuid || "",
        });
        sendJson(res, 200, out, corsOrigin);
        return;
      }

      const actMatch = pathname.match(/^\/api\/remote\/tab\/([^/]+)\/action$/);
      if (actMatch && req.method === "POST") {
        const wid = decodeURIComponent(actMatch[1]);
        const watch = loadState().watches.find((w) => w.id === wid);
        if (!watch) {
          sendJson(res, 404, { ok: false, error: "watch not found" }, corsOrigin);
          return;
        }
        const body = await readJsonBody(req);
        const out = await desktopRelay.enqueueCommand(
          {
            type: body.type || "reply",
            watchId: wid,
            url: watch.url,
            name: watch.name,
            profileUuid: watch.profileUuid || "",
            text: body.text || "",
            autoSubmit: body.autoSubmit !== false,
            xRatio: Number(body.xRatio) || 0.5,
            yRatio: Number(body.yRatio) || 0.5,
            dy: Number(body.dy) || 0,
            fields: Array.isArray(body.fields) ? body.fields : undefined,
            clickButtonText: body.clickButtonText || "",
            fieldIdx: body.fieldIdx !== undefined ? Number(body.fieldIdx) : undefined,
          },
          12000
        );
        sendJson(res, 200, out, corsOrigin);
        return;
      }

      if (req.method === "GET" && pathname === "/api/catalog") {
        sendJson(
          res,
          200,
          {
            ok: true,
            categories: PLATFORM_CATALOG_CATEGORIES,
            platforms: PLATFORM_CATALOG,
          },
          corsOrigin,
          authCookieHeader
        );
        return;
      }

      // Single-request mobile polling bundle (5x fewer Cloudflare Worker requests & faster phone sync!)
      if (req.method === "GET" && pathname === "/api/mobile/bundle") {
        const sum = getPublicSummary();
        if (!localTrusted && sum.settings) {
          sum.settings = {
            ...sum.settings,
            webhookConfigured: Boolean(sum.settings.webhookUrl),
            emailConfigured: Boolean(sum.settings.emailPush?.enabled && sum.settings.emailPush?.user),
            webhookUrl: sum.settings.webhookUrl ? "••••••••" : "",
            emailPush: sum.settings.emailPush
              ? { ...sum.settings.emailPush, pass: sum.settings.emailPush.pass ? "••••••••" : "" }
              : { enabled: false },
            aiButlerApiKey: sum.settings.aiButlerApiKey ? "••••••••" : "",
            aiButlerWebhookUrl: sum.settings.aiButlerWebhookUrl ? "••••••••" : "",
          };
        }
        const desktop = await desktopMonitor.getDesktopState().catch(() => ({ windows: [], badges: [], recentAlerts: [], installedApps: [] }));
        const st = loadState();
        sendJson(
          res,
          200,
          {
            ok: true,
            state: { ...sum, desktopBridgeConnected: desktopRelay.isDesktopConnected() },
            desktop,
            cc: { ok: true, ...agentEngine.listState(serverPortRef.port) },
            aiInbox: { ok: true, channels: aiInbox.listChannels() },
            aiButler: {
              ...aiButler.getEventsSince(0),
              enabled: Boolean(st.settings?.aiButlerEnabled),
              provider: st.settings?.aiButlerProvider || "codex",
            },
          },
          corsOrigin,
          authCookieHeader
        );
        return;
      }

      if (req.method === "POST" && pathname === "/api/quick-replies") {
        const body = await readJsonBody(req);
        const quickReplies = saveQuickReplies(body.quickReplies || []);
        sendJson(res, 200, { ok: true, quickReplies }, corsOrigin);
        return;
      }

      if (req.method === "GET" && pathname === "/api/state") {
        const sum = getPublicSummary();
        // Mask raw secrets on mobile view for privacy while showing whether push is active
        if (!localTrusted && sum.settings) {
          sum.settings = {
            ...sum.settings,
            webhookConfigured: Boolean(sum.settings.webhookUrl),
            emailConfigured: Boolean(sum.settings.emailPush?.enabled && sum.settings.emailPush?.user),
            webhookUrl: sum.settings.webhookUrl ? "••••••••" : "",
            emailPush: sum.settings.emailPush
              ? { ...sum.settings.emailPush, pass: sum.settings.emailPush.pass ? "••••••••" : "" }
              : { enabled: false },
            aiButlerApiKey: sum.settings.aiButlerApiKey ? "••••••••" : "",
            aiButlerWebhookUrl: sum.settings.aiButlerWebhookUrl ? "••••••••" : "",
          };
        }
        sendJson(
          res,
          200,
          { ...sum, desktopBridgeConnected: desktopRelay.isDesktopConnected() },
          corsOrigin,
          authCookieHeader
        );
        return;
      }

      if (req.method === "GET" && pathname === "/api/presets") {
        sendJson(res, 200, { ok: true, packs: PRESET_PACKS }, corsOrigin);
        return;
      }

      if (req.method === "GET" && pathname === "/api/scan-leads") {
        const q = reqUrl.searchParams.get("q") || "Shopify";
        const limit = Math.min(20, Math.max(1, Number(reqUrl.searchParams.get("limit")) || 12));
        const scanResult = await scanBuyerLeads(q, { limit });
        sendJson(res, 200, scanResult, corsOrigin);
        return;
      }

      if (req.method === "POST" && pathname === "/api/license/activate") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "desktop only" }, corsOrigin);
          return;
        }
        const body = await readJsonBody(req);
        const out = activateLicenseKey(body.key || "");
        sendJson(res, out.ok ? 200 : 400, out, corsOrigin);
        return;
      }

      if (req.method === "POST" && pathname === "/api/settings") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "desktop only" }, corsOrigin);
          return;
        }
        const body = await readJsonBody(req);
        const settings = updateSettings(body);
        if (body.preventSleep !== undefined) {
          syncPreventSleepState(Boolean(settings.preventSleep));
        }
        if (body.allowLanDirect !== undefined) {
          syncLanBridgeServer(Boolean(settings.allowLanDirect));
        }
        sendJson(res, 200, { ok: true, settings }, corsOrigin);
        return;
      }

      if (req.method === "GET" && pathname === "/api/due") {
        const force = reqUrl.searchParams.get("force") === "1";
        const targetId = reqUrl.searchParams.get("id") || "";
        sendJson(res, 200, getDueWatches(new Date(), { force, targetId }), corsOrigin);
        return;
      }

      if (req.method === "POST" && pathname === "/api/watches") {
        const body = await readJsonBody(req);
        const result = upsertWatch(body);
        sendJson(res, result.created ? 201 : 200, { ok: true, ...result }, corsOrigin);
        return;
      }

      if (req.method === "POST" && pathname === "/api/report") {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false }, "");
          return;
        }
        const body = await readJsonBody(req);
        if (!body.id) {
          sendJson(res, 400, { ok: false, error: "id is required" }, corsOrigin);
          return;
        }
        const recorded = recordProbeReport(body.id, body);
        if (!recorded) {
          sendJson(res, 404, { ok: false, error: "watch not found" }, corsOrigin);
          return;
        }

        let alertResult = null;
        let butlerOut = null;
        if (recorded.shouldAlertUnread) {
          butlerOut = await aiButler
            .runAiTriage(
              {
                sourceType: "web",
                platformName: recorded.item.name,
                targetKey: `web:${recorded.item.id}`,
                snippet: recorded.item.snippet || "",
                contextSummary: recorded.item.contextSummary || "",
                unreadCount: recorded.item.unreadCount,
              },
              recorded.settings || {}
            )
            .catch(() => null);
          if (butlerOut?.suggestion?.suggestedReplies?.[0]) {
            saveReplyDraft(recorded.item.id, butlerOut.suggestion.suggestedReplies[0]);
          }
        }

        if (!body.skipExternal) {
          const mobLink = currentMobileLink(serverPortRef.port);
          if (recorded.shouldAlertUnread) {
            if (!(butlerOut?.enabled && butlerOut?.ok && butlerOut?.isSpam)) {
              broadcastLiveAlert({
                kind: "web",
                title: `🔴 ${recorded.item.name} (${recorded.item.unreadCount}条未读)`,
                body: butlerOut?.suggestion?.summary || recorded.item.snippet || "收到新未读消息",
                targetKey: `web:${recorded.item.id}`,
              });
              alertResult = await notifyUnread(recorded.item, recorded.settings, mobLink);
            } else {
              alertResult = { skippedByAiButlerSpamFilter: true };
            }
          } else if (recorded.shouldAlertAuth) {
            alertResult = await notifyAuthExpired(recorded.item, recorded.settings, mobLink);
          }
        }
        sendJson(res, 200, { ok: true, ...recorded, alertResult, aiButler: butlerOut }, corsOrigin);
        return;
      }

      const draftMatch = pathname.match(/^\/api\/watches\/([^/]+)\/draft$/);
      if (req.method === "POST" && draftMatch) {
        const id = decodeURIComponent(draftMatch[1]);
        const body = await readJsonBody(req);
        const watch = saveReplyDraft(id, body.draft ?? body.lastDraft ?? "");
        if (!watch) {
          sendJson(res, 404, { ok: false, error: "watch not found" }, corsOrigin);
          return;
        }
        sendJson(res, 200, { ok: true, watch }, corsOrigin);
        return;
      }

      const resolveMatch = pathname.match(/^\/api\/watches\/([^/]+)\/resolve$/);
      if (req.method === "POST" && resolveMatch) {
        const id = decodeURIComponent(resolveMatch[1]);
        const body = await readJsonBody(req);
        const watch = resolveWatch(id, body.action || "resolve");
        if (!watch) {
          sendJson(res, 404, { ok: false, error: "watch not found" }, corsOrigin);
          return;
        }
        sendJson(res, 200, { ok: true, watch }, corsOrigin);
        return;
      }

      const unbindMatch = pathname.match(/^\/api\/watches\/([^/]+)\/unbind$/);
      if (req.method === "POST" && unbindMatch) {
        const id = decodeURIComponent(unbindMatch[1]);
        const watch = loadState().watches.find((w) => w.id === id);
        if (!watch) {
          sendJson(res, 404, { ok: false, error: "watch not found" }, corsOrigin);
          return;
        }
        if (desktopRelay.isDesktopConnected()) {
          await desktopRelay
            .enqueueCommand(
              {
                type: "unbind",
                watchId: id,
                url: watch.url,
                name: watch.name,
                profileUuid: watch.profileUuid || "",
              },
              6000
            )
            .catch(() => null);
        }
        const updated = unbindWatch(id);
        sendJson(res, 200, { ok: true, watch: updated }, corsOrigin);
        return;
      }

      const deleteMatch = pathname.match(/^\/api\/watches\/([^/]+)$/);
      if (req.method === "DELETE" && deleteMatch) {
        const id = decodeURIComponent(deleteMatch[1]);
        const existing = loadState().watches.find((w) => w.id === id);
        if (existing && desktopRelay.isDesktopConnected()) {
          await desktopRelay
            .enqueueCommand(
              {
                type: "unbind",
                watchId: id,
                url: existing.url,
                name: existing.name,
                profileUuid: existing.profileUuid || "",
              },
              3500
            )
            .catch(() => null);
        }
        const deleted = deleteWatch(id);
        if (!deleted) {
          sendJson(res, 404, { ok: false, error: "watch not found" }, corsOrigin);
          return;
        }
        sendJson(res, 200, { ok: true, deleted: true }, corsOrigin);
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" }, corsOrigin);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message || "bad request" }, corsOrigin);
    }
  };

  const server = http.createServer(handleRequest);
  let lanBridgeServer = null;

  function syncLanBridgeServer(wantLan) {
    if (process.env.TABPULSE_DISABLE_EXTERNAL_EFFECTS === "1") return;
    if (!wantLan) {
      if (lanBridgeServer) {
        try { lanBridgeServer.close(); } catch {}
        lanBridgeServer = null;
      }
      return;
    }
    const lans = getLanAddresses();
    const lanIp = lans[0]?.ip;
    if (!lanIp || lanBridgeServer) return;
    try {
      const s = http.createServer(handleRequest);
      s.on("error", () => { lanBridgeServer = null; });
      s.listen(serverPortRef.port, lanIp);
      lanBridgeServer = s;
    } catch {
      lanBridgeServer = null;
    }
  }

  server.on("listening", () => {
    const addr = server.address();
    if (addr && typeof addr === "object" && addr.port) {
      serverPortRef.port = addr.port;
    }
    if (process.env.TABPULSE_DISABLE_EXTERNAL_EFFECTS !== "1") {
      const st = loadState();
      if (st.settings?.allowLanDirect) syncLanBridgeServer(true);
    }
  });

  server.on("close", () => {
    clearInterval(sseKeepAlive);
    if (lanBridgeServer) {
      try { lanBridgeServer.close(); } catch {}
      lanBridgeServer = null;
    }
    for (const c of sseClients) {
      try { c.end(); } catch {}
    }
    sseClients.clear();
  });

  return server;
}

function isDirectEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntrypoint()) {
  loadState();
  // Security-first default: bind 127.0.0.1 loopback ONLY (zero coffee-shop Wi-Fi LAN exposure!)
  const host = process.env.TABPULSE_HOST || "127.0.0.1";
  const port = Number(process.env.TABPULSE_PORT || 17890);
  const server = createHubServer({ port });
  server.listen(port, host, () => {
    console.log(`TabPulse Hub v5.7.0 listening securely on http://${host}:${port}`);
  });
}
