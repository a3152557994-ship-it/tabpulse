import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultWatches } from "../seed/default-watches.mjs";
import { PLAN_LABELS, verifyLicenseKey } from "./license.mjs";
import { generateVapidKeys, sendWebPushNotification } from "./webpush.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_FILE = path.resolve(__dirname, "..", "data", "state.json");
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_CATEGORIES = new Set(["主力阵地", "接单外包", "开发者商店", "长尾蹲守"]);
const VALID_TIERS = new Set(["red", "yellow", "green"]);

export function getDataFilePath() {
  return process.env.TABPULSE_DATA_FILE || DEFAULT_DATA_FILE;
}

const DEFAULT_QUICK_REPLIES_RAW = [
  {
    id: "qr-1",
    cat: "破冰秒回",
    titleZh: "现货秒回引导拍下",
    titleEn: "Fast Stock & Order Guide",
    textZh: "{哈喽|你好呀|嗨}~ 宝贝目前{有现货的|今天拍下就能安排}哦！页面标价就是实在底价，您可以直接拍下，看到第一时间给您极速处理~",
    textEn: "Hey! Thanks for reaching out — {happy to help|yes, I'm available right now}. Could you share your target timeline so I can send over a clear fixed-price scope?",
  },
  {
    id: "qr-2",
    cat: "防砍价",
    titleZh: "温和拒砍价+送小福利",
    titleEn: "Polite Price Anchor + Bonus",
    textZh: "{亲|朋友}，咱们这已经是{实在良心底价|薄利走量一口价}啦，品质和服务绝对让您省心！今天定下来的话，我额外给您{附赠一份实用资料包|优先加急安排}，您看行吗？",
    textEn: "We keep pricing transparent at our best flat rate so we never cut corners on quality — if we kick off this week, I'll include {priority 24h delivery|our setup checklist} as a free bonus!",
  },
  {
    id: "qr-3",
    cat: "售后安抚",
    titleZh: "化解不满防差评",
    titleEn: "De-escalate & Protect 5-Star",
    textZh: "非常抱歉给您添麻烦了！您看具体是哪一步没达到预期？咱们支持{免费重调补发|14天无忧售后}，一定给您妥善解决到位，辛苦先别急着评，给我个弥补机会~",
    textEn: "So sorry about the hiccup! Let me fix this for you right away — would you prefer an immediate patch today or a full no-questions-asked refund?",
  },
  {
    id: "qr-4",
    cat: "合规防封",
    titleZh: "平台内安全沟通留痕（零导流违禁词）",
    titleEn: "On-Platform Safe Scope Reply",
    textZh: "{放心哈|没问题的}，咱们全程在平台内沟通留痕保障双方权益！您把具体要求直接发当前对话框就行，拍下后我在订单里给您发完整交付包~",
    textEn: "{Sounds great|Happy to help}! Let's keep all scope details right here on the platform so everything stays protected. Drop your requirements below and I'll get right on it!",
  },
];

export function normalizeQuickReply(item = {}, idx = 0) {
  const category = String(item.category || item.cat || "常用话术").trim();
  const titleZh = String(item.titleZh || item.title || "快捷话术").trim();
  const titleEn = String(item.titleEn || item.title || titleZh).trim();
  const textZh = String(item.body || item.template || item.text || item.textZh || item.textEn || "")
    .replace(/抱谦/g, "抱歉")
    .trim();
  const textEn = String(item.textEn || item.body || item.template || item.text || textZh).trim();
  return {
    id: String(item.id || `qr-${idx + 1}`),
    category,
    cat: category,
    title: String(item.title || titleZh).trim(),
    titleZh,
    titleEn,
    body: textZh,
    template: textZh,
    text: textZh,
    textZh,
    textEn,
  };
}

const DEFAULT_QUICK_REPLIES = DEFAULT_QUICK_REPLIES_RAW.map(normalizeQuickReply);

function makeDefaultState(now = new Date()) {
  return {
    version: "5.7.0",
    extensionHeartbeatAt: null,
    license: null,
    mobileToken: crypto.randomBytes(24).toString("base64url"),
    tunnelBoxId: "bx_" + crypto.randomBytes(10).toString("hex"),
    tunnelWriteKey: crypto.randomBytes(24).toString("base64url"),
    vapidKeys: generateVapidKeys(),
    pushSubscriptions: [],
    settings: {
      webhookUrl: "",
      emailPush: { enabled: false, host: "", port: 465, user: "", pass: "", to: "" },
      keepAliveEnabled: true,
      radarKeywords: "Shopify",
      lang: "zh",
      preventSleep: false,
      tunnelAutoStart: false,
      allowLanDirect: false,
      allowRemoteAiCli: false,
    },
    quickReplies: DEFAULT_QUICK_REPLIES,
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
    if (!Array.isArray(parsed.quickReplies) || parsed.quickReplies.length === 0) {
      parsed.quickReplies = DEFAULT_QUICK_REPLIES;
    } else {
      parsed.quickReplies = parsed.quickReplies.map(normalizeQuickReply);
    }
    let dirty = false;
    if (!parsed.mobileToken || typeof parsed.mobileToken !== "string" || parsed.mobileToken.length < 16) {
      parsed.mobileToken = crypto.randomBytes(24).toString("base64url");
      dirty = true;
    }
    if (!parsed.tunnelBoxId || !/^bx_[a-zA-Z0-9]{10,36}$/.test(String(parsed.tunnelBoxId))) {
      parsed.tunnelBoxId = "bx_" + crypto.randomBytes(10).toString("hex");
      dirty = true;
    }
    if (!parsed.tunnelWriteKey || String(parsed.tunnelWriteKey).length < 16) {
      parsed.tunnelWriteKey = crypto.randomBytes(24).toString("base64url");
      dirty = true;
    }
    if (!parsed.vapidKeys || !parsed.vapidKeys.publicKey || !parsed.vapidKeys.privateKey) {
      parsed.vapidKeys = generateVapidKeys();
      dirty = true;
    }
    if (!Array.isArray(parsed.pushSubscriptions)) {
      parsed.pushSubscriptions = [];
      dirty = true;
    }
    if (dirty) saveState(parsed);
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
  const prevEmail = (current.emailPush && typeof current.emailPush === "object")
    ? current.emailPush
    : { enabled: false, host: "", port: 465, user: "", pass: "", to: "" };
  const nextEmail = patch.emailPush && typeof patch.emailPush === "object"
    ? {
        enabled: patch.emailPush.enabled !== undefined ? Boolean(patch.emailPush.enabled) : Boolean(prevEmail.enabled),
        host: patch.emailPush.host !== undefined ? String(patch.emailPush.host || "").trim() : String(prevEmail.host || ""),
        port: patch.emailPush.port !== undefined ? Number(patch.emailPush.port) || 465 : Number(prevEmail.port) || 465,
        user: patch.emailPush.user !== undefined ? String(patch.emailPush.user || "").trim() : String(prevEmail.user || ""),
        pass:
          patch.emailPush.pass !== undefined && patch.emailPush.pass !== "••••••••"
            ? String(patch.emailPush.pass || "").trim()
            : String(prevEmail.pass || ""),
        to: patch.emailPush.to !== undefined ? String(patch.emailPush.to || "").trim() : String(prevEmail.to || ""),
      }
    : prevEmail;
  state.settings = {
    webhookUrl: patch.webhookUrl !== undefined ? String(patch.webhookUrl || "").trim() : current.webhookUrl,
    emailPush: nextEmail,
    keepAliveEnabled:
      patch.keepAliveEnabled !== undefined
        ? Boolean(patch.keepAliveEnabled)
        : current.keepAliveEnabled !== undefined
          ? Boolean(current.keepAliveEnabled)
          : true,
    radarKeywords:
      patch.radarKeywords !== undefined ? String(patch.radarKeywords || "").trim() : current.radarKeywords,
    lang: patch.lang === "en" ? "en" : patch.lang === "zh" ? "zh" : current.lang || "zh",
    termsAcceptedAt:
      patch.termsAcceptedAt !== undefined ? patch.termsAcceptedAt : (current.termsAcceptedAt || null),
    aiButlerEnabled:
      patch.aiButlerEnabled !== undefined ? Boolean(patch.aiButlerEnabled) : Boolean(current.aiButlerEnabled),
    aiButlerProvider:
      patch.aiButlerProvider !== undefined ? String(patch.aiButlerProvider || "codex") : (current.aiButlerProvider || "codex"),
    aiButlerPersona:
      patch.aiButlerPersona !== undefined ? String(patch.aiButlerPersona || "").trim() : (current.aiButlerPersona || ""),
    aiButlerConversationId:
      patch.aiButlerConversationId !== undefined
        ? String(patch.aiButlerConversationId || "").trim()
        : (current.aiButlerConversationId || ""),
    aiButlerWebhookUrl:
      patch.aiButlerWebhookUrl !== undefined
        ? String(patch.aiButlerWebhookUrl || "").trim()
        : (current.aiButlerWebhookUrl || ""),
    aiButlerApiUrl:
      patch.aiButlerApiUrl !== undefined ? String(patch.aiButlerApiUrl || "").trim() : (current.aiButlerApiUrl || ""),
    aiButlerApiKey:
      patch.aiButlerApiKey !== undefined ? String(patch.aiButlerApiKey || "").trim() : (current.aiButlerApiKey || ""),
    aiButlerModel:
      patch.aiButlerModel !== undefined ? String(patch.aiButlerModel || "").trim() : (current.aiButlerModel || "gpt-4o-mini"),
    preventSleep:
      patch.preventSleep !== undefined ? Boolean(patch.preventSleep) : Boolean(current.preventSleep),
    tunnelAutoStart:
      patch.tunnelAutoStart !== undefined ? Boolean(patch.tunnelAutoStart) : Boolean(current.tunnelAutoStart),
    allowLanDirect:
      patch.allowLanDirect !== undefined ? Boolean(patch.allowLanDirect) : Boolean(current.allowLanDirect),
    allowRemoteAiCli:
      patch.allowRemoteAiCli !== undefined ? Boolean(patch.allowRemoteAiCli) : Boolean(current.allowRemoteAiCli),
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

export function deterministicProfileUuid(seedStr) {
  const hex = crypto.createHash("sha1").update(`tabpulse-profile:${seedStr}`).digest("hex");
  const p1 = hex.slice(0, 8);
  const p2 = hex.slice(8, 12);
  const p3 = "4" + hex.slice(13, 16);
  const v = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const p4 = v + hex.slice(17, 20);
  const p5 = hex.slice(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

export function upsertWatch(input, nowDate = new Date()) {
  if (!input || !String(input.url || "").trim()) {
    throw new Error("url is required");
  }
  let normalizedUrl = String(input.url).trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = `https://${normalizedUrl}`;
  }
  let parsedHost = "site";
  try {
    parsedHost = new URL(normalizedUrl).hostname;
  } catch {
    throw new Error("invalid url");
  }

  const state = loadState(nowDate);
  const nowIso = nowDate.toISOString();
  const allowDuplicateUrl = Boolean(input.allowDuplicateUrl);
  const existingIdx = state.watches.findIndex(
    (w) => (input.id && w.id === input.id) || (!input.id && !allowDuplicateUrl && w.url === normalizedUrl)
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
      url: normalizedUrl,
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

  const newId = input.id ? String(input.id).trim() : slugifyId(input.name, normalizedUrl);
  const isolatedProfile = input.isolatedProfile !== undefined ? Boolean(input.isolatedProfile) : true;
  const newWatch = {
    id: newId,
    name: String(input.name || parsedHost).trim(),
    url: normalizedUrl,
    category,
    publishTier,
    isolatedProfile,
    profileUuid: deterministicProfileUuid(newId),
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
    item.lastLoginVerifiedAt = nowIso;
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
    item.lastLoginVerifiedAt = nowIso;
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

export function unbindWatch(id, nowDate = new Date()) {
  const state = loadState(nowDate);
  const idx = state.watches.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  const item = {
    ...state.watches[idx],
    status: "auth_expired",
    unreadCount: 0,
    snippet: "",
    lastFingerprint: "",
    lastLoginVerifiedAt: null,
    unboundAt: nowDate.toISOString(),
  };
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

export function saveQuickReplies(list = [], nowDate = new Date()) {
  const state = loadState(nowDate);
  if (Array.isArray(list)) {
    state.quickReplies = list.slice(0, 200).map(normalizeQuickReply);
    saveState(state);
  }
  return state.quickReplies || DEFAULT_QUICK_REPLIES;
}

export function getMobileToken() {
  const state = loadState();
  return state.mobileToken;
}

export function getTunnelBoxCredentials() {
  const state = loadState();
  return {
    boxId: state.tunnelBoxId,
    writeKey: state.tunnelWriteKey,
  };
}

export function rotateMobileToken() {
  const state = loadState();
  state.mobileToken = crypto.randomBytes(24).toString("base64url");
  saveState(state);
  return state.mobileToken;
}

export function getVapidPublicKey() {
  const state = loadState();
  return state.vapidKeys.publicKey;
}

export function savePushSubscription(sub) {
  if (!sub || !sub.endpoint) return { ok: false, error: "endpoint required" };
  const state = loadState();
  const list = Array.isArray(state.pushSubscriptions) ? state.pushSubscriptions : [];
  const filtered = list.filter((x) => x.endpoint !== sub.endpoint);
  filtered.unshift({
    endpoint: sub.endpoint,
    keys: sub.keys || {},
    createdAt: new Date().toISOString(),
  });
  state.pushSubscriptions = filtered.slice(0, 12);
  saveState(state);
  return { ok: true, count: state.pushSubscriptions.length };
}

export async function broadcastMobileWebPush(payloadObj = {}) {
  const state = loadState();
  const subs = Array.isArray(state.pushSubscriptions) ? state.pushSubscriptions : [];
  if (!subs.length) return { sent: 0 };
  const unreadTotal = state.watches
    .filter((w) => w.status === "unread")
    .reduce((s, w) => s + (Number(w.unreadCount) || 0), 0);
  const fullPayload = { unreadTotal: Math.max(1, unreadTotal), ...payloadObj };
  const keep = [];
  let sent = 0;
  for (const sub of subs) {
    const res = await sendWebPushNotification(sub, fullPayload, state.vapidKeys);
    if (res.status !== 404 && res.status !== 410) {
      keep.push(sub);
    }
    if (res.ok) sent++;
  }
  if (keep.length !== subs.length) {
    state.pushSubscriptions = keep;
    saveState(state);
  }
  return { sent, activeDevices: keep.length };
}

export function getPublicSummary(nowDate = new Date()) {
  const state = loadState(nowDate);
  const watches = state.watches;
  const unreadWatches = watches.filter((w) => w.status === "unread");
  const authExpiredWatches = watches.filter((w) => w.status === "auth_expired");
  const pausedWatches = watches.filter((w) => w.status === "paused");
  return {
    version: "5.7.0",
    pushSubscribersCount: (state.pushSubscriptions || []).length,
    extensionHeartbeatAt: state.extensionHeartbeatAt,
    license: getLicenseStatus(nowDate, state),
    settings: state.settings || { webhookUrl: "", radarKeywords: "Shopify", lang: "zh" },
    quickReplies: state.quickReplies || DEFAULT_QUICK_REPLIES,
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
