import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PYTHON_BIN = "/usr/bin/python3";
const HOME_DIR = os.homedir();
const NOTIFY_SCRIPT = process.env.TABPULSE_NOTIFY_SCRIPT || path.join(HOME_DIR, ".gemini", "config", "assistant", "notify.py");
const AGENTAPI_BIN = process.env.TABPULSE_AGENTAPI_BIN || path.join(HOME_DIR, ".gemini", "antigravity", "bin", "agentapi");
const TRANSCRIPT_ROOT = path.join(HOME_DIR, ".gemini", "antigravity", "brain");
const EXEC_TIMEOUT_MS = 15000;

export const notificationLog = [];

function externalEffectsDisabled() {
  return process.env.TABPULSE_DISABLE_EXTERNAL_EFFECTS === "1";
}

async function sendCustomerWebhook(webhookUrl, title, text) {
  const url = String(webhookUrl || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    // Compatible with Feishu/Lark, Slack, Discord, ServerChan, Bark, and generic JSON webhooks
    const payload = url.includes("feishu.cn") || url.includes("larksuite.com")
      ? { msg_type: "text", content: { text: `${title}\n${text}` } }
      : url.includes("discord.com/api/webhooks")
        ? { content: `**${title}**\n${text}` }
        : { text: `${title}\n${text}`, title, desp: text, body: text };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, ok: res.ok };
  } catch (err) {
    return { ok: false, error: err.message };
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
      } catch {
        // ignore malformed trailing line
      }
    }
    return snippets.slice(-2).join(" | ");
  } catch {
    return "";
  }
}

export async function notifyUnread(item, settings = {}) {
  const subject = `🚨 【AI推送】万站回音：${item.name} 有 ${item.unreadCount} 条新消息`;
  const body = [
    `平台：${item.name}（${item.url}）`,
    `未读数：${item.unreadCount}`,
    item.contextSummary ? `当初背景：${item.contextSummary}` : "",
    item.snippet ? `消息摘要：${item.snippet}` : "",
    `建议动作：打开万站回音桌面端或 http://127.0.0.1:17890 查看 AI 拟好的草稿，并一键跳回官方后台回复。`,
  ]
    .filter(Boolean)
    .join("\n");

  if (externalEffectsDisabled()) {
    notificationLog.push({ type: "unread", id: item.id, subject, body, skipped: true });
    return { skipped: true, reason: "TABPULSE_DISABLE_EXTERNAL_EFFECTS=1" };
  }

  const result = { notify: null, agent: null, webhook: null };

  if (settings?.webhookUrl) {
    result.webhook = await sendCustomerWebhook(settings.webhookUrl, subject, body);
  }

  if (fs.existsSync(NOTIFY_SCRIPT)) {
    try {
      const { stdout } = await execFileAsync(
        PYTHON_BIN,
        [NOTIFY_SCRIPT, "--subject", subject, "--urgent", body],
        { timeout: EXEC_TIMEOUT_MS }
      );
      result.notify = stdout.trim();
    } catch (err) {
      result.notifyError = err.message;
    }
  }

  if (item.conversationId && fs.existsSync(AGENTAPI_BIN)) {
    const tail = readTranscriptTailSummary(item.conversationId);
    const tierNote =
      item.publishTier === "red"
        ? "该平台属红灯手发平台，只起草回复并保存到 TabPulse 草稿框（POST /api/watches/" +
          item.id +
          "/draft），严禁自动点击发送。"
        : "请先起草回复写入 TabPulse 草稿框，再按平台安全规则推进。";
    const msg = [
      `【TabPulse 万站回音唤醒】监听平台「${item.name}」检测到 ${item.unreadCount} 条未读新消息。`,
      item.url ? `网址：${item.url}` : "",
      item.contextSummary ? `原任务背景：${item.contextSummary}` : "",
      item.snippet ? `最新摘要：${item.snippet}` : "",
      tail ? `最近对话上下文：${tail}` : "",
      tierNote,
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

export async function notifyAuthExpired(item, settings = {}) {
  const title = `TabPulse 登录过期提醒：${item.name}`;
  const summary = `平台「${item.name}」跳转到登录页，哨兵已自动暂停重试以防触发风控。`;
  const action = `打开万站回音桌面端点击「内置登录」重登一次（或不需要再蹲就点暂停）。`;

  if (externalEffectsDisabled()) {
    notificationLog.push({ type: "auth_expired", id: item.id, title, summary, skipped: true });
    return { skipped: true, reason: "TABPULSE_DISABLE_EXTERNAL_EFFECTS=1" };
  }

  if (settings?.webhookUrl) {
    await sendCustomerWebhook(settings.webhookUrl, title, `${summary}\n${action}`);
  }

  if (!fs.existsSync(NOTIFY_SCRIPT)) {
    return { enqueued: false, skipped: true };
  }

  try {
    const { stdout } = await execFileAsync(
      PYTHON_BIN,
      [
        NOTIFY_SCRIPT,
        "--enqueue",
        "--account",
        "TabPulse",
        "--title",
        title,
        "--summary",
        summary,
        "--action",
        action,
      ],
      { timeout: EXEC_TIMEOUT_MS }
    );
    return { enqueued: true, stdout: stdout.trim() };
  } catch (err) {
    return { enqueued: false, error: err.message };
  }
}
