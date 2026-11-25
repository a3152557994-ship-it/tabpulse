# 🔔 消息总管 / ReplyRadar v5.5.0

**多账号物理防串号收发工作台 · 38 平台点图标秒加 · 手机纯文字红点随身箱 · 9 工具 AI MCP**

- 🌐 **官网与 24h 全网求购雷达（免登录即测）**：https://a3152557994-ship-it.github.io/tabpulse/
-  **macOS 中文版高速下载（1.2 MB · 免装 Node）**：https://replyradar-edge.a3152557994.workers.dev/dl/XiaoXiZongGuan-CN-macOS.dmg
- 🪟 **Windows 10/11 64位高速下载（5.0 MB）**：https://replyradar-edge.a3152557994.workers.dev/dl/XiaoXiZongGuan-CN-Windows-x64.zip
- 🤖 **AI 检索规范 (`llms.txt`)**：https://a3152557994-ship-it.github.io/tabpulse/llms.txt

---

## 核心能力（v5.5.0）

1. **38 个常用平台点图标一键添加（零网址免折腾）**：内置闲鱼、小红书、抖店、拼多多、淘宝千牛、BOSS直聘、猎聘、电鸭、B站、Reddit、Upwork、X 等图标库，点一下直接打开登录；同一图标再点一次自动开启第 2 个独立 Cookie 防串号副仓。
2. **本机软件与日常浏览器免重登自动看护**：自动识别本机微信、QQ、千牛、飞书、钉钉程序坞红点及日常 Chrome/Edge 已开聊天网页。
3. **默认锁死本机回环防公共 Wi-Fi 攻击**：默认仅监听 `127.0.0.1` 不向外部局域网敞开端口，配对密钥上屏即隐防截屏泄露，支持一键断连作废旧二维码与永久固定手机书签。
4. **内置 9 工具 MCP 服务**：接入 Claude Code / Cursor / Codex / Antigravity 后，长任务跑完或遇分岔口自动推手机锁屏并支持一键点选拍板。

## AI MCP 快速挂载

```json
{
  "mcpServers": {
    "replyradar": {
      "command": "npx",
      "args": ["-y", "github:a3152557994-ship-it/tabpulse"]
    }
  }
}
```
