import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME_DIR = os.homedir();

function resolveAiInboxFile() {
  if (process.env.TABPULSE_DATA_FILE) {
    return path.join(path.dirname(process.env.TABPULSE_DATA_FILE), "ai-inbox.json");
  }
  return path.join(HOME_DIR, ".tabpulse", "ai-inbox.json");
}

function slugifyAgent(name) {
  const clean = String(name || "AI助手")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "ai-assistant";
}

class AiInboxBridge {
  constructor() {
    this.channels = new Map(); // slug -> channelObj
    this.pendingWaiters = new Map(); // requestId -> { resolve, timer, slug }
    this.onAiAlert = null;
    this.loadedPath = "";
  }

  ensureLoaded() {
    const p = resolveAiInboxFile();
    if (this.loadedPath === p) return;
    this.loadedPath = p;
    this.channels.clear();
    if (!fs.existsSync(p)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      for (const ch of raw.channels || []) {
        if (ch && ch.id) this.channels.set(ch.id, ch);
      }
    } catch {}
  }

  persist() {
    const p = resolveAiInboxFile();
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const arr = Array.from(this.channels.values()).slice(0, 30);
      fs.writeFileSync(p, JSON.stringify({ channels: arr }, null, 2), "utf-8");
    } catch {}
  }

  getOrCreateChannel(agentName = "AI 助手", extra = {}) {
    this.ensureLoaded();
    const label = String(agentName || "AI 助手").trim() || "AI 助手";
    const id = slugifyAgent(extra.channelId || label);
    let ch = this.channels.get(id);
    if (!ch) {
      ch = {
        id,
        key: `ai:${id}`,
        agentName: label,
        conversationId: extra.conversationId || "",
        unreadCount: 0,
        unreadForAi: [],
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      this.channels.set(id, ch);
    } else {
      if (label) ch.agentName = label;
      if (extra.conversationId) ch.conversationId = extra.conversationId;
    }
    return ch;
  }

  pushNotification({ agentName = "AI 助手", title = "", message = "", options = [], conversationId = "" } = {}) {
    const ch = this.getOrCreateChannel(agentName, { conversationId });
    const now = new Date().toISOString();
    const cleanText = [title ? `【${title}】` : "", String(message || "").trim()].filter(Boolean).join("\n");
    const msgEntry = {
      id: `aim_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`,
      role: "ai",
      title: String(title || ""),
      text: cleanText || "AI 任务已完成",
      options: Array.isArray(options) ? options.map(String).filter(Boolean).slice(0, 6) : [],
      at: now,
    };
    ch.messages.push(msgEntry);
    if (ch.messages.length > 60) ch.messages = ch.messages.slice(-60);
    ch.unreadCount = (Number(ch.unreadCount) || 0) + 1;
    ch.updatedAt = now;
    this.persist();

    if (this.onAiAlert) {
      this.onAiAlert({
        title: title ? `🤖 ${ch.agentName}：${title}` : `🤖 ${ch.agentName} 新提醒`,
        summary: String(message || title || "点击手机红点查看详情").slice(0, 160),
        targetKey: ch.key,
      });
    }

    return { ok: true, channelId: ch.id, targetKey: ch.key, message: msgEntry };
  }

  askHumanAndWait({
    agentName = "AI 助手",
    question = "",
    options = [],
    context = "",
    conversationId = "",
    timeoutSeconds = 240,
  } = {}) {
    const ch = this.getOrCreateChannel(agentName, { conversationId });
    const now = new Date().toISOString();
    const requestId = `ask_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
    const normalizedOpts =
      Array.isArray(options) && options.length
        ? options.map(String).filter(Boolean).slice(0, 6)
        : ["✅ 同意继续", "⏸️ 先暂停"];

    const fullText = [
      `❓ 需要你拍板确认：`,
      String(question || "请确认下一步操作").trim(),
      context ? `\n补充背景：${String(context).trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const msgEntry = {
      id: requestId,
      requestId,
      role: "ai",
      isQuestion: true,
      answered: false,
      answer: "",
      text: fullText,
      options: normalizedOpts,
      at: now,
    };

    ch.messages.push(msgEntry);
    if (ch.messages.length > 60) ch.messages = ch.messages.slice(-60);
    ch.unreadCount = (Number(ch.unreadCount) || 0) + 1;
    ch.updatedAt = now;
    this.persist();

    if (this.onAiAlert) {
      this.onAiAlert({
        title: `❓ [${ch.agentName}] 等你手机拍板`,
        summary: `${String(question || "").slice(0, 110)}（点红点一键选择）`,
        targetKey: ch.key,
      });
    }

    const waitMs = Math.max(1000, Math.min(600_000, Number(timeoutSeconds || 240) * 1000));

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWaiters.delete(requestId);
        resolve({
          ok: true,
          answered: false,
          timedOut: true,
          requestId,
          channelId: ch.id,
          hint: "用户在等待时间内暂未点击手机回复，可稍后调用 tabpulse_check_human_replies 查看异步回复",
        });
      }, waitMs);

      this.pendingWaiters.set(requestId, {
        slug: ch.id,
        timer,
        resolve,
      });
    });
  }

  submitHumanReply({ channelId = "", requestId = "", text = "" } = {}) {
    this.ensureLoaded();
    const cleanReply = String(text || "").trim();
    if (!cleanReply) return { ok: false, error: "回复内容不能为空" };

    let ch = this.channels.get(channelId) || this.channels.get(slugifyAgent(channelId));
    if (!ch && requestId) {
      for (const candidate of this.channels.values()) {
        if ((candidate.messages || []).some((m) => m.requestId === requestId)) {
          ch = candidate;
          break;
        }
      }
    }
    if (!ch) {
      ch = this.getOrCreateChannel(channelId || "AI 助手");
    }

    const now = new Date().toISOString();
    ch.unreadCount = 0;
    ch.updatedAt = now;

    // Match specific requestId OR latest unanswered question in this channel
    let matchedQuestion = null;
    if (requestId) {
      matchedQuestion = (ch.messages || []).find((m) => m.requestId === requestId);
    } else {
      for (let i = ch.messages.length - 1; i >= 0; i--) {
        if (ch.messages[i].isQuestion && !ch.messages[i].answered) {
          matchedQuestion = ch.messages[i];
          break;
        }
      }
    }

    if (matchedQuestion) {
      matchedQuestion.answered = true;
      matchedQuestion.answer = cleanReply;
    }

    const userMsg = {
      id: `usr_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`,
      role: "user",
      text: cleanReply,
      replyToRequestId: matchedQuestion?.requestId || "",
      at: now,
    };
    ch.messages.push(userMsg);
    if (ch.messages.length > 60) ch.messages = ch.messages.slice(-60);

    const resolvedReqId = matchedQuestion?.requestId || requestId;
    const waiter = resolvedReqId ? this.pendingWaiters.get(resolvedReqId) : null;
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pendingWaiters.delete(resolvedReqId);
      this.persist();
      waiter.resolve({
        ok: true,
        answered: true,
        requestId: resolvedReqId,
        channelId: ch.id,
        answer: cleanReply,
        answeredAt: now,
      });
      return { ok: true, deliveredLiveToWaitingAi: true, channel: ch };
    }

    // Queue for async AI pull via tabpulse_check_human_replies
    if (!Array.isArray(ch.unreadForAi)) ch.unreadForAi = [];
    ch.unreadForAi.push({
      id: userMsg.id,
      text: cleanReply,
      requestId: resolvedReqId || "",
      at: now,
    });
    this.persist();
    return {
      ok: true,
      deliveredLiveToWaitingAi: false,
      queuedForAi: true,
      conversationId: ch.conversationId || "",
      channel: ch,
    };
  }

  pullPendingRepliesForAi({ agentName = "", consume = true } = {}) {
    this.ensureLoaded();
    const targetSlug = agentName ? slugifyAgent(agentName) : "";
    const items = [];
    for (const ch of this.channels.values()) {
      if (targetSlug && ch.id !== targetSlug) continue;
      const pending = Array.isArray(ch.unreadForAi) ? ch.unreadForAi : [];
      for (const item of pending) {
        items.push({ agentName: ch.agentName, channelId: ch.id, ...item });
      }
      if (consume && pending.length) {
        ch.unreadForAi = [];
      }
    }
    if (consume && items.length) this.persist();
    return { ok: true, count: items.length, replies: items };
  }

  clearChannelUnread(channelId) {
    this.ensureLoaded();
    const ch = this.channels.get(channelId) || this.channels.get(slugifyAgent(channelId));
    if (ch) {
      ch.unreadCount = 0;
      this.persist();
    }
    return { ok: true };
  }

  listChannels() {
    this.ensureLoaded();
    const list = Array.from(this.channels.values()).map((ch) => {
      const last = (ch.messages || [])[ch.messages.length - 1];
      const hasPendingAsk = (ch.messages || []).some((m) => m.isQuestion && !m.answered);
      return {
        id: ch.id,
        key: ch.key,
        agentName: ch.agentName,
        unreadCount: Number(ch.unreadCount) || 0,
        hasPendingAsk,
        updatedAt: ch.updatedAt,
        snippet: last ? last.text.replace(/\s+/g, " ").slice(0, 95) : "AI 自动通知与手机一键拍板通道",
        messages: ch.messages || [],
      };
    });
    list.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return list;
  }
}

export const aiInbox = new AiInboxBridge();
