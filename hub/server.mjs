import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRESET_PACKS } from "../seed/preset-packs.mjs";
import { notifyAuthExpired, notifyUnread } from "./notifier.mjs";
import { scanBuyerLeads } from "./scanner.mjs";
import {
  activateLicenseKey,
  deleteWatch,
  getDueWatches,
  getPublicSummary,
  loadState,
  recordProbeReport,
  resolveWatch,
  saveReplyDraft,
  updateSettings,
  upsertWatch,
} from "./store.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const INDEX_HTML_PATH = path.join(__dirname, "ui", "index.html");
const LLMS_TXT_PATH = path.join(PROJECT_ROOT, "llms.txt");
const PLAYBOOK_HTML_PATH = path.join(PROJECT_ROOT, "docs", "cold-reply-playbook.html");

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === "null") return true; // Local native macOS WKWebView file:// origin
  return (
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin) ||
    /^chrome-extension:\/\/[a-p]{32}$/i.test(origin) ||
    /^chrome-extension:\/\/[a-z0-9-]+$/i.test(origin)
  );
}

function sendJson(res, statusCode, payload, corsOrigin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, contentType, body) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) {
      throw new Error("payload too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function createHubServer() {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const corsOrigin = isAllowedOrigin(origin) ? origin : "";

    if (req.method === "OPTIONS") {
      if (origin && !corsOrigin) {
        sendJson(res, 403, { error: "origin not allowed" }, "");
        return;
      }
      res.writeHead(204, {
        ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
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
      if (req.method === "GET" && pathname === "/") {
        const html = fs.readFileSync(INDEX_HTML_PATH, "utf-8");
        sendText(res, 200, "text/html; charset=utf-8", html);
        return;
      }

      if (req.method === "GET" && pathname === "/llms.txt") {
        const txt = fs.readFileSync(LLMS_TXT_PATH, "utf-8");
        sendText(res, 200, "text/plain; charset=utf-8", txt);
        return;
      }

      if (req.method === "GET" && pathname === "/bonus/cold-reply-playbook") {
        const html = fs.readFileSync(PLAYBOOK_HTML_PATH, "utf-8");
        sendText(res, 200, "text/html; charset=utf-8", html);
        return;
      }

      if (req.method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, { ok: true, version: "0.2.0" }, corsOrigin);
        return;
      }

      if (req.method === "GET" && pathname === "/api/state") {
        sendJson(res, 200, getPublicSummary(), corsOrigin);
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
        const body = await readJsonBody(req);
        const settings = updateSettings(body);
        sendJson(res, 200, { ok: true, settings }, corsOrigin);
        return;
      }

      if (req.method === "GET" && pathname === "/api/due") {
        sendJson(res, 200, getDueWatches(), corsOrigin);
        return;
      }

      if (req.method === "POST" && pathname === "/api/watches") {
        const body = await readJsonBody(req);
        const result = upsertWatch(body);
        sendJson(res, result.created ? 201 : 200, { ok: true, ...result }, corsOrigin);
        return;
      }

      if (req.method === "POST" && pathname === "/api/report") {
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
        if (!body.skipExternal) {
          if (recorded.shouldAlertUnread) {
            alertResult = await notifyUnread(recorded.item, recorded.settings);
          } else if (recorded.shouldAlertAuth) {
            alertResult = await notifyAuthExpired(recorded.item, recorded.settings);
          }
        }
        sendJson(res, 200, { ok: true, ...recorded, alertResult }, corsOrigin);
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
  const host = "127.0.0.1";
  const port = Number(process.env.TABPULSE_PORT || 17890);
  const server = createHubServer();
  server.listen(port, host, () => {
    console.log(`TabPulse Hub v0.2.0 listening on http://${host}:${port}`);
  });
}
