#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "用法: ./bin/bind-creem-secret.sh <whsec_签名密钥> [creem_API密钥]"
  exit 1
fi

WH_SEC="$1"
API_KEY="${2:-}"
PRIV_FILE="$HOME/.config/tabpulse/license_ed25519_private.pem"
TMP_SEC="$(mktemp)"
chmod 600 "$TMP_SEC"
trap 'rm -f "$TMP_SEC"' EXIT

node --input-type=module - "$PRIV_FILE" "$WH_SEC" "$API_KEY" "$TMP_SEC" <<'JS'
import fs from "node:fs";
const [privPath, whSec, apiKey, outPath] = process.argv.slice(2);
const obj = {
  LICENSE_ED25519_PRIVATE_PEM: fs.readFileSync(privPath, "utf8").trim(),
  CREEM_WEBHOOK_SECRET: whSec.trim(),
};
if (apiKey.trim()) obj.CREEM_API_KEY = apiKey.trim();
fs.writeFileSync(outPath, JSON.stringify(obj), { mode: 0o600 });
JS

cd "$(dirname "$0")/../worker"
npx cf deploy --secrets-file "$TMP_SEC"
echo "✅ Creem Webhook 密钥与离线发码私钥已加密部署至 replyradar-edge！"
