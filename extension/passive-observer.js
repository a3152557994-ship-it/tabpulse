(() => {
  if (window.__TABPULSE_PASSIVE_INSTALLED__) return;
  window.__TABPULSE_PASSIVE_INSTALLED__ = true;

  function postPassive(payload) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tabpulsePassive) {
        window.webkit.messageHandlers.tabpulsePassive.postMessage(payload);
      } else if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(JSON.stringify({ passiveEvent: true, ...payload }));
      }
    } catch {
      // ignore
    }
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // 1. W3C App Badging API Hook
  if (navigator && typeof navigator.setAppBadge === "function") {
    const origSet = navigator.setAppBadge.bind(navigator);
    navigator.setAppBadge = function (contents) {
      const n = typeof contents === "number" ? contents : 1;
      postPassive({ event: "badge", unreadCount: Math.max(0, n), snippet: document.title || "" });
      return origSet(contents);
    };
  }
  if (navigator && typeof navigator.clearAppBadge === "function") {
    const origClear = navigator.clearAppBadge.bind(navigator);
    navigator.clearAppBadge = function () {
      postPassive({ event: "badge", unreadCount: 0, snippet: "" });
      return origClear();
    };
  }

  // 2. W3C Web Notification API Hook
  if (typeof window.Notification === "function") {
    const OrigNotification = window.Notification;
    const WrappedNotification = function (title, options = {}) {
      const body = options && options.body ? String(options.body) : "";
      postPassive({
        event: "notification",
        unreadCount: 1,
        snippet: [String(title || ""), body].filter(Boolean).join(" — ").slice(0, 140),
      });
      return new OrigNotification(title, options);
    };
    WrappedNotification.prototype = OrigNotification.prototype;
    Object.defineProperty(WrappedNotification, "permission", {
      get: () => OrigNotification.permission,
    });
    if (typeof OrigNotification.requestPermission === "function") {
      WrappedNotification.requestPermission = OrigNotification.requestPermission.bind(OrigNotification);
    }
    window.Notification = WrappedNotification;
  }

  // 3. Passive Title + Visible Red-Dot Badge MutationObserver (Xianyu / Xiaohongshu / V2EX / Eleduck / Reddit / X)
  let debounceTimer = null;
  let lastSentKey = "";

  const BADGE_SELECTORS = [
    '[class*="unread-count" i]',
    '[class*="unreadCount"]',
    '[class*="msg-count" i]',
    '[class*="message-badge" i]',
    '[class*="notif-badge" i]',
    '[class*="ant-badge-count"]',
    '[class*="reds-badge"]',
    '[class*="im-unread"]',
    'a[href*="/notifications"] [class*="badge" i]',
    'a[href*="/notifications"] [class*="unread" i]',
    'a[href*="/message"] [class*="badge" i]',
    '[data-testid="AppTabBar_Notifications_Link"] [aria-label]',
    '[aria-label*="未读"]',
    '[aria-label*="unread" i]',
    '[data-unread]',
  ];

  function inspectTitleAndBadges() {
    const title = (document.title || "").trim();
    let count = 0;
    const pats = [
      /^\(\s*(\d{1,4})\s*\)/,
      /^\[\s*(\d{1,4})\s*\]/,
      /[【\[]\s*(\d{1,4})\s*条?(?:新消息|未读|私信)/i,
      /(\d{1,4})\s*(?:unread|new notifications?|条未读|条新消息)/i,
    ];
    for (const p of pats) {
      const m = title.match(p);
      if (m && m[1]) count = Math.max(count, parseInt(m[1], 10) || 0);
    }

    // Scan visible DOM unread badges without touching network
    for (const sel of BADGE_SELECTORS) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(sel));
      } catch {
        continue;
      }
      for (const el of nodes.slice(0, 15)) {
        if (!isVisible(el) || el.closest("article, pre, code, footer")) continue;
        const txt = (el.textContent || "").trim();
        const aria = el.getAttribute("aria-label") || "";
        if (/^\d{1,3}\+?$/.test(txt)) {
          count = Math.max(count, parseInt(txt, 10) || 0);
        } else {
          const am = aria.match(/(\d{1,3})\s*(?:条?未读|unread|new)/i);
          if (am) count = Math.max(count, parseInt(am[1], 10) || 0);
        }
      }
    }

    const key = `${count}:${title.slice(0, 40)}`;
    if (key !== lastSentKey) {
      lastSentKey = key;
      postPassive({ event: "mutation", unreadCount: count, snippet: count > 0 ? title : "", pageTitle: title });
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(inspectTitleAndBadges, 1200);
    const obs = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(inspectTitleAndBadges, 2000);
    });
    if (document.documentElement) {
      obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    }
  });
})();
