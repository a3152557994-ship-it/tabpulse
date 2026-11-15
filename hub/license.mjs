import crypto from "node:crypto";

// Raw 32-byte Ed25519 public key (private signing key stays offline on founder machine only)
export const PUBLIC_KEY_HEX = "7953c20694277c090b5a4d3e7544a478223fa1bad98c5d1ff0dd6ca6a1f00244";

// ASN.1 DER prefix for Ed25519 SubjectPublicKeyInfo (RFC 8410)
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function getPublicKeyObject(pubHex = PUBLIC_KEY_HEX) {
  const raw = Buffer.from(pubHex, "hex");
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

export const PLAN_LABELS = {
  free: {
    zh: "免费体验版（限盯 2 个平台）",
    en: "Free Starter (Up to 2 Sources)",
    maxWatches: 2,
    autoRadar: false,
    multiAccount: false,
  },
  annual_cn: {
    zh: "年度专业版（无限平台 + 24h 自动商机雷达）",
    en: "Pro Annual (Unlimited Sources + Auto Lead Radar)",
    maxWatches: 999,
    autoRadar: true,
    multiAccount: false,
  },
  lifetime: {
    zh: "终身买断专业版（无限平台 + 附赠破冰话术库）",
    en: "Lifetime Desktop Pro (Unlimited Sources + Playbook)",
    maxWatches: 999,
    autoRadar: true,
    multiAccount: false,
  },
  pro_sub: {
    zh: "Pro 全球订阅版（无限平台 + 云端商机秒推）",
    en: "Pro Subscription (Unlimited Sources + Instant Push)",
    maxWatches: 999,
    autoRadar: true,
    multiAccount: false,
  },
  agency: {
    zh: "Agency 工作室多号版（无限平台 + 多账号隔离路由）",
    en: "Agency Multi-Account (Unlimited + Isolated Profiles)",
    maxWatches: 9999,
    autoRadar: true,
    multiAccount: true,
  },
};

export function verifyLicenseKey(rawKey, nowDate = new Date(), pubHex = PUBLIC_KEY_HEX) {
  const trimmed = String(rawKey || "").trim();
  if (!trimmed) {
    return { valid: false, error: "请输入激活码 / License key is empty" };
  }
  const parts = trimmed.split(".");
  if (parts.length !== 3 || parts[0] !== "TP1") {
    return { valid: false, error: "激活码格式无效（应以 TP1. 开头）/ Invalid license key format" };
  }

  const [, payloadB64, sigB64] = parts;
  let payloadBytes;
  let sigBytes;
  try {
    payloadBytes = Buffer.from(payloadB64, "base64url");
    sigBytes = Buffer.from(sigB64, "base64url");
  } catch {
    return { valid: false, error: "激活码编码损坏 / Malformed base64url encoding" };
  }

  if (sigBytes.length !== 64) {
    return { valid: false, error: "激活码签名长度无效 / Invalid signature length" };
  }

  const pubKey = getPublicKeyObject(pubHex);
  const ok = crypto.verify(null, payloadBytes, pubKey, sigBytes);
  if (!ok) {
    return { valid: false, error: "激活码签名校验未通过 / Signature verification failed" };
  }

  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf-8"));
  } catch {
    return { valid: false, error: "激活码载荷解析失败 / Invalid license payload" };
  }

  const plan = PLAN_LABELS[payload.p] ? payload.p : "lifetime";
  if (payload.e) {
    const expMs = new Date(payload.e).getTime();
    if (Number.isFinite(expMs) && expMs < nowDate.getTime()) {
      return {
        valid: false,
        expired: true,
        plan,
        serial: payload.s || "",
        expiresAt: payload.e,
        error: `激活码已于 ${payload.e} 到期 / License expired on ${payload.e}`,
      };
    }
  }

  return {
    valid: true,
    plan,
    planMeta: PLAN_LABELS[plan],
    serial: String(payload.s || ""),
    expiresAt: payload.e || null,
    issuedAt: payload.i || null,
  };
}
