self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function getScopeBasePrefix() {
  try {
    const scopePath = new URL(self.registration.scope).pathname.replace(/\/+$/, "");
    const m = scopePath.match(/^(\/box\/bx_[a-zA-Z0-9]+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

self.addEventListener("push", (event) => {
  const prefix = getScopeBasePrefix();
  let data = { title: "🔔 消息总管新消息", body: "点击进入查看详情并回复", targetKey: "", unreadTotal: 1 };
  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text() || data.body;
    }
  }

  const tasks = [
    self.registration.showNotification(data.title || "🔔 消息总管新消息", {
      body: data.body || "收到新消息提醒",
      icon: `${prefix}/mobile-icon.svg`,
      badge: `${prefix}/mobile-icon.svg`,
      tag: data.targetKey || "tabpulse-msg",
      renotify: true,
      data: { targetKey: data.targetKey || "" },
    }),
  ];

  if ("setAppBadge" in self.navigator) {
    tasks.push(self.navigator.setAppBadge(Math.max(1, Number(data.unreadTotal) || 1)).catch(() => {}));
  }

  event.waitUntil(Promise.all(tasks));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const prefix = getScopeBasePrefix();
  const targetKey = event.notification.data?.targetKey || "";
  const targetUrl = targetKey ? `${prefix}/m#open=${encodeURIComponent(targetKey)}` : `${prefix}/m`;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("/m") && "focus" in client) {
          client.postMessage({ action: "openChannel", targetKey });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
