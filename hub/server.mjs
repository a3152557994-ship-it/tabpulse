import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRESET_PACKS } from "../seed/preset-packs.mjs";
import { aiButler } from "./ai-butler.mjs";
import { aiInbox } from "./ai-inbox.mjs";
import { installAiClient, listAiClientsStatus } from "./ai-installer.mjs";
import { desktopMonitor } from "./desktop-monitor.mjs";
import {
  agentEngine,
  checkMobileAuth,
  desktopRelay,
  isLocalDesktopTrusted,
  tunnelManager,
} from "./mobile-bridge.mjs";
import { notifyAgentAlert, notifyAuthExpired, notifyUnread, sendCustomerWebhook } from "./notifier.mjs";
import { scanBuyerLeads } from "./scanner.mjs";
import {
  activateLicenseKey,
  broadcastMobileWebPush,
  deleteWatch,
  getDueWatches,
  getMobileToken,
  getPublicSummary,
  getVapidPublicKey,
  loadState,
  recordProbeReport,
  resolveWatch,
  rotateMobileToken,
  savePushSubscription,
  saveQuickReplies,
  saveReplyDraft,
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

function isAllowedDesktopOrigin(origin) {
  if (!origin) return false;
  if (origin === "null") return true;
  return (
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin) ||
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
  const info = tunnelManager.getInfo(localPort, tok);
  return info.primaryUrl;
}

function renderPairGateHtml(errorMsg = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/><title>消息总管 · 手机安全配对</title><style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#0f172a;color:#f8fafc;display:grid;place-items:center;min-height:100vh;padding:20px}form{background:#1e293b;border:1px solid #334155;border-radius:18px;padding:24px;width:100%;max-width:360px;box-sizing:border-box}h1{font-size:19px;margin:0 0 8px}p{font-size:13px;color:#94a3b8;line-height:1.5;margin:0 0 16px}input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #475569;background:#0f172a;color:#fff;font-size:14px;margin-bottom:12px}button{width:100%;padding:12px;border-radius:10px;border:none;background:#2563eb;color:#fff;font-weight:700;font-size:15px}</style></head><body><form method="GET" action="/m"><h1>🔒 消息总管 · 手机随身端</h1><p>请在电脑端打开《消息总管》点击顶部「📱 手机扫码遥控」直接扫码进入，或在下方粘贴配对密钥：</p>${errorMsg ? `<p style="color:#f87171">${errorMsg}</p>` : ""}<input name="t" placeholder="粘贴电脑端配对密钥..." required /><button type="submit">验证并进入手机工作台</button></form></body></html>`;
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

  const server = http.createServer(async (req, res) => {
    const localTrusted = isLocalDesktopTrusted(req);
    const origin = req.headers.origin;
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
        sendJson(res, 200, { ok: true, version: "5.3.0", desktopBridge: desktopRelay.isDesktopConnected() }, corsOrigin);
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
            sendText(res, auth.locked ? 429 : 401, "text/html; charset=utf-8", renderPairGateHtml(auth.error));
          } else {
            sendJson(res, auth.locked ? 429 : 401, { ok: false, error: auth.error }, corsOrigin);
          }
          return;
        }
        if (auth.fromQuery) {
          const isHttps = req.headers["x-forwarded-proto"] === "https" || Boolean(req.headers["cf-ray"]);
          authCookieHeader = {
            "Set-Cookie": `tp_mob_tok=${encodeURIComponent(expectedTok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${isHttps ? "; Secure" : ""}`,
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

      // Desktop-only management routes (never exposed over tunnel)
      if (pathname.startsWith("/api/mobile/")) {
        if (!localTrusted) {
          sendJson(res, 403, { ok: false, error: "desktop only" }, corsOrigin);
          return;
        }
        if (req.method === "GET" && pathname === "/api/mobile/info") {
          const tok = getMobileToken();
          sendJson(
            res,
            200,
            {
              ok: true,
              ...tunnelManager.getInfo(serverPortRef.port, tok),
              desktopBridgeConnected: desktopRelay.isDesktopConnected(),
            },
            corsOrigin
          );
          return;
        }
        if (req.method === "POST" && pathname === "/api/mobile/tunnel") {
          const body = await readJsonBody(req);
          if (body.action === "start") {
            await tunnelManager.start(serverPortRef.port);
          } else if (body.action === "stop") {
            tunnelManager.stop();
          } else if (body.action === "rotateToken") {
            rotateMobileToken();
          }
          const tok = getMobileToken();
          sendJson(
            res,
            200,
            {
              ok: true,
              ...tunnelManager.getInfo(serverPortRef.port, tok),
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
        sendJson(res, 200, { ok: true, commands: desktopRelay.pollNextCommands() }, corsOrigin);
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
        const body = await readJsonBody(req);
        const session = agentEngine.createSession(body);
        sendJson(res, 201, { ok: true, session }, corsOrigin);
        return;
      }
      const ccSendMatch = pathname.match(/^\/api\/cc\/sessions\/([^/]+)\/send$/);
      if (ccSendMatch && req.method === "POST") {
        const sid = decodeURIComponent(ccSendMatch[1]);
        const body = await readJsonBody(req);
        const session = agentEngine.sendPrompt(sid, body.prompt || "");
        sendJson(res, 200, { ok: true, session }, corsOrigin);
        return;
      }
      const ccStopMatch = pathname.match(/^\/api\/cc\/sessions\/([^/]+)\/stop$/);
      if (ccStopMatch && req.method === "POST") {
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
        const st = loadState();
        const link = currentMobileLink(serverPortRef.port);
        const title = "🔔 消息总管手机提醒测试";
        const summary = "提醒已打通！来消息时手机直接响铃，点进对应红点就能看消息并回复。";
        const pushOut = await broadcastMobileWebPush({ title, body: summary, targetKey: "" });
        let webhookOut = null;
        if (st.settings?.webhookUrl) {
          webhookOut = await sendCustomerWebhook(st.settings.webhookUrl, title, summary, link);
        }
        sendJson(res, 200, { ok: true, webPush: pushOut, webhook: webhookOut }, corsOrigin);
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
      const deskActMatch = pathname.match(/^\/api\/desktop\/window\/(\d+)\/action$/);
      if (deskActMatch && req.method === "POST") {
        const body = await readJsonBody(req);
        const out = await desktopMonitor.performWindowAction(deskActMatch[1], body);
        sendJson(res, 200, out, corsOrigin);
        return;
      }

      // Remote Tab Live Snapshot & Fixed-IP Reply Injection routes
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
          },
          10000
        );
        sendJson(res, 200, out, corsOrigin);
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
        // Mask raw webhook URL on mobile view for privacy while showing whether push is active
        if (!localTrusted && sum.settings) {
          sum.settings = {
            ...sum.settings,
            webhookConfigured: Boolean(sum.settings.webhookUrl),
            webhookUrl: sum.settings.webhookUrl ? "••••••••" : "",
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

      const deleteMatch = pathname.match(/^\/api\/watches\/([^/]+)$/);
      if (req.method === "DELETE" && deleteMatch) {
        const id = decodeURIComponent(deleteMatch[1]);
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
  });

  server.on("listening", () => {
    const addr = server.address();
    if (addr && typeof addr === "object" && addr.port) {
      serverPortRef.port = addr.port;
    }
  });

  server.on("close", () => {
    clearInterval(sseKeepAlive);
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
  const host = process.env.TABPULSE_HOST || "0.0.0.0";
  const port = Number(process.env.TABPULSE_PORT || 17890);
  const server = createHubServer({ port });
  server.listen(port, host, () => {
    console.log(`TabPulse Hub v5.3.0 listening on http://${host}:${port}`);
  });
}
