const HUB_URL = "http://127.0.0.1:17890";
const GROUP_TITLE = "🔔 消息总管";
const ALARM_NAME = "tabpulse-pulse";

let cycleRunning = false;
let titleSyncTimer = null;

function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  runPulseCycle().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
});

ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runPulseCycle().catch(() => {});
  }
});

// Zero-reload real-time listener: when any already-open tab's title updates (e.g. "(1) 消息中心"), sync within 1.5s!
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.title && tab && /^https?:\/\//i.test(tab.url || "")) {
    clearTimeout(titleSyncTimer);
    titleSyncTimer = setTimeout(() => {
      syncAlreadyOpenBrowserTabs().catch(() => {});
    }, 1500);
  }
});

async function fetchJson(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function findNormalWindow() {
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  if (!wins || wins.length === 0) return null;
  return wins.find((w) => w.focused) || wins[0];
}

async function placeTabInCollapsedGroup(tabId, windowId) {
  try {
    const groups = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
    if (groups && groups.length > 0) {
      const groupId = groups[0].id;
      await chrome.tabs.group({ tabIds: [tabId], groupId });
      await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => {});
    } else {
      const groupId = await chrome.tabs.group({
        tabIds: [tabId],
        createProperties: { windowId },
      });
      await chrome.tabGroups.update(groupId, {
        title: GROUP_TITLE,
        collapsed: true,
        color: "blue",
      });
    }
  } catch {
    // Non-fatal if browser blocks tab grouping during window transition
  }
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") {
        done();
      }
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || tab.status === "complete") {
        done();
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeWatchInBackground(watch, windowId) {
  let tab = null;
  try {
    tab = await chrome.tabs.create({
      windowId,
      url: watch.url,
      active: false,
    });
    await chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
    await placeTabInCollapsedGroup(tab.id, windowId);

    await waitForTabComplete(tab.id, 15000);
    // Allow client-side SPA frameworks to render unread badges naturally
    await sleep(4500);

    const execResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["probe.js"],
    });
    const probe = (execResults && execResults[0] && execResults[0].result) || {
      unreadCount: 0,
      snippet: "",
      authExpired: false,
    };

    await fetchJson(`${HUB_URL}/api/report`, {
      method: "POST",
      body: JSON.stringify({
        id: watch.id,
        unreadCount: probe.unreadCount || 0,
        snippet: probe.snippet || "",
        authExpired: Boolean(probe.authExpired),
        pageTitle: probe.pageTitle || "",
        url: probe.url || watch.url,
      }),
    });
  } catch {
    // Silent resilience: never interrupt user or spam errors on transient network failures
  } finally {
    if (tab && tab.id) {
      if (watch.mode === "pinned") {
        await chrome.tabs.discard(tab.id).catch(() => {});
      } else {
        await chrome.tabs.remove(tab.id).catch(() => {});
      }
    }
  }
}

async function updateActionBadge() {
  try {
    const state = await fetchJson(`${HUB_URL}/api/state`);
    const count = Number(state?.stats?.unreadMessagesTotal || 0);
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    }
  } catch {
    // Hub might be offline
  }
}

async function syncAlreadyOpenBrowserTabs() {
  const state = await fetchJson(`${HUB_URL}/api/state`).catch(() => null);
  if (!state || !Array.isArray(state.watches) || state.watches.length === 0) return;

  const openTabs = await chrome.tabs.query({});
  for (const watch of state.watches) {
    if (watch.status === "paused" || !watch.url) continue;
    let watchHost = "";
    try {
      watchHost = new URL(watch.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    const matchingTab = openTabs.find((t) => {
      if (!t.id || !/^https?:\/\//i.test(t.url || "")) return false;
      try {
        const th = new URL(t.url).hostname.replace(/^www\./, "").toLowerCase();
        return th === watchHost || th.endsWith(`.${watchHost}`) || watchHost.endsWith(`.${th}`);
      } catch {
        return false;
      }
    });
    if (!matchingTab) continue;

    try {
      const execResults = await chrome.scripting.executeScript({
        target: { tabId: matchingTab.id },
        files: ["probe.js"],
      });
      const probe = (execResults && execResults[0] && execResults[0].result) || null;
      if (probe) {
        await fetchJson(`${HUB_URL}/api/report`, {
          method: "POST",
          body: JSON.stringify({
            id: watch.id,
            unreadCount: probe.unreadCount || 0,
            snippet: probe.snippet || "",
            authExpired: Boolean(probe.authExpired),
            pageTitle: probe.pageTitle || matchingTab.title || "",
            url: matchingTab.url,
          }),
        });
      }
    } catch {
      // Tab may be restricted or transitioning
    }
  }
}

async function runPulseCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    await syncAlreadyOpenBrowserTabs().catch(() => {});
    const duePayload = await fetchJson(`${HUB_URL}/api/due`);
    const dueList = Array.isArray(duePayload.due) ? duePayload.due : [];
    if (dueList.length > 0) {
      const win = await findNormalWindow();
      if (win && win.id) {
        for (const watch of dueList) {
          await probeWatchInBackground(watch, win.id);
        }
      }
    }
    await updateActionBadge();
  } catch {
    // Hub offline: stay completely silent
  } finally {
    cycleRunning = false;
  }
}
