(() => {
  if (window.__TABPULSE_PASSIVE_INSTALLED__) return;
  window.__TABPULSE_PASSIVE_INSTALLED__ = true;

  const INSTALLED_AT = Date.now();
  let consecutiveAuthHits = 0;

  function postPassive(payload) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tabpulsePassive) {
        window.webkit.messageHandlers.tabpulsePassive.postMessage(payload);
      } else if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(JSON.stringify({ passiveEvent: true, ...payload }));
      } else if (window.TabPulseAndroid && typeof window.TabPulseAndroid.onPassiveEvent === "function") {
        window.TabPulseAndroid.onPassiveEvent(JSON.stringify(payload));
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
    const bodyText = ((document.body && document.body.innerText) || "").slice(0, 1600);

    if (/(安全验证|滑动验证|人机验证|Verify you are human|Just a moment|Security Check)/i.test(title)) {
      return true;
    }
    if (/\/(login|signin|sign-in|passport|sso|i\/flow\/login|account\/login|web\/user\/login)/i.test(pathname)) {
      return true;
    }
    if (/^(登录|请登录|Sign in|Log in|会员登录|用户登录|小红书登录|扫码登录)/i.test(title)) {
      return true;
    }
    const pwd = document.querySelector('input[type="password"]');
    if (pwd && isVisible(pwd)) {
      return true;
    }
    // Check prominent QR/SMS login gates on Goofish / Xiaohongshu / Zhihu / BOSS / Zhaopin when not signed in
    if (
      bodyText.length < 1100 &&
      /(扫码登录|手机验证码登录|登录后查看|请先登录|微信扫码登录|APP扫码登录|Sign in to X|Log in to Reddit)/i.test(bodyText)
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
      '[class*="friend-content" i]',
      '[class*="last-msg" i]',
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
      for (const r of rows.slice(0, 5)) {
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
      consecutiveAuthHits = 0;
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
      consecutiveAuthHits = 0;
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

  // 3. Passive Title + Visible Red-Dot Badge + Anti-False-Positive Auth Gate Observer
  let debounceTimer = null;
  let lastSentKey = "";

  const NUMERIC_BADGE_SELECTORS = [
    '[class*="unread-count" i]',
    '[class*="unreadCount"]',
    '[class*="unread-num" i]',
    '[class*="unreadNum"]',
    '[class*="msg-count" i]',
    '[class*="msg-num" i]',
    '[class*="message-badge" i]',
    '[class*="notif-badge" i]',
    '[class*="notice-badge" i]',
    '[class*="badge-count" i]',
    '[class*="ant-badge-count"]',
    '[class*="el-badge__content"]',
    '[class*="van-badge"]',
    '[class*="reds-badge"]',
    '[class*="im-unread"]',
    '[class*="chat-unread"]',
    'a[href*="/notifications"] [class*="badge" i]',
    'a[href*="/notifications"] [class*="unread" i]',
    'a[href*="/message"] [class*="badge" i]',
    'a[href*="/chat"] [class*="badge" i]',
    '[data-testid="AppTabBar_Notifications_Link"] [aria-label]',
    '[aria-label*="未读"]',
    '[aria-label*="unread" i]',
    '[data-unread]',
  ];

  // Numberless pure red-dot badges (GitHub .mail-status.unread, XHS/Maimai/Bilibili/Eleduck dot)
  const DOT_ONLY_SELECTORS = [
    ".mail-status.unread",
    'a[href*="/notifications"] [class*="red-dot" i]',
    'a[href*="/notifications"] [class*="unread-dot" i]',
    'a[href*="/message"] [class*="red-dot" i]',
    'a[href*="/message"] [class*="unread-dot" i]',
    'a[href*="/im"] [class*="red-dot" i]',
    '[class*="nav" i] [class*="unread-dot" i]',
    '[class*="header" i] [class*="unread-dot" i]',
    '[class*="chat-item" i] [class*="unread-dot" i]',
  ];

  function inspectTitleAndBadges() {
    const title = (document.title || "").trim();
    if (!title && (!document.body || !document.body.innerText)) return;

    const authExpired = detectAuthOrChallengeGate();
    if (authExpired) {
      // Anti-false-positive: SPAs/SSOs often flash a login shell for 2-4s while redirecting with cookies!
      consecutiveAuthHits += 1;
      if (Date.now() - INSTALLED_AT < 4500 || consecutiveAuthHits < 2) {
        return;
      }
      const authKey = `AUTH_EXPIRED:${location.host}`;
      if (authKey !== lastSentKey) {
        lastSentKey = authKey;
        postPassive({ event: "auth", authExpired: true, unreadCount: 0, snippet: "", pageTitle: title });
      }
      return;
    }

    consecutiveAuthHits = 0;

    let count = 0;
    const pats = [
      /^\(\s*(\d{1,4})\s*\)/,
      /^\[\s*(\d{1,4})\s*\]/,
      /[【\[]\s*(\d{1,4})\s*条?(?:新消息|未读|私信)/i,
      /(\d{1,4})\s*(?:unread|new notifications?|条未读|条新消息)/i,
      /(?:您有|收到)\s*(\d{1,4})\s*条?(?:新消息|未读|私信)/i,
    ];
    for (const p of pats) {
      const m = title.match(p);
      if (m && m[1]) count = Math.max(count, parseInt(m[1], 10) || 0);
    }

    for (const sel of NUMERIC_BADGE_SELECTORS) {
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
        const dataUnread = el.getAttribute("data-unread") || el.getAttribute("data-count") || "";
        if (/^\d{1,3}\+?$/.test(txt)) {
          const n = parseInt(txt, 10) || 0;
          if (n > 0) count = Math.max(count, n);
        } else if (/^\d{1,3}$/.test(dataUnread)) {
          const n = parseInt(dataUnread, 10) || 0;
          if (n > 0) count = Math.max(count, n);
        } else {
          const am = aria.match(/(\d{1,3})\s*(?:条?未读|unread|new)/i);
          if (am) count = Math.max(count, parseInt(am[1], 10) || 0);
        }
      }
    }

    if (count === 0) {
      for (const sel of DOT_ONLY_SELECTORS) {
        try {
          const dots = Array.from(document.querySelectorAll(sel));
          if (dots.some((d) => isVisible(d) && !d.closest("article, pre, code, footer"))) {
            count = 1;
            break;
          }
        } catch {
          // ignore
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

  // Gentle same-origin daytime keep-alive hook (invoked only by native app for logged-in sessions; zero reload)
  window.__TABPULSE_KEEPALIVE_PING__ = function () {
    try {
      if (detectAuthOrChallengeGate()) return { ok: false, authExpired: true };
      fetch(location.origin + "/favicon.ico", { method: "HEAD", credentials: "include", cache: "no-store" }).catch(
        () => {}
      );
      return { ok: true, ts: Date.now() };
    } catch {
      return { ok: false };
    }
  };

  function startObserver() {
    setTimeout(inspectTitleAndBadges, 2600);
    setTimeout(inspectTitleAndBadges, 6800);
    // Lightweight in-memory passive check every 12s (0 network requests, catches title/JS badge updates reliably)
    setInterval(inspectTitleAndBadges, 12000);
    const obs = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(inspectTitleAndBadges, 1800);
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
