#!/usr/bin/env node
import readline from "node:readline";
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

async function callHubOrLocal(method, apiPath, body, localFallback) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
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
    if (err && (err.name === "AbortError" || err.cause?.code === "ECONNREFUSED" || /fetch failed/i.test(err.message))) {
      return localFallback();
    }
    throw err;
  }
}

const TOOLS = [
  {
    name: "tabpulse_register_watch",
    description:
      "Register a web platform page into TabPulse so the browser-independent desktop sentinel watches for future unread replies passively without polling loops or account-ban risk.",
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
    description: "List all watched platforms, unread alerts, auth-expired alerts, license tier, and summary counters.",
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
      "Save an AI-prepared reply draft onto a watched platform card so the user can copy it and open the native platform in one click.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Watch ID" },
        draft: { type: "string", description: "Prepared reply text for the user to review/copy" },
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
          capabilities: { tools: {} },
          serverInfo: { name: "tabpulse-mcp", version: "0.2.0" },
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
    process.stderr.write(`tabpulse-mcp error: ${err?.stack || err}\n`);
  });
});
