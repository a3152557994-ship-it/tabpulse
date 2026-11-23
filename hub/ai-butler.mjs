import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { aiInbox } from "./ai-inbox.mjs";

const execFileAsync = promisify(execFile);
const HOME_DIR = os.homedir();

function buildAugmentedPath() {
  const extra = [
    path.join(HOME_DIR, ".local", "bin"),
    path.join(HOME_DIR, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return Array.from(new Set([...extra, ...(process.env.PATH || "").split(path.delimiter).filter(Boolean)])).join(
    path.delimiter
  );
}

function findBin(name) {
  for (const dir of buildAugmentedPath().split(path.delimiter)) {
    const full = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function extractJsonObject(rawText) {
  const str = String(rawText || "").trim();
  const m = str.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

class AiPersonalButler {
  constructor() {
    this.suggestionsByTarget = new Map(); // targetKey -> { summary, suggestedReplies, isSpam, provider, at }
    this.eventFeed = []; // real-time stream of incoming platform/app events for AI & MCP
    this.eventSeq = 0;
  }

  detectAvailableProviders() {
    const codexBin = findBin("codex");
    const claudeBin = findBin("claude");
    const geminiBin = findBin("gemini");
    const agentApiBin = path.join(HOME_DIR, ".gemini", "antigravity", "bin", "agentapi");
    return [
      {
        id: "codex",
        name: "ChatGPT / Codex 个人助理 (本机免 Key)",
        installed: Boolean(codexBin),
        bin: codexBin || "",
      },
      {
        id: "claude",
        name: "Claude Code 个人助理 (本机免 Key)",
        installed: Boolean(claudeBin),
        bin: claudeBin || "",
      },
      {
        id: "agentapi",
        name: "Antigravity 常驻助理窗口唤醒",
        installed: fs.existsSync(agentApiBin),
        bin: fs.existsSync(agentApiBin) ? agentApiBin : "",
      },
      {
        id: "webhook",
        name: "外部 AI Agent Webhook (OpenClaw / 扣子 / n8n)",
        installed: true,
        bin: "",
      },
      {
        id: "openai_api",
        name: "自定义大模型 API (OpenAI / DeepSeek 兼容)",
        installed: true,
        bin: "",
      },
      ...(geminiBin
        ? [{ id: "gemini", name: "Gemini CLI (本机)", installed: true, bin: geminiBin }]
        : []),
    ];
  }

  recordLiveEvent(ev) {
    this.eventSeq += 1;
    const item = {
      seq: this.eventSeq,
      at: new Date().toISOString(),
      ...ev,
    };
    this.eventFeed.unshift(item);
    if (this.eventFeed.length > 80) this.eventFeed.length = 80;
    return item;
  }

  getEventsSince(sinceSeq = 0) {
    const n = Number(sinceSeq) || 0;
    const events = this.eventFeed.filter((e) => e.seq > n);
    return {
      ok: true,
      latestSeq: this.eventSeq,
      events,
      suggestions: Object.fromEntries(this.suggestionsByTarget.entries()),
    };
  }

  getSuggestion(targetKey) {
    return this.suggestionsByTarget.get(targetKey) || null;
  }

  buildTriagePrompt({ platformName, snippet, contextSummary, customPersona }) {
    return [
      "你是主人的全平台私人 AI 助理。刚刚《消息总管》监听到一条新消息，请立即判断是否为广告噪音，若是真实消息请给出 1 句精炼汇报和 2 条可直接发给对方的得体回复草稿。",
      customPersona ? `主人业务背景与口吻要求：${customPersona}` : "",
      `来源平台/软件：${platformName}`,
      contextSummary ? `此前背景备注：${contextSummary}` : "",
      `刚刚收到的新消息内容：${snippet}`,
      '请严格只输出一段 JSON（不要输出 Markdown 代码块）：{"isSpam":false,"summary":"一句话汇报重点","suggestedReplies":["草稿1","草稿2"]}',
    ]
      .filter(Boolean)
      .join("\n");
  }

  async runAiTriage(event, settings = {}) {
    // Always record into real-time AI/MCP event stream so connected AIs know immediately!
    const recorded = this.recordLiveEvent(event);

    if (!settings?.aiButlerEnabled) {
      return { enabled: false, event: recorded };
    }

    const provider = settings.aiButlerProvider || "codex";
    const prompt = this.buildTriagePrompt({
      platformName: event.platformName,
      snippet: event.snippet,
      contextSummary: event.contextSummary || "",
      customPersona: settings.aiButlerPersona || "",
    });

    let parsed = null;

    try {
      if (provider === "rule_fast" || process.env.TABPULSE_BUTLER_MOCK === "1") {
        const lower = String(event.snippet || "").toLowerCase();
        const isSpam = /促销|广告|退订|unsubscribe|官方活动/.test(lower);
        parsed = isSpam
          ? { isSpam: true, summary: "系统营销广播，已静默过滤", suggestedReplies: [] }
          : {
              isSpam: false,
              summary: `${event.platformName} 来新消息：${String(event.snippet || "").slice(0, 48)}`,
              suggestedReplies: [
                "你好，刚看到您的消息，现在方便直接沟通～",
                "收到！我马上为您确认一下细节稍后回复您。",
              ],
            };
      } else if (provider === "codex") {
        const bin = findBin("codex");
        if (bin) {
          const { stdout } = await execFileAsync(bin, ["exec", "--skip-git-repo-check", prompt], {
            timeout: 25000,
            env: { ...process.env, PATH: buildAugmentedPath(), NO_COLOR: "1" },
          });
          parsed = extractJsonObject(stdout);
        }
      } else if (provider === "claude") {
        const bin = findBin("claude");
        if (bin) {
          const { stdout } = await execFileAsync(bin, ["-p", prompt], {
            timeout: 25000,
            env: { ...process.env, PATH: buildAugmentedPath(), NO_COLOR: "1" },
          });
          parsed = extractJsonObject(stdout);
        }
      } else if (provider === "agentapi") {
        const agentApiBin = path.join(HOME_DIR, ".gemini", "antigravity", "bin", "agentapi");
        const convId = String(settings.aiButlerConversationId || "").trim();
        if (convId && fs.existsSync(agentApiBin)) {
          const wakeMsg = `【消息总管实时唤醒】「${event.platformName}」刚收到新消息：${event.snippet}\n（目标通道：${event.targetKey}，如需推主人手机拍板请调 tabpulse_ask_human）`;
          await execFileAsync(agentApiBin, ["send-message", convId, wakeMsg], { timeout: 12000 });
          parsed = {
            isSpam: false,
            summary: `已实时唤醒 Antigravity 助理窗口处理「${event.platformName}」新消息`,
            suggestedReplies: [],
          };
        }
      } else if (provider === "webhook" && settings.aiButlerWebhookUrl) {
        const r = await fetch(String(settings.aiButlerWebhookUrl).trim(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: "incoming_message", ...recorded }),
        });
        const txt = await r.text();
        parsed = extractJsonObject(txt) || {
          isSpam: false,
          summary: `已实时推送给外部 AI 助理 (${r.status})`,
          suggestedReplies: [],
        };
      } else if (provider === "openai_api" && settings.aiButlerApiUrl && settings.aiButlerApiKey) {
        const base = String(settings.aiButlerApiUrl).replace(/\/+$/, "");
        const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.aiButlerApiKey}`,
          },
          body: JSON.stringify({
            model: settings.aiButlerModel || "gpt-4o-mini",
            temperature: 0.3,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const j = await r.json();
        parsed = extractJsonObject(j?.choices?.[0]?.message?.content || "");
      }
    } catch (err) {
      return { enabled: true, ok: false, error: err.message, event: recorded };
    }

    if (!parsed) return { enabled: true, ok: false, event: recorded };

    const suggestion = {
      targetKey: event.targetKey,
      platformName: event.platformName,
      incomingSnippet: event.snippet,
      isSpam: Boolean(parsed.isSpam),
      summary: String(parsed.summary || "").trim(),
      suggestedReplies: Array.isArray(parsed.suggestedReplies)
        ? parsed.suggestedReplies.map(String).filter(Boolean).slice(0, 3)
        : [],
      provider,
      at: new Date().toISOString(),
    };

    this.suggestionsByTarget.set(event.targetKey, suggestion);

    // If AI identified it as real (non-spam), post an actionable card into AI Personal Assistant channel!
    if (!suggestion.isSpam) {
      aiInbox.pushNotification({
        agentName: "🧠 AI 个人助理",
        title: `${event.platformName} 来信汇报`,
        message: [
          `📩 原消息：${event.snippet}`,
          suggestion.summary ? `💡 AI 研判：${suggestion.summary}` : "",
          suggestion.suggestedReplies.length
            ? `✍️ 已为您拟好回复（点进「${event.platformName}」即可一键发出）：\n1) ${suggestion.suggestedReplies[0]}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }

    return { enabled: true, ok: true, isSpam: suggestion.isSpam, suggestion, event: recorded };
  }
}

export const aiButler = new AiPersonalButler();
