(() => {
  const title = (document.title || "").trim();
  const href = location.href;
  const pathname = location.pathname || "";

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // 1. Detect login redirect or prominent login gate (never try to bypass auth)
  const passwordInput = document.querySelector('input[type="password"]');
  const loginPathPattern = /\/(login|signin|sign-in|passport|sso|i\/flow\/login)/i;
  const loginTitlePattern = /^(登录|Sign in|Log in|会员登录|用户登录)/i;
  const authExpired =
    loginPathPattern.test(pathname) ||
    loginTitlePattern.test(title) ||
    (Boolean(passwordInput) && isVisible(passwordInput));

  if (authExpired) {
    return {
      unreadCount: 0,
      snippet: "",
      authExpired: true,
      pageTitle: title,
      url: href,
    };
  }

  let unreadCount = 0;

  // 2. Check document.title common unread patterns: (3), [2], 【1条新消息】, 2 unread
  const titlePatterns = [
    /^\(\s*(\d{1,4})\s*\)/,
    /^\[\s*(\d{1,4})\s*\]/,
    /[【\[]\s*(\d{1,4})\s*条?(?:新消息|未读|私信)/i,
    /(\d{1,4})\s*(?:unread|new notifications?|条未读|条新消息)/i,
  ];
  for (const pat of titlePatterns) {
    const m = title.match(pat);
    if (m && m[1]) {
      unreadCount = Math.max(unreadCount, parseInt(m[1], 10) || 0);
    }
  }

  // 3. Read-only scan of notification/unread badges (avoid noisy content counters)
  const badgeSelectors = [
    '[data-testid="AppTabBar_Notifications_Link"] [aria-label]',
    'a[href*="/notifications"] [class*="badge"]',
    'a[href*="/notifications"] [class*="unread"]',
    'a[href*="/message"] [class*="badge"]',
    'a[href*="/message"] [class*="unread"]',
    '[class*="unread-count"]',
    '[class*="unreadCount"]',
    '[class*="msg-count"]',
    '[class*="message-badge"]',
    '[class*="notif-badge"]',
    '[class*="red-dot"][data-count]',
    '[aria-label*="未读"]',
    '[aria-label*="unread" i]',
    '[data-unread]',
  ];

  const ignoredAncestorSelector = "footer, pre, code, article, .markdown-body";
  for (const sel of badgeSelectors) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (!isVisible(el) || el.closest(ignoredAncestorSelector)) continue;
      const aria = el.getAttribute("aria-label") || "";
      const dataUnread = el.getAttribute("data-unread") || el.getAttribute("data-count") || "";
      const txt = (el.textContent || "").trim();

      const ariaMatch = aria.match(/(\d{1,4})\s*(?:条?未读|unread|new)/i);
      if (ariaMatch) {
        unreadCount = Math.max(unreadCount, parseInt(ariaMatch[1], 10) || 0);
      }
      if (/^\d{1,4}$/.test(dataUnread)) {
        unreadCount = Math.max(unreadCount, parseInt(dataUnread, 10) || 0);
      }
      if (/^\d{1,4}\+?$/.test(txt)) {
        unreadCount = Math.max(unreadCount, parseInt(txt, 10) || 0);
      }
    }
  }

  // 4. Optional short snippet preview if unread > 0
  let snippet = "";
  if (unreadCount > 0) {
    const previewSelectors = [
      '[class*="message-item"]',
      '[class*="notification-item"]',
      '[class*="chat-item"]',
      '[data-testid="notification"]',
    ];
    const parts = [];
    for (const sel of previewSelectors) {
      let rows = [];
      try {
        rows = Array.from(document.querySelectorAll(sel));
      } catch {
        continue;
      }
      for (const row of rows.slice(0, 3)) {
        if (!isVisible(row)) continue;
        const clean = (row.innerText || "").replace(/\s+/g, " ").trim();
        if (clean && clean.length >= 4) {
          parts.push(clean.slice(0, 90));
        }
      }
      if (parts.length > 0) break;
    }
    snippet = parts.slice(0, 2).join(" | ");
  }

  return {
    unreadCount,
    snippet,
    authExpired: false,
    pageTitle: title,
    url: href,
  };
})();
