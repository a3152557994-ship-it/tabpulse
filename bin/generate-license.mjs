#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyLicenseKey } from "../hub/license.mjs";

const DEFAULT_PRIV_PATH = path.join(os.homedir(), ".config", "tabpulse", "license_ed25519_private.pem");

export function signLicensePayload(payload, privatePem) {
  const privKey = crypto.createPrivateKey(privatePem);
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf-8");
  const sigBytes = crypto.sign(null, payloadBytes, privKey);
  return `TP1.${payloadBytes.toString("base64url")}.${sigBytes.toString("base64url")}`;
}

function parseArgs(argv) {
  const opts = {
    plan: "lifetime",
    count: 1,
    prefix: "CN",
    days: null,
    priv: process.env.TABPULSE_PRIVATE_KEY_FILE || DEFAULT_PRIV_PATH,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--plan" && argv[i + 1]) opts.plan = argv[++i];
    else if (a === "--count" && argv[i + 1]) opts.count = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--prefix" && argv[i + 1]) opts.prefix = argv[++i];
    else if (a === "--days" && argv[i + 1]) opts.days = Number(argv[++i]) || null;
    else if (a === "--priv" && argv[i + 1]) opts.priv = argv[++i];
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv);
  if (!fs.existsSync(opts.priv)) {
    console.error(`Private key not found at ${path.resolve(opts.priv)}`);
    process.exit(1);
  }
  const pem = fs.readFileSync(opts.priv, "utf-8");
  const today = new Date().toISOString().slice(0, 10);
  const expiresAt = opts.days
    ? new Date(Date.now() + opts.days * 86400 * 1000).toISOString().slice(0, 10)
    : null;

  for (let idx = 1; idx <= opts.count; idx += 1) {
    const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
    const serial = `${opts.prefix}-${String(idx).padStart(3, "0")}-${rand}`;
    const key = signLicensePayload(
      {
        p: opts.plan,
        s: serial,
        i: today,
        e: expiresAt,
      },
      pem
    );
    const check = verifyLicenseKey(key);
    if (!check.valid) {
      throw new Error(`Self-verification failed for ${serial}: ${check.error}`);
    }
    console.log(`${serial}\t${opts.plan}\t${expiresAt || "PERMANENT"}\t${key}`);
  }
}
