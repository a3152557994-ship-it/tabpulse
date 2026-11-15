const INTENT_TERMS_EN = [
  "hiring",
  "looking for",
  "need a",
  "freelance",
  "contract",
  "budget",
  "paid",
  "agency",
  "consultant",
  "developer needed",
  "help wanted",
  "lf ",
  "lf:",
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
];

function computeIntentScore(title = "", snippet = "", query = "") {
  const hay = `${title} ${snippet}`.toLowerCase();
  let score = 40;
  const qTokens = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  for (const tok of qTokens) {
    if (hay.includes(tok)) score += 15;
  }
  for (const term of [...INTENT_TERMS_EN, ...INTENT_TERMS_ZH]) {
    if (hay.includes(term)) score += 12;
  }
  if (/\$\s?\d+|¥\s?\d+|\d+\s*(usd|k|元|万|刀)/i.test(hay)) {
    score += 18;
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
        "User-Agent": "TabPulse-LeadScanner/0.2 (+https://a3152557994-ship-it.github.io/tabpulse/)",
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

export async function scanBuyerLeads(rawQuery = "Shopify", { limit = 12, hours = 72 } = {}) {
  const query = String(rawQuery || "Shopify").trim().slice(0, 80) || "Shopify";
  const hasChinese = /[\u4e00-\u9fa5]/.test(query);
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - Math.max(24, Number(hours) || 72) * 3600;

  const redditQuery = encodeURIComponent(
    hasChinese ? `${query} 外包 OR 远程 OR 合作` : `${query} hiring OR looking for OR freelance`
  );
  const hnQuery = encodeURIComponent(hasChinese ? query : `${query} hiring freelance`);
  const ghQuery = encodeURIComponent(
    hasChinese
      ? `${query} (外包 OR 兼职 OR 远程 OR 有偿 OR 招募) in:title,body`
      : `${query} (hiring OR freelance OR paid OR bounty OR "help wanted") in:title,body`
  );

  const [redditJson, hnJson, ghJson] = await Promise.all([
    fetchJsonWithTimeout(
      `https://api.pullpush.io/reddit/search/submission/?q=${redditQuery}&size=8&sort=desc`
    ),
    fetchJsonWithTimeout(
      `https://hn.algolia.com/api/v1/search_by_date?query=${hnQuery}&tags=(story,comment)&hitsPerPage=8`
    ),
    fetchJsonWithTimeout(
      `https://api.github.com/search/issues?q=${ghQuery}&sort=created&order=desc&per_page=8`
    ),
  ]);

  const leads = [];

  if (redditJson && Array.isArray(redditJson.data)) {
    for (const row of redditJson.data) {
      const title = String(row.title || "").trim();
      if (!title) continue;
      const body = String(row.selftext || "").replace(/\s+/g, " ").trim().slice(0, 180);
      const createdSec = Number(row.created_utc) || nowSec;
      const url = row.permalink
        ? `https://www.reddit.com${row.permalink}`
        : row.full_link || "https://www.reddit.com";
      leads.push({
        source: `Reddit r/${row.subreddit || "all"}`,
        platform: "reddit",
        title,
        snippet: body || `Posted by u/${row.author || "member"} in r/${row.subreddit || "community"}`,
        url,
        publishedAt: new Date(createdSec * 1000).toISOString(),
        fresh: createdSec >= cutoffSec,
        intentScore: computeIntentScore(title, body, query),
      });
    }
  }

  if (hnJson && Array.isArray(hnJson.hits)) {
    for (const hit of hnJson.hits) {
      const rawTitle = hit.title || hit.story_title || "Hacker News Thread";
      const cleanComment = String(hit.comment_text || hit.story_text || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      const createdSec = Number(hit.created_at_i) || nowSec;
      leads.push({
        source: "Hacker News",
        platform: "hn",
        title: String(rawTitle).trim(),
        snippet: cleanComment || `By @${hit.author || "hn"}`,
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        publishedAt: new Date(createdSec * 1000).toISOString(),
        fresh: createdSec >= cutoffSec,
        intentScore: computeIntentScore(rawTitle, cleanComment, query),
      });
    }
  }

  if (ghJson && Array.isArray(ghJson.items)) {
    for (const issue of ghJson.items) {
      const title = String(issue.title || "").trim();
      const body = String(issue.body || "").replace(/\s+/g, " ").trim().slice(0, 180);
      const createdMs = issue.created_at ? new Date(issue.created_at).getTime() : Date.now();
      const repoName = String(issue.repository_url || "").split("/repos/")[1] || "github";
      leads.push({
        source: `GitHub · ${repoName}`,
        platform: "github",
        title,
        snippet: body || `Issue #${issue.number}`,
        url: issue.html_url,
        publishedAt: new Date(createdMs).toISOString(),
        fresh: createdMs / 1000 >= cutoffSec,
        intentScore: computeIntentScore(title, body, query),
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
      if (b.fresh !== a.fresh) return b.fresh ? 1 : -1;
      if (b.intentScore !== a.intentScore) return b.intentScore - a.intentScore;
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
