import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

export function resolveMcpRuntimePaths() {
  const mcpScript = path.join(PROJECT_ROOT, "mcp-server", "index.mjs");
  const skillFile = path.join(PROJECT_ROOT, "skills", "replyradar-notify", "SKILL.md");
  const nodeCandidates = [process.execPath, "/usr/local/bin/node", "/opt/homebrew/bin/node"];
  const nodeBin = nodeCandidates.find((p) => p && fs.existsSync(p)) || "node";
  return { nodeBin, mcpScript, skillFile };
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) || {};
  } catch {
    return {};
  }
}

function writeJsonWithBackup(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch {}
  }
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

function checkJsonMcpConnected(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw.includes("replyradar") || raw.includes("tabpulse");
  } catch {
    return false;
  }
}

export function listAiClientsStatus({ homeDir = os.homedir(), localPort = 17890 } = {}) {
  const { nodeBin, mcpScript, skillFile } = resolveMcpRuntimePaths();

  const claudeJson = path.join(homeDir, ".claude.json");
  const claudeDir = path.join(homeDir, ".claude");
  const cursorDir = path.join(homeDir, ".cursor");
  const cursorMcp = path.join(cursorDir, "mcp.json");
  const codexDir = path.join(homeDir, ".codex");
  const codexToml = path.join(codexDir, "config.toml");
  const windsurfMcp = path.join(homeDir, ".codeium", "windsurf", "mcp_config.json");
  const agyDir = path.join(homeDir, ".gemini", "antigravity");
  const agyConfigDir = path.join(homeDir, ".gemini", "config");
  const agyMcp = fs.existsSync(agyConfigDir)
    ? path.join(agyConfigDir, "mcp_config.json")
    : path.join(agyDir, "mcp_config.json");

  const clients = [
    {
      id: "claude-code",
      name: "Claude Code",
      desc: "自动注入 MCP 工具 + 终端完成自动推手机 Hook",
      detected: fs.existsSync(claudeDir) || fs.existsSync(claudeJson),
      connected: checkJsonMcpConnected(claudeJson),
      configPath: claudeJson,
    },
    {
      id: "cursor",
      name: "Cursor",
      desc: "自动写入 ~/.cursor/mcp.json 挂载手机通知与拍板工具",
      detected: fs.existsSync(cursorDir) || fs.existsSync("/Applications/Cursor.app"),
      connected: checkJsonMcpConnected(cursorMcp),
      configPath: cursorMcp,
    },
    {
      id: "codex",
      name: "OpenAI Codex CLI",
      desc: "自动写入 ~/.codex/config.toml 挂载 replyradar MCP 服务",
      detected: fs.existsSync(codexDir),
      connected:
        fs.existsSync(codexToml) &&
        fs.readFileSync(codexToml, "utf-8").includes("replyradar"),
      configPath: codexToml,
    },
    {
      id: "antigravity",
      name: "Antigravity / Gemini",
      desc: "自动挂载至 ~/.gemini/config/mcp_config.json 启用手机通知与拍板",
      detected: fs.existsSync(agyDir) || fs.existsSync(agyConfigDir) || fs.existsSync("/Applications/Antigravity.app"),
      connected: checkJsonMcpConnected(agyMcp),
      configPath: agyMcp,
    },
    {
      id: "windsurf",
      name: "Windsurf",
      desc: "自动写入 Windsurf MCP 配置文件",
      detected: fs.existsSync(path.dirname(windsurfMcp)) || fs.existsSync("/Applications/Windsurf.app"),
      connected: checkJsonMcpConnected(windsurfMcp),
      configPath: windsurfMcp,
    },
  ];

  const mcpSnippetJson = JSON.stringify(
    {
      mcpServers: {
        replyradar: {
          command: nodeBin,
          args: [mcpScript],
        },
      },
    },
    null,
    2
  );

  const oneSentenceForAnyAi = `请帮我调用本机《消息总管》(http://127.0.0.1:${localPort})：当你完成耗时任务时，POST JSON {"agentName":"你的名字","title":"任务完成","message":"结果摘要"} 到 http://127.0.0.1:${localPort}/api/ai-inbox/push 推我手机红点；当你需要我拍板做决定时，POST {"agentName":"你的名字","question":"问题","options":["同意继续","先暂停"]} 到 http://127.0.0.1:${localPort}/api/ai-inbox/ask 等待我在手机点选结果（或直接挂载 MCP: ${nodeBin} ${mcpScript}，技能说明见 ${skillFile}）。`;

  return {
    ok: true,
    nodeBin,
    mcpScript,
    skillFile,
    mcpSnippetJson,
    oneSentenceForAnyAi,
    clients,
  };
}

export function installAiClient(clientId, { homeDir = os.homedir(), localPort = 17890, mcpOnly = false } = {}) {
  const { nodeBin, mcpScript, skillFile } = resolveMcpRuntimePaths();
  const skillBody = !mcpOnly && fs.existsSync(skillFile) ? fs.readFileSync(skillFile, "utf-8") : "";
  const mcpEntry = { command: nodeBin, args: [mcpScript] };

  const installJsonMcp = (targetJsonPath) => {
    const obj = safeReadJson(targetJsonPath);
    if (!obj.mcpServers || typeof obj.mcpServers !== "object") obj.mcpServers = {};
    obj.mcpServers.replyradar = mcpEntry;
    writeJsonWithBackup(targetJsonPath, obj);
  };

  const copySkillTo = (destSkillPath) => {
    if (!skillBody || mcpOnly) return;
    fs.mkdirSync(path.dirname(destSkillPath), { recursive: true });
    fs.writeFileSync(destSkillPath, skillBody, "utf-8");
  };

  if (clientId === "claude-code") {
    installJsonMcp(path.join(homeDir, ".claude.json"));
    copySkillTo(path.join(homeDir, ".claude", "skills", "replyradar-notify", "SKILL.md"));

    // Also wire deterministic Stop & Notification hooks
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    const sObj = safeReadJson(settingsPath);
    if (!sObj.hooks || typeof sObj.hooks !== "object") sObj.hooks = {};
    const stopCmd = `curl -fsS -m 3 -X POST "http://127.0.0.1:${localPort}/api/cc/hook?event=Stop" -H "Content-Type: application/json" --data-binary @- >/dev/null 2>&1 || true`;
    const notifyCmd = `curl -fsS -m 3 -X POST "http://127.0.0.1:${localPort}/api/cc/hook?event=Notification" -H "Content-Type: application/json" --data-binary @- >/dev/null 2>&1 || true`;
    for (const [ev, cmd] of [["Stop", stopCmd], ["Notification", notifyCmd]]) {
      const arr = Array.isArray(sObj.hooks[ev]) ? sObj.hooks[ev] : [];
      if (!JSON.stringify(arr).includes("/api/cc/hook")) {
        arr.push({ matcher: "", hooks: [{ type: "command", command: cmd }] });
      }
      sObj.hooks[ev] = arr;
    }
    writeJsonWithBackup(settingsPath, sObj);
    return { ok: true, clientId, installed: true };
  }

  if (clientId === "cursor") {
    installJsonMcp(path.join(homeDir, ".cursor", "mcp.json"));
    if (!mcpOnly && skillBody) {
      const mdcPath = path.join(homeDir, ".cursor", "rules", "replyradar-notify.mdc");
      fs.mkdirSync(path.dirname(mdcPath), { recursive: true });
      fs.writeFileSync(
        mdcPath,
        `---\ndescription: Auto-notify user's phone or ask for mobile 1-tap approval via ReplyRadar MCP\nalwaysApply: true\n---\n\n${skillBody.replace(/^---[\s\S]*?---\s*/, "")}`,
        "utf-8"
      );
    }
    return { ok: true, clientId, installed: true };
  }

  if (clientId === "codex") {
    const tomlPath = path.join(homeDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    let raw = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, "utf-8") : "";
    if (!raw.includes("[mcp_servers.replyradar]")) {
      if (raw && !raw.endsWith("\n")) raw += "\n";
      raw += `\n[mcp_servers.replyradar]\ncommand = ${JSON.stringify(nodeBin)}\nargs = [${JSON.stringify(mcpScript)}]\n`;
      if (fs.existsSync(tomlPath)) {
        try { fs.copyFileSync(tomlPath, `${tomlPath}.bak`); } catch {}
      }
      fs.writeFileSync(tomlPath, raw, "utf-8");
    }
    copySkillTo(path.join(homeDir, ".codex", "skills", "replyradar-notify", "SKILL.md"));
    return { ok: true, clientId, installed: true };
  }

  if (clientId === "antigravity") {
    const agyCfgDir = path.join(homeDir, ".gemini", "config");
    const targetMcp = fs.existsSync(agyCfgDir)
      ? path.join(agyCfgDir, "mcp_config.json")
      : path.join(homeDir, ".gemini", "antigravity", "mcp_config.json");
    installJsonMcp(targetMcp);
    copySkillTo(path.join(homeDir, ".gemini", "config", "skills", "replyradar-notify", "SKILL.md"));
    return { ok: true, clientId, installed: true, configPath: targetMcp };
  }

  if (clientId === "windsurf") {
    installJsonMcp(path.join(homeDir, ".codeium", "windsurf", "mcp_config.json"));
    return { ok: true, clientId, installed: true };
  }

  return { ok: false, error: `未知 AI 客户端: ${clientId}` };
}
