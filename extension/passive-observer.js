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

  function detectAuthOrChallengeGate() {
    const title = (document.title || "").trim();
    const pathname = location.pathname || "";
    const bodyText = ((document.body && document.body.innerText) || "").slice(0, 1400);

    if (/(安全验证|滑动验证|人机验证|Verify you are human|Just a moment|Security Check)/i.test(title)) {
      return true;
    }
    if (/\/(login|signin|sign-in|passport|sso|i\/flow\/login)/i.test(pathname)) {
      return true;
    }
    if (/^(登录|请登录|Sign in|Log in|会员登录|用户登录|小红书登录)/i.test(title)) {
      return true;
    }
    const pwd = document.querySelector('input[type="password"]');
    if (pwd && isVisible(pwd)) {
      return true;
    }
    // Check prominent QR/SMS login gates on Goofish / Xiaohongshu / Zhihu when not signed in
    if (
      bodyText.length < 900 &&
      /(扫码登录|手机验证码登录|登录后查看|请先登录|Sign in to X|Log in to Reddit)/i.test(bodyText)
    ) {
      return true;
    }
    return false;
  }

  function extractLatestMessageSnippet(fallbackTitle) {
    const selectors = [
      '[class*="conv-item" i]',
      '[class*="session-item" i]',
      '[class*="chat-item" i]',
      '[class*="message-item" i]',
      '[class*="notification-item" i]',
      '[class*="msg-content" i]',
      '[data-testid="notification"]',
      '[data-testid="conversation"]',
    ];
    for (const sel of selectors) {
      let rows = [];
      try {
        rows = Array.from(document.querySelectorAll(sel));
      } catch {
        continue;
      }
      for (const r of rows.slice(0, 4)) {
        if (!isVisible(r)) continue;
        const txt = (r.innerText || "").replace(/\s+/g, " ").trim();
        if (txt.length >= 4 && txt.length <= 220) {
          return txt.slice(0, 110);
        }
      }
    }
    return fallbackTitle || "";
  }

  // 1. W3C App Badging API Hook
  if (navigator && typeof navigator.setAppBadge === "function") {
    const origSet = navigator.setAppBadge.bind(navigator);
    navigator.setAppBadge = function (contents) {
      const n = typeof contents === "number" ? contents : 1;
      postPassive({
        event: "badge",
        authExpired: false,
        unreadCount: Math.max(0, n),
        snippet: extractLatestMessageSnippet(document.title || ""),
      });
      return origSet(contents);
    };
  }
  if (navigator && typeof navigator.clearAppBadge === "function") {
    const origClear = navigator.clearAppBadge.bind(navigator);
    navigator.clearAppBadge = function () {
      postPassive({ event: "badge", authExpired: false, unreadCount: 0, snippet: "" });
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
        authExpired: false,
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

  // 3. Passive Title + Visible Red-Dot Badge + Auth Gate Observer
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
    if (!title && (!document.body || !document.body.innerText)) return;

    const authExpired = detectAuthOrChallengeGate();
    if (authExpired) {
      const authKey = `AUTH_EXPIRED:${location.host}`;
      if (authKey !== lastSentKey) {
        lastSentKey = authKey;
        postPassive({ event: "auth", authExpired: true, unreadCount: 0, snippet: "", pageTitle: title });
      }
      return;
    }

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

    const snippet = count > 0 ? extractLatestMessageSnippet(title) : "";
    const key = `OK:${count}:${snippet.slice(0, 36)}:${title.slice(0, 28)}`;
    if (key !== lastSentKey) {
      lastSentKey = key;
      postPassive({ event: "mutation", authExpired: false, unreadCount: count, snippet, pageTitle: title });
    }
  }

  function startObserver() {
    setTimeout(inspectTitleAndBadges, 2200);
    const obs = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(inspectTitleAndBadges, 2000);
    });
    if (document.documentElement) {
      obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    }
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }
})();
