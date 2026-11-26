---
name: replyradar-notify
description: On-demand phone notification, mobile human-in-the-loop confirmation (ask_human), and cross-platform unread message bridge via local ReplyRadar / 消息总管 MCP. Activate ONLY when the user explicitly asks to push a mobile notification, request remote phone approval, or read/watch platform messages in ReplyRadar.
---

# ReplyRadar / 消息总管 — 按需手机通知与平台消息协同技能

本机已连接 **《消息总管》(ReplyRadar)** MCP 服务。请严格遵循**按需调用**原则，绝不在常规对话或普通任务完成后擅自弹手机通知、绝不未经要求阻塞等待手机拍板：

## 调用边界与使用规范

1. **按需推送手机提醒 → `tabpulse_notify_phone`**
   - **仅当用户明确要求**（如「跑完推我手机」「发条通知到消息总管」）时调用 `tabpulse_notify_phone`，传入简明的 `title` 与纯文字摘要 `message`。
2. **按需远程手机询问 → `tabpulse_ask_human`**
   - **仅当用户明确指示通过手机远程拍板**（如「我出门了，有需要确认的推我手机点选」）时调用 `tabpulse_ask_human`，提供 2–4 个简短 `options`。若本地《消息总管》未启动，工具会优雅返回 `hubOffline: true` JSON，届时直接在当前对话询问用户即可。
3. **挂接网页未读看护 → `tabpulse_register_watch` / `tabpulse_list_watches`**
   - 当用户要求将某个店铺、社区或招聘后台加入《消息总管》静默看护，或查看当前各平台未读红点汇总时调用。
4. **读取手机留言或平台纯文字消息 → `tabpulse_check_human_replies` / `tabpulse_read_channel_messages`**
   - 当用户要求查看手机随身收件箱留言，或读取闲鱼、小红书、微信、电鸭等已挂接渠道的最新消息时调用。
