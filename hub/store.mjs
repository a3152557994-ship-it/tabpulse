import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultWatches } from "../seed/default-watches.mjs";
import { PLAN_LABELS, verifyLicenseKey } from "./license.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_FILE = path.resolve(__dirname, "..", "data", "state.json");
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_CATEGORIES = new Set(["主力阵地", "接单外包", "开发者商店", "长尾蹲守"]);
const VALID_TIERS = new Set(["red", "yellow", "green"]);

export function getDataFilePath() {
  return process.env.TABPULSE_DATA_FILE || DEFAULT_DATA_FILE;
}

function makeDefaultState(now = new Date()) {
  return {
    version: "0.3.0",
    extensionHeartbeatAt: null,
    license: null,
    settings: {
      webhookUrl: "",
      radarKeywords: "Shopify",
      lang: "zh",
    },
    watches: createDefaultWatches(now),
  };
}

export function loadState(now = new Date()) {
  const filePath = getDataFilePath();
  if (!fs.existsSync(filePath)) {
    const initial = makeDefaultState(now);
    saveState(initial);
    return initial;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.watches)) {
      const initial = makeDefaultState(now);
      saveState(initial);
      return initial;
    }
    if (!parsed.settings || typeof parsed.settings !== "object") {
      parsed.settings = { webhookUrl: "", radarKeywords: "Shopify", lang: "zh" };
    }
    return parsed;
  } catch {
    const initial = makeDefaultState(now);
    saveState(initial);
    return initial;
  }
}

export function saveState(state) {
  const filePath = getDataFilePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

export function getLicenseStatus(nowDate = new Date(), stateObj = null) {
  const state = stateObj || loadState(nowDate);
  if (!state.license || !state.license.key) {
    return {
      valid: false,
      plan: "free",
      planMeta: PLAN_LABELS.free,
      serial: "",
      expiresAt: null,
    };
  }
  const verified = verifyLicenseKey(state.license.key, nowDate);
  if (!verified.valid) {
    return {
      valid: false,
      plan: "free",
      planMeta: PLAN_LABELS.free,
      serial: verified.serial || "",
      expiresAt: verified.expiresAt || null,
      expired: Boolean(verified.expired),
      error: verified.error,
    };
  }
  return {
    valid: true,
    plan: verified.plan,
    planMeta: verified.planMeta,
    serial: verified.serial,
    expiresAt: verified.expiresAt,
    activatedAt: state.license.activatedAt || null,
  };
}

export function activateLicenseKey(rawKey, nowDate = new Date()) {
  const verified = verifyLicenseKey(rawKey, nowDate);
  if (!verified.valid) {
    return { ok: false, error: verified.error };
  }
  const state = loadState(nowDate);
  state.license = {
    key: String(rawKey).trim(),
    plan: verified.plan,
    serial: verified.serial,
    expiresAt: verified.expiresAt,
    activatedAt: nowDate.toISOString(),
  };
  saveState(state);
  return {
    ok: true,
    license: getLicenseStatus(nowDate, state),
  };
}

export function updateSettings(patch = {}, nowDate = new Date()) {
  const state = loadState(nowDate);
  const current = state.settings || { webhookUrl: "", radarKeywords: "Shopify", lang: "zh", termsAcceptedAt: null };
  state.settings = {
    webhookUrl: patch.webhookUrl !== undefined ? String(patch.webhookUrl || "").trim() : current.webhookUrl,
    radarKeywords:
      patch.radarKeywords !== undefined ? String(patch.radarKeywords || "").trim() : current.radarKeywords,
    lang: patch.lang === "en" ? "en" : patch.lang === "zh" ? "zh" : current.lang || "zh",
    termsAcceptedAt:
      patch.termsAcceptedAt !== undefined ? patch.termsAcceptedAt : (current.termsAcceptedAt || null),
  };
  saveState(state);
  return state.settings;
}

/**
 * Compute next adaptive check ISO timestamp:
 * - Respects baseIntervalMinutes (doubles after 7d with zero unread, capped at 720m)
 * - Adds ±25% random jitter
 * - Protects Asia/Shanghai 00:00-07:59 sleep window -> pushes to 08:05 + 0..40m
 */
export function computeNextCheck(item, nowDate = new Date(), randomFn = Math.random) {
  const nowMs = nowDate instanceof Date ? nowDate.getTime() : new Date(nowDate).getTime();
  const minFloor = item.publishTier === "red" ? 60 : 15;
  let intervalMinutes = Math.max(minFloor, Number(item.baseIntervalMinutes) || 60);

  const createdMs = item.createdAt ? new Date(item.createdAt).getTime() : nowMs;
  const ageMs = Number.isFinite(createdMs) ? nowMs - createdMs : 0;
  if (ageMs >= SEVEN_DAYS_MS && (Number(item.totalUnreadSeen) || 0) === 0) {
    intervalMinutes = Math.min(720, intervalMinutes * 2);
  }

  const jitterFactor = 0.75 + randomFn() * 0.5;
  const jitterMinutes = Math.max(5, Math.round(intervalMinutes * jitterFactor));
  let candidateMs = nowMs + jitterMinutes * 60 * 1000;

  // Convert candidate timestamp into Asia/Shanghai wall-clock coordinates (UTC+8, no DST)
  const shanghaiWall = new Date(candidateMs + SHANGHAI_OFFSET_MS);
  const hour = shanghaiWall.getUTCHours();
  const minute = shanghaiWall.getUTCMinutes();
  const second = shanghaiWall.getUTCSeconds();

  if (hour >= 0 && hour < 8) {
    const currentMinutesOfDay = hour * 60 + minute;
    const morningOffsetMinutes = 8 * 60 + 5 - currentMinutesOfDay;
    const wakeJitterMinutes = Math.floor(randomFn() * 41);
    candidateMs += (morningOffsetMinutes + wakeJitterMinutes) * 60 * 1000 - second * 1000;
  }

  return new Date(candidateMs).toISOString();
}

function slugifyId(name, url) {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-");
    } catch {
      return "site";
    }
  })();
  const ascii = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = crypto.randomBytes(2).toString("hex");
  return `${ascii || host || "watch"}-${suffix}`.replace(/^-+/, "");
}

export function upsertWatch(input, nowDate = new Date()) {
  if (!input || !input.url) {
    throw new Error("url is required");
  }
  const state = loadState(nowDate);
  const nowIso = nowDate.toISOString();
  const existingIdx = state.watches.findIndex(
    (w) => (input.id && w.id === input.id) || (!input.id && w.url === input.url)
  );

  const category = VALID_CATEGORIES.has(input.category) ? input.category : "长尾蹲守";
  const publishTier = VALID_TIERS.has(input.publishTier) ? input.publishTier : "yellow";
  const mode = input.mode === "pinned" ? "pinned" : "low_freq";
  const baseIntervalMinutes = Math.max(5, Number(input.baseIntervalMinutes) || 60);

  if (existingIdx >= 0) {
    const current = state.watches[existingIdx];
    const updated = {
      ...current,
      name: input.name ? String(input.name).trim() : current.name,
      url: String(input.url).trim(),
      category: input.category ? category : current.category,
      publishTier: input.publishTier ? publishTier : current.publishTier,
      conversationId:
        input.conversationId !== undefined ? String(input.conversationId || "").trim() : current.conversationId,
      contextSummary:
        input.contextSummary !== undefined ? String(input.contextSummary || "").trim() : current.contextSummary,
      mode: input.mode ? mode : current.mode,
      baseIntervalMinutes: input.baseIntervalMinutes ? baseIntervalMinutes : current.baseIntervalMinutes,
    };
    state.watches[existingIdx] = updated;
    saveState(state);
    return { watch: updated, created: false };
  }

  const newWatch = {
    id: input.id ? String(input.id).trim() : slugifyId(input.name, input.url),
    name: String(input.name || new URL(input.url).hostname).trim(),
    url: String(input.url).trim(),
    category,
    publishTier,
    conversationId: String(input.conversationId || "").trim(),
    contextSummary: String(input.contextSummary || "").trim(),
    mode,
    baseIntervalMinutes,
    status: "idle",
    unreadCount: 0,
    snippet: "",
    lastDraft: "",
    lastFingerprint: "",
    createdAt: nowIso,
    lastCheckedAt: null,
    nextCheckAt: computeNextCheck({ baseIntervalMinutes, createdAt: nowIso, totalUnreadSeen: 0 }, nowDate),
    lastUnreadAt: null,
    totalUnreadSeen: 0,
    pageTitle: "",
    lastReportedUrl: "",
    history: [],
  };

  state.watches.push(newWatch);
  saveState(state);
  return { watch: newWatch, created: true };
}

export function getDueWatches(nowDate = new Date(), { recordHeartbeat = true, force = false, targetId = "" } = {}) {
  const state = loadState(nowDate);
  const nowMs = nowDate.getTime();
  if (recordHeartbeat) {
    state.extensionHeartbeatAt = nowDate.toISOString();
    saveState(state);
  }

  if (targetId) {
    const exact = state.watches.filter((w) => w.id === targetId);
    return {
      due: exact,
      pendingDueCount: exact.length,
      extensionHeartbeatAt: state.extensionHeartbeatAt,
    };
  }

  // Red-light social platforms use Wavebox-style passive live-tab observation (ZERO automatic cold reloads!)
  const active = state.watches.filter(
    (w) => w.status !== "paused" && (force || (w.status !== "auth_expired" && w.publishTier !== "red"))
  );
  if (force) {
    const sorted = [...active].sort((a, b) => {
      const aLast = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
      const bLast = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
      return aLast - bLast;
    });
    return {
      due: sorted.slice(0, 1),
      pendingDueCount: sorted.length,
      extensionHeartbeatAt: state.extensionHeartbeatAt,
    };
  }

  const pinned = active.filter((w) => w.mode === "pinned");
  const dueLowFreq = active
    .filter((w) => w.mode !== "pinned")
    .filter((w) => !w.nextCheckAt || new Date(w.nextCheckAt).getTime() <= nowMs)
    .sort((a, b) => new Date(a.nextCheckAt || 0).getTime() - new Date(b.nextCheckAt || 0).getTime());

  // Never open multiple low_freq background tabs in one pulse cycle
  const nextLowFreq = dueLowFreq.slice(0, 1);
  return {
    due: [...pinned, ...nextLowFreq],
    pendingDueCount: dueLowFreq.length,
    extensionHeartbeatAt: state.extensionHeartbeatAt,
  };
}

export function recordProbeReport(id, report = {}, nowDate = new Date(), randomFn = Math.random) {
  const state = loadState(nowDate);
  const idx = state.watches.findIndex((w) => w.id === id);
  if (idx < 0) return null;

  const item = { ...state.watches[idx] };
  const nowIso = nowDate.toISOString();
  const unreadCount = Math.max(0, Number(report.unreadCount) || 0);
  const snippet = String(report.snippet || "").trim();
  const authExpired = Boolean(report.authExpired);
  const fingerprint = crypto
    .createHash("sha1")
    .update(`${unreadCount}:${snippet}`)
    .digest("hex");

  let shouldAlertUnread = false;
  let shouldAlertAuth = false;

  if (authExpired) {
    if (item.status !== "auth_expired") {
      shouldAlertAuth = true;
    }
    if (item.status !== "paused") {
      item.status = "auth_expired";
    }
  } else if (unreadCount > 0) {
    if (fingerprint !== item.lastFingerprint) {
      shouldAlertUnread = true;
      item.lastFingerprint = fingerprint;
      item.totalUnreadSeen = (Number(item.totalUnreadSeen) || 0) + unreadCount;
      item.lastUnreadAt = nowIso;
    }
    item.unreadCount = unreadCount;
    item.snippet = snippet;
    if (item.status !== "paused") {
      item.status = "unread";
    }
  } else {
    item.unreadCount = 0;
    item.snippet = "";
    item.lastFingerprint = "";
    if (item.status !== "paused") {
      item.status = "idle";
    }
  }

  item.lastCheckedAt = nowIso;
  if (report.pageTitle) item.pageTitle = String(report.pageTitle).trim();
  if (report.url) item.lastReportedUrl = String(report.url).trim();
  item.nextCheckAt = computeNextCheck(item, nowDate, randomFn);

  const historyEntry = {
    at: nowIso,
    unreadCount,
    authExpired,
    snippet: snippet.slice(0, 120),
  };
  item.history = [historyEntry, ...(Array.isArray(item.history) ? item.history : [])].slice(0, 20);

  state.watches[idx] = item;
  state.extensionHeartbeatAt = nowIso;
  saveState(state);

  return { item, shouldAlertUnread, shouldAlertAuth, settings: state.settings || {} };
}

export function saveReplyDraft(id, draftText, nowDate = new Date()) {
  const state = loadState(nowDate);
  const idx = state.watches.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  state.watches[idx] = {
    ...state.watches[idx],
    lastDraft: String(draftText || ""),
    draftUpdatedAt: nowDate.toISOString(),
  };
  saveState(state);
  return state.watches[idx];
}

export function resolveWatch(id, action = "resolve", nowDate = new Date()) {
  const state = loadState(nowDate);
  const idx = state.watches.findIndex((w) => w.id === id);
  if (idx < 0) return null;

  const item = { ...state.watches[idx] };
  if (action === "pause") {
    item.status = "paused";
  } else if (action === "resume") {
    item.status = item.unreadCount > 0 ? "unread" : "idle";
    item.nextCheckAt = nowDate.toISOString();
  } else {
    item.status = "idle";
    item.unreadCount = 0;
    item.snippet = "";
    item.lastFingerprint = "";
    item.nextCheckAt = computeNextCheck(item, nowDate);
  }

  state.watches[idx] = item;
  saveState(state);
  return item;
}

export function deleteWatch(id) {
  const state = loadState();
  const before = state.watches.length;
  state.watches = state.watches.filter((w) => w.id !== id);
  if (state.watches.length === before) return false;
  saveState(state);
  return true;
}

export function getPublicSummary(nowDate = new Date()) {
  const state = loadState(nowDate);
  const watches = state.watches;
  const unreadWatches = watches.filter((w) => w.status === "unread");
  const authExpiredWatches = watches.filter((w) => w.status === "auth_expired");
  const pausedWatches = watches.filter((w) => w.status === "paused");
  return {
    version: "0.3.0",
    extensionHeartbeatAt: state.extensionHeartbeatAt,
    license: getLicenseStatus(nowDate, state),
    settings: state.settings || { webhookUrl: "", radarKeywords: "Shopify", lang: "zh" },
    stats: {
      total: watches.length,
      unreadCount: unreadWatches.length,
      unreadMessagesTotal: unreadWatches.reduce((sum, w) => sum + (Number(w.unreadCount) || 0), 0),
      authExpiredCount: authExpiredWatches.length,
      pausedCount: pausedWatches.length,
      activeCount: watches.length - pausedWatches.length,
    },
    watches,
  };
}
