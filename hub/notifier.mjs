import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { desktopRelay } from "./mobile-bridge.mjs";
import { broadcastMobileWebPush } from "./store.mjs";

const execFileAsync = promisify(execFile);

const HOME_DIR = os.homedir();
const AGENTAPI_BIN = process.env.TABPULSE_AGENTAPI_BIN || path.join(HOME_DIR, ".gemini", "antigravity", "bin", "agentapi");
const TRANSCRIPT_ROOT = path.join(HOME_DIR, ".gemini", "antigravity", "brain");
const EXEC_TIMEOUT_MS = 15000;

export const notificationLog = [];

function externalEffectsDisabled() {
  return process.env.TABPULSE_DISABLE_EXTERNAL_EFFECTS === "1";
}

function isPrivateOrLocalWebhookHost(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      h === "localhost" ||
      h === "0.0.0.0" ||
      h === "::1" ||
      h.endsWith(".local") ||
      h.endsWith(".internal") ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^169\.254\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
    ) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function normalizeCustomerPushTarget(rawInput = "") {
  const s = String(rawInput || "").trim();
  if (!s) return { kind: "none", url: "", token: "" };
  if (/^[0-9a-f]{32}$/i.test(s)) {
    return { kind: "pushplus", url: "https://www.pushplus.plus/send", token: s };
  }
  if (/^SCT[0-9a-zA-Z]{10,}$/.test(s)) {
    return { kind: "serverchan", url: `https://sctapi.ftqq.com/${s}.send`, token: s };
  }
  if (/^tg:\/\/([^@\s]+)@(-?\d+)$/i.test(s)) {
    const m = s.match(/^tg:\/\/([^@\s]+)@(-?\d+)$/i);
    return {
      kind: "telegram",
      url: `https://api.telegram.org/bot${m[1]}/sendMessage`,
      token: m[1],
      chatId: m[2],
    };
  }
  if (/^ntfy:\/\/([a-zA-Z0-9._-]{3,64})$/i.test(s)) {
    const topic = s.replace(/^ntfy:\/\//i, "");
    return { kind: "ntfy", url: `https://ntfy.sh/${topic}`, token: topic };
  }
  if (/^[A-Za-z0-9]{20,28}$/.test(s)) {
    return { kind: "bark", url: `https://api.day.app/${s}`, token: s };
  }
  if (/^https?:\/\//i.test(s)) {
    if (process.env.TABPULSE_ALLOW_LOCAL_WEBHOOK_TEST !== "1" && isPrivateOrLocalWebhookHost(s)) {
      return { kind: "invalid", url: "", token: "" };
    }
    if (/^https?:\/\/ntfy\.sh\/[a-zA-Z0-9._-]+/i.test(s)) {
      return { kind: "ntfy", url: s, token: "" };
    }
    return { kind: "url", url: s, token: "" };
  }
  return { kind: "invalid", url: "", token: "" };
}

function inspectWebhookJsonResult(data, defaultChannel) {
  if (!data || typeof data !== "object") return { ok: true, channel: defaultChannel };
  if (defaultChannel === "Telegram" && data.ok === false) {
    return { ok: false, channel: defaultChannel, error: data.description || "Telegram 推送失败" };
  }
  if (defaultChannel === "PushPlus" && typeof data.code === "number" && data.code !== 200) {
    return { ok: false, channel: defaultChannel, error: data.msg || `PushPlus 错误 (${data.code})` };
  }
  if (defaultChannel === "Bark" && typeof data.code === "number" && data.code !== 200) {
    return { ok: false, channel: defaultChannel, error: data.message || `Bark 错误 (${data.code})` };
  }
  if ((defaultChannel === "Server酱" || defaultChannel === "飞书") && typeof data.code === "number" && data.code !== 0) {
    return { ok: false, channel: defaultChannel, error: data.message || data.msg || `${defaultChannel} 错误 (${data.code})` };
  }
  if (typeof data.errcode === "number" && data.errcode !== 0) {
    return { ok: false, channel: defaultChannel, error: data.errmsg || `${defaultChannel} 错误 (${data.errcode})` };
  }
  return { ok: true, channel: defaultChannel };
}

export async function sendEmailPushNotification(emailCfg, subject, text) {
  if (!emailCfg || !emailCfg.enabled || !emailCfg.user || !emailCfg.pass) return null;
  const user = String(emailCfg.user).trim();
  const pass = String(emailCfg.pass).trim();
  const to = String(emailCfg.to || user).trim();
  const defaultHost = user.endsWith("@qq.com")
    ? "smtp.qq.com"
    : user.endsWith("@163.com")
      ? "smtp.163.com"
      : user.endsWith("@126.com")
        ? "smtp.126.com"
        : user.endsWith("@gmail.com")
          ? "smtp.gmail.com"
          : "";
  const host = String(emailCfg.host || defaultHost).trim();
  const port = Number(emailCfg.port) || 465;
  if (!host || !to) return { ok: false, channel: "Email", error: "缺少 SMTP 服务器地址或收件箱" };
  if (isPrivateOrLocalWebhookHost(`https://${host}`)) {
    return { ok: false, channel: "Email", error: "不允许使用内网 SMTP 地址" };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(res);
    };

    const socket = tls.connect({ host, port, servername: host, timeout: 10000 });
    let buf = "";
    let step = 0;

    const sendLine = (line) => socket.write(`${line}\r\n`);
    const encodeHeader = (str) => `=?UTF-8?B?${Buffer.from(String(str), "utf-8").toString("base64")}?=`;

    socket.on("timeout", () => finish({ ok: false, channel: "Email", error: "SMTP 连接超时" }));
    socket.on("error", (err) => finish({ ok: false, channel: "Email", error: err.message }));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const lines = buf.split("\r\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line || /^\d{3}-/.test(line)) continue;
        const code = parseInt(line.slice(0, 3), 10) || 0;
        if (code >= 400) {
          finish({ ok: false, channel: "Email", error: line.slice(0, 120) });
          return;
        }
        if (step === 0 && code === 220) {
          step = 1;
          sendLine("EHLO replyradar.local");
        } else if (step === 1 && code === 250) {
          step = 2;
          sendLine("AUTH LOGIN");
        } else if (step === 2 && code === 334) {
          step = 3;
          sendLine(Buffer.from(user, "utf-8").toString("base64"));
        } else if (step === 3 && code === 334) {
          step = 4;
          sendLine(Buffer.from(pass, "utf-8").toString("base64"));
        } else if (step === 4 && code === 235) {
          step = 5;
          sendLine(`MAIL FROM:<${user}>`);
        } else if (step === 5 && code === 250) {
          step = 6;
          sendLine(`RCPT TO:<${to}>`);
        } else if (step === 6 && (code === 250 || code === 251)) {
          step = 7;
          sendLine("DATA");
        } else if (step === 7 && code === 354) {
          step = 8;
          const bodyB64 = Buffer.from(String(text || ""), "utf-8").toString("base64");
          const mime = [
            `From: ${encodeHeader("消息总管")} <${user}>`,
            `To: <${to}>`,
            `Subject: ${encodeHeader(subject)}`,
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=UTF-8",
            "Content-Transfer-Encoding: base64",
            "",
            bodyB64,
            ".",
          ].join("\r\n");
          sendLine(mime);
        } else if (step === 8 && code === 250) {
          step = 9;
          sendLine("QUIT");
          finish({ ok: true, channel: "Email" });
        }
      }
    });
  });
}

export async function sendCustomerWebhook(webhookUrl, title, text, mobileLink = "") {
  const norm = normalizeCustomerPushTarget(webhookUrl);
  if (norm.kind === "none") return null;
  if (norm.kind === "invalid") {
    return {
      ok: false,
      channel: "invalid",
      error: "格式不正确：支持 32位 PushPlus 口令、SCT SendKey、Bark码、tg://BotToken@ChatId、ntfy://主题 或 https:// 链接",
    };
  }
  const url = norm.url;
  const fullText = mobileLink ? `${text}\n📱 手机点此直接看纯文字并回复：${mobileLink}` : text;
  try {
    if (norm.kind === "pushplus" || url.includes("pushplus.plus/send")) {
      const tok = norm.token || new URL(url).searchParams.get("token") || "";
      const r = await fetch("https://www.pushplus.plus/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tok, title, content: fullText, template: "txt" }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) return { status: r.status, ok: false, channel: "PushPlus", error: `HTTP ${r.status}` };
      return { status: r.status, ...inspectWebhookJsonResult(data, "PushPlus") };
    }

    if (norm.kind === "telegram") {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: norm.chatId, text: `${title}\n${fullText}` }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) return { status: r.status, ok: false, channel: "Telegram", error: data?.description || `HTTP ${r.status}` };
      return { status: r.status, ...inspectWebhookJsonResult(data, "Telegram") };
    }

    if (norm.kind === "ntfy") {
      const headers = {
        Title: Buffer.from(title, "utf-8").toString("ascii").replace(/[^\x20-\x7E]/g, "") || "ReplyRadar Alert",
        Priority: "high",
      };
      if (mobileLink) headers.Click = mobileLink;
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: `${title}\n${fullText}`,
      });
      if (!r.ok) return { status: r.status, ok: false, channel: "ntfy", error: `HTTP ${r.status}` };
      return { status: r.status, ok: true, channel: "ntfy" };
    }

    if (norm.kind === "bark" || (url.includes("api.day.app/") && url.replace(/\/+$/, "").split("/").length === 4)) {
      const base = url.replace(/\/+$/, "");
      const q = mobileLink ? `?url=${encodeURIComponent(mobileLink)}&sound=minuet` : "?sound=minuet";
      const barkUrl = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(text)}${q}`;
      const r = await fetch(barkUrl);
      const data = await r.json().catch(() => null);
      if (!r.ok) return { status: r.status, ok: false, channel: "Bark", error: `HTTP ${r.status}` };
      return { status: r.status, ...inspectWebhookJsonResult(data, "Bark") };
    }

    const channelLabel =
      url.includes("feishu.cn") || url.includes("larksuite.com")
        ? "飞书"
        : url.includes("qyapi.weixin.qq.com")
          ? "企业微信"
          : url.includes("oapi.dingtalk.com")
            ? "钉钉"
            : url.includes("discord.com/api/webhooks")
              ? "Discord"
              : url.includes("sctapi.ftqq.com")
                ? "Server酱"
                : "Webhook";

    const payload =
      channelLabel === "飞书"
        ? { msg_type: "text", content: { text: `${title}\n${fullText}` } }
        : channelLabel === "企业微信"
          ? { msgtype: "text", text: { content: `${title}\n${fullText}` } }
          : channelLabel === "钉钉"
            ? { msgtype: "text", text: { content: `【消息总管】${title}\n${fullText}` } }
            : channelLabel === "Discord"
              ? { content: `**${title}**\n${fullText}` }
              : channelLabel === "Server酱"
                ? { title, desp: fullText }
                : { text: `${title}\n${fullText}`, title, desp: fullText, body: fullText, url: mobileLink };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { status: res.status, ok: false, channel: channelLabel, error: `HTTP ${res.status}` };
    return { status: res.status, ...inspectWebhookJsonResult(data, channelLabel) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function showMacBanner(title, subtitle, watchId = "", targetKey = "") {
  // Primary: Push directly to connected native macOS 消息总管.app (UNUserNotificationCenter + Glass sound + clickable jump!)
  if (desktopRelay.isDesktopConnected()) {
    desktopRelay.pushNativeNotice({ title, body: subtitle, watchId, targetKey });
    return "native-app";
  }
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/osascript")) return null;
  try {
    const safeTitle = String(title).slice(0, 64).replace(/["\\]/g, "'");
    const safeSub = String(subtitle).slice(0, 90).replace(/["\\]/g, "'");
    await execFileAsync(
      "/usr/bin/osascript",
      ["-e", `display notification "${safeSub}" with title "${safeTitle}" sound name "Glass"`],
      { timeout: 5000 }
    );
    return "osascript";
  } catch {
    return null;
  }
}

function readTranscriptTailSummary(conversationId) {
  if (!conversationId) return "";
  const transcriptPath = path.join(TRANSCRIPT_ROOT, conversationId, ".system_generated", "logs", "transcript.jsonl");
  if (!fs.existsSync(transcriptPath)) return "";
  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean).slice(-5);
    const snippets = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.content && typeof obj.content === "string") {
          snippets.push(`[${obj.type || "STEP"}] ${obj.content.replace(/\s+/g, " ").slice(0, 80)}`);
        }
      } catch {}
    }
    return snippets.slice(-2).join(" | ");
  } catch {
    return "";
  }
}

export async function notifyUnread(item, settings = {}, mobileLink = "") {
  const targetKey = `web:${item.id}`;
  const deepLink = mobileLink ? `${mobileLink}#open=${encodeURIComponent(targetKey)}` : "";
  const subject = `🚨【消息总管】${item.name} 有 ${item.unreadCount} 条新消息`;
  const body = [
    `平台：${item.name}`,
    `未读数：${item.unreadCount}`,
    item.contextSummary ? `备注：${item.contextSummary}` : "",
    item.snippet ? `摘要：${item.snippet}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (externalEffectsDisabled()) {
    notificationLog.push({ type: "unread", id: item.id, subject, body, skipped: true });
    return { skipped: true, reason: "TABPULSE_DISABLE_EXTERNAL_EFFECTS=1" };
  }

  const result = { macBanner: null, agent: null, webhook: null, email: null, webPush: null };
  result.macBanner = await showMacBanner(
    `消息总管：${item.name} (${item.unreadCount}条新消息)`,
    item.snippet || item.contextSummary || "点击打开工作台或手机随身端直接回复",
    item.id,
    targetKey
  );

  result.webPush = await broadcastMobileWebPush({
    title: `🔴 ${item.name} (${item.unreadCount}条未读)`,
    body: item.snippet || item.contextSummary || "点击红点直接进入查看并回复",
    targetKey,
  }).catch(() => null);

  if (settings?.webhookUrl) {
    result.webhook = await sendCustomerWebhook(settings.webhookUrl, subject, body, deepLink);
  }

  if (settings?.emailPush?.enabled) {
    const emailBody = deepLink ? `${body}\n\n📱 手机直达回复：${deepLink}` : body;
    result.email = await sendEmailPushNotification(settings.emailPush, subject, emailBody).catch((e) => ({
      ok: false,
      channel: "Email",
      error: e.message,
    }));
  }

  if (item.conversationId && fs.existsSync(AGENTAPI_BIN)) {
    const tail = readTranscriptTailSummary(item.conversationId);
    const msg = [
      `【消息总管唤醒】监听平台「${item.name}」检测到 ${item.unreadCount} 条未读新消息。`,
      item.url ? `网址：${item.url}` : "",
      item.snippet ? `最新摘要：${item.snippet}` : "",
      tail ? `最近上下文：${tail}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      const { stdout } = await execFileAsync(AGENTAPI_BIN, ["send-message", item.conversationId, msg], {
        timeout: EXEC_TIMEOUT_MS,
      });
      result.agent = stdout.trim() || "sent";
    } catch (err) {
      result.agentError = err.message;
    }
  }

  return result;
}

export async function notifyAuthExpired(item, settings = {}, mobileLink = "") {
  const targetKey = `web:${item.id}`;
  const deepLink = mobileLink ? `${mobileLink}#open=${encodeURIComponent(targetKey)}` : "";
  const title = `🟠【消息总管】登录待刷新：${item.name}`;
  const summary = `平台「${item.name}」登录已过期，请在电脑或手机端直接扫码续登。`;

  if (externalEffectsDisabled()) {
    notificationLog.push({ type: "auth_expired", id: item.id, title, summary, skipped: true });
    return { skipped: true, reason: "TABPULSE_DISABLE_EXTERNAL_EFFECTS=1" };
  }

  await showMacBanner(title, summary, item.id, targetKey);
  await broadcastMobileWebPush({
    title,
    body: summary,
    targetKey,
  }).catch(() => null);

  if (settings?.webhookUrl) {
    await sendCustomerWebhook(settings.webhookUrl, title, summary, deepLink);
  }
  return { ok: true };
}

export async function notifyAgentAlert({ title, summary, targetKey = "" }, settings = {}, mobileLink = "") {
  if (externalEffectsDisabled()) {
    notificationLog.push({ type: "agent_alert", title, summary, skipped: true });
    return { skipped: true };
  }
  const deepLink = mobileLink && targetKey ? `${mobileLink}#open=${encodeURIComponent(targetKey)}` : mobileLink;
  await showMacBanner(title, summary, "", targetKey);
  const webPush = await broadcastMobileWebPush({
    title,
    body: summary,
    targetKey: targetKey || "cc:latest",
  }).catch(() => null);
  let webhook = null;
  if (settings?.webhookUrl) {
    webhook = await sendCustomerWebhook(settings.webhookUrl, title, summary, deepLink);
  }
  let email = null;
  if (settings?.emailPush?.enabled) {
    email = await sendEmailPushNotification(
      settings.emailPush,
      title,
      deepLink ? `${summary}\n\n📱 手机直达：${deepLink}` : summary
    ).catch(() => null);
  }
  return { ok: true, webhook, email, webPush };
}
