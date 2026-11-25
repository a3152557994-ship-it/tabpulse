import { DurableObject } from "cloudflare:workers";

const ALLOWED_RELEASE_ASSETS = new Map([
  [
    "XiaoXiZongGuan-CN-macOS.dmg",
    "https://github.com/a3152557994-ship-it/tabpulse/releases/latest/download/XiaoXiZongGuan-CN-macOS.dmg",
  ],
  [
    "消息总管-macOS安装包.dmg",
    "https://github.com/a3152557994-ship-it/tabpulse/releases/latest/download/XiaoXiZongGuan-CN-macOS.dmg",
  ],
  [
    "ReplyRadar-EN-macOS.dmg",
    "https://github.com/a3152557994-ship-it/tabpulse/releases/latest/download/ReplyRadar-EN-macOS.dmg",
  ],
  [
    "XiaoXiZongGuan-CN-Windows-x64.zip",
    "https://github.com/a3152557994-ship-it/tabpulse/releases/latest/download/XiaoXiZongGuan-CN-Windows-x64.zip",
  ],
  [
    "ReplyRadar-EN-Windows-x64.zip",
    "https://github.com/a3152557994-ship-it/tabpulse/releases/latest/download/ReplyRadar-EN-Windows-x64.zip",
  ],
  [
    "cloudflared-darwin-arm64.tgz",
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz",
  ],
  [
    "cloudflared-darwin-amd64.tgz",
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz",
  ],
  [
    "cloudflared-windows-amd64.exe",
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
  ],
]);

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isAllowedTunnelOrigin(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h.endsWith(".lhr.life") || h.endsWith(".trycloudflare.com") || h.endsWith(".localhost.run");
  } catch {
    return false;
  }
}

export class TunnelBox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        )
      `);
    });
  }

  getVal(key) {
    const rows = this.ctx.storage.sql.exec("SELECT v FROM meta WHERE k = ?", key).toArray();
    return rows.length > 0 ? String(rows[0].v) : "";
  }

  setVal(key, val) {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      key,
      String(val)
    );
  }

  async syncTunnel(writeHash, targetOrigin) {
    const existingHash = this.getVal("write_hash");
    if (existingHash && existingHash !== writeHash) {
      return { ok: false, error: "unauthorized box write key" };
    }
    const nowIso = new Date().toISOString();
    if (!existingHash) this.setVal("write_hash", writeHash);
    this.setVal("target_origin", targetOrigin);
    this.setVal("updated_at", nowIso);
    return { ok: true, targetOrigin, updatedAt: nowIso };
  }

  async getTunnel() {
    return {
      targetOrigin: this.getVal("target_origin"),
      updatedAt: this.getVal("updated_at"),
    };
  }
}

function renderOfflinePage(boxId, updatedAt) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>消息总管 · 等待家里电脑上线</title><style>body{margin:0;background:#0f172a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px;text-align:center}.card{background:#1e293b;border:1px solid #334155;border-radius:18px;padding:24px;max-width:380px}h1{font-size:18px;margin:0 0 10px}p{font-size:13.5px;color:#94a3b8;line-height:1.6;margin:0 0 16px}button{background:#2563eb;color:#fff;border:none;border-radius:10px;padding:11px 20px;font-size:14.5px;font-weight:700;cursor:pointer}</style></head><body><div class="card"><h1>⏳ 正在连接家里电脑的《消息总管》</h1><p>固定书签号：<code>${boxId}</code>${updatedAt ? `<br/>上次在线：${updatedAt}` : ""}<br/>请确认电脑端已打开《消息总管》并开启「出门 4G/5G 穿透」（重启后会自动重连同步此固定链接）。</p><button onclick="location.reload()">↻ 刷新重连</button></div></body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          service: "replyradar-edge",
          features: ["china-cdn-download-mirror", "permanent-mobile-bookmark-gateway"],
        },
        { headers: cors }
      );
    }

    // 1. High-Speed Global/China Edge CDN Mirror for Installers & Cloudflared Binary
    if (url.pathname.startsWith("/dl/") && (request.method === "GET" || request.method === "HEAD")) {
      const name = decodeURIComponent(url.pathname.slice(4));
      const upstream = ALLOWED_RELEASE_ASSETS.get(name);
      if (!upstream) {
        return Response.json({ ok: false, error: "unknown asset" }, { status: 404, headers: cors });
      }
      const noCache = url.searchParams.get("nocache") === "1";
      const cacheKey = new Request(`https://edge-cache.replyradar.internal/v54/${encodeURIComponent(name)}`, {
        method: "GET",
      });
      const cache = caches.default;
      if (!noCache && request.method === "GET") {
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
      }

      const ghRes = await fetch(upstream, {
        redirect: "follow",
        headers: { "User-Agent": "ReplyRadar-Edge-CDN/5.4" },
      });
      if (!ghRes.ok) {
        return Response.redirect(upstream, 302);
      }
      const headers = new Headers();
      headers.set("Content-Type", ghRes.headers.get("Content-Type") || "application/octet-stream");
      if (ghRes.headers.get("Content-Length")) {
        headers.set("Content-Length", ghRes.headers.get("Content-Length"));
      }
      headers.set(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
      );
      headers.set("Cache-Control", "public, max-age=600");
      headers.set("Access-Control-Allow-Origin", "*");

      const outRes = new Response(request.method === "HEAD" ? null : ghRes.body, {
        status: 200,
        headers,
      });
      if (request.method === "GET" && Number(ghRes.headers.get("Content-Length") || 0) < 25 * 1024 * 1024) {
        ctx.waitUntil(cache.put(cacheKey, outRes.clone()));
      }
      return outRes;
    }

    // 2. Desktop Tunnel Sync -> Binds/Updates Permanent Mobile Bookmark URL
    if (url.pathname === "/api/tunnel/sync" && request.method === "POST") {
      let body = {};
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid json" }, { status: 400, headers: cors });
      }
      const boxId = String(body.boxId || "").trim();
      const writeKey = String(body.writeKey || "").trim();
      const targetOrigin = String(body.targetOrigin || "").trim().replace(/\/+$/, "");

      if (!/^bx_[a-zA-Z0-9]{10,36}$/.test(boxId) || writeKey.length < 16) {
        return Response.json({ ok: false, error: "invalid boxId or writeKey" }, { status: 400, headers: cors });
      }
      if (!isAllowedTunnelOrigin(targetOrigin)) {
        return Response.json({ ok: false, error: "invalid tunnel origin" }, { status: 400, headers: cors });
      }
      const writeHash = await sha256Hex(writeKey);
      const stub = env.TUNNEL_BOX.getByName(boxId);
      const res = await stub.syncTunnel(writeHash, targetOrigin);
      if (!res.ok) {
        return Response.json(res, { status: 403, headers: cors });
      }
      const permanentUrl = `${url.origin}/go/${boxId}`;
      return Response.json({ ok: true, permanentUrl, ...res }, { headers: cors });
    }

    // 3. Permanent Bookmark Redirect (/go/:boxId?t=...)
    const goMatch = url.pathname.match(/^\/go\/(bx_[a-zA-Z0-9]{10,36})\/?$/);
    if (goMatch && (request.method === "GET" || request.method === "HEAD")) {
      const boxId = goMatch[1];
      const stub = env.TUNNEL_BOX.getByName(boxId);
      const info = await stub.getTunnel();
      if (!info || !info.targetOrigin) {
        return new Response(renderOfflinePage(boxId, ""), {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      const tok = url.searchParams.get("t") || "";
      const dest = `${info.targetOrigin}/m${tok ? `?t=${encodeURIComponent(tok)}` : ""}`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: dest,
          "Cache-Control": "no-store",
        },
      });
    }

    return Response.json({ ok: false, error: "not found" }, { status: 404, headers: cors });
  },
};
