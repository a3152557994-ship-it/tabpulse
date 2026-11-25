#!/usr/bin/env node
import readline from "node:readline";
import { aiInbox } from "../hub/ai-inbox.mjs";
import { scanBuyerLeads } from "../hub/scanner.mjs";
import {
  getPublicSummary,
  resolveWatch,
  saveReplyDraft,
  upsertWatch,
} from "../hub/store.mjs";

const PROTOCOL_VERSION = "2024-11-05";

function getHubBaseUrl() {
  const port = Number(process.env.TABPULSE_PORT || 17890);
  return `http://127.0.0.1:${port}`;
}

async function callHubOrLocal(method, apiPath, body, localFallback, timeoutMs = 2500) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${getHubBaseUrl()}${apiPath}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (
      localFallback &&
      err &&
      (err.name === "AbortError" || err.cause?.code === "ECONNREFUSED" || /fetch failed/i.test(err.message))
    ) {
      return localFallback();
    }
    throw err;
  }
}

const TOOLS = [
  {
    name: "tabpulse_notify_phone",
    description:
      "Immediately push a notification alert and red unread badge to the user's phone inbox (消息总管 / ReplyRadar). Call this automatically whenever you finish a multi-step task, hit an error, or find a high-value result so the user gets notified on their phone without staring at the computer.",
    inputSchema: {
      type: "object",
      properties: {
        agentName: {
          type: "string",
          description: "Your AI name shown as the sender channel on the user's phone, e.g. 'Claude Code', 'Cursor', 'Antigravity', 'Codex'",
        },
        title: { type: "string", description: "Short headline of the alert" },
        message: { type: "string", description: "Pure-text summary shown when the user taps your red dot on their phone" },
        conversationId: {
          type: "string",
          description: "Optional conversation UUID so user replies on phone can wake up your session",
        },
      },
      required: ["title", "message"],
    },
  },
  {
    name: "tabpulse_ask_human",
    description:
      "Push a question with 1-tap choice buttons to the user's phone lock screen & red-dot inbox, and WAIT for the user's mobile tap or typed reply before continuing! Use whenever you need human approval, a decision between options, or confirmation to send a customer quote while the user may be away from their desk.",
    inputSchema: {
      type: "object",
      properties: {
        agentName: {
          type: "string",
          description: "Your AI name, e.g. 'Claude Code', 'Cursor', 'Antigravity'",
        },
        question: { type: "string", description: "Clear question for the human to decide on their phone" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "2 to 5 short 1-tap button choices shown on the phone, e.g. ['批准执行', '改用方案B', '先暂停']",
        },
        context: { type: "string", description: "Optional brief background context" },
        timeoutSeconds: {
          type: "number",
          description: "Max seconds to wait for the user's phone tap (default 240, max 600)",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "tabpulse_check_human_replies",
    description:
      "Check if the user has sent any new async instructions or replies to you from their phone's ReplyRadar inbox.",
    inputSchema: {
      type: "object",
      properties: {
        agentName: { type: "string", description: "Optional filter by AI channel name" },
      },
    },
  },
  {
    name: "tabpulse_read_channel_messages",
    description:
      "Read pure-text chat messages from any watched web platform (Xianyu, Xiaohongshu, Reddit, X, Eleduck) or running desktop app (WeChat, Qianniu, Feishu, Gemini) via local ReplyRadar.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Platform watch ID, platform name (e.g. '闲鱼', '小红书'), or desktop app name (e.g. '微信', 'Gemini')",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "tabpulse_register_watch",
    description:
      "Register a web platform page into ReplyRadar / 消息总管 so the desktop sentinel watches for future unread replies passively and pushes phone alerts automatically.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional stable ID slug" },
        name: { type: "string", description: "Human-friendly site or task title" },
        url: { type: "string", description: "Inbox/notification/home URL to inspect passively" },
        category: {
          type: "string",
          enum: ["主力阵地", "接单外包", "开发者商店", "长尾蹲守"],
        },
        publishTier: {
          type: "string",
          enum: ["red", "yellow", "green"],
          description: "red = human manual send only; yellow = semi-auto; green = automated dev portal",
        },
        conversationId: {
          type: "string",
          description: "Target conversation UUID to wake up via agentapi when an unread reply arrives",
        },
        contextSummary: {
          type: "string",
          description: "What the AI submitted or did here so future replies carry full business context",
        },
        baseIntervalMinutes: {
          type: "number",
          description: "Base adaptive interval in minutes (default 60; auto doubles after 7d idle)",
        },
      },
      required: ["name", "url"],
    },
  },
  {
    name: "tabpulse_list_watches",
    description: "List all watched web platforms, desktop app unread badges, AI inbox channels, and summary counters.",
    inputSchema: {
      type: "object",
      properties: {
        statusFilter: {
          type: "string",
          enum: ["all", "unread", "auth_expired", "idle", "paused"],
        },
      },
    },
  },
  {
    name: "tabpulse_save_reply_draft",
    description:
      "Save an AI-prepared reply draft onto a watched platform card so the user can review or send it in one tap on their phone.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Watch ID" },
        draft: { type: "string", description: "Prepared reply text for the user to review/send" },
      },
      required: ["id", "draft"],
    },
  },
  {
    name: "tabpulse_resolve_watch",
    description: "Resolve an unread badge, pause watching a platform, or resume after human re-login.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Watch ID" },
        action: { type: "string", enum: ["resolve", "pause", "resume"] },
      },
      required: ["id"],
    },
  },
  {
    name: "tabpulse_scan_buyer_leads",
    description:
      "Scan Reddit, Hacker News, and GitHub in real time for fresh freelance, contract, agency, or buyer-intent posts matching a skill keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Skill or product keyword, e.g. 'Shopify', 'Python scraper', 'iOS App', '小程序'",
        },
        limit: {
          type: "number",
          description: "Max leads to return (default 8, max 20)",
        },
      },
      required: ["query"],
    },
  },
];

async function executeTool(name, args = {}) {
  switch (name) {
    case "tabpulse_notify_phone": {
      return callHubOrLocal(
        "POST",
        "/api/ai-inbox/push",
        {
          agentName: args.agentName || "AI 助手",
          title: args.title || "新进展提醒",
          message: args.message || "",
          conversationId: args.conversationId || "",
        },
        () =>
          aiInbox.pushNotification({
            agentName: args.agentName || "AI 助手",
            title: args.title || "新进展提醒",
            message: args.message || "",
            conversationId: args.conversationId || "",
          })
      );
    }

    case "tabpulse_ask_human": {
      const timeoutSec = Math.max(5, Math.min(600, Number(args.timeoutSeconds) || 240));
      return callHubOrLocal(
        "POST",
        "/api/ai-inbox/ask",
        {
          agentName: args.agentName || "AI 助手",
          question: args.question || "",
          options: args.options || ["✅ 同意继续", "⏸️ 先暂停"],
          context: args.context || "",
          timeoutSeconds: timeoutSec,
        },
        null,
        (timeoutSec + 5) * 1000
      );
    }

    case "tabpulse_check_human_replies": {
      return callHubOrLocal(
        "POST",
        "/api/ai-inbox/pull",
        { agentName: args.agentName || "", consume: true },
        () => aiInbox.pullPendingRepliesForAi({ agentName: args.agentName || "", consume: true })
      );
    }

    case "tabpulse_read_channel_messages": {
      const q = String(args.target || "").trim().toLowerCase();
      const st = await callHubOrLocal("GET", "/api/state", undefined, () => getPublicSummary());
      const matchedWatch = (st.watches || []).find(
        (w) => w.id.toLowerCase() === q || String(w.name || "").toLowerCase().includes(q)
      );
      if (matchedWatch) {
        return callHubOrLocal(
          "GET",
          `/api/remote/tab/${encodeURIComponent(matchedWatch.id)}/snapshot`,
          undefined,
          () => ({ ok: true, watch: matchedWatch, messages: [{ text: matchedWatch.snippet || "", isMe: false }] }),
          9000
        );
      }
      const dst = await callHubOrLocal("GET", "/api/desktop/state", undefined, () => ({ windows: [] }), 6000);
      const matchedWin = (dst.windows || []).find((w) => String(w.appName || "").toLowerCase().includes(q));
      if (matchedWin) {
        return callHubOrLocal(
          "GET",
          `/api/desktop/window/${matchedWin.windowId}/messages`,
          undefined,
          () => ({ ok: true, window: matchedWin, messages: [] }),
          6000
        );
      }
      return { ok: false, error: `未找到匹配的平台或桌面软件窗口: ${args.target}` };
    }

    case "tabpulse_register_watch": {
      return callHubOrLocal("POST", "/api/watches", args, () => ({
        ok: true,
        ...upsertWatch(args),
      }));
    }

    case "tabpulse_list_watches": {
      const data = await callHubOrLocal("GET", "/api/state", undefined, () => getPublicSummary());
      const filter = args.statusFilter && args.statusFilter !== "all" ? args.statusFilter : null;
      if (!filter) return data;
      return {
        ...data,
        watches: (data.watches || []).filter((w) => w.status === filter),
      };
    }

    case "tabpulse_save_reply_draft": {
      if (!args.id) throw new Error("id is required");
      return callHubOrLocal(
        "POST",
        `/api/watches/${encodeURIComponent(args.id)}/draft`,
        { draft: args.draft ?? "" },
        () => {
          const watch = saveReplyDraft(args.id, args.draft ?? "");
          if (!watch) throw new Error("watch not found");
          return { ok: true, watch };
        }
      );
    }

    case "tabpulse_resolve_watch": {
      if (!args.id) throw new Error("id is required");
      const action = args.action || "resolve";
      return callHubOrLocal(
        "POST",
        `/api/watches/${encodeURIComponent(args.id)}/resolve`,
        { action },
        () => {
          const watch = resolveWatch(args.id, action);
          if (!watch) throw new Error("watch not found");
          return { ok: true, watch };
        }
      );
    }

    case "tabpulse_scan_buyer_leads": {
      const q = args.query || "Shopify";
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
      return scanBuyerLeads(q, { limit });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function writeResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function writeError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      if (!isNotification) {
        writeResponse(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: { subscribe: true, listChanged: false } },
          serverInfo: { name: "replyradar-mcp", version: "5.5.0" },
        });
      }
      return;
    }

    if (method === "resources/list") {
      if (!isNotification) {
        writeResponse(id, {
          resources: [
            {
              uri: "replyradar://events/live",
              name: "全平台实时新消息流 (网页 + 电脑软件)",
              description: "一旦任何监听网页或电脑软件收到新消息，此资源实时更新并推送 notifications/resources/updated",
              mimeType: "application/json",
            },
          ],
        });
      }
      return;
    }

    if (method === "resources/subscribe") {
      startLiveResourcePushLoop();
      if (!isNotification) writeResponse(id, {});
      return;
    }

    if (method === "resources/read") {
      const feed = await callHubOrLocal("GET", "/api/ai-butler/state?since=0", undefined, () => ({
        ok: true,
        events: [],
      }));
      if (!isNotification) {
        writeResponse(id, {
          contents: [
            {
              uri: params?.uri || "replyradar://events/live",
              mimeType: "application/json",
              text: JSON.stringify(feed, null, 2),
            },
          ],
        });
      }
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "ping") {
      if (!isNotification) writeResponse(id, {});
      return;
    }

    if (method === "tools/list") {
      if (!isNotification) writeResponse(id, { tools: TOOLS });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const data = await executeTool(toolName, toolArgs);
      if (!isNotification) {
        writeResponse(id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        });
      }
      return;
    }

    if (!isNotification) {
      writeError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (!isNotification) {
      if (method === "tools/call") {
        writeResponse(id, {
          isError: true,
          content: [{ type: "text", text: err.message || String(err) }],
        });
      } else {
        writeError(id, -32603, err.message || String(err));
      }
    }
  }
}

let livePushTimer = null;
let lastSeenEventSeq = 0;

function startLiveResourcePushLoop() {
  if (livePushTimer) return;
  livePushTimer = setInterval(async () => {
    try {
      const data = await callHubOrLocal("GET", `/api/ai-butler/state?since=${lastSeenEventSeq}`, undefined, null, 1500);
      if (data && Number(data.latestSeq) > lastSeenEventSeq) {
        lastSeenEventSeq = Number(data.latestSeq);
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/resources/updated",
            params: { uri: "replyradar://events/live" },
          }) + "\n"
        );
      }
    } catch {}
  }, 3000);
  if (livePushTimer.unref) livePushTimer.unref();
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }
  handleRequest(parsed).catch((err) => {
    process.stderr.write(`replyradar-mcp error: ${err?.stack || err}\n`);
  });
});
