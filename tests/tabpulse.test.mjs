import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { signLicensePayload } from "../bin/generate-license.mjs";
import { verifyLicenseKey } from "../hub/license.mjs";
import { notificationLog } from "../hub/notifier.mjs";
import { createHubServer } from "../hub/server.mjs";
import {
  computeNextCheck,
  getDueWatches,
  loadState,
  recordProbeReport,
  resolveWatch,
} from "../hub/store.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tabpulse-test-"));
const tmpStateFile = path.join(tmpDir, "state.json");

process.env.TABPULSE_DATA_FILE = tmpStateFile;
process.env.TABPULSE_DISABLE_EXTERNAL_EFFECTS = "1";

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("store initializes 7 seed watches, protects sleep window, and deduplicates alerts", () => {
  const state = loadState(new Date("2026-11-15T05:00:00.000Z"));
  assert.equal(state.watches.length, 7);
  const ids = new Set(state.watches.map((w) => w.id));
  assert.ok(ids.has("xhs-creator"));
  assert.ok(ids.has("eleduck-inbox"));
  assert.ok(ids.has("crazygames-dev"));

  const nightProbe = computeNextCheck(
    { baseIntervalMinutes: 60, createdAt: "2026-11-15T00:00:00.000Z", totalUnreadSeen: 0 },
    new Date("2026-11-15T15:30:00.000Z"),
    () => 0.5
  );
  const shanghaiWall = new Date(new Date(nightProbe).getTime() + 8 * 3600 * 1000);
  assert.equal(shanghaiWall.getUTCHours(), 8);
  assert.ok(shanghaiWall.getUTCMinutes() >= 5 && shanghaiWall.getUTCMinutes() <= 45);

  const oldNext = computeNextCheck(
    { baseIntervalMinutes: 400, createdAt: "2026-11-01T00:00:00.000Z", totalUnreadSeen: 0 },
    new Date("2026-11-15T04:00:00.000Z"),
    () => 0.5
  );
  const diffMinutes = Math.round((new Date(oldNext).getTime() - new Date("2026-11-15T04:00:00.000Z").getTime()) / 60000);
  assert.ok(diffMinutes >= 720);

  const r1 = recordProbeReport("eleduck-inbox", { unreadCount: 2, snippet: "Hi there" });
  assert.equal(r1.shouldAlertUnread, true);
  assert.equal(r1.item.status, "unread");

  const r2 = recordProbeReport("eleduck-inbox", { unreadCount: 2, snippet: "Hi there" });
  assert.equal(r2.shouldAlertUnread, false);

  resolveWatch("eleduck-inbox", "resolve");
  const r3 = recordProbeReport("eleduck-inbox", { unreadCount: 2, snippet: "Hi there" });
  assert.equal(r3.shouldAlertUnread, true);

  const a1 = recordProbeReport("zbj-inbox", { authExpired: true, unreadCount: 0 });
  assert.equal(a1.shouldAlertAuth, true);
  assert.equal(a1.item.status, "auth_expired");

  const dueAfterAuth = getDueWatches(new Date("2099-01-01T04:00:00.000Z"));
  assert.equal(
    dueAfterAuth.due.some((w) => w.id === "zbj-inbox"),
    false
  );

  resolveWatch("zbj-inbox", "resume");
  const dueAfterResume = getDueWatches(new Date("2099-01-01T04:00:00.000Z"));
  assert.ok(dueAfterResume.pendingDueCount >= 1);
});

test("Ed25519 asymmetric offline license verification accepts valid keys and rejects tampering/expiry", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pubHex = spki.subarray(spki.length - 32).toString("hex");

  const validLifetime = signLicensePayload({ p: "lifetime", s: "TEST-001", e: null }, privPem);
  const resOk = verifyLicenseKey(validLifetime, new Date("2026-11-15T00:00:00Z"), pubHex);
  assert.equal(resOk.valid, true);
  assert.equal(resOk.plan, "lifetime");
  assert.equal(resOk.serial, "TEST-001");

  const tampered = validLifetime.slice(0, -4) + "AAAA";
  assert.equal(verifyLicenseKey(tampered, new Date(), pubHex).valid, false);

  const expiredKey = signLicensePayload({ p: "annual_cn", s: "EXP-001", e: "2025-01-01" }, privPem);
  const resExp = verifyLicenseKey(expiredKey, new Date("2026-11-15T00:00:00Z"), pubHex);
  assert.equal(resExp.valid, false);
  assert.equal(resExp.expired, true);
});

test("HTTP hub v0.2.0 serves UI, presets, playbook, CORS, watch CRUD, settings, and alerts", async () => {
  notificationLog.length = 0;
  const server = createHubServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.ok((await htmlRes.text()).includes("消息总管"));

    const playbookRes = await fetch(`${baseUrl}/bonus/cold-reply-playbook`);
    assert.equal(playbookRes.status, 200);
    assert.ok((await playbookRes.text()).includes("高成交率外包与商务破冰回复话术库"));

    const presetsRes = await (await fetch(`${baseUrl}/api/presets`)).json();
    assert.equal(presetsRes.ok, true);
    assert.equal(presetsRes.packs.length, 2);

    const llmsRes = await fetch(`${baseUrl}/llms.txt`);
    assert.equal(llmsRes.status, 200);
    assert.ok((await llmsRes.text()).includes("tabpulse_scan_buyer_leads"));

    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.deepEqual(health, { ok: true, version: "0.4.0" });

    const badCors = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(badCors.status, 403);

    const createRes = await fetch(`${baseUrl}/api/watches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "demo-site",
        name: "测试接单站",
        url: "https://example.com/inbox",
        category: "长尾蹲守",
        publishTier: "yellow",
        contextSummary: "提交了独立开发方案",
      }),
    });
    assert.equal(createRes.status, 201);

    const repRes = await fetch(`${baseUrl}/api/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "demo-site",
        unreadCount: 3,
        snippet: "客户回复：方便发一下案例吗？",
      }),
    });
    const repData = await repRes.json();
    assert.equal(repData.ok, true);
    assert.equal(repData.shouldAlertUnread, true);
    assert.equal(notificationLog.length, 1);

    const setRes = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhookUrl: "https://example.com/hook" }),
    });
    assert.equal((await setRes.json()).settings.webhookUrl, "https://example.com/hook");

    const delRes = await fetch(`${baseUrl}/api/watches/demo-site`, { method: "DELETE" });
    assert.equal((await delRes.json()).deleted, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCP stdio server v0.2.0 exposes 5 tools and completes roundtrip", async () => {
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, "mcp-server", "index.mjs")], {
    env: {
      ...process.env,
      TABPULSE_DATA_FILE: tmpStateFile,
      TABPULSE_PORT: "19999",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const waiters = [];

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const next = waiters.shift();
      if (next) next(msg);
    }
  });

  function sendAndWait(payload) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout for ${payload.method}`)), 5000);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  try {
    const init = await sendAndWait({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
    assert.equal(init.result.serverInfo.version, "0.2.0");

    const listed = await sendAndWait({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(listed.result.tools.length, 5);
    assert.ok(listed.result.tools.some((t) => t.name === "tabpulse_scan_buyer_leads"));
  } finally {
    child.kill();
  }
});

test("Native Universal macOS binaries (CN 消息总管 & EN ReplyRadar) pass --self-test and scripts pass syntax check", () => {
  const cnBin = path.join(PROJECT_ROOT, "dist", "消息总管.app", "Contents", "MacOS", "XiaoXiZongGuan");
  const enBin = path.join(PROJECT_ROOT, "dist", "ReplyRadar.app", "Contents", "MacOS", "ReplyRadar");
  if (fs.existsSync(cnBin)) {
    assert.ok(execFileSync(cnBin, ["--self-test"], { encoding: "utf-8" }).includes("SELFTEST_OK"));
  }
  if (fs.existsSync(enBin)) {
    assert.ok(execFileSync(enBin, ["--self-test"], { encoding: "utf-8" }).includes("SELFTEST_OK"));
  }

  for (const rel of ["extension/background.js", "extension/probe.js", "extension/passive-observer.js", "extension/popup.js"]) {
    execFileSync(process.execPath, ["--check", path.join(PROJECT_ROOT, rel)]);
  }
});
