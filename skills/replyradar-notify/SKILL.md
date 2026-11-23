---
name: replyradar-notify
description: Automatic phone red-dot push notification, mobile 1-tap human-in-the-loop approval (ask_human), and cross-platform unread message bridge via local ReplyRadar / 消息总管 MCP. Activate whenever finishing a multi-minute task, needing user confirmation while away from keyboard, or monitoring replies on web/desktop platforms.
---

# ReplyRadar / 消息总管 — AI 自动推手机与远程拍板技能

你已连接本机 **《消息总管》(ReplyRadar)** MCP 服务。无需人类手动配置网页或脚本，你应在以下时机**主动调用**对应工具，把结果或待拍板事项推送到主人手机的红点收件箱：

## 1. 什么时候自动调用（无需主人每次叮嘱）

1. **长任务跑完 / 出重要结果时 → 调 `tabpulse_notify_phone`**
   - 当你完成了耗时较长的编译、重构、部署、数据抓取，或发现了异常报错/高意向商机时，直接调用 `tabpulse_notify_phone`（填清 `agentName`、`title` 与精炼结论 `message`），主人手机会立刻响铃并在你的专属头像上亮起红点。
2. **卡在关键分岔口需主人拍板时 → 调 `tabpulse_ask_human`（手机一键点选回复）**
   - 当遇到需要人类确认的决策（例如：是否发送对外报价、采用方案 A 还是方案 B、是否执行高影响修改），调用 `tabpulse_ask_human` 并传入 2–4 个简短 `options`（如 `["批准执行", "改用保守方案", "先暂停"]`）。
   - 该工具会直接推到主人手机锁屏，并在手机聊天页生成可一键点击的按钮；主人点一下手机按钮或打字回复后，结果会直接返回给你继续往下干活！
3. **帮主人投递了岗位/报价/审核/帖子后 → 调 `tabpulse_register_watch`**
   - 只要在某个网页后台留下了待回信动作，顺手调用 `tabpulse_register_watch` 把该页面挂进《消息总管》静默看护，后续对方一回信会自动推主人手机。
4. **查看主人在手机上主动发来的新留言 → 调 `tabpulse_check_human_replies` / 读平台消息调 `tabpulse_read_channel_messages`**
   - 需要读取微信/千牛/闲鱼/小红书等已挂接平台的纯文字最新消息时，调用 `tabpulse_read_channel_messages`。
