# 🔔 TabPulse (万站回音) v0.2.0

**Browser-Independent Unread Inbox Sentinel, Live 24h Buyer-Intent Lead Radar & 5-Tool MCP Server**

- 🌐 **Live Website & Free 24h Missed Lead Scanner**: [https://a3152557994-ship-it.github.io/tabpulse/](https://a3152557994-ship-it.github.io/tabpulse/)
-  **Download Native macOS Universal App (`.dmg`, 673 KB, Zero Chrome Required)**: [Download v0.2.0 (.dmg)](https://github.com/a3152557994-ship-it/tabpulse/releases/latest/download/TabPulse-v0.2.0-macOS-universal.dmg)
- 🤖 **AI Agent Specification (`llms.txt`)**: [https://a3152557994-ship-it.github.io/tabpulse/llms.txt](https://a3152557994-ship-it.github.io/tabpulse/llms.txt)

---

## Why TabPulse?

Freelancers, outbound agencies, and indie founders lose high-intent deals every week because buyer replies and hiring threads sit unseen across 10–30 closed web tabs (Upwork, Reddit, Hacker News, X, GitHub, Eleduck 电鸭, V2EX, Xiaohongshu 小红书, Xianyu 闲鱼).

1. **No Browser Extension Lock-In**: Native macOS app (`AppKit` + system `WKWebView`) runs independently in your menu bar—even if all browsers are closed.
2. **Residential Anti-Ban Safety**: Session cookies stay 100% on your Mac. Sequential checks use ±25% random human jitter, sleep automatically from `00:00–08:00`, pause immediately on expired auth, and never auto-post on strict social platforms.
3. **Live 24h Buyer-Intent Radar**: Instant concurrent search across Reddit, Hacker News, and GitHub paid/contract threads.
4. **5-Tool MCP Server**: Plugs straight into Claude Desktop, Cursor, and Antigravity.

---

## Quick Start (MCP for Claude / Cursor / Antigravity)

```json
{
  "mcpServers": {
    "tabpulse": {
      "command": "npx",
      "args": ["-y", "github:a3152557994-ship-it/tabpulse"]
    }
  }
}
```

### Exposed MCP Tools
- `tabpulse_register_watch` — Register any web inbox/portal with business context & safety tier (`red` | `yellow` | `green`).
- `tabpulse_list_watches` — Inspect unread counts, message snippets, and auth health.
- `tabpulse_save_reply_draft` — Prepare a context-aware reply draft for 1-click human review.
- `tabpulse_resolve_watch` — Clear unread badge, pause, or resume after re-login.
- `tabpulse_scan_buyer_leads` — Real-time buyer-intent search across Reddit, Hacker News & GitHub.
