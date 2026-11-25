import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aiInbox } from "./ai-inbox.mjs";

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

/**
 * Run a local CLI tool with stdin strictly closed ('ignore') so tools like `codex exec`
 * never hang waiting on 'Reading additional input from stdin...'.
 */
function runCliClosedStdin(bin, args, timeoutMs = 24000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: buildAugmentedPath(), NO_COLOR: "1" },
    });
    const outChunks = [];
    const errChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGTERM"); } catch {}
        reject(new Error(`CLI timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (c) => outChunks.push(c));
    child.stderr.on("data", (c) => errChunks.push(c));
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `Exited with code ${code}`));
      } else {
        resolve({ stdout, stderr, code });
      }
    });
  });
}

/**
 * Extract the LAST valid triage JSON object from CLI output so echoed user prompts
 * (e.g. from `codex exec`) never corrupt JSON.parse!
 */
export function extractJsonObject(rawText) {
  const str = String(rawText || "").trim();
  if (!str) return null;

  // 1. Direct parse
  try {
    const direct = JSON.parse(str);
    if (direct && typeof direct === "object" && "isSpam" in direct) return direct;
  } catch {}

  // 2. Scan lines from bottom to top for clean JSON object
  const lines = str.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object" && ("summary" in obj || "isSpam" in obj)) {
          if (obj.summary !== "一句话汇报重点") return obj;
        }
      } catch {}
    }
  }

  // 3. Balanced brace scan from end of string
  const closeIdx = str.lastIndexOf("}");
  if (closeIdx > 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = closeIdx; i >= 0; i--) {
      const ch = str[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "}") depth++;
      else if (ch === "{") {
        depth--;
        if (depth === 0) {
          try {
            const cand = JSON.parse(str.slice(i, closeIdx + 1));
            if (cand && typeof cand === "object") return cand;
          } catch {}
          break;
        }
      }
    }
  }
  return null;
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
      ...(geminiBin
        ? [{ id: "gemini", name: "Gemini CLI 个人助理 (本机免 Key)", installed: true, bin: geminiBin }]
        : []),
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
        id: "rule_fast",
        name: "本地零延迟规则引擎 (离线秒回)",
        installed: true,
        bin: "",
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
      "你是主人的全平台私人 AI 助理。刚刚《消息总管》监听到一条新消息，请立即判断是否为系统促销/广告垃圾噪音；若是真实客户或重要通知，请给出 1 句精炼中文汇报和 2 条可直接发给对方的得体回复草稿。",
      customPersona ? `主人业务背景与口吻要求：${customPersona}` : "",
      `来源平台/软件：${platformName}`,
      contextSummary ? `此前背景备注：${contextSummary}` : "",
      `刚刚收到的新消息内容：${snippet}`,
      "只输出一行合法 JSON 对象（不要用 Markdown 代码块），包含布尔字段 isSpam、字符串字段 summary、字符串数组字段 suggestedReplies（2条回复草稿）。",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async runAiTriage(event, settings = {}) {
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
          const outFile = path.join(os.tmpdir(), `tp-butler-${process.pid}-${Date.now()}.txt`);
          try {
            const { stdout } = await runCliClosedStdin(
              bin,
              ["exec", "--skip-git-repo-check", "-s", "read-only", "-o", outFile, prompt],
              24000
            );
            const replyTxt = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf-8") : stdout;
            parsed = extractJsonObject(replyTxt) || extractJsonObject(stdout);
          } finally {
            try { fs.unlinkSync(outFile); } catch {}
          }
        }
      } else if (provider === "gemini") {
        const bin = findBin("gemini");
        if (bin) {
          const { stdout } = await runCliClosedStdin(bin, ["-p", prompt], 24000);
          parsed = extractJsonObject(stdout);
        }
      } else if (provider === "claude") {
        const bin = findBin("claude");
        if (bin) {
          const { stdout } = await runCliClosedStdin(bin, ["-p", prompt], 24000);
          parsed = extractJsonObject(stdout);
        }
      } else if (provider === "agentapi") {
        const agentApiBin = path.join(HOME_DIR, ".gemini", "antigravity", "bin", "agentapi");
        const convId = String(settings.aiButlerConversationId || "").trim();
        if (convId && fs.existsSync(agentApiBin)) {
          const wakeMsg = `【消息总管实时唤醒】「${event.platformName}」刚收到新消息：${event.snippet}\n（目标通道：${event.targetKey}，如需推主人手机拍板请调 tabpulse_ask_human）`;
          await runCliClosedStdin(agentApiBin, ["send-message", convId, wakeMsg], 12000);
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
