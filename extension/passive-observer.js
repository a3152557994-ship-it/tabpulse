(() => {
  if (window.__TABPULSE_PASSIVE_INSTALLED__) return;
  window.__TABPULSE_PASSIVE_INSTALLED__ = true;

  function postPassive(payload) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tabpulsePassive) {
        window.webkit.messageHandlers.tabpulsePassive.postMessage(payload);
      }
    } catch {
      // ignore
    }
  }

  // 1. W3C App Badging API Hook (Wavebox / Ferdium standard — zero network traffic)
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

  // 2. W3C Web Notification API Hook (Captures real-time WebSocket push notifications from Xianyu/XHS/Slack/X)
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

  // 3. Passive Title & Badge MutationObserver (Only reacts when the site's own JS updates DOM)
  let debounceTimer = null;
  let lastSentKey = "";

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
    const key = `${count}:${title}`;
    if (key !== lastSentKey) {
      lastSentKey = key;
      postPassive({ event: "mutation", unreadCount: count, snippet: count > 0 ? title : "", pageTitle: title });
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    inspectTitleAndBadges();
    const obs = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(inspectTitleAndBadges, 1800);
    });
    const titleEl = document.querySelector("head > title") || document.head || document.documentElement;
    if (titleEl) {
      obs.observe(titleEl, { subtree: true, childList: true, characterData: true });
    }
  });
})();
