#!/usr/bin/env node
import { installAiClient, listAiClientsStatus } from "../hub/ai-installer.mjs";

const args = process.argv.slice(2);
const target = args[0] || "--status";

if (target === "--status") {
  console.log(JSON.stringify(listAiClientsStatus(), null, 2));
  process.exit(0);
}

if (target === "--all-detected") {
  const st = listAiClientsStatus();
  const results = [];
  for (const c of st.clients) {
    if (c.detected) {
      results.push(installAiClient(c.id));
    }
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
  process.exit(0);
}

console.log(JSON.stringify(installAiClient(target), null, 2));
