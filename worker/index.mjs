import { DurableObject } from "cloudflare:workers";

const CREEM_LIFETIME_PRODUCT_ID = "prod_WXZloyzwbIaBZ2LAlOgkX";
const CREEM_ANNUAL_PRODUCT_ID = "prod_7GwFeV4qIacTtjIg6t8QE";

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
    "XiaoXiZongGuan-Android.apk",
    "https://github.com/a3152557994-ship-it/tabpulse/releases/latest/download/XiaoXiZongGuan-Android.apk",
  ],
  [
    "消息总管-安卓手机版.apk",
    "https://github.com/a3152557994-ship-it/tabpulse/releases/latest/download/XiaoXiZongGuan-Android.apk",
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

function toBase64Url(bytes) {
  let bin = "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToPkcs8Bytes(pem) {
  const b64 = String(pem || "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function mintTp1LicenseKey({ plan = "lifetime", serialPrefix = "GL", orderRef = "" }, privatePem) {
  if (!privatePem) return null;
  const pkcs8 = pemToPkcs8Bytes(privatePem);
  const privKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const today = new Date().toISOString().slice(0, 10);
  const expiresAt =
    plan === "annual" || plan === "annual_cn" || plan === "pro_sub"
      ? new Date(Date.now() + 370 * 86400 * 1000).toISOString().slice(0, 10)
      : null;
  const suffix = String(orderRef || crypto.randomUUID())
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-6)
    .toUpperCase();
  const serial = `${serialPrefix}-${suffix || "PRO001"}`;
  const payloadObj = { p: plan, s: serial, i: today, e: expiresAt };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const sigBuf = await crypto.subtle.sign("Ed25519", privKey, payloadBytes);
  return {
    key: `TP1.${toBase64Url(payloadBytes)}.${toBase64Url(sigBuf)}`,
    plan,
    serial,
    expiresAt,
  };
}

async function verifyCreemWebhookHmac(rawBody, headerSig, secret) {
  const cleanSig = String(headerSig || "").trim().toLowerCase();
  const cleanSec = String(secret || "").trim();
  if (!cleanSig || !cleanSec || !/^[0-9a-f]{64}$/.test(cleanSig)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(cleanSec),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expectedHex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (expectedHex.length !== cleanSig.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    diff |= expectedHex.charCodeAt(i) ^ cleanSig.charCodeAt(i);
  }
  return diff === 0;
}

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
        );
        CREATE TABLE IF NOT EXISTS issued_licenses (
          order_key TEXT PRIMARY KEY,
          license_key TEXT NOT NULL,
          plan TEXT NOT NULL,
          customer_email TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relay_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relay_commands (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
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

  async saveOrGetLicense({ orderKeys = [], licenseKey = "", plan = "lifetime", email = "" }) {
    const validKeys = orderKeys.map((k) => String(k || "").trim()).filter(Boolean);
    for (const k of validKeys) {
      const existing = this.ctx.storage.sql
        .exec("SELECT license_key, plan, customer_email, created_at FROM issued_licenses WHERE order_key = ?", k)
        .toArray();
      if (existing.length > 0) {
        return {
          found: true,
          licenseKey: String(existing[0].license_key),
          plan: String(existing[0].plan),
          email: String(existing[0].customer_email),
          createdAt: String(existing[0].created_at),
        };
      }
    }
    if (!licenseKey || !validKeys.length) return { found: false };
    const nowIso = new Date().toISOString();
    for (const k of validKeys) {
      this.ctx.storage.sql.exec(
        "INSERT INTO issued_licenses (order_key, license_key, plan, customer_email, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(order_key) DO NOTHING",
        k,
        licenseKey,
        plan,
        String(email || ""),
        nowIso
      );
    }
    return { found: true, licenseKey, plan, email: String(email || ""), createdAt: nowIso };
  }

  async pushRelayEvent({ title = "", body = "", source = "cc" }) {
    const nowMs = Date.now();
    const cleanTitle = String(title || "🤖 远程任务提醒").trim().slice(0, 120) || "🤖 远程任务提醒";
    const cleanBody = String(body || "任务已完成，请查看").trim().slice(0, 800);
    const cleanSource = String(source || "cc").trim().slice(0, 40);
    this.ctx.storage.sql.exec(
      "INSERT INTO relay_events (title, body, source, created_at) VALUES (?, ?, ?, ?)",
      cleanTitle,
      cleanBody,
      cleanSource,
      nowMs
    );
    // Keep only latest 50 events so storage stays tiny
    this.ctx.storage.sql.exec(
      "DELETE FROM relay_events WHERE id NOT IN (SELECT id FROM relay_events ORDER BY id DESC LIMIT 50)"
    );
    const row = this.ctx.storage.sql.exec("SELECT MAX(id) AS max_id FROM relay_events").toArray();
    const id = row.length > 0 ? Number(row[0].max_id || 0) : 0;
    return { ok: true, id, createdAt: nowMs };
  }

  async pullRelayEvents(sinceId = 0) {
    const cleanSince = Math.max(0, Number(sinceId) || 0);
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT id, title, body, source, created_at FROM relay_events WHERE id > ? ORDER BY id ASC LIMIT 30",
        cleanSince
      )
      .toArray();
    const maxRow = this.ctx.storage.sql.exec("SELECT MAX(id) AS max_id FROM relay_events").toArray();
    const latestId = maxRow.length > 0 && maxRow[0].max_id != null ? Number(maxRow[0].max_id) : cleanSince;
    return {
      ok: true,
      latestId,
      events: rows.map((r) => ({
        id: Number(r.id),
        title: String(r.title || ""),
        body: String(r.body || ""),
        source: String(r.source || "cc"),
        createdAt: Number(r.created_at || 0),
      })),
    };
  }

  async enqueueRelayCommand(prompt = "") {
    const cleanPrompt = String(prompt || "").trim().slice(0, 4000);
    if (!cleanPrompt) return { ok: false, error: "empty prompt" };
    const nowMs = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO relay_commands (prompt, status, created_at) VALUES (?, 'pending', ?)",
      cleanPrompt,
      nowMs
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM relay_commands WHERE id NOT IN (SELECT id FROM relay_commands ORDER BY id DESC LIMIT 30)"
    );
    const row = this.ctx.storage.sql.exec("SELECT MAX(id) AS max_id FROM relay_commands").toArray();
    const cmdId = row.length > 0 ? Number(row[0].max_id || 0) : 0;
    // Mirror user's sent command into timeline so phone sees full back-and-forth history
    await this.pushRelayEvent({
      title: "📤 你在手机发给 CC 的指令",
      body: cleanPrompt,
      source: "user-cmd",
    });
    return { ok: true, commandId: cmdId, createdAt: nowMs };
  }

  async claimNextRelayCommand() {
    const rows = this.ctx.storage.sql
      .exec("SELECT id, prompt, created_at FROM relay_commands WHERE status = 'pending' ORDER BY id ASC LIMIT 1")
      .toArray();
    if (!rows.length) {
      return { ok: true, command: null };
    }
    const picked = rows[0];
    const id = Number(picked.id);
    this.ctx.storage.sql.exec("UPDATE relay_commands SET status = 'claimed' WHERE id = ?", id);
    return {
      ok: true,
      command: {
        id,
        prompt: String(picked.prompt || ""),
        createdAt: Number(picked.created_at || 0),
      },
    };
  }
}

function escHtml(raw) {
  return String(raw || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderOfflinePage(boxId, updatedAt) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="referrer" content="no-referrer"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>消息总管 · 等待家里电脑上线</title><style>body{margin:0;background:#0f172a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px;text-align:center}.card{background:#1e293b;border:1px solid #334155;border-radius:18px;padding:24px;max-width:380px}h1{font-size:18px;margin:0 0 10px}p{font-size:13.5px;color:#94a3b8;line-height:1.6;margin:0 0 16px}button{background:#2563eb;color:#fff;border:none;border-radius:10px;padding:11px 20px;font-size:14.5px;font-weight:700;cursor:pointer}</style></head><body><div class="card"><h1>⏳ 正在连接家里电脑的《消息总管》</h1><p>固定书签号：<code>${escHtml(boxId)}</code>${updatedAt ? `<br/>上次在线：${escHtml(updatedAt)}` : ""}<br/>请确认电脑端已打开《消息总管》并开启「出门 4G/5G 加密穿透」（重启后会自动重连同步此固定链接）。</p><button onclick="location.reload()">↻ 刷新重连</button></div></body></html>`;
}

function renderCheckoutSuccessHtml({ licenseKey, plan, checkoutId, origin }) {
  const hasKey = Boolean(licenseKey);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>ReplyRadar Pro — Order Confirmed</title><style>body{margin:0;background:#0b1120;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px}.card{background:#1e293b;border:1.5px solid #3b82f6;border-radius:20px;padding:28px;max-width:560px;width:100%;box-sizing:border-box;box-shadow:0 24px 60px rgba(0,0,0,0.5)}h1{font-size:22px;margin:0 0 8px}p{font-size:14px;color:#cbd5e1;line-height:1.6;margin:0 0 14px}.keybox{background:#090d16;border:1px solid #475569;border-radius:12px;padding:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all;color:#34d399;margin:12px 0}.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}a.btn,button.btn{padding:11px 18px;border-radius:10px;font-weight:700;font-size:14px;cursor:pointer;text-decoration:none;border:1px solid #334155;background:#0f172a;color:#fff}button.primary,a.primary{background:#2563eb;border-color:#2563eb}</style></head><body><div class="card"><h1>🎉 Thank You! ReplyRadar ${plan === "annual" || plan === "annual_cn" ? "Annual" : "Lifetime"} Pro</h1>${
    hasKey
      ? `<p>Your official offline activation key (works on both <strong>macOS &amp; Windows</strong> — paste inside ReplyRadar → <em>Activate Pro</em>):</p><div class="keybox" id="k">${escHtml(licenseKey)}</div><div class="btns"><button class="btn primary" onclick="navigator.clipboard.writeText(document.getElementById('k').textContent);this.textContent='✅ License Key Copied!'">📋 Copy Activation Key</button><a class="btn" href="${origin}/dl/ReplyRadar-EN-macOS.dmg"> Download macOS (.dmg)</a><a class="btn" href="${origin}/dl/ReplyRadar-EN-Windows-x64.zip">🪟 Download Windows (.zip)</a></div>`
      : `<p>Your payment (${escHtml(checkoutId || "confirmed")}) is being finalized! Refresh this page in 3 seconds to view your <code>TP1.</code> license key, or click below if it takes longer than 30 seconds:</p><div class="btns"><button class="btn primary" onclick="location.reload()">↻ Refresh Now</button><a class="btn" href="mailto:a3152557994@gmail.com?subject=ReplyRadar%20Order%20${encodeURIComponent(checkoutId || "")}">✉️ Instant Support</a></div>`
  }<p style="margin-top:18px;font-size:12.5px;color:#94a3b8">Please save a copy of your key. Protected by our 14-day 100% refund guarantee.</p></div></body></html>`;
}

function resolvePlanFromProduct(productId, productName = "") {
  if (productId === CREEM_ANNUAL_PRODUCT_ID || /annual|year|年/i.test(String(productName))) {
    return "annual_cn";
  }
  return "lifetime";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, creem-signature",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          service: "replyradar-edge",
          features: [
            "china-cdn-download-mirror",
            "permanent-mobile-bookmark-gateway",
            "creem-webhook-ed25519-license-issuer",
          ],
          products: {
            lifetime: `https://www.creem.io/product/${CREEM_LIFETIME_PRODUCT_ID}`,
            annual: `https://www.creem.io/product/${CREEM_ANNUAL_PRODUCT_ID}`,
          },
        },
        { headers: cors }
      );
    }

    // 1. Creem Verified Webhook -> Auto-Issue Official Ed25519 TP1. License Key
    if (url.pathname === "/webhooks/creem" && request.method === "POST") {
      const rawBody = await request.text();
      const sig = request.headers.get("creem-signature") || "";
      const valid = await verifyCreemWebhookHmac(rawBody, sig, env.CREEM_WEBHOOK_SECRET || "");
      if (!valid) {
        return Response.json({ ok: false, error: "invalid creem-signature" }, { status: 401, headers: cors });
      }
      let evt = {};
      try {
        evt = JSON.parse(rawBody);
      } catch {
        return Response.json({ ok: false, error: "invalid json" }, { status: 400, headers: cors });
      }
      const eventType = String(evt.eventType || evt.type || "");
      const obj = evt.object || evt.data || {};
      if (eventType === "checkout.completed" || eventType === "subscription.paid") {
        const checkoutId = String(obj.id || obj.checkout_id || "");
        const orderId = String(obj.order?.id || obj.order_id || "");
        const productId = String(obj.product?.id || obj.product_id || "");
        const productName = String(obj.product?.name || "");
        const email = String(obj.customer?.email || obj.customer_email || "");
        const plan = resolvePlanFromProduct(productId, productName);
        const vault = env.TUNNEL_BOX.getByName("orders_vault");
        const orderKeys = [checkoutId, orderId].filter(Boolean);

        const existing = await vault.saveOrGetLicense({ orderKeys });
        if (existing.found) {
          return Response.json({ ok: true, alreadyIssued: true, plan: existing.plan }, { headers: cors });
        }

        const minted = await mintTp1LicenseKey(
          { plan, serialPrefix: "CREEM", orderRef: orderId || checkoutId },
          env.LICENSE_ED25519_PRIVATE_PEM
        );
        if (minted?.key) {
          await vault.saveOrGetLicense({
            orderKeys,
            licenseKey: minted.key,
            plan: minted.plan,
            email,
          });
          return Response.json({ ok: true, issued: true, serial: minted.serial, plan: minted.plan }, { headers: cors });
        }
      }
      return Response.json({ ok: true, received: eventType }, { headers: cors });
    }

    // 2. Post-Payment Redirect Page (/checkout/success?checkout_id=...&order_id=...)
    if (url.pathname === "/checkout/success" && (request.method === "GET" || request.method === "HEAD")) {
      const checkoutId = url.searchParams.get("checkout_id") || "";
      const orderId = url.searchParams.get("order_id") || "";
      const productId = url.searchParams.get("product_id") || "";
      const vault = env.TUNNEL_BOX.getByName("orders_vault");
      let record = await vault.saveOrGetLicense({ orderKeys: [checkoutId, orderId] });

      // Direct Creem API fallback if buyer lands slightly before webhook arrives
      if (!record.found && checkoutId && env.CREEM_API_KEY && env.LICENSE_ED25519_PRIVATE_PEM) {
        try {
          const apiBase = String(env.CREEM_API_BASE_URL || "https://api.creem.io/v1").replace(/\/+$/, "");
          const r = await fetch(`${apiBase}/checkouts?checkout_id=${encodeURIComponent(checkoutId)}`, {
            headers: { "x-api-key": env.CREEM_API_KEY },
          });
          if (r.ok) {
            const cData = await r.json();
            if (cData.status === "completed" || cData.order?.status === "paid") {
              const plan = resolvePlanFromProduct(cData.product?.id || productId, cData.product?.name || "");
              const minted = await mintTp1LicenseKey(
                { plan, serialPrefix: "CREEM", orderRef: cData.order?.id || orderId || checkoutId },
                env.LICENSE_ED25519_PRIVATE_PEM
              );
              if (minted?.key) {
                record = await vault.saveOrGetLicense({
                  orderKeys: [checkoutId, cData.order?.id || orderId],
                  licenseKey: minted.key,
                  plan: minted.plan,
                  email: cData.customer?.email || "",
                });
              }
            }
          }
        } catch {}
      }

      return new Response(
        renderCheckoutSuccessHtml({
          licenseKey: record.found ? record.licenseKey : "",
          plan: record.plan || resolvePlanFromProduct(productId, ""),
          checkoutId: checkoutId || orderId,
          origin: url.origin,
        }),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }

    // 3. High-Speed Global/China Edge CDN Mirror for Installers & Cloudflared Binary
    if (url.pathname.startsWith("/dl/") && (request.method === "GET" || request.method === "HEAD")) {
      const name = decodeURIComponent(url.pathname.slice(4));
      const upstream = ALLOWED_RELEASE_ASSETS.get(name);
      if (!upstream) {
        return Response.json({ ok: false, error: "unknown asset" }, { status: 404, headers: cors });
      }
      const noCache = url.searchParams.get("nocache") === "1";
      const cacheKey = new Request(`https://edge-cache.replyradar.internal/v58/${encodeURIComponent(name)}`, {
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

    // 4. Desktop Tunnel Sync -> Binds/Updates Permanent Mobile Bookmark URL
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

    // 5. Permanent Bookmark Redirect (/go/:boxId?t=...) -> Stable same-origin reverse proxy /box/:boxId/m
    const goMatch = url.pathname.match(/^\/go\/(bx_[a-zA-Z0-9]{10,36})\/?$/);
    if (goMatch && (request.method === "GET" || request.method === "HEAD")) {
      const boxId = goMatch[1];
      const tok = url.searchParams.get("t") || "";
      const dest = `${url.origin}/box/${boxId}/m${tok ? `?t=${encodeURIComponent(tok)}` : ""}`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: dest,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // 6. Permanent Same-Origin Reverse Proxy (/box/:boxId/*) -> Keeps Mobile Cookies, PWA Icon & Web Push Alive Forever!
    const boxMatch = url.pathname.match(/^\/box\/(bx_[a-zA-Z0-9]{10,36})(\/.*)?$/);
    if (boxMatch) {
      const boxId = boxMatch[1];
      const subPath = boxMatch[2] || "/m";
      const stub = env.TUNNEL_BOX.getByName(boxId);
      const info = await stub.getTunnel();
      if (!info || !info.targetOrigin) {
        if (subPath.startsWith("/api/")) {
          return Response.json(
            { ok: false, offline: true, error: "电脑端《消息总管》当前离线，请确认电脑已开机并开启穿透" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
        return new Response(renderOfflinePage(boxId, ""), {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if (subPath === "/manifest.webmanifest" && request.method === "GET") {
        return Response.json(
          {
            name: "消息总管 · 手机随身版",
            short_name: "消息总管",
            start_url: `/box/${boxId}/m`,
            scope: `/box/${boxId}/`,
            display: "standalone",
            background_color: "#0b1120",
            theme_color: "#0b1120",
            icons: [
              {
                src: `/box/${boxId}/mobile-icon.svg`,
                sizes: "512x512",
                type: "image/svg+xml",
                purpose: "any maskable",
              },
            ],
          },
          { headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-store" } }
        );
      }

      const upstreamUrl = `${info.targetOrigin}${subPath}${url.search}`;
      const fwdHeaders = new Headers();
      for (const hName of ["accept", "content-type", "cookie", "authorization", "x-tabpulse-token", "user-agent"]) {
        const val = request.headers.get(hName);
        if (val) fwdHeaders.set(hName, val);
      }
      const cfIp = request.headers.get("cf-connecting-ip");
      if (cfIp) fwdHeaders.set("x-forwarded-for", cfIp);
      fwdHeaders.set("x-forwarded-proto", "https");
      fwdHeaders.set("x-tabpulse-box-prefix", `/box/${boxId}`);

      try {
        let fwdBody = undefined;
        if (request.method !== "GET" && request.method !== "HEAD") {
          const buf = await request.arrayBuffer();
          fwdBody = buf;
          fwdHeaders.set("content-length", String(buf.byteLength));
        }
        const upRes = await fetch(upstreamUrl, {
          method: request.method,
          headers: fwdHeaders,
          body: fwdBody,
          redirect: "manual",
        });

        if (upRes.status >= 502 && upRes.status <= 504) {
          if (subPath.startsWith("/api/")) {
            return Response.json(
              { ok: false, offline: true, error: "家里电脑隧道重连中，请稍等几秒后重试" },
              { status: 503, headers: { "Cache-Control": "no-store" } }
            );
          }
          return new Response(renderOfflinePage(boxId, info.updatedAt), {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }

        const outHeaders = new Headers();
        for (const [k, v] of upRes.headers.entries()) {
          const lk = k.toLowerCase();
          if (lk === "set-cookie") {
            const rewritten = v
              .replace(/Path=\/([^;]*)/i, `Path=/box/${boxId}/`)
              .replace(/SameSite=Strict/i, "SameSite=Lax");
            outHeaders.append("Set-Cookie", rewritten.includes("Secure") ? rewritten : `${rewritten}; Secure`);
          } else if (lk === "location") {
            outHeaders.set(
              "Location",
              v.startsWith("/") ? `/box/${boxId}${v}` : v
            );
          } else if (lk === "service-worker-allowed") {
            outHeaders.set("Service-Worker-Allowed", `/box/${boxId}/`);
          } else if (lk !== "content-length" && lk !== "transfer-encoding") {
            outHeaders.set(k, v);
          }
        }
        if (subPath === "/sw.js") {
          outHeaders.set("Service-Worker-Allowed", `/box/${boxId}/`);
        }

        return new Response(upRes.body, {
          status: upRes.status,
          headers: outHeaders,
        });
      } catch {
        if (subPath.startsWith("/api/")) {
          return Response.json(
            { ok: false, offline: true, error: "暂时无法连上家里电脑，请确认电脑端软件正在运行" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
        return new Response(renderOfflinePage(boxId, info.updatedAt), {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    }

    // 7. Zero-QR Claude-Cage / Overseas Server Two-Way Relay -> Notify Phone & Receive Next Command!
    const ccHookMatch = url.pathname.match(/^\/sh\/cc-hook\/(rc_[a-zA-Z0-9]{16,48})\/?$/);
    if (ccHookMatch && (request.method === "GET" || request.method === "HEAD")) {
      const token = ccHookMatch[1];
      const pushEndpoint = `${url.origin}/api/relay/push/${token}`;
      const cmdEndpoint = `${url.origin}/api/relay/cmd/${token}`;
      const relayHost = url.hostname;
      const script = `#!/usr/bin/env bash
set -e
mkdir -p "$HOME/.claude" "$HOME/.local/bin"

cat > "$HOME/.local/bin/cc-notify" <<'EOF'
#!/usr/bin/env bash
MSG="\${1:-任务已完成}"
curl -fsS -m 8 -X POST "${pushEndpoint}?src=cli" --data-raw "$MSG" >/dev/null 2>&1 || true
EOF
chmod +x "$HOME/.local/bin/cc-notify"

cat > "$HOME/.local/bin/cc-remote" <<'EOF'
#!/usr/bin/env bash
AUTO_FLAG=""
if [ "\${1:-}" = "--auto" ] || [ "\${1:-}" = "-y" ]; then
  AUTO_FLAG="--dangerously-skip-permissions"
fi
DIR_NAME="\$(basename "\$(pwd)")"
echo "🔒 消息总管 · CC 笼子/远程双向接力已启动（当前目录: \$(pwd)）"
echo "📱 现在可以在手机《消息总管》接收完工弹窗，并直接打字给 CC 发下一条指令！(按 Ctrl+C 停止)"
curl -fsS -m 8 -X POST "${pushEndpoint}?src=cc-ready&title=\$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "🟢 CC 已在笼子待命（\$DIR_NAME）" 2>/dev/null || echo "CC-Ready")" \\
  --data-raw "已在目录 \$(pwd) 开启双向接力，你在手机上直接发指令即可继续干活！" >/dev/null 2>&1 || true

HAS_SESSION=0
while true; do
  RAW="\$(curl -fsS -m 10 "${cmdEndpoint}" 2>/dev/null || true)"
  PROMPT=""
  if [ -n "\$RAW" ]; then
    if command -v python3 >/dev/null 2>&1; then
      PROMPT="\$(printf '%s' "\$RAW" | python3 -c 'import sys,json;d=json.load(sys.stdin);c=d.get("command");print(c.get("prompt","") if isinstance(c,dict) else "")' 2>/dev/null || true)"
    elif command -v node >/dev/null 2>&1; then
      PROMPT="\$(printf '%s' "\$RAW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s);console.log((d.command&&d.command.prompt)||"");}catch{}});' 2>/dev/null || true)"
    fi
  fi
  if [ -n "\$PROMPT" ]; then
    echo ""
    echo "▶ [手机发来新指令]: \$PROMPT"
    curl -fsS -m 8 -X POST "${pushEndpoint}?src=cc-running" --data-raw "⏳ 笼子里的 CC 已收到指令，正在执行：\$PROMPT" >/dev/null 2>&1 || true
    OUT_TMP="\$(mktemp)"
    if [ "\$HAS_SESSION" -eq 1 ]; then
      TABPULSE_REMOTE_WRAPPER=1 claude -p "\$PROMPT" --continue \$AUTO_FLAG >"\$OUT_TMP" 2>&1 || TABPULSE_REMOTE_WRAPPER=1 claude -p "\$PROMPT" \$AUTO_FLAG >"\$OUT_TMP" 2>&1 || true
    else
      TABPULSE_REMOTE_WRAPPER=1 claude -p "\$PROMPT" --continue \$AUTO_FLAG >"\$OUT_TMP" 2>&1 || TABPULSE_REMOTE_WRAPPER=1 claude -p "\$PROMPT" \$AUTO_FLAG >"\$OUT_TMP" 2>&1 || true
      HAS_SESSION=1
    fi
    cat "\$OUT_TMP"
    SUMMARY="\$(tail -c 700 "\$OUT_TMP" | tr '\\000' ' ')"
    rm -f "\$OUT_TMP"
    [ -z "\$SUMMARY" ] && SUMMARY="指令已执行完毕，请指示下一步。"
    # Note: if Stop hook is also active, we send explicit result summary with output text!
    curl -fsS -m 8 -X POST "${pushEndpoint}?src=cc-done" --data-raw "✅ [\$DIR_NAME 执行完毕] \$SUMMARY" >/dev/null 2>&1 || true
    echo "✅ 已将结果推回手机《消息总管》，等待你手机发来下一条指令..."
  fi
  sleep 3
done
EOF
chmod +x "$HOME/.local/bin/cc-remote"

if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$rc" ] && ! grep -q '.local/bin' "$rc" 2>/dev/null; then
      echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
    fi
  done
fi

if command -v python3 >/dev/null 2>&1; then
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude/settings.json")
try:
    with open(p, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        cfg = {}
except Exception:
    cfg = {}
hooks = cfg.get("hooks")
if not isinstance(hooks, dict):
    hooks = {}
    cfg["hooks"] = hooks
cmd = '[ -z "$TABPULSE_REMOTE_WRAPPER" ] && curl -fsS -m 8 -X POST ${pushEndpoint} -H "Content-Type: application/json" --data-binary @- >/dev/null 2>&1 || true'
new_item = {"hooks": [{"type": "command", "command": cmd}]}
for ev in ("Stop", "Notification"):
    existing = hooks.get(ev)
    if not isinstance(existing, list):
        existing = []
    kept = [x for x in existing if "/api/relay/push/" not in json.dumps(x)]
    kept.append(new_item)
    hooks[ev] = kept
# If strict sandbox domain whitelist is configured, allow relay host automatically
net = cfg.get("network")
if isinstance(net, dict) and isinstance(net.get("allowedDomains"), list):
    if "${relayHost}" not in net["allowedDomains"]:
        net["allowedDomains"].append("${relayHost}")
sb = cfg.get("sandbox")
if isinstance(sb, dict) and isinstance(sb.get("network"), dict) and isinstance(sb["network"].get("allowedDomains"), list):
    if "${relayHost}" not in sb["network"]["allowedDomains"]:
        sb["network"]["allowedDomains"].append("${relayHost}")
with open(p, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
PY
elif command -v node >/dev/null 2>&1; then
node -e '
const fs = require("fs"), os = require("os"), p = os.homedir() + "/.claude/settings.json";
let cfg = {}; try { const parsed = JSON.parse(fs.readFileSync(p, "utf8")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cfg = parsed; } catch {}
if (!cfg.hooks || typeof cfg.hooks !== "object" || Array.isArray(cfg.hooks)) cfg.hooks = {};
const cmd = "[ -z \\"$TABPULSE_REMOTE_WRAPPER\\" ] && curl -fsS -m 8 -X POST ${pushEndpoint} -H \\"Content-Type: application/json\\" --data-binary @- >/dev/null 2>&1 || true";
const newItem = { hooks: [{ type: "command", command: cmd }] };
for (const ev of ["Stop", "Notification"]) {
  const cur = Array.isArray(cfg.hooks[ev]) ? cfg.hooks[ev] : [];
  const kept = cur.filter((x) => !JSON.stringify(x).includes("/api/relay/push/"));
  kept.push(newItem);
  cfg.hooks[ev] = kept;
}
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
'
elif [ ! -s "$HOME/.claude/settings.json" ]; then
cat > "$HOME/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "curl -fsS -m 8 -X POST ${pushEndpoint} -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1 || true" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "curl -fsS -m 8 -X POST ${pushEndpoint} -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1 || true" }] }
    ]
  }
}
JSON
else
  echo "⚠️ 检测到已有 ~/.claude/settings.json 但未安装 python3/node，请直接使用 ~/.local/bin/cc-remote 开启手机双向接力。"
fi

curl -fsS -m 8 -X POST "${pushEndpoint}" -H "Content-Type: application/json" \\
  -d '{"title":"✅ CC 笼子 / 海外服务器已连上手机！","body":"绑定成功！1）平时敲 claude 干完活会自动弹窗通知手机；2）在项目目录敲 ~/.local/bin/cc-remote（笼子内免确认加 --auto），手机收到通知后还能直接打字给 CC 发下一条指令！","source":"cc-setup"}' >/dev/null 2>&1 || true
echo "✅ 绑定成功！你的手机《消息总管》马上会收到连接成功弹窗。"
echo "🚀 想在手机上直接给笼子里的 CC 回发下一条指令，请在项目目录运行："
echo "   ~/.local/bin/cc-remote --auto"
`;
      return new Response(script, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    const relayMatch = url.pathname.match(/^\/api\/relay\/(push|pull|cmd)\/(rc_[a-zA-Z0-9]{16,48})\/?$/);
    if (relayMatch) {
      const mode = relayMatch[1];
      const token = relayMatch[2];
      const boxHash = (await sha256Hex(`relay_v1:${token}`)).slice(0, 36);
      const stub = env.TUNNEL_BOX.getByName(`relay_${boxHash}`);

      if (mode === "pull" && request.method === "GET") {
        const since = Number(url.searchParams.get("since") || "0") || 0;
        const data = await stub.pullRelayEvents(since);
        return Response.json(data, { headers: { ...cors, "Cache-Control": "no-store" } });
      }

      if (mode === "cmd") {
        if (request.method === "POST") {
          let prompt = url.searchParams.get("prompt") || "";
          const raw = (await request.text()).trim();
          if (raw) {
            try {
              const j = JSON.parse(raw);
              prompt = String(j.prompt || j.cmd || j.text || prompt);
            } catch {
              prompt = raw;
            }
          }
          const queued = await stub.enqueueRelayCommand(prompt);
          return Response.json(queued, { status: queued.ok ? 200 : 400, headers: { ...cors, "Cache-Control": "no-store" } });
        }
        if (request.method === "GET") {
          const claimed = await stub.claimNextRelayCommand();
          return Response.json(claimed, { headers: { ...cors, "Cache-Control": "no-store" } });
        }
      }

      if (mode === "push" && (request.method === "POST" || request.method === "GET")) {
        let title = url.searchParams.get("title") || "";
        let body = url.searchParams.get("msg") || url.searchParams.get("body") || "";
        let source = url.searchParams.get("src") || "cc";

        if (request.method === "POST") {
          const raw = (await request.text()).trim();
          if (raw) {
            try {
              const j = JSON.parse(raw);
              const cwdBase = String(j.cwd || "")
                .replace(/\/+$/, "")
                .split("/")
                .filter(Boolean)
                .pop() || "";
              const hookEvent = String(j.hook_event_name || "");
              if (hookEvent === "Notification" || j.notification_type) {
                title = cwdBase ? `⏳ 海外 CC 等你确认（${cwdBase}）` : "⏳ 海外 CC 等你处理";
                body = String(j.message || j.last_assistant_message || "海外服务器上的 CC 正在等待你的输入或确认");
                source = "cc-wait";
              } else if (hookEvent === "Stop" || j.stop_hook_active !== undefined || j.last_assistant_message !== undefined) {
                title = cwdBase ? `✅ 海外 CC 干完活了（${cwdBase}）` : "✅ 海外 CC 干完活了！";
                body = String(
                  j.last_assistant_message ||
                    j.summary ||
                    j.message ||
                    (cwdBase ? `目录 ${cwdBase} 中的任务已执行完毕` : "海外服务器上的 CC 已完成当前任务")
                );
                source = "cc-stop";
              } else if (j.title || j.body || j.msg) {
                title = String(j.title || title || (cwdBase ? `🤖 CC 提醒（${cwdBase}）` : "🤖 海外 CC 提醒"));
                body = String(j.body || j.msg || j.message || body || "任务已完成");
                source = String(j.source || source);
              } else {
                title = cwdBase ? `✅ 海外 CC 干完活了（${cwdBase}）` : "✅ 海外 CC 干完活了！";
                body = String(j.message || "海外服务器上的任务已执行完毕");
                source = "cc-stop";
              }
            } catch {
              title = title || "🤖 远程服务器提醒";
              body = raw;
            }
          }
        }
        const saved = await stub.pushRelayEvent({ title, body, source });
        return Response.json(saved, { headers: { ...cors, "Cache-Control": "no-store" } });
      }
    }

    return Response.json({ ok: false, error: "not found" }, { status: 404, headers: cors });
  },
};
