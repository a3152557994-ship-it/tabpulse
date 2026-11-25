import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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

export function normalizeCustomerPushTarget(rawInput = "") {
  const s = String(rawInput || "").trim();
  if (!s) return { kind: "none", url: "", token: "" };
  if (/^[0-9a-f]{32}$/i.test(s)) {
    return { kind: "pushplus", url: "https://www.pushplus.plus/send", token: s };
  }
  if (/^SCT[0-9a-zA-Z]{10,}$/.test(s)) {
    return { kind: "serverchan", url: `https://sctapi.ftqq.com/${s}.send`, token: s };
  }
  if (/^[A-Za-z0-9]{20,28}$/.test(s)) {
    return { kind: "bark", url: `https://api.day.app/${s}`, token: s };
  }
  if (/^https?:\/\//i.test(s)) {
    return { kind: "url", url: s, token: "" };
  }
  return { kind: "invalid", url: "", token: "" };
}

function inspectWebhookJsonResult(data, defaultChannel) {
  if (!data || typeof data !== "object") return { ok: true, channel: defaultChannel };
  // PushPlus: { code: 200, msg: "请求成功" }
  if (defaultChannel === "PushPlus" && typeof data.code === "number" && data.code !== 200) {
    return { ok: false, channel: defaultChannel, error: data.msg || `PushPlus 错误 (${data.code})` };
  }
  // Bark: { code: 200, message: "success" }
  if (defaultChannel === "Bark" && typeof data.code === "number" && data.code !== 200) {
    return { ok: false, channel: defaultChannel, error: data.message || `Bark 错误 (${data.code})` };
  }
  // Server酱 / Feishu: { code: 0, ... }
  if ((defaultChannel === "Server酱" || defaultChannel === "飞书") && typeof data.code === "number" && data.code !== 0) {
    return { ok: false, channel: defaultChannel, error: data.message || data.msg || `${defaultChannel} 错误 (${data.code})` };
  }
  // WeCom / DingTalk: { errcode: 0, errmsg: "ok" }
  if (typeof data.errcode === "number" && data.errcode !== 0) {
    return { ok: false, channel: defaultChannel, error: data.errmsg || `${defaultChannel} 错误 (${data.errcode})` };
  }
  return { ok: true, channel: defaultChannel };
}

export async function sendCustomerWebhook(webhookUrl, title, text, mobileLink = "") {
  const norm = normalizeCustomerPushTarget(webhookUrl);
  if (norm.kind === "none") return null;
  if (norm.kind === "invalid") {
    return {
      ok: false,
      channel: "invalid",
      error: "格式不正确：请粘贴 32 位 PushPlus 口令、SCT 开头 SendKey、Bark 码或 https:// 开头链接",
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

    // Bark GET URL support (https://api.day.app/<key>) with ?url= jump straight into Mobile Pocket Console
    if (norm.kind === "bark" || (url.includes("api.day.app/") && url.replace(/\/+$/, "").split("/").length === 4)) {
      const base = url.replace(/\/+$/, "");
      const q = mobileLink ? `?url=${encodeURIComponent(mobileLink)}` : "";
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

async function showMacBanner(title, subtitle) {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/osascript")) return null;
  try {
    const safeTitle = String(title).slice(0, 64).replace(/["\\]/g, "'");
    const safeSub = String(subtitle).slice(0, 90).replace(/["\\]/g, "'");
    await execFileAsync(
      "/usr/bin/osascript",
      ["-e", `display notification "${safeSub}" with title "${safeTitle}" sound name "Glass"`],
      { timeout: 5000 }
    );
    return "shown";
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

  const result = { macBanner: null, agent: null, webhook: null, webPush: null };
  result.macBanner = await showMacBanner(
    `消息总管：${item.name} (${item.unreadCount}条新消息)`,
    item.snippet || item.contextSummary || "点击打开工作台或手机随身端直接回复"
  );

  result.webPush = await broadcastMobileWebPush({
    title: `🔴 ${item.name} (${item.unreadCount}条未读)`,
    body: item.snippet || item.contextSummary || "点击红点直接进入查看并回复",
    targetKey,
  }).catch(() => null);

  if (settings?.webhookUrl) {
    result.webhook = await sendCustomerWebhook(settings.webhookUrl, subject, body, deepLink);
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
  const summary = `平台「${item.name}」当前未登录，已自动停检保护账号。`;

  if (externalEffectsDisabled()) {
    notificationLog.push({ type: "auth_expired", id: item.id, title, summary, skipped: true });
    return { skipped: true, reason: "TABPULSE_DISABLE_EXTERNAL_EFFECTS=1" };
  }

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
  await showMacBanner(title, summary);
  const webPush = await broadcastMobileWebPush({
    title,
    body: summary,
    targetKey: targetKey || "cc:latest",
  }).catch(() => null);
  let webhook = null;
  if (settings?.webhookUrl) {
    webhook = await sendCustomerWebhook(settings.webhookUrl, title, summary, deepLink);
  }
  return { ok: true, webhook, webPush };
}
