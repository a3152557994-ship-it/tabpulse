const HUB_URL = "http://127.0.0.1:17890";

async function initPopup() {
  const statusEl = document.getElementById("hub-status");
  try {
    const res = await fetch(`${HUB_URL}/api/state`);
    const data = await res.json();
    const s = data.stats || {};
    statusEl.textContent = `中枢在线 · 盯梢 ${s.total || 0} 站 · 未读 ${s.unreadMessagesTotal || 0} 条`;
  } catch {
    statusEl.textContent = "中枢未启动（请先确保 launchd 或 npm start 已运行）";
    statusEl.style.color = "#dc2626";
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (tab && /^https?:\/\//i.test(tab.url || "")) {
      document.getElementById("site-name").value = (tab.title || "").slice(0, 40);
      document.getElementById("site-url").value = tab.url;
    }
  });
}

document.getElementById("open-hub").addEventListener("click", () => {
  chrome.tabs.create({ url: HUB_URL });
});

document.getElementById("quick-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msgEl = document.getElementById("msg");
  const payload = {
    name: document.getElementById("site-name").value.trim(),
    url: document.getElementById("site-url").value.trim(),
    publishTier: document.getElementById("site-tier").value,
    category: document.getElementById("site-cat").value,
    contextSummary: document.getElementById("site-ctx").value.trim(),
    baseIntervalMinutes: 60,
  };

  try {
    const res = await fetch(`${HUB_URL}/api/watches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());
    msgEl.style.color = "#059669";
    msgEl.textContent = "✅ 已加入万站回音后台监控";
  } catch (err) {
    msgEl.style.color = "#dc2626";
    msgEl.textContent = "添加失败：" + err.message;
  }
});

initPopup();
