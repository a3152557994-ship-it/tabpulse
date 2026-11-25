const INTENT_TERMS_EN = [
  "hiring",
  "looking for",
  "need a",
  "freelance",
  "contract",
  "bounty",
  "budget",
  "paid",
  "agency",
  "consultant",
  "developer needed",
  "help wanted",
  "for hire",
  "[hiring]",
  "quote",
];

const INTENT_TERMS_ZH = [
  "外包",
  "接单",
  "求购",
  "找人",
  "寻找",
  "兼职",
  "远程",
  "预算",
  "定制",
  "开发",
  "合作",
  "急招",
  "有偿",
  "招聘",
  "诚聘",
  "私活",
];

const NOISE_TITLE_RE = /\b(bump\s+|dependabot|renovate|do not merge|auto-bump|release\s+v?\d|chore\(|ci\()\b/i;

function computeIntentScore(title = "", snippet = "", query = "", isJobBoard = false) {
  const hay = `${title} ${snippet}`.toLowerCase();
  let score = isJobBoard ? 62 : 42;
  const qTokens = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  for (const tok of qTokens) {
    if (hay.includes(tok)) score += 14;
  }
  for (const term of [...INTENT_TERMS_EN, ...INTENT_TERMS_ZH]) {
    if (hay.includes(term)) score += 11;
  }
  if (/\[hiring\]|【远程】|【外包】|【兼职】/i.test(title)) {
    score += 15;
  }
  if (/\$\s?\d+|¥\s?\d+|\d+\s*(usd|k\/m|元|万|刀)/i.test(hay)) {
    score += 16;
  }
  return Math.min(99, score);
}

async function fetchJsonWithTimeout(url, timeoutMs = 5500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "ReplyRadar-LeadScanner/5.3 (+https://a3152557994-ship-it.github.io/tabpulse/)",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function scanBuyerLeads(rawQuery = "Shopify", { limit = 12, hours = 96 } = {}) {
  const query = String(rawQuery || "Shopify").trim().slice(0, 80) || "Shopify";
  const hasChinese = /[\u4e00-\u9fa5]/.test(query);
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - Math.max(24, Number(hours) || 96) * 3600;
  const qLower = query.toLowerCase();
  const qTokens = qLower.split(/[\s,，/]+/).filter((t) => t.length >= 2);

  const redditQuery = encodeURIComponent(
    hasChinese ? `${query} (外包 OR 远程 OR 合作 OR 兼职)` : `${query} (hiring OR "looking for" OR freelance OR budget)`
  );
  const hnQuery = encodeURIComponent(hasChinese ? `${query} 远程` : `${query} hiring freelance`);
  // Strictly `is:issue is:open` so random Pull Requests & CI bumps NEVER pollute leads!
  const ghQuery = encodeURIComponent(
    hasChinese
      ? `${query} is:issue is:open (外包 OR 兼职 OR 远程 OR 有偿 OR 招募 OR 悬赏) in:title,body`
      : `${query} is:issue is:open (hiring OR freelance OR paid OR bounty) in:title,body`
  );

  const [redditJson, hnJson, ghJson, v2JobsJson, v2OutsourceJson] = await Promise.all([
    fetchJsonWithTimeout(`https://api.pullpush.io/reddit/search/submission/?q=${redditQuery}&size=10&sort=desc`),
    fetchJsonWithTimeout(`https://hn.algolia.com/api/v1/search_by_date?query=${hnQuery}&tags=(story,comment)&hitsPerPage=8`),
    fetchJsonWithTimeout(`https://api.github.com/search/issues?q=${ghQuery}&sort=created&order=desc&per_page=8`),
    fetchJsonWithTimeout("https://www.v2ex.com/api/topics/show.json?node_name=jobs"),
    fetchJsonWithTimeout("https://www.v2ex.com/api/topics/show.json?node_name=outsourcing"),
  ]);

  const leads = [];

  // 1. V2EX 酷工作 & 外包节点（真实中文远程/外包/招聘帖）
  const v2Combined = [
    ...(Array.isArray(v2OutsourceJson) ? v2OutsourceJson.map((x) => ({ ...x, _nodeLabel: "V2EX · 外包求购" })) : []),
    ...(Array.isArray(v2JobsJson) ? v2JobsJson.map((x) => ({ ...x, _nodeLabel: "V2EX · 酷工作/远程" })) : []),
  ];
  for (const row of v2Combined) {
    const title = String(row.title || "").trim();
    if (!title || /(求职|找工作|个人接单|承接|接单|接外包|代做|提供.*开发)/i.test(title)) continue; // keep buyer/employer posts, skip seller self-ads
    const body = String(row.content || "").replace(/\s+/g, " ").trim().slice(0, 180);
    const hay = `${title} ${body}`.toLowerCase();
    const matchedQuery = qTokens.length === 0 || qTokens.some((t) => hay.includes(t));
    // Include exact keyword matches, or if user searched broad Chinese freelance terms, top remote/contract posts
    const broadChineseFreelance = hasChinese && /(远程|外包|兼职|独立|全栈|开发|ai|agent)/i.test(hay);
    if (!matchedQuery && !broadChineseFreelance) continue;
    const createdSec = Number(row.created) || nowSec;
    leads.push({
      source: row._nodeLabel,
      platform: "v2ex",
      title,
      snippet: body || "点击查看雇主详细需求与联系方式",
      url: row.url || `https://www.v2ex.com/t/${row.id}`,
      publishedAt: new Date(createdSec * 1000).toISOString(),
      fresh: createdSec >= cutoffSec,
      intentScore: computeIntentScore(title, body, query, true),
    });
  }

  // 2. Reddit Buyer & Hiring Posts
  if (redditJson && Array.isArray(redditJson.data)) {
    for (const row of redditJson.data) {
      const title = String(row.title || "").trim();
      if (!title || NOISE_TITLE_RE.test(title) || /^\[for hire\]/i.test(title)) continue;
      const body = String(row.selftext || "").replace(/\s+/g, " ").trim().slice(0, 180);
      const createdSec = Number(row.created_utc) || nowSec;
      const url = row.permalink
        ? `https://www.reddit.com${row.permalink}`
        : row.full_link || "https://www.reddit.com";
      const sub = row.subreddit || "all";
      const isJobSub = /forhire|hire|freelance|jobs|shopify|saas|entrepreneur/i.test(sub);
      leads.push({
        source: `Reddit r/${sub}`,
        platform: "reddit",
        title,
        snippet: body || `Posted by u/${row.author || "member"} in r/${sub}`,
        url,
        publishedAt: new Date(createdSec * 1000).toISOString(),
        fresh: createdSec >= cutoffSec,
        intentScore: computeIntentScore(title, body, query, isJobSub),
      });
    }
  }

  // 3. Hacker News Hiring & Freelance Threads
  if (hnJson && Array.isArray(hnJson.hits)) {
    for (const hit of hnJson.hits) {
      const rawTitle = String(hit.title || hit.story_title || "Hacker News Thread").trim();
      if (NOISE_TITLE_RE.test(rawTitle)) continue;
      const cleanComment = String(hit.comment_text || hit.story_text || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      const createdSec = Number(hit.created_at_i) || nowSec;
      const isWhoIsHiring = /who is hiring|freelancer\?|seeking freelancer/i.test(rawTitle);
      leads.push({
        source: "Hacker News",
        platform: "hn",
        title: rawTitle,
        snippet: cleanComment || `By @${hit.author || "hn"}`,
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        publishedAt: new Date(createdSec * 1000).toISOString(),
        fresh: createdSec >= cutoffSec,
        intentScore: computeIntentScore(rawTitle, cleanComment, query, isWhoIsHiring),
      });
    }
  }

  // 4. GitHub Open Bounty / Contract / Help-Wanted Issues ONLY (Zero PRs!)
  if (ghJson && Array.isArray(ghJson.items)) {
    for (const issue of ghJson.items) {
      if (issue.pull_request || String(issue.html_url || "").includes("/pull/")) continue;
      const login = String(issue.user?.login || "");
      if (/\[bot\]|dependabot|renovate/i.test(login)) continue;
      const title = String(issue.title || "").trim();
      if (!title || NOISE_TITLE_RE.test(title)) continue;
      const body = String(issue.body || "").replace(/\s+/g, " ").trim().slice(0, 180);
      const createdMs = issue.created_at ? new Date(issue.created_at).getTime() : Date.now();
      const repoName = String(issue.repository_url || "").split("/repos/")[1] || "github";
      leads.push({
        source: `GitHub Bounty · ${repoName}`,
        platform: "github",
        title,
        snippet: body || `Issue #${issue.number}`,
        url: issue.html_url,
        publishedAt: new Date(createdMs).toISOString(),
        fresh: createdMs / 1000 >= cutoffSec,
        intentScore: computeIntentScore(title, body, query, false),
      });
    }
  }

  const seenUrls = new Set();
  const deduped = leads
    .filter((item) => {
      if (!item.url || seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return true;
    })
    .sort((a, b) => {
      if (b.intentScore !== a.intentScore) return b.intentScore - a.intentScore;
      if (b.fresh !== a.fresh) return b.fresh ? 1 : -1;
      return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    })
    .slice(0, limit);

  return {
    ok: true,
    query,
    scannedAt: new Date().toISOString(),
    totalFound: deduped.length,
    leads: deduped,
  };
}
