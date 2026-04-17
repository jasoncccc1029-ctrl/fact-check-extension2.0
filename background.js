/**
 * Maps API textualRating to UI status（錯誤／部分錯誤／證據不足／正確／事實釐清）。
 * 合併 ClaimReview 常見欄位，並對 PolitiFact／Snopes／AFP 等字串做較完整語意對應；避免長句僅因含「待查證」就全落灰。
 */
function fcaRatingClassificationBlob(review) {
  if (!review || typeof review !== "object") return "";
  const parts = [
    review.textualRating,
    review.alternateName,
    review.name,
    review.headline,
    review.title,
    review.description
  ]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  return parts.join(" ").trim();
}

/** 機構正式評級字串（避免把長篇 headline／description 裡的「無法證實」等敘述誤當成評級）。 */
function fcaRatingCoreStrip(review) {
  if (!review || typeof review !== "object") return "";
  const parts = [review.textualRating, review.alternateName]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  return parts.join(" ").trim();
}

/**
 * @param {string} textualRating
 * @param {{ skipBroadInconclusive?: boolean }} [opts] 長篇合併字串時略過易誤判的「證據不足」類子字串比對
 */
function classifyTextualRating(textualRating, opts = {}) {
  const raw = String(textualRating ?? "").trim();
  if (!raw) return "Gray";
  const r = raw.toLowerCase();
  const skipBroad = opts.skipBroadInconclusive === true;

  const critical =
    /\b(pants[\s-]on[\s-]fire|four[\s-]pinocchios?|pinocchios?)\b/i.test(r) ||
    /\b(fake|hoax|scam|debunked|fabricat|doctored|manipulated\s+media)\b/i.test(r) ||
    /\b(mostly\s+false|largely\s+false|almost\s+entirely\s+false)\b/i.test(r) ||
    /\b(false|bogus|incorrect)\b/.test(r) ||
    /not\s+true|isn'?t\s+true|not\s+accurate|without\s+foundation/i.test(r) ||
    raw.includes("錯誤") ||
    raw.includes("謠言") ||
    raw.includes("不實") ||
    raw.includes("虛假") ||
    raw.includes("造假") ||
    raw.includes("偽造");

  const partial =
    /\b(half[\s-]?true|half\s+true)\b/i.test(r) ||
    /\b(misleading|distorted|exaggerat|overblown|cherry[\s-]pick|selective)\b/i.test(r) ||
    /\b(partly|partial(ly)?)\s+(true|false|correct|incorrect)\b/i.test(r) ||
    raw.includes("誤導") ||
    raw.includes("誇大") ||
    raw.includes("斷章取義") ||
    raw.includes("部分錯誤") ||
    raw.includes("部分正確") ||
    raw.includes("易生誤解");

  const verified =
    /\b(mostly\s+true|largely\s+true|almost\s+entirely\s+true)\b/i.test(r) ||
    /\btrue\b/.test(r) ||
    (/\b(confirmed|accurate|legitimate)\b/i.test(r) && !/\bincorrect\b/i.test(r)) ||
    (/\bcorrect\b/i.test(r) && !/\bincorrect\b/i.test(r)) ||
    (raw.includes("正確") && !raw.includes("不正確") && !raw.includes("部分正確"));

  const clarify =
    /\b(mixture|mixed)\b/i.test(r) ||
    /\b(missing\s+context|lacks\s+context|out\s+of\s+context|no\s+context|needs\s+context)\b/i.test(r) ||
    /\b(outdated|recaption(ed)?|miscaption(ed)?|mislabeled|misattributed|miscaption)\b/i.test(r) ||
    /\b(opinion|editorial|satire|satirical)\b/i.test(r) ||
    raw.includes("事實釐清") ||
    /脈絡不足|缺少脈絡|需補充脈絡|脈絡說明/.test(raw) ||
    raw.includes("個人意見") ||
    raw.includes("易造成誤解");

  const inconclusiveExact =
    /^待查證$/i.test(raw.trim()) ||
    /^unverified$/i.test(raw.trim()) ||
    /^證據不足$/i.test(raw.trim()) ||
    /^無法證實$/i.test(raw.trim());
  const inconclusiveNarrowEn =
    /\b(unverified|inconclusive|insufficient\s+evidence|unable\s+to\s+(verify|confirm)|cannot\s+be\s+verified|cannot\s+verify|no\s+credible\s+evidence)\b/i.test(
      r
    ) ||
    /\bunproven\b/i.test(r) ||
    /\bunfounded\b/i.test(r);
  const inconclusiveBroadZh =
    raw.includes("證據不足") ||
    raw.includes("無法證實") ||
    raw.includes("未能證實") ||
    raw.includes("尚無法查證") ||
    /尚無.*共識|尚無查核|無共識結論/.test(raw);
  const inconclusive =
    inconclusiveExact ||
    inconclusiveNarrowEn ||
    (!skipBroad && inconclusiveBroadZh);

  const weakEvidence =
    /\b(unsupported\s+by|not\s+supported\s+by|lacks\s+supporting\s+evidence|weak\s+evidence)\b/i.test(
      r
    ) &&
    !critical &&
    !verified;

  if (critical) return "Red";
  if (partial) return "Orange";
  if (weakEvidence) return "Orange";
  if (verified) return "Green";
  if (clarify) return "Blue";
  if (inconclusive) return "Gray";
  return "Gray";
}

function attachFcaStatusToClaims(claims) {
  return (claims || []).map((c) => {
    const review = c?.claimReview?.[0];
    const core = fcaRatingCoreStrip(review);
    if (core.length) {
      const fromCore = classifyTextualRating(core, { skipBroadInconclusive: false });
      if (fromCore !== "Gray") {
        return { ...c, fcaStatus: fromCore };
      }
    }
    const blob =
      fcaRatingClassificationBlob(review) || String(review?.textualRating || "").trim();
    const longBlob = blob.length > 88;
    return {
      ...c,
      fcaStatus: classifyTextualRating(blob, { skipBroadInconclusive: longBlob })
    };
  });
}

const COFACTS_GQL_URL = "https://api.cofacts.tw/graphql";
const GOOGLE_FACTCHECK_API_URL = "https://factchecktools.googleapis.com/v1alpha1/claims:search";
const TFC_WP_POSTS_API_URL = "https://tfc-taiwan.org.tw/wp-json/wp/v2/posts";
const FCA_INDEX_FETCH_TIMEOUT_MS = 3200;
const FCA_INDEX_MAX_PRIMARY_PAIRS = 6;
const FCA_INDEX_MAX_FALLBACK_PAIRS = 3;

/**
 * 國際查核索引（Vercel）是否僅限受信任使用者。
 * true：未設定 chrome.storage.local「apiToken」時不呼叫索引（請將同一密鑰設於 Vercel `FCA_SEARCH_TOKEN` 並交給信任的人於 Popup 儲存）。
 * false：適合公開上架，搭配伺服器匿名限流（見 VERCEL_SETUP_一步一步.md）。
 */
/** false：與 VERCEL 文件一致，未設 apiToken 仍可查索引（由伺服端限流）；true：僅信任 Popup 已存權杖的客戶端。 */
const FCA_INDEX_TRUSTED_ONLY = false;

/** 新查核請求會中止上一筆索引 fetch，避免快速換選時結果错置。 */
let _fcaFactcheckAbort = null;

/** 查核排序時「可信來源」加權（避免每次 addScore 重新配置陣列）。 */
const FCA_TRUSTED_PUBLISHER_SITES = [
  "factcheck.org",
  "snopes.com",
  "politifact.com",
  "apnews.com",
  "reuters.com",
  "afp.com",
  "fullfact.org",
  "usatoday.com",
  "washingtonpost.com",
  "bbc.com",
  "mygopen.com",
  "cofacts.tw",
  "tfc-taiwan.org.tw",
  "abc.net.au",
  "aap.com.au",
  "altnews.in",
  "thip.media",
  "science.feedback.org",
  "wcnc.com",
  "factcheck.afp.com"
];

const FCA_STRIP_LONE_SURROGATES =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g;

function fcaStripBadUtf16(s) {
  return String(s ?? "").replace(FCA_STRIP_LONE_SURROGATES, "");
}

/** 將瀏覽器 fetch 錯誤轉成可查因的中文說明（通常為網路／防火牆）。 */
function humanizeCofactsFetchError(err) {
  const m = String(err?.message || err || "");
  if (
    m === "Failed to fetch" ||
    m === "NetworkError when attempting to fetch resource." ||
    m.toLowerCase().includes("failed to fetch")
  ) {
    return (
      "無法連線至 Cofacts API。請檢查網路、代理／VPN、公司或校園防火牆，以及廣告封鎖是否阻擋 api.cofacts.tw；" +
      "亦可至 chrome://extensions 重新載入本擴充功能後再試。"
    );
  }
  if (m === "Load failed" || /abort/i.test(m)) {
    return "連線 Cofacts 中斷或逾時，請稍後再試。";
  }
  return m;
}

async function fetchCofactsGraphqlWithRetry(query, variables) {
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ query, variables })
  };
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(COFACTS_GQL_URL, init);
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 420));
    }
  }
  throw lastErr;
}

/** 摘取多篇候選與回覆（content 端會再依重疊篩一篇），供 AI 比對。 */
function summarizeCofactsJsonForAi(gqlJson) {
  const edges = gqlJson?.data?.ListArticles?.edges;
  if (!Array.isArray(edges) || !edges.length) return null;
  const articles = edges.slice(0, 5).map(({ node: n, score: edgeScore }) => {
    if (!n?.id) return null;
    const s = Number(edgeScore);
    return {
      id: n.id,
      ...(Number.isFinite(s) && s > 0 ? { esScore: Math.round(s * 1000) / 1000 } : {}),
      text: String(n.text || "").slice(0, 720),
      replies: (n.articleReplies || []).slice(0, 3).map((ar) => ({
        replyType: ar.replyType || null,
        replySnippet: String(ar?.reply?.text || "").slice(0, 360)
      }))
    };
  }).filter(Boolean);
  if (!articles.length) return null;
  return { articles };
}

/** API 回傳的每一則候選文章是否都尚無 NORMAL 查核回覆（僅有主文、無共識結論可對照）。 */
function cofactsAllReturnedArticlesLackReplies(gqlJson) {
  const edges = gqlJson?.data?.ListArticles?.edges;
  if (!Array.isArray(edges) || !edges.length) return true;
  for (const e of edges) {
    const n = e?.node;
    const replies = n?.articleReplies;
    if (Array.isArray(replies) && replies.length > 0) return false;
    for (const x of n?.aiReplies || []) {
      if (String(x?.status || "").toUpperCase() !== "SUCCESS") continue;
      const t = String(x?.text || "").replace(/\s+/g, " ").trim();
      if (t.length >= 12) return false;
    }
  }
  return true;
}

const FCA_KW_THEME_KEYS = [
  "chinaLexicon",
  "usSkeptic",
  "defenseSecurity",
  "publicHealth",
  "economyTrade"
];

/** 自訂附加關鍵字（與內建表合併；使用者詞彙優先掃描）。 */
function fcaNormalizeKeywordExtras(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of FCA_KW_THEME_KEYS) {
    const arr = raw[k];
    if (!Array.isArray(arr)) continue;
    const cleaned = [
      ...new Set(
        arr
          .map((x) => String(x ?? "").trim())
          .filter(Boolean)
          .slice(0, 120)
      )
    ];
    if (cleaned.length) out[k] = cleaned;
  }
  return out;
}

/** 查核機構／查核網（非新聞快訊本身，而是查核報告頁）。 */
const FCA_DOMAIN_FACTCHECK_HOSTS = [
  "snopes.com",
  "factcheck.org",
  "politifact.com",
  "fullfact.org",
  "tfc-taiwan.org.tw",
  "mygopen.com",
  "cofacts.tw",
  "altnews.in",
  "thip.media",
  "science.feedback.org",
  "factcheck.afp.com"
];

/** 國際大型新聞機構／主流英語入口（含通訊社網站）。 */
const FCA_DOMAIN_INTL_NEWS_HOSTS = [
  "cnn.com",
  "nytimes.com",
  "theguardian.com",
  "wsj.com",
  "bloomberg.com",
  "ft.com",
  "economist.com",
  "axios.com",
  "npr.org",
  "latimes.com",
  "usatoday.com",
  "nbcnews.com",
  "cbsnews.com",
  "bbc.com",
  "reuters.com",
  "apnews.com",
  "dw.com",
  "france24.com",
  "aljazeera.com",
  "spectator.co.uk",
  "washingtonpost.com"
];

/** 台灣為主的新聞媒體／入口（不含已在國際表者）。 */
const FCA_DOMAIN_TW_NEWS_HOSTS = [
  "cna.com.tw",
  "news.ltn.com.tw",
  "ltn.com.tw",
  "udn.com",
  "chinatimes.com",
  "storm.mg",
  "tw.news.yahoo.com",
  "ettoday.net",
  "setn.com",
  "ftvnews.com.tw",
  "pts.org.tw",
  "tvbs.com.tw",
  "nownews.com",
  "rfa.org",
  "voachinese.com"
];

/** 新聞欄「通訊社／國際電」分層（與一般國際大媒體區隔；至少保留一則）。 */
const FCA_WIRE_NEWS_HOSTS = [
  "reuters.com",
  "apnews.com",
  "afp.com",
  "factcheck.afp.com",
  "bloomberg.com",
  "yna.co.kr"
];

const FCA_TRUSTED_NEWS_HOSTS = [
  ...new Set([...FCA_DOMAIN_INTL_NEWS_HOSTS, ...FCA_DOMAIN_TW_NEWS_HOSTS])
];
const FCA_TRUSTED_NEWS_SOURCE_NAMES = [
  "reuters",
  "associated press",
  "ap news",
  "bbc",
  "cnn",
  "the guardian",
  "the new york times",
  "washington post",
  "華視",
  "公視",
  "中央社",
  "cna",
  "聯合報",
  "udn",
  "自由時報",
  "ltn",
  "tvbs",
  "中時",
  "中國時報",
  "三立",
  "ettoday",
  "風傳媒",
  "民視",
  "nownews",
  "路透"
];

function fcaHasCjk(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ""));
}

function fcaGoogleNewsRssSearchUrl(query, localeText) {
  const enc = encodeURIComponent(query);
  if (fcaHasCjk(String(localeText || ""))) {
    return `https://news.google.com/rss/search?q=${enc}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  }
  return `https://news.google.com/rss/search?q=${enc}&hl=en-US&gl=US&ceid=US:en`;
}

async function fcaGetNewsDownrankHosts() {
  try {
    const { fcaNewsDownrankHosts } = await chrome.storage.local.get("fcaNewsDownrankHosts");
    if (typeof fcaNewsDownrankHosts !== "string" || !fcaNewsDownrankHosts.trim()) return [];
    const out = [];
    for (const line of fcaNewsDownrankHosts.split(/\r?\n/)) {
      let h = line.trim().split(/[\s,#]+/)[0] || "";
      h = h.toLowerCase().replace(/^https?:\/\//, "").split("/")[0] || "";
      h = h.replace(/^www\./, "");
      if (h) out.push(h);
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

function fcaNewsHostDownrankPenalty(host, downHosts) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  if (!h || !downHosts?.length) return 0;
  for (const d of downHosts) {
    if (!d) continue;
    if (h === d || h.endsWith("." + d)) return 0.52;
  }
  return 0;
}

/** 即時新聞／英文查核索引共用：地緣與報導泛詞，避免單憑重疊詞拉高相關度。 */
const FCA_LATIN_TOKEN_GENERIC = new Set(
  `trump biden harris obama putin zelensky netanyahu modi xi jinping macron
iran iraq iranian iraqi syria yemen gaza hamas lebanon hezbollah ukraine nato kiev kyiv taiwan
china chinese russia russian india indian israel israeli pakistan turkish turkey korea japan
war wars crisis conflict attack attacks strike strikes bombing missile missiles military naval army
tanker ship ships vessel strait gulf hormuz oil cargo port border security defence defense forces
government president minister prime secretary official officials state country countries nation leaders
report reports claim claims viral video footage clip social media news breaking latest update live
week month year today yesterday people public world international middle eastern regional summit talks
meeting alleged allegedly official sources according cited statement spokesperson nuclear sanction sanctions
ceasefire truce peace troop troops invasion withdraw american british european nato allied`
    .split(/\s+/)
    .filter(Boolean)
);

function fcaXmlDecode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function fcaHostTrusted(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "").trim();
  if (!h) return false;
  return FCA_TRUSTED_NEWS_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

function fcaSourceNameTrusted(name) {
  const s = String(name || "").toLowerCase().trim();
  if (!s) return false;
  return FCA_TRUSTED_NEWS_SOURCE_NAMES.some((k) => s.includes(k));
}

function fcaTrustedHostTw(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "").trim();
  if (!h) return false;
  return FCA_DOMAIN_TW_NEWS_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

function fcaTrustedHostWire(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "").trim();
  if (!h) return false;
  return FCA_WIRE_NEWS_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

/** @returns {"wire"|"local_tw"|"other"} */
function fcaNewsHostTier(host, sourceName) {
  const s = String(sourceName || "").toLowerCase();
  if (fcaTrustedHostWire(host)) return "wire";
  if (/reuters|associated press|\bap news\b|\bafp\b|法新社|路透社/.test(s)) return "wire";
  if (fcaTrustedHostTw(host)) return "local_tw";
  if (
    /中央社|\bcna\b|聯合報|\budn\b|自由時報|\bltn\b|中國時報|中時|ettoday|tvbs|三立|民視|公視|華視|風傳媒|蘋果日報/.test(
      s
    )
  ) {
    return "local_tw";
  }
  return "other";
}

function fcaNormalizeNewsTitleForDedup(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[\s\u3000\-–—·｜|,:;!?。，、！？'"「」『』【】（）]/g, "")
    .trim();
}

function fcaTitleBigrams(title) {
  const n = fcaNormalizeNewsTitleForDedup(title);
  const set = new Set();
  for (let i = 0; i < n.length - 1; i++) {
    set.add(n.slice(i, i + 2));
  }
  return set;
}

function fcaRealtimeNewsTitleSimilarity(a, b) {
  const A = fcaTitleBigrams(a);
  const B = fcaTitleBigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(1, Math.min(A.size, B.size));
}

/** 同事件／高度重複標題去重（保留分數較高者已在陣列前段）。 */
function fcaRealtimeNewsEventDedup(items, threshold = 0.48) {
  const out = [];
  for (const it of items) {
    let dup = false;
    for (const kept of out) {
      if (fcaRealtimeNewsTitleSimilarity(it.title, kept.title) >= threshold) {
        dup = true;
        break;
      }
    }
    if (!dup) out.push(it);
  }
  return out;
}

/**
 * 同媒體只留一則前提下，優先納入：至少 1 則通訊社類、1 則台灣主流（若榜上有）。
 */
function fcaLayerTrustedNewsPick(rankedDeduped, limit) {
  const mediaSeen = new Set();
  const picked = [];
  const tryPush = (it) => {
    const mediaKey = (it.host || it.source || "").toLowerCase().trim();
    if (!mediaKey) return false;
    if (mediaSeen.has(mediaKey)) return false;
    mediaSeen.add(mediaKey);
    picked.push(it);
    return picked.length >= limit;
  };
  const tierOf = (it) => fcaNewsHostTier(it.host, it.source);
  const ranked = [...rankedDeduped];
  const wires = ranked.filter((x) => tierOf(x) === "wire");
  const locals = ranked.filter((x) => tierOf(x) === "local_tw");
  if (wires[0]) tryPush(wires[0]);
  if (locals[0]) tryPush(locals[0]);
  for (const it of ranked) {
    if (picked.length >= limit) break;
    tryPush(it);
  }
  return picked.map(({ __score, ...rest }) => rest);
}

function fcaParseTrustedNewsRss(xmlText, limit = 5) {
  const xml = String(xmlText || "");
  const items = [];
  const reItem = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = reItem.exec(xml)) !== null) {
    const block = m[0];
    const title = fcaXmlDecode((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "")
      .replace(/\s+/g, " ")
      .trim();
    const link = fcaXmlDecode((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || "").trim();
    const sourceName = fcaXmlDecode((block.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || "")
      .replace(/\s+/g, " ")
      .trim();
    const sourceUrlRaw = (block.match(/<source\b[^>]*\burl="([^"]+)"/i) || [])[1] || "";
    const sourceUrl = fcaXmlDecode(sourceUrlRaw).trim();
    if (!title || !link) continue;
    let host = "";
    try {
      const u = new URL(sourceUrl || link);
      host = (u.hostname || "").replace(/^www\./, "").toLowerCase();
    } catch {
      host = "";
    }
    if (!fcaHostTrusted(host) && !fcaSourceNameTrusted(sourceName)) continue;
    const pubDateRaw = fcaXmlDecode(
      (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || ""
    ).trim();
    const pubTs = Date.parse(pubDateRaw);
    items.push({
      title: title.replace(/\s-\s[^-]{1,40}$/, "").trim(),
      link,
      source: sourceName || host,
      host,
      publishedAt: Number.isFinite(pubTs) ? pubTs : 0
    });
    if (items.length >= limit) break;
  }
  return items;
}

const fcaNewsCache = new Map();
const FCA_NEWS_CACHE_TTL_MS = 3 * 60 * 1000;

async function fcaSearchTrustedRealtimeNews(text, limit = 5) {
  const q = String(text || "").replace(/\s+/g, " ").trim();
  if (!q || q.length < 6) return [];
  const locTag = fcaHasCjk(q) ? "zh" : "en";
  const cacheKey = `news:${locTag}:${q.slice(0, 140)}:${limit}`;
  const now = Date.now();
  const cacheHit = fcaNewsCache.get(cacheKey);
  if (cacheHit && now - cacheHit.t < FCA_NEWS_CACHE_TTL_MS) {
    return cacheHit.v;
  }
  const downHosts = await fcaGetNewsDownrankHosts();
  const queries = fcaBuildRealtimeNewsQueries(q);
  if (!queries.length) return [];
  const picks = queries.slice(0, 5);
  const batches = await Promise.all(
    picks.map(async (query) => {
      const url = fcaGoogleNewsRssSearchUrl(query, q);
      try {
        const res = await fetch(url, {
          headers: {
            Accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8"
          }
        });
        if (!res.ok) return [];
        const xml = await res.text();
        return fcaParseTrustedNewsRss(xml, Math.max(limit * 2, 8));
      } catch (e) {
        console.log("[FCA] realtime trusted news", query, e);
        return [];
      }
    })
  );
  const merged = [];
  const seen = new Set();
  for (const rows of batches) {
    for (const it of rows) {
      const key = `${it.link}::${it.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
    }
  }
  if (!merged.length) return [];
  const scored = merged
    .map((it) => {
      const target = `${it.title} ${it.source} ${it.host}`;
      const lex = fcaRealtimeNewsLexicalScore(q, target);
      return {
        ...it,
        __lex: lex,
        __score:
          lex +
          fcaRealtimeNewsRecencyScore(it.publishedAt) -
          fcaRealtimeNewsOpinionPenalty(it.title) -
          fcaNewsHostDownrankPenalty(it.host, downHosts)
      };
    })
    .sort((a, b) => b.__score - a.__score);

  const floorPrimary =
    fcaHasCjk(q) && q.replace(/\s/g, "").length > 36 ? 0.132 : 0.118;
  const floorFallback = 0.072;
  let pool = scored.filter((it) => it.__lex >= floorPrimary);
  if (!pool.length) pool = scored.filter((it) => it.__lex >= floorFallback);
  if (!pool.length) pool = scored;

  const ranked = pool.map(({ __lex, ...rest }) => rest);
  const eventDeduped = fcaRealtimeNewsEventDedup(ranked, 0.48);
  const out = fcaLayerTrustedNewsPick(eventDeduped, limit);
  fcaNewsCache.set(cacheKey, { t: now, v: out });
  return out;
}

function fcaBuildRealtimeNewsQueries(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const out = [];
  const add = (s) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    if (!t) return;
    if (out.includes(t)) return;
    out.push(t);
  };

  const firstSentence = cleaned.split(/[。！？!?]/)[0]?.trim() || "";
  const head = firstSentence.length >= 8 ? firstSentence.slice(0, 34) : cleaned.slice(0, 34);
  const kws = extractKeywords(cleaned).slice(0, 5);
  const fallbacks = buildFallbackQueries(cleaned).slice(0, 4);
  const isCjk = fcaHasCjk(cleaned);

  if (isCjk) {
    add(`${head} 即時`);
    if (head.length >= 8) add(`"${head}" 即時`);
    for (const k of kws) add(`${k} 即時`);
    for (const k of fallbacks) add(`${k} 新聞`);
    if (cleaned.length <= 22) add(`${cleaned} 即時`);
  } else {
    add(`${head} breaking news`);
    if (head.length >= 10) add(`"${head}" live`);
    for (const k of kws) add(`${k} latest news`);
    for (const k of fallbacks) add(`${k} news`);
    if (cleaned.length <= 48) add(`${cleaned} breaking`);
  }
  return out.slice(0, 8);
}

function fcaWeakNewsYearToken(w) {
  return /^(19|20)\d{2}$/.test(String(w || "").toLowerCase());
}

/** 反白談鐵路／高鐵新制時，避免「同年媽祖進香直播」等僅撞年份的離題新聞排到前面。 */
function fcaRealtimeNewsCrossDomainPenalty(queryText, title) {
  const q = String(queryText || "");
  const t = String(title || "");
  if (!q || !t) return 0;
  const railQ =
    /(?:台|臺)鐵|高鐵|雙鐵|捷運|輕軌|對號座|自由座|定期票|台灣高鐵|臺灣高鐵|新自強|EMU\d{3}/.test(
      q
    );
  if (!railQ) return 0;
  const railT =
    /(?:台|臺)鐵|高鐵|雙鐵|捷運|輕軌|對號座|自由座|定期票|台灣高鐵|臺灣高鐵|新自強|EMU\d{3}/.test(
      t
    );
  const festT =
    /媽祖|進香|白沙屯|大甲|繞境|起駕|香燈|GPS定位|直播.*媽|媽祖.*直播/.test(t);
  if (festT && !railT) return 0.94;
  return 0;
}

function fcaRealtimeNewsLexicalScore(queryText, targetText) {
  const q = String(queryText || "").trim();
  const t = String(targetText || "").trim();
  if (!q || !t) return 0;
  const qWords = fcaRealtimeTokens(q);
  const tNorm = t.toLowerCase();
  if (!qWords.length) return 0;
  let hit = 0;
  let distinct = 0;
  const matched = [];
  for (const w of qWords) {
    const wl = String(w).toLowerCase();
    if (!wl) continue;
    if (tNorm.includes(wl)) {
      hit++;
      distinct++;
      matched.push(w);
    }
  }
  let base = hit / qWords.length;
  const lenBonus = qWords.some((w) => /[\u4e00-\u9fff]{4,}/.test(w)) ? 0.08 : 0;
  let out = Math.min(1, base + lenBonus);
  const n = qWords.length;
  if (n >= 10 && distinct < 3) out *= 0.68;
  else if (n >= 6 && distinct < 2) out *= 0.64;
  else if (n >= 4 && distinct < 2) out *= 0.8;
  if (matched.length && matched.every((w) => fcaWeakNewsYearToken(w))) {
    out *= 0.06;
  }
  out -= fcaRealtimeNewsCrossDomainPenalty(q, t);
  return Math.max(0, out);
}

function fcaRealtimeNewsMatchScore(queryText, targetText) {
  return fcaRealtimeNewsLexicalScore(queryText, targetText);
}

function fcaRealtimeNewsRecencyScore(tsMs) {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return 0;
  const ageMs = Date.now() - tsMs;
  if (ageMs <= 0) return 0.3;
  if (ageMs <= 24 * 60 * 60 * 1000) return 0.32; // 24 小時內優先
  if (ageMs <= 72 * 60 * 60 * 1000) return 0.18;
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return 0.1;
  return 0.03;
}

function fcaRealtimeNewsOpinionPenalty(title) {
  const t = String(title || "").toLowerCase();
  if (!t) return 0;
  const patterns = [
    /社論/,
    /觀點/,
    /評論/,
    /專欄/,
    /投書/,
    /論壇/,
    /時評/,
    /\bopinion\b/,
    /\beditorial\b/,
    /\bcolumn\b/,
    /\bcommentary\b/
  ];
  return patterns.some((re) => re.test(t)) ? 0.2 : 0;
}

function fcaRealtimeTokens(text) {
  const s = String(text || "");
  const zhRuns = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const out = [];
  for (const run of zhRuns) {
    out.push(run);
    if (run.length >= 4) out.push(run.slice(0, 4));
    if (run.length >= 6) out.push(run.slice(0, 6));
  }
  const en = s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(
      (x) =>
        x.length >= 4 &&
        !FCA_LATIN_TOKEN_GENERIC.has(x) &&
        !/^(19|20)\d{2}$/.test(x)
    );
  out.push(...en);
  return [...new Set(out)].slice(0, 14);
}

/**
 * 本機掃描：網域分型＋議題關鍵字（後者仍供內部／匯出選用）。
 * 畫面上「網域分析」僅使用 domain／host。
 */
function buildLocalMediaScan(selectionText, pageHost, keywordExtras = null) {
  const text = String(selectionText ?? "").replace(/\s+/g, " ").trim();
  const host = String(pageHost ?? "")
    .replace(/^www\./, "")
    .toLowerCase()
    .trim();

  function hostIn(list) {
    if (!host) return false;
    return list.some((s) => host === s || host.endsWith("." + s));
  }

  let domain = {
    tier: "unknown",
    label: "其它／未分類網域",
    detail:
      "尚未納入內建分型表。請自行確認發布單位、作者、原始引用與網站屬性（是否為新聞、意願見、論壇等）。"
  };
  if (!host) {
    domain = {
      tier: "unknown",
      label: "無法取得頁面網域",
      detail: "若於外掛視窗或其它環境查詢，將無法對來源網站分型。"
    };
  } else if (host.endsWith(".gov.tw") || host.includes(".gov.tw")) {
    domain = {
      tier: "gov_tw",
      label: "政府／公開機構（.gov.tw）",
      detail:
        "多可視為官方第一手資訊來源，仍請留意文件日期、管轄單位、頁面是否為新聞稿或法規全文。"
    };
  } else if (host.endsWith(".gov") && !host.includes(".gov.tw")) {
    domain = {
      tier: "gov_us",
      label: "政府／公立機構網域（.gov，非台灣）",
      detail:
        "多為機關官方網站；請確認頁面層級（部門、地方、競選或封存站）與發布日期。"
    };
  } else if (host.endsWith(".edu")) {
    domain = {
      tier: "academic",
      label: "學術／教育網域（.edu）",
      detail:
        "常為學校或研究單位；新聞性內容可能來自校刊或研究科普，仍請對照原始論文或官方新聞稿。"
    };
  } else if (hostIn(FCA_DOMAIN_FACTCHECK_HOSTS)) {
    domain = {
      tier: "fact_check",
      label: "查核機構／事實查核平台",
      detail:
        "網站主體為查核或闢謠；請逐則閱讀評級理由、時間與引用出處。若為社群協作平台，請確認是否已有正式查核回覆再做結論。"
    };
  } else if (hostIn(FCA_DOMAIN_INTL_NEWS_HOSTS)) {
    domain = {
      tier: "news_intl",
      label: "國際大型新聞媒體／通訊社",
      detail:
        "通常有編輯與更正政策；即時 live blog 或快訊仍會更新。請對照內文引用、署名與是否為評論版／分析稿。"
    };
  } else if (hostIn(FCA_DOMAIN_TW_NEWS_HOSTS)) {
    domain = {
      tier: "news_tw",
      label: "台灣新聞媒體／新聞入口",
      detail:
        "具編輯台流程為常態；轉載或快讯請追查是否標註原始外电／通訊社與來稿單位。"
    };
  } else if (
    hostIn([
      "threads.net",
      "facebook.com",
      "fb.com",
      "instagram.com",
      "twitter.com",
      "x.com",
      "dcard.tw",
      "ptt.cc",
      "reddit.com",
      "youtube.com",
      "youtu.be",
      "tiktok.com",
      "line.me"
    ])
  ) {
    domain = {
      tier: "social_ugc",
      label: "社群平台／使用者生成內容",
      detail:
        "貼文、留言與轉傳多未經審稿；請盡量回到當事方、官方或主流新聞的一手來源核對。"
    };
  }

  const pickSamples = (keys, limit = 4) => {
    const seen = new Set();
    const out = [];
    for (const k of keys) {
      if (text.includes(k) && !seen.has(k)) {
        seen.add(k);
        out.push(k);
        if (out.length >= limit) break;
      }
    }
    return out;
  };

  const ex = keywordExtras && typeof keywordExtras === "object" ? keywordExtras : {};

  const chinaLex = pickSamples(
    [
      ...(ex.chinaLexicon || []),
      "視頻",
      "互聯網",
      "軟件",
      "屏幕",
      "充值",
      "點贊",
      "視頻號",
      "網信辦",
      "負能量",
      "接地氣",
      "圈粉",
      "高質量發展",
      "高亮"
    ],
    5
  );

  const usSkKeys = [
    ...(ex.usSkeptic || []),
    "疑美",
    "疑美論",
    "美國陰謀",
    "美國不可信",
    "棄台",
    "賣台",
    "掏空台灣",
    "棋子",
    "美軍不會來",
    "美國只會口頭"
  ];
  const usSkFound = pickSamples(usSkKeys, 5);

  const defFound = pickSamples(
    [
      ...(ex.defenseSecurity || []),
      "國防部",
      "軍售",
      "共機",
      "台海",
      "國軍",
      "國防預算",
      "兵推",
      "演訓",
      "軍機",
      "飛彈",
      "戰機",
      "國防安全"
    ],
    5
  );

  const healthFound = pickSamples(
    [
      ...(ex.publicHealth || []),
      "疫情",
      "疫苗",
      "確診",
      "CDC",
      "WHO",
      "公衛",
      "傳染",
      "病毒",
      "防疫",
      "衛福部",
      "指揮中心"
    ],
    5
  );

  const econFound = pickSamples(
    [
      ...(ex.economyTrade || []),
      "關稅",
      "制裁",
      "CPTPP",
      "APEC",
      "FED",
      "Fed",
      "央行",
      "匯率",
      "升息",
      "降息",
      "貿易戰",
      "WTO",
      "供應鏈",
      "出口",
      "進口"
    ],
    5
  );

  const themes = {
    chinaLexicon: { hit: chinaLex.length > 0, samples: chinaLex },
    usSkeptic: { hit: usSkFound.length > 0, samples: usSkFound },
    defenseSecurity: { hit: defFound.length > 0, samples: defFound },
    publicHealth: { hit: healthFound.length > 0, samples: healthFound },
    economyTrade: { hit: econFound.length > 0, samples: econFound }
  };

  return {
    version: 1,
    host,
    domain,
    themes,
    disclaimer:
      "僅為關鍵字與網域規則之輔助提示，無法判斷真假，亦可能誤判；請與查核資料及原始來源交叉比對。"
  };
}

function parseGeminiJsonText(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  let s = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(s.slice(i, j + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 去除 BOM、頭尾空白、誤貼的引號，避免金鑰讀取失敗。 */
function normalizeGeminiApiKey(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.replace(/^\uFEFF/, "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  // 容錯：允許貼入 "Bearer xxx" 或整段 URL 含 ?key=xxx
  s = s.replace(/^bearer\s+/i, "").trim();
  const km = s.match(/[?&]key=([^&\s]+)/i);
  if (km && km[1]) {
    try {
      s = decodeURIComponent(km[1]).trim();
    } catch {
      s = km[1].trim();
    }
  }
  s = s.replace(/\s+/g, "");
  return s;
}

const GEMINI_MODEL_FALLBACKS = [
  "gemini-2.0-flash"
];
const FCA_AI_SUMMARY_MAX_CHARS = 140;

function normalizeGeminiModelName(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/^models\//i, "").trim();
  s = s.replace(/:generateContent$/i, "").trim();
  return s;
}

/** 最近一次 Gemini HTTP 錯誤狀態（供判斷 429 配額）。成功時歸零。 */
let fcaLastGeminiHttpStatus = 0;
/** 金鑰無效、過期或遭停用（應停止換模型重試）。 */
let fcaLastGeminiKeyInvalid = false;
/** 最近一次 Gemini 錯誤摘要（供 UI 診斷；成功時清空）。 */
let fcaLastGeminiErrHint = "";
/** Gemini 暫時冷卻（429/503）截止時間；冷卻中直接略過請求，避免持續撞限流。 */
let fcaGeminiCooldownUntil = 0;
let fcaGeminiCooldownStatus = 0;
/** 把冷卻截止時間寫進 session storage，跨 SW 重啟後仍能讀回。 */
function fcaSaveGeminiCooldown() {
  chrome.storage.session.set({
    fcaGeminiCooldownUntil,
    fcaGeminiCooldownStatus
  }).catch(() => {});
}
/** 若記憶體冷卻已過期（SW 重啟歸零），嘗試從 session storage 補回。 */
async function fcaRestoreGeminiCooldownIfNeeded() {
  if (fcaGeminiCooldownUntil > Date.now()) return; // 記憶體已有效，不用讀 storage
  try {
    const s = await chrome.storage.session.get(["fcaGeminiCooldownUntil", "fcaGeminiCooldownStatus"]);
    const until = Number(s.fcaGeminiCooldownUntil) || 0;
    if (until > Date.now()) {
      fcaGeminiCooldownUntil = until;
      fcaGeminiCooldownStatus = Number(s.fcaGeminiCooldownStatus) || 429;
      console.log("[FCA] gemini cooldown restored from session storage,",
        Math.ceil((until - Date.now()) / 1000) + "s remaining");
    }
  } catch {}
}
/** 冷卻中略過 Gemini 時，節流 console（避免併發／多段流程洗版）。 */
let fcaGeminiCooldownLogAt = 0;
/** 429 後冷卻拉長，並搭配「遇配額不換模型」避免單次查核打爆配額。 */
const FCA_GEMINI_COOLDOWN_429_MS = 300 * 1000;
const FCA_GEMINI_COOLDOWN_LOG_MIN_MS = 50 * 1000;
const FCA_GEMINI_COOLDOWN_503_MS = 25 * 1000;
/** 候選模型上限：Free tier 15 RPM，單次查核最多用 2 個模型就好。 */
const FCA_GEMINI_DISCOVERED_MODEL_CAP = 1;
/** 以 API key 為粒度快取可用模型，避免每次都打 list models。 */
let fcaGeminiModelDiscoveryCache = { keyHash: "", at: 0, models: [] };
const FCA_GEMINI_MODEL_DISCOVERY_TTL_MS = 10 * 60 * 1000;

async function geminiDiscoverAvailableModels(apiKey) {
  const keyNorm = String(apiKey || "").trim();
  if (!keyNorm) return [];
  /* 冷卻中不打 listModels，直接回傳快取或空陣列 */
  if (fcaGeminiCooldownUntil > Date.now()) {
    return Array.isArray(fcaGeminiModelDiscoveryCache.models)
      ? fcaGeminiModelDiscoveryCache.models.slice()
      : [];
  }
  const now = Date.now();
  /* 先看記憶體快取 */
  if (
    fcaGeminiModelDiscoveryCache.keyHash === keyNorm &&
    now - fcaGeminiModelDiscoveryCache.at < FCA_GEMINI_MODEL_DISCOVERY_TTL_MS &&
    Array.isArray(fcaGeminiModelDiscoveryCache.models) &&
    fcaGeminiModelDiscoveryCache.models.length
  ) {
    return fcaGeminiModelDiscoveryCache.models.slice();
  }
  /* SW 重啟後記憶體歸零，嘗試從 session storage 補回（避免多一次 API 呼叫）。 */
  try {
    const cached = await chrome.storage.session.get(["fcaModelCacheKey", "fcaModelCacheAt", "fcaModelCacheList"]);
    if (
      cached.fcaModelCacheKey === keyNorm &&
      Number(cached.fcaModelCacheAt) + FCA_GEMINI_MODEL_DISCOVERY_TTL_MS > now &&
      Array.isArray(cached.fcaModelCacheList) &&
      cached.fcaModelCacheList.length
    ) {
      fcaGeminiModelDiscoveryCache = { keyHash: keyNorm, at: Number(cached.fcaModelCacheAt), models: cached.fcaModelCacheList };
      return cached.fcaModelCacheList.slice();
    }
  } catch {}
  try {
    const url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(
      keyNorm
    )}`;
    const res = await fetch(url, { method: "GET" });
    const raw = await res.text();
    const data = raw ? JSON.parse(raw) : null;
    const rows = Array.isArray(data?.models) ? data.models : [];
    const models = rows
      .filter((m) =>
        Array.isArray(m?.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m) =>
        normalizeGeminiModelName(String(m?.name || ""))
      )
      .filter((m) => /^gemini-/i.test(m));
    const deduped = [...new Set(models)];
    const cacheAt = Date.now();
    fcaGeminiModelDiscoveryCache = { keyHash: keyNorm, at: cacheAt, models: deduped };
    /* 同步寫 session storage，跨 SW 重啟有效 */
    chrome.storage.session.set({
      fcaModelCacheKey: keyNorm,
      fcaModelCacheAt: cacheAt,
      fcaModelCacheList: deduped
    }).catch(() => {});
    return deduped;
  } catch {
    return [];
  }
}

async function geminiRequestOneModel(
  model,
  apiKey,
  instructions,
  userPayloadText,
  maxOutputTokens
) {
  const m = normalizeGeminiModelName(model);
  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(
    m
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28000);
  const buildPayload = (mode = "json") => {
    const base = {
      contents: [
        {
          role: "user",
          parts: [{ text: `${instructions}\n\n${userPayloadText}` }]
        }
      ]
    };
    if (mode === "json") {
      base.generationConfig = {
        temperature: 0.12,
        maxOutputTokens,
        responseMimeType: "application/json"
      };
    } else if (mode === "plain") {
      base.generationConfig = {
        temperature: 0.12,
        maxOutputTokens
      };
    }
    return base;
  };
  const postGemini = async (mode = "json") => {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(mode))
    });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      return { res, raw, data: null, parseJsonOk: false };
    }
    return { res, raw, data, parseJsonOk: true };
  };

  try {
    let { res, raw, data, parseJsonOk } = await postGemini("json");
    if (!parseJsonOk) {
      return {
        parsed: null,
        tryNextModel: false,
        log: "response not JSON",
        isQuotaOrRate: false
      };
    }

    let errMsg = String(data?.error?.message || "");
    const compatFail = () =>
      res.status === 400 &&
      /invalid json payload|unknown name .*responsemimetype|cannot find field .*responsemimetype|invalid argument/i.test(
        String(data?.error?.message || "")
      );
    if (compatFail()) {
      let r2 = await postGemini("plain");
      res = r2.res;
      raw = r2.raw;
      data = r2.data;
      if (!r2.parseJsonOk) {
        return {
          parsed: null,
          tryNextModel: false,
          log: "response not JSON",
          isQuotaOrRate: false
        };
      }
      if (compatFail()) {
        // 最後相容路徑：不帶 generationConfig
        r2 = await postGemini("minimal");
        res = r2.res;
        raw = r2.raw;
        data = r2.data;
        if (!r2.parseJsonOk) {
          return {
            parsed: null,
            tryNextModel: false,
            log: "response not JSON",
            isQuotaOrRate: false
          };
        }
      }
      errMsg = String(data?.error?.message || "");
    }

    if (!res.ok) {
      fcaLastGeminiHttpStatus = res.status;
      fcaLastGeminiErrHint = (errMsg || raw || "").slice(0, 260);
      const badKey =
        /API key not valid|API_KEY_INVALID|invalid API key|API key expired|renew the API key|reconfigure the API key|has been expired|PERMISSION_DENIED.*key|leaked|API key.*disabled/i.test(
          errMsg
        );
      if (badKey) fcaLastGeminiKeyInvalid = true;
      const isQuotaOrRate =
        res.status === 429 ||
        /RESOURCE_EXHAUSTED|Too Many Requests|quota|rate limit|exceeded your current quota/i.test(
          errMsg
        );
      const isTransientServer =
        (res.status >= 500 && res.status <= 504) ||
        /service unavailable|temporarily unavailable|currently experiencing|backend error|internal error/i.test(
          errMsg
        );
      if (isQuotaOrRate) {
        /* 判斷是 RPM（每分鐘）還是 RPD（每日）配額耗盡，設定對應冷卻時間。
           優先順序：error.details[].retryDelay > Retry-After header > 訊息關鍵字推斷 > 預設5分鐘。*/
        const isDailyQuota =
          /per.?day|daily|exceeded your current quota|free tier|billing|plan.*limit|RESOURCE_EXHAUSTED/i.test(errMsg) &&
          !/per.?minute|per.?second|rate.?limit|too.?many.?requests/i.test(errMsg);
        let suggestedWaitMs = isDailyQuota
          ? 24 * 60 * 60 * 1000   /* 每日配額：等到隔天重置（24h）*/
          : FCA_GEMINI_COOLDOWN_429_MS; /* 速率限制：等 5 分鐘 */
        try {
          const retryAfterHeader = res.headers?.get?.("Retry-After");
          if (retryAfterHeader) {
            const sec = parseInt(retryAfterHeader, 10);
            if (sec > 0) suggestedWaitMs = Math.max(suggestedWaitMs, sec * 1000);
          }
          const details = data?.error?.details;
          if (Array.isArray(details)) {
            for (const d of details) {
              const rd = String(d?.retryDelay || d?.retry_delay || "");
              /* "86400s" → 86400, "60s" → 60, "1.5s" → 1.5 */
              const sec = parseFloat(rd);
              if (sec > 0) suggestedWaitMs = Math.max(suggestedWaitMs, sec * 1000);
            }
          }
        } catch {}
        /* 上限 25 小時，最少 5 分鐘 */
        suggestedWaitMs = Math.min(Math.max(suggestedWaitMs, FCA_GEMINI_COOLDOWN_429_MS), 25 * 60 * 60 * 1000);
        const waitMin = Math.round(suggestedWaitMs / 60000);
        const quotaType = isDailyQuota ? "RPD(daily)" : "RPM(rate)";
        console.log(`[FCA] gemini 429 ${quotaType} – cooldown ${waitMin} min; msg="${errMsg.slice(0,100)}"`);
        fcaGeminiCooldownStatus = 429;
        fcaGeminiCooldownUntil = Math.max(
          fcaGeminiCooldownUntil,
          Date.now() + suggestedWaitMs
        );
        fcaSaveGeminiCooldown();
      } else if (isTransientServer) {
        fcaGeminiCooldownStatus = res.status >= 500 ? res.status : 503;
        fcaGeminiCooldownUntil = Math.max(
          fcaGeminiCooldownUntil,
          Date.now() + FCA_GEMINI_COOLDOWN_503_MS
        );
        fcaSaveGeminiCooldown();
      }
      // 配額／429／暫時壅塞：勿再換模型重試（否則單次查核會對多個模型各打 1～2 次，儀表板 429 暴增）。
      const unsupportedModel =
        res.status === 404 ||
        /not found for API version|is not found|Invalid.*model|unsupported.*model|Unknown model|NOT_FOUND/i.test(
          errMsg
        );
      // 503/5xx 常是單一模型尖峰壅塞；允許接續嘗試下一個模型提升可用率。
      const tryNext =
        !badKey &&
        ((isTransientServer && res.status !== 429) || unsupportedModel);
      if (badKey) {
        console.log("[FCA] Gemini key rejected; skip other models", (errMsg || "").slice(0, 120));
      }
      console.log(
        "[FCA] Gemini",
        m,
        res.status,
        (errMsg || raw).slice(0, 180)
      );
      return {
        parsed: null,
        tryNextModel: tryNext,
        log: errMsg,
        isQuotaOrRate: isQuotaOrRate || isTransientServer
      };
    }

    fcaLastGeminiHttpStatus = 0;
    fcaLastGeminiKeyInvalid = false;
    fcaLastGeminiErrHint = "";
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = parseGeminiJsonText(text);
    if (!parsed || typeof parsed !== "object") {
      console.log("[FCA] Gemini parse fail", String(text).slice(0, 200));
      fcaLastGeminiErrHint = "model returned non-JSON content";
      return { parsed: null, tryNextModel: true, log: "parse", isQuotaOrRate: false };
    }
    console.log("[FCA] Gemini OK model=", m);
    return { parsed, tryNextModel: false, log: "", isQuotaOrRate: false };
  } catch (err) {
    console.log("[FCA] geminiRequestOneModel error", m, err);
    fcaLastGeminiErrHint = String(err?.message || err).slice(0, 260);
    return {
      parsed: null,
      tryNextModel: false,
      log: String(err?.message || err),
      isQuotaOrRate: false
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 遇 429／配額錯誤時對同一模型延遲再試一次，降低免費額度瞬間爆滿的假性失敗。 */
async function geminiRequestOneModelWithBackoff(
  model,
  apiKey,
  instructions,
  userPayloadText,
  maxOutputTokens
) {
  const first = await geminiRequestOneModel(
    model,
    apiKey,
    instructions,
    userPayloadText,
    maxOutputTokens
  );
  if (first.parsed) return first;
  if (fcaLastGeminiKeyInvalid) return first;
  if (first.isQuotaOrRate) {
    // 429／配額：不重打同一模型（徒增計次）。僅對 502–504 做一次短延遲重試。
    const st = Number(fcaLastGeminiHttpStatus) || 0;
    if (st === 429) return first;
    if (st >= 502 && st <= 504) {
      console.log("[FCA] Gemini server blip, retry once after delay", model);
      await new Promise((r) => setTimeout(r, 2800));
      return geminiRequestOneModel(
        model,
        apiKey,
        instructions,
        userPayloadText,
        maxOutputTokens
      );
    }
    return first;
  }
  return first;
}

/**
 * 呼叫 Gemini JSON 模式並解析為物件（不做欄位驗證）。無金鑰／失敗回傳 null。
 * 會依序嘗試使用者指定模型與後備模型（避免某區域無 2.0 導致整段 AI 失效）。
 */
async function geminiFetchParsedJson(
  instructions,
  userPayloadText,
  logTag,
  maxOutputTokens = 1024
) {
  const storage = await chrome.storage.local.get(["geminiApiKey", "fcaGeminiModel"]);
  const apiKey = normalizeGeminiApiKey(storage.geminiApiKey);
  if (!apiKey) {
    console.log("[FCA] geminiFetchParsedJson skipped: no geminiApiKey", logTag || "");
    return null;
  }
  /* SW 重啟後記憶體歸零，先嘗試從 session storage 補回冷卻截止時間。 */
  await fcaRestoreGeminiCooldownIfNeeded();
  const now = Date.now();
  if (fcaGeminiCooldownUntil > now) {
    const waitSec = Math.max(1, Math.ceil((fcaGeminiCooldownUntil - now) / 1000));
    const st = Number(fcaGeminiCooldownStatus) || 429;
    fcaLastGeminiHttpStatus = st;
    fcaLastGeminiErrHint = `rate-limit cooldown ${waitSec}s (HTTP ${st})`;
    if (now - fcaGeminiCooldownLogAt >= FCA_GEMINI_COOLDOWN_LOG_MIN_MS) {
      fcaGeminiCooldownLogAt = now;
      console.log(
        "[FCA] gemini cooldown active",
        `${waitSec}s`,
        `status=${st}`,
        logTag || "",
        "(suppressing similar logs for 50s)"
      );
    }
    return null;
  }

  const userM =
    typeof storage.fcaGeminiModel === "string"
      ? normalizeGeminiModelName(storage.fcaGeminiModel)
      : "";
  const candidates = [];
  if (userM) candidates.push(userM);
  const discovered = await geminiDiscoverAvailableModels(apiKey);
  for (const m of discovered.slice(0, FCA_GEMINI_DISCOVERED_MODEL_CAP)) {
    if (!candidates.includes(m)) candidates.push(m);
  }
  for (const m of GEMINI_MODEL_FALLBACKS) {
    if (!candidates.includes(m)) candidates.push(m);
  }

  for (const model of candidates) {
    if (fcaLastGeminiKeyInvalid) break;
    /* 429 或冷卻中 → 立即停止，不再嘗試其他模型 */
    if (fcaLastGeminiHttpStatus === 429 || fcaGeminiCooldownUntil > Date.now()) break;
    const { parsed, tryNextModel } = await geminiRequestOneModelWithBackoff(
      model,
      apiKey,
      instructions,
      userPayloadText,
      maxOutputTokens
    );
    if (parsed) return parsed;
    if (!tryNextModel) break;
  }

  if (
    fcaLastGeminiHttpStatus !== 429 &&
    !(fcaGeminiCooldownUntil > Date.now())
  ) {
    console.log("[FCA] geminiFetchParsedJson exhausted models", logTag || "");
  }
  return null;
}

/** @returns {{ category: string, reason: string, confidence: number } | null} */
function geminiVerdictCoreFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  const cat = String(parsed.category || "")
    .toUpperCase()
    .trim();
  const allowed = ["RUMOR", "OPINION", "FACT", "OUTDATED"];
  if (!allowed.includes(cat)) {
    console.log("[FCA] Gemini invalid category", cat);
    return null;
  }

  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.6;
  confidence = Math.min(1, Math.max(0, confidence));

  return {
    category: cat,
    reason: String(parsed.reason || "")
      .trim()
      .slice(0, FCA_AI_SUMMARY_MAX_CHARS),
    confidence
  };
}

/**
 * 呼叫 Gemini 產出 { category, reason, confidence }。無金鑰或失敗回傳 null。
 */
async function geminiGenerateVerdict(instructions, userPayloadText, logTag) {
  const parsed = await geminiFetchParsedJson(
    instructions,
    userPayloadText,
    logTag,
    1024
  );
  return geminiVerdictCoreFromParsed(parsed);
}

/**
 * 判斷 Cofacts 候選是否與使用者選取**同一可驗證主題**。回傳 null 表示略過（沿用既有結果）。
 * @returns {Promise<{ related: boolean, reason: string } | null>}
 */
async function verifyCofactsSourceMatchesSelection(selectionText, summaryObj) {
  const sel = String(selectionText ?? "").trim().slice(0, 2400);
  if (!sel || !summaryObj) return null;

  const instructions = `你是查核資料品管員。請判斷「使用者選取文字」與下方 Cofacts 候選（文章 text 與查核回覆摘要）是否**泛指同一則可對照的事實或謠言主題**。
若主題明顯無關（例如一則談採砂石環評、另一則談法院判決且無共同事件或指控連結），必須判定為不相關。
若有片段重合但整體論點不同，也算不相關。
食安／中毒／傳染病稿：若餐點品項、病原類型、主要縣市／行政區、或辨識度高的店家／分店名顯然不同，應判不相關（不可僅因「食物中毒」「衛生局」等泛詞就視為同一案）。
只回傳 JSON：{"related":true或false,"reason":"簡短中文"}`;

  const payload =
    `【使用者選取文字】\n${sel}\n\n【Cofacts 候選摘要 JSON】\n` +
    JSON.stringify(summaryObj, null, 0);

  const parsed = await geminiFetchParsedJson(instructions, payload, "cofacts-rel", 320);
  if (!parsed || typeof parsed.related !== "boolean") return null;

  return {
    related: parsed.related,
    reason: String(parsed.reason || "").trim().slice(0, 400)
  };
}

/**
 * 使用 Gemini 比對使用者選取文字與 Cofacts 摘要。API Key 從 chrome.storage.local「geminiApiKey」讀取。
 * @returns {Promise<{ category: string, reason: string, confidence: number } | null>}
 */
async function analyzeWithAI(selectionText, gqlJson) {
  const sel = String(selectionText ?? "").trim();
  const summary = summarizeCofactsJsonForAi(gqlJson);
  if (!sel || !summary) return null;

  const instructions = `你是一個專業的事實查核員。請比對以下「使用者選取文字」與「Cofacts 查核資料」。
資料中可能含多篇候選文章（articles 陣列），請以與使用者選取最相關的內容與回覆為準做判斷。
若談的是食安／疫情／法律案件，但候選條目的案由、地點、當事節點或病原等與選文明顯不同案，請勿套用該條目的真偽結論，應偏向 [OPINION] 或低信心並在 reason 說明非同一事件。
判斷該文字屬於：
1. [RUMOR]：明確的錯誤資訊。
2. [OPINION]：個人主觀立場、評論、無共識。
3. [FACT]：證實為真的事實。
4. [OUTDATED]：過時但曾是真的資訊。
請只回傳一個 JSON 物件（不要其他說明），格式嚴格如下：
{"category":"RUMOR","reason":"簡短的理由","confidence":0.9}
其中 category 必須是 RUMOR、OPINION、FACT、OUTDATED 四者之一；confidence 為 0 到 1 的小數。`;

  const payload =
    `【使用者選取文字】\n${sel}\n\n【Cofacts 查核資料（JSON）】\n` +
    JSON.stringify(summary, null, 0);

  return geminiGenerateVerdict(instructions, payload, "cofacts");
}

/**
 * 僅依反白文字做常識性判讀（無即時搜尋、非正式查核）。API Key 同上。
 * @returns {Promise<{ category: string, reason: string, confidence: number } | null>}
 */
async function analyzeSelectionStandaloneAI(selectionText, articleContext = "") {
  const sel = String(selectionText ?? "")
    .trim()
    .slice(0, 6000);
  const art = String(articleContext ?? "")
    .trim()
    .slice(0, 4500);
  if (!sel) return null;

  const withArticle = art.length >= 120;

  const instructions = withArticle
    ? `你是謹慎的新聞與資訊助理。使用者正在瀏覽網頁並反白了一段文字；可查核資料庫未提供與反白直接對照的條目（或僅為待查證情境）。
你無法瀏覽即時網路。下方【網頁正文摘錄】取自同一頁可讀正文（可能含側欄／頁尾雜訊、且可能不完整），僅作語境，請交叉對照反白段落。
請在 reason 中依序完成（全中文、約 150～450 字）：
1) 先簡述摘錄與反白相關的內容主旨（當成「新聞／論述摘要」）。
2) 再說明反白作為「事實性陳述」時的傾向、不確定處或需另行查證之處（非正式查核結論）。
分類（擇一）：RUMOR／OPINION／FACT／OUTDATED
— RUMOR：高度可能錯誤、常見謠言表述、或與公認事實明顯牴觸。
— OPINION：意見、價值判斷、煽情敘事、無法僅憑摘錄客觀驗證。
— FACT：在一般理解下屬可驗證且大致成立（仍可能不完整）。
— OUTDATED：可能曾成立但時效或情境已明顯改變。
請只回傳 JSON：{"category":"RUMOR","reason":"（先摘要再判讀）","confidence":0.0到1.0}
category 必須為 RUMOR、OPINION、FACT、OUTDATED 之一。`
    : `你是謹慎的事實查核助理。使用者從網頁「反白」了一段文字（可能只有片段）。你無法瀏覽網路或查即時新聞，請僅依常識、邏輯與廣為人知的知識，評估這段文字作為「事實性陳述」時的大致類型。
若資訊不足、需要可靠來源才能確認、或涉及仍在發展的時事，請在 reason 中誠實說明，並給較低的 confidence。
分類（擇一）：
1. RUMOR：高度可能為錯誤資訊、常見謠言表述、或與公認事實明顯牴觸。
2. OPINION：個人意見、價值判斷、情緒性評論、無法客觀驗證的論述。
3. FACT：在一般理解下屬可驗證且大致成立的事實陳述（仍可能不夠完整）。
4. OUTDATED：可能曾成立但時效或情境已明顯改變。
請只回傳 JSON：{"category":"RUMOR","reason":"簡短中文理由","confidence":0.0到1.0的小數}
其中 category 必須是 RUMOR、OPINION、FACT、OUTDATED 四者之一。`;

  const payload = withArticle
    ? `【使用者反白文字】\n${sel}\n\n【網頁正文摘錄（僅供語境，可能不完整）】\n${art}`
    : `【使用者反白文字】\n${sel}`;

  return geminiGenerateVerdict(instructions, payload, "standalone");
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("[FCA] extension installed / updated");
  chrome.contextMenus.create({
    id: "factcheck",
    title: "查核：\"%s\"",
    contexts: ["selection"]
  });
});


chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "factcheck") {
    const selection = (info.selectionText ?? "").trim();
    if (!selection) return;

    console.log("[FCA] contextMenus onClicked, query length=", selection.length);
    const result = await queryFactCheckSmart(selection);
    await chrome.storage.session.set({
      lastQuery: selection,
      lastResult: result
    });
    const { history = [] } = await chrome.storage.local.get("history");
    const updated = [{
      query: selection,
      time: new Date().toLocaleString("zh-TW"),
      count: result.length
    }, ...history].slice(0, 10);
    await chrome.storage.local.set({ history: updated });
    try {
      await chrome.action.openPopup();
    } catch {
      // 某些情況（平台/版本/權限）不允許直接開 popup，忽略即可
    }
  }
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "OPEN_GEMINI_SETTINGS_TAB") {
    (async () => {
      try {
        const url = chrome.runtime.getURL("popup/popup.html");
        await chrome.tabs.create({ url, active: true });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === "FC_COFACTS_GRAPHQL") {
    const query = typeof msg.query === "string" ? msg.query : "";
    const variables = msg.variables && typeof msg.variables === "object" ? msg.variables : {};
    const selectionText =
      typeof msg.selectionText === "string" ? msg.selectionText.trim() : "";
    if (!query.trim()) {
      sendResponse({ ok: false, error: "EMPTY_QUERY" });
      return;
    }
    console.log("[FCA] FC_COFACTS_GRAPHQL proxy (+ optional AI)");
    (async () => {
      try {
        const res = await fetchCofactsGraphqlWithRetry(query, variables);
        const raw = await res.text();
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          sendResponse({
            ok: false,
            error: `Cofacts HTTP ${res.status}（回傳非 JSON）`
          });
          return;
        }
        if (!res.ok) {
          sendResponse({
            ok: false,
            error: `Cofacts HTTP ${res.status}`,
            json
          });
          return;
        }
        if (json?.errors?.length) {
          sendResponse({
            ok: true,
            json,
            ai: null,
            cofactsDiscarded: false,
            cofactsDiscardReason: "",
            geminiQuotaExceeded: false,
            geminiKeyInvalid: false
          });
          return;
        }
        let ai = null;
        let cofactsDiscarded = false;
        let cofactsDiscardReason = "";
        let hasGemini = false;
        const skipGemini =
          Boolean(msg.skipGemini) || Boolean(msg.thematicSupplementary);
        if (msg.thematicSupplementary) {
          console.log("[FCA] Cofacts thematic supplementary fetch (no Gemini 關聯丟棄)");
        }
        if (selectionText && json && !skipGemini) {
          try {
            fcaLastGeminiHttpStatus = 0;
            fcaLastGeminiKeyInvalid = false;
            const summary = summarizeCofactsJsonForAi(json);
            const storageKey = await chrome.storage.local.get(["geminiApiKey"]);
            hasGemini = normalizeGeminiApiKey(storageKey.geminiApiKey).length > 0;
            /* SW 重啟後記憶體歸零，先補回冷卻截止時間再判斷。 */
            if (hasGemini) await fcaRestoreGeminiCooldownIfNeeded();

            const geminiCoolActive =
              hasGemini && Date.now() < fcaGeminiCooldownUntil;
            if (geminiCoolActive) {
              const waitSec = Math.max(
                1,
                Math.ceil((fcaGeminiCooldownUntil - Date.now()) / 1000)
              );
              fcaLastGeminiHttpStatus = Number(fcaGeminiCooldownStatus) || 429;
              fcaLastGeminiErrHint = `Gemini 配額／429 冷卻中，約 ${waitSec} 秒後再試（此筆略過 AI 關聯與判讀）`;
            } else {
            let useCofactsForAi = true;
            if (hasGemini && summary) {
              // 僅一則候選時略過「關聯檢查」：少打一輪 Gemini，降低 429；ES 已篩出單篇時誤判成本較低。
              const skipRelVerify =
                Array.isArray(summary.articles) && summary.articles.length === 1;
              let rel = null;
              if (!skipRelVerify) {
                rel = await verifyCofactsSourceMatchesSelection(
                  selectionText,
                  summary
                );
              }
              if (rel && rel.related === false) {
                useCofactsForAi = false;
                cofactsDiscarded = true;
                cofactsDiscardReason = rel.reason || "與查核候選主題不符";
                /* 關聯驗證若已觸發 429，不再繼續打 standalone（避免同一筆查核打爆配額）。 */
                const blockedAfterRelVerify =
                  fcaLastGeminiKeyInvalid === true ||
                  fcaLastGeminiHttpStatus === 429 ||
                  (Date.now() < fcaGeminiCooldownUntil &&
                    Number(fcaGeminiCooldownStatus) === 429);
                if (!blockedAfterRelVerify) {
                  ai = await analyzeSelectionStandaloneAI(selectionText);
                }
                console.log(
                  "[FCA] Cofacts discarded as unrelated; standalone AI",
                  ai?.category
                );
              }
            }

            const geminiBlockedAfterRel =
              fcaLastGeminiKeyInvalid === true ||
              fcaLastGeminiHttpStatus === 429 ||
              (Date.now() < fcaGeminiCooldownUntil &&
                Number(fcaGeminiCooldownStatus) === 429);

            if (useCofactsForAi && hasGemini && !geminiBlockedAfterRel) {
              if (cofactsAllReturnedArticlesLackReplies(json)) {
                ai = await analyzeSelectionStandaloneAI(selectionText);
                if (ai) {
                  console.log(
                    "[FCA] Cofacts hits have no replies; standalone AI",
                    ai.category,
                    ai.confidence
                  );
                }
              } else {
                ai = await analyzeWithAI(selectionText, json);
                if (ai) console.log("[FCA] AI verdict", ai.category, ai.confidence);
              }
              /* 只有「非 429／非金鑰錯誤」才 fallback standalone；
                 若剛才已被 429 了，不再多打一槍浪費配額。 */
              const blockedAfterMain =
                fcaLastGeminiKeyInvalid === true ||
                fcaLastGeminiHttpStatus === 429 ||
                (Date.now() < fcaGeminiCooldownUntil &&
                  Number(fcaGeminiCooldownStatus) === 429);
              if (!ai && !blockedAfterMain) {
                ai = await analyzeSelectionStandaloneAI(selectionText);
                if (ai) {
                  console.log(
                    "[FCA] primary AI empty; standalone fallback",
                    ai.category
                  );
                }
              }
            }
            }
          } catch (e) {
            console.log("[FCA] analyzeWithAI / relevance failed", e);
          }
        }
        sendResponse({
          ok: true,
          json,
          ai,
          cofactsDiscarded,
          cofactsDiscardReason,
          geminiKeyInvalid: hasGemini && !ai && fcaLastGeminiKeyInvalid,
          geminiQuotaExceeded:
            hasGemini &&
            !ai &&
            !fcaLastGeminiKeyInvalid &&
            fcaLastGeminiHttpStatus === 429,
          geminiHttpStatus: hasGemini && !ai ? fcaLastGeminiHttpStatus : 0,
          geminiErrHint: hasGemini && !ai ? String(fcaLastGeminiErrHint || "").slice(0, 260) : ""
        });
      } catch (err) {
        console.log("[FCA] FC_COFACTS_GRAPHQL error", err);
        sendResponse({ ok: false, error: humanizeCofactsFetchError(err) });
      }
    })();
    return true;
  }
  if (msg.type === "FC_LOCAL_MEDIA_SCAN") {
    const text = typeof msg.text === "string" ? msg.text : "";
    const host = typeof msg.host === "string" ? msg.host : "";
    (async () => {
      try {
        const bag = await chrome.storage.local.get(["fcaMediaKeywordExtras"]);
        const extras = fcaNormalizeKeywordExtras(bag.fcaMediaKeywordExtras);
        const scan = buildLocalMediaScan(text, host, extras);
        sendResponse({ ok: true, scan });
      } catch (e) {
        console.log("[FCA] FC_LOCAL_MEDIA_SCAN", e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === "FC_TRUSTED_NEWS_SEARCH") {
    const text = typeof msg.text === "string" ? msg.text : "";
    const limit = Number(msg.limit) || 5;
    (async () => {
      try {
        const items = await fcaSearchTrustedRealtimeNews(text, Math.max(1, Math.min(8, limit)));
        sendResponse({ ok: true, items });
      } catch (e) {
        sendResponse({ ok: false, items: [], error: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === "FC_AI_STANDALONE") {
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    const articleContext =
      typeof msg.articleContext === "string" ? msg.articleContext.trim() : "";
    if (!text) {
      sendResponse({ ok: false, error: "EMPTY_TEXT", ai: null });
      return;
    }
    console.log(
      "[FCA] FC_AI_STANDALONE len=",
      text.length,
      "articleCtx=",
      articleContext.length
    );
    (async () => {
      try {
        const storageKey = await chrome.storage.local.get(["geminiApiKey"]);
        const hasK = normalizeGeminiApiKey(storageKey.geminiApiKey).length > 0;
        /* SW 重啟後記憶體歸零，先補回冷卻截止時間。 */
        if (hasK) await fcaRestoreGeminiCooldownIfNeeded();
        /* 若冷卻尚未結束，直接回傳 429 狀態，不送出新請求。 */
        if (hasK && Date.now() < fcaGeminiCooldownUntil) {
          const waitSec = Math.max(1, Math.ceil((fcaGeminiCooldownUntil - Date.now()) / 1000));
          console.log(`[FCA] FC_AI_STANDALONE skipped – cooldown ${waitSec}s remaining`);
          sendResponse({
            ok: true,
            ai: null,
            geminiKeyInvalid: false,
            geminiQuotaExceeded: true,
            geminiHttpStatus: Number(fcaGeminiCooldownStatus) || 429,
            geminiErrHint: `Gemini 冷卻中，約 ${waitSec} 秒後可用`
          });
          return;
        }
        fcaLastGeminiHttpStatus = 0;
        fcaLastGeminiKeyInvalid = false;
        fcaLastGeminiErrHint = "";
        const ai = await analyzeSelectionStandaloneAI(text, articleContext);
        if (ai) console.log("[FCA] standalone AI", ai.category, ai.confidence);
        sendResponse({
          ok: true,
          ai,
          geminiKeyInvalid: hasK && !ai && fcaLastGeminiKeyInvalid,
          geminiQuotaExceeded:
            hasK && !ai && !fcaLastGeminiKeyInvalid && fcaLastGeminiHttpStatus === 429,
          geminiHttpStatus: hasK && !ai ? fcaLastGeminiHttpStatus : 0,
          geminiErrHint: hasK && !ai ? String(fcaLastGeminiErrHint || "").slice(0, 260) : ""
        });
      } catch (e) {
        console.log("[FCA] FC_AI_STANDALONE error", e);
        sendResponse({
          ok: true,
          ai: null,
          error: String(e?.message || e),
          geminiQuotaExceeded: false,
          geminiKeyInvalid: false
        });
      }
    })();
    return true;
  }
  if (msg.type === "FC_ANALYZE_SELECTION") {
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    console.log("[FCA] message FC_ANALYZE_SELECTION received, len=", text.length);
    if (!text) {
      sendResponse({
        ok: false,
        status: "Yellow",
        claimReview: null,
        claims: [],
        error: "EMPTY_TEXT"
      });
      return;
    }
    queryFactCheckSmart(text)
      .then((claims) => {
        const withStatus = attachFcaStatusToClaims(claims);
        if (!withStatus.length) {
          console.log("[FCA] FC_ANALYZE_SELECTION no claims, status Yellow");
          sendResponse({
            ok: true,
            status: "Yellow",
            claimReview: null,
            claims: []
          });
          return;
        }
        const top = withStatus[0];
        const status = top.fcaStatus || "Yellow";
        const claimReview = top.claimReview?.[0] ?? null;
        console.log("[FCA] FC_ANALYZE_SELECTION response status=", status, "claims=", withStatus.length);
        sendResponse({
          ok: true,
          status,
          claimReview,
          claims: withStatus
        });
      })
      .catch((err) => {
        console.log("[FCA] FC_ANALYZE_SELECTION error", err);
        sendResponse({
          ok: false,
          status: "Yellow",
          claimReview: null,
          claims: [],
          error: String(err?.message || err)
        });
      });
    return true;
  }
  if (msg.type === "FC_USER_CLASSIFY_AND_FETCH") {
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    const userStatus = msg.userStatus;
    const allowed = ["Red", "Orange", "Yellow", "Green"];
    console.log("[FCA] message FC_USER_CLASSIFY_AND_FETCH len=", text.length, "userStatus=", userStatus);
    if (!text || !allowed.includes(userStatus)) {
      sendResponse({
        ok: false,
        status: "Yellow",
        claimReview: null,
        claims: [],
        error: "INVALID_INPUT"
      });
      return;
    }
    queryFactCheckSmart(text)
      .then((claims) => {
        const withStatus = attachFcaStatusToClaims(claims);
        const claimReview = withStatus[0]?.claimReview?.[0] ?? null;
        console.log("[FCA] FC_USER_CLASSIFY_AND_FETCH done claims=", withStatus.length, "highlightAs=", userStatus);
        sendResponse({
          ok: true,
          status: userStatus,
          claimReview,
          claims: withStatus
        });
      })
      .catch((err) => {
        console.log("[FCA] FC_USER_CLASSIFY_AND_FETCH error", err);
        sendResponse({
          ok: false,
          status: userStatus,
          claimReview: null,
          claims: [],
          error: String(err?.message || err)
        });
      });
    return true;
  }
  if (msg.type === "QUERY_FACTCHECK") {
    const text = typeof msg.text === "string" ? msg.text : "";
    console.log("[FCA] message QUERY_FACTCHECK len=", String(text).trim().length);
    try {
      _fcaFactcheckAbort?.abort();
    } catch {}
    const ac = new AbortController();
    _fcaFactcheckAbort = ac;
    const signal = ac.signal;
    queryFactCheckSmart(text, signal)
      .then((claims) => {
        if (signal.aborted) {
          sendResponse(attachFcaStatusToClaims([]));
          return;
        }
        console.log("[FCA] QUERY_FACTCHECK result count=", (claims || []).length);
        sendResponse(attachFcaStatusToClaims(claims));
      })
      .catch(() => {
        sendResponse(attachFcaStatusToClaims([]));
      });
    return true;
  }
  if (msg.type === "SHOW_NOTIFICATION") {
    const count = Number(msg.count) || 0;
    const query = typeof msg.query === "string" ? msg.query : "";
    Promise.resolve()
      .then(() => chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "事實查核結果",
        message: count > 0
          ? `找到 ${count} 筆查核結果，點擊擴充功能圖示查看`
          : `查無「${query}」的相關查核資料`
      }))
      .catch(() => {});
    return true;
  }
});


function extractKeywords(text) {
  const cleaned = String(text ?? "")
    .replace(/[！!？?，,。.、；;：:「」『』【】《》\s]/g, " ")
    .trim();
  if (!cleaned) return [];

  // 短句直接用原句（避免關鍵字抽取反而失真）
  if (cleaned.length <= 28) return [cleaned];

  const stopWords = new Set(
    `the a an is are was were be been have has had do does did will would
could should may might that this these those and or but in on at to for
of with by from as it its we they he she you i my our their his her
not no yes than then into out over under said says say also just only
some such more most about after before because being both each even
like made make many much must same seem still take them these those
through too very well what when where which while who whom whose your
there here where why how all any both under again further then than
once ever own same so than into`.split(/\s+/)
  );

  const tokenScores = new Map();
  const bump = (token, score) => {
    const t = String(token ?? "").trim();
    if (t.length < 2) return;
    tokenScores.set(t, (tokenScores.get(t) || 0) + score);
  };

  // 中文：以連續中文字串做 2-4 字 n-gram，偏好較長且重複出現者
  const chineseRuns = cleaned.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of chineseRuns) {
    const maxN = Math.min(4, run.length);
    for (let n = 2; n <= maxN; n++) {
      for (let i = 0; i <= run.length - n; i++) {
        const gram = run.slice(i, i + n);
        bump(gram, 1 + n * 0.6);
      }
    }
  }

  // 英文：分詞 + 去停用詞，偏好較長且重複出現者
  const englishWords = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map(w => w.replace(/^-+|-+$/g, ""))
    .filter(w => w.length >= 4 && !stopWords.has(w));

  const freq = new Map();
  for (const w of englishWords) freq.set(w, (freq.get(w) || 0) + 1);
  for (const [w, c] of freq.entries()) bump(w, c * (1 + Math.min(6, w.length) * 0.25));

  const ranked = [...tokenScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  if (ranked.length === 0) return [cleaned.slice(0, 60)];

  const hasZh = /[\u4e00-\u9fff]/.test(cleaned);

  // 中文長句：首句／首分句常含核心宣稱，單獨當查詢可提高精準度
  let headClause = "";
  if (hasZh) {
    const fc = cleaned.split(/[。！？!?\n]/)[0]?.trim() || "";
    const fcNoSpace = fc.replace(/\s+/g, "");
    if (fcNoSpace.length >= 6 && fcNoSpace.length <= 42) {
      headClause = fcNoSpace;
    }
  }

  // 英文專有名詞／引號內較可能是可查核宣稱
  let quotedSnip = "";
  const qm = cleaned.match(
    /[「『]([^」』]{5,48})[」』]|"([^"]{5,80})"|'([^']{5,80})'/
  );
  if (qm) quotedSnip = (qm[1] || qm[2] || qm[3] || "").trim();

  // 英文長稿：首句常為核心宣稱，單獨查詢可提高精準度（CNN 等）
  let enHeadClause = "";
  if (!hasZh && cleaned.length > 34) {
    const fs = cleaned.split(/[.!?](?:\s+|$)/)[0]?.trim() || "";
    if (fs.length >= 28 && fs.length <= 220) enHeadClause = fs;
  }

  // 查詢字串：中文避免用空格把詞切開（部分後端會把空格當 AND / 分詞，反而降低命中）
  const top = ranked.slice(0, 12);
  const combo4 = hasZh ? top.slice(0, 4).join("") : top.slice(0, 4).join(" ");
  const combo3 = hasZh ? top.slice(0, 3).join("") : top.slice(0, 3).join(" ");
  const combo2 = hasZh ? top.slice(0, 2).join("") : top.slice(0, 2).join(" ");
  const candidates = [
    headClause,
    enHeadClause,
    quotedSnip,
    combo4,
    combo3,
    combo2,
    top[0],
    top[1],
    top[2],
    cleaned.slice(0, 60)
  ]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean);

  // 長文多給主查詢組數；寧可多打幾次索引換召回，再由分數排序
  const maxPrimary =
    cleaned.length > 110 ? 5 :
    cleaned.length > 88 ? 5 :
    cleaned.length > 72 ? 4 :
    cleaned.length > 52 ? 4 : 3;
  return [...new Set(candidates)].slice(0, maxPrimary);
}

function buildFallbackQueries(text) {
  const cleaned = String(text ?? "")
    .replace(/[！!？?，,。.、；;：:「」『』【】《》\s]/g, " ")
    .trim();
  if (!cleaned) return [];

  // 兩三字詞（如「川普」）先前被 length>=4 整段刪除，導致補搜從未執行
  const shortHead =
    cleaned.length >= 2 && cleaned.length <= 12 ? cleaned : "";

  // 針對中文長句：提供更寬鬆的查詢（更像人手動會拿去查的 6–14 字片段）
  const zhRuns = cleaned.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const bestRun = zhRuns.sort((a, b) => b.length - a.length)[0] || "";

  // 常見機構名尾綴，優先抽出主體名稱（例如：與善同行展望協會）
  const orgMatch = cleaned.match(/[\u4e00-\u9fff]{2,}(協會|基金會|學會|總會|工會|公會|委員會|聯盟|聯合會|研究會|促進會|協進會|志工團|關懷協會)/);
  const orgName = orgMatch ? orgMatch[0] : "";

  // 事件描述常從這些動詞開始，前半段通常是主體詞
  const actionSplit = cleaned.split(/(推動|舉辦|辦理|發起|宣導|呼籲|公告|提醒|送暖|捐贈|募款|探訪|關懷)/)[0]?.trim() || "";

  const minLen = cleaned.length <= 12 ? 2 : 4;
  const pieces = [
    shortHead,
    orgName,
    actionSplit,
    cleaned.slice(0, 60),
    cleaned.slice(0, 36),
    cleaned.slice(0, 18),
    bestRun.slice(0, 18),
    bestRun.slice(0, 14),
    bestRun.slice(0, 10),
    bestRun.slice(0, 8)
  ]
    .map(s => s.trim())
    .filter(s => s.length >= minLen);

  return [...new Set(pieces)].slice(0, 4);
}

function fcaSelectionLooksMostlyLatin(text) {
  const t = String(text || "");
  const lat = (t.match(/[a-zA-Z]/g) || []).length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return lat >= 14 && lat >= cjk * 2 + 2;
}


async function queryFactCheckSmart(text, signal) {
  const cleanedText = String(text ?? "").trim();
  const queries = extractKeywords(cleanedText);
  if (queries.length === 0) {
    console.log("[FCA] queryFactCheckSmart no keywords, empty");
    return [];
  }

  if (FCA_INDEX_TRUSTED_ONLY) {
    let apiTok = "";
    try {
      const { apiToken } = await chrome.storage.local.get("apiToken");
      apiTok = String(apiToken || "").trim();
    } catch {}
    if (!apiTok) {
      console.log("[FCA] queryFactCheckSmart: trusted-only mode, missing apiToken — skip index API");
      return [];
    }
  }

  const langs = detectQueryLangs(cleanedText);
  console.log("[FCA] queryFactCheckSmart start queries=", queries.length, "langs=", langs);
  const headers = await getApiHeaders();

  // 快取：同一個 (lang, query) 10 分鐘內不重複打 API
  const cacheTtlMs = 10 * 60 * 1000;
  const now = Date.now();

  const fallbackQueries = buildFallbackQueries(cleanedText);
  const fallbackLangs = langs.length === 1 ? ["zh-TW", "en"] : langs;

  const sessionSnapshot = await fcaPrefetchSearchCacheSnapshot(
    queries,
    langs,
    fallbackQueries,
    fallbackLangs,
    signal
  );

  const primaryP = runSearchBatch({
    queries,
    langs,
    headers,
    now,
    cacheTtlMs,
    signal,
    sessionSnapshot,
    maxPairs: FCA_INDEX_MAX_PRIMARY_PAIRS
  });
  const primary = await primaryP;
  if (signal?.aborted) return [];
  const primaryUnique = dedupeClaims(primary);
  const maybeAugmentWithTfc = async (arr) => {
    const base = Array.isArray(arr) ? arr : [];
    if (base.length >= 3 && (Number(base[0]?.__score) || 0) >= 0.62) return base;
    const tfcRows = await fcaFetchTfcPostsClaims(cleanedText, signal);
    if (!tfcRows.length) return base;
    const merged = dedupeClaims([...base, ...tfcRows]);
    const rescored = merged.map((c) => addScoreToClaim(c, cleanedText));
    rescored.sort((a, b) => (b.__score || 0) - (a.__score || 0));
    return rescored;
  };
  const maybeAugmentWithGoogleFactCheck = async (arr) => {
    const base = Array.isArray(arr) ? arr : [];
    if (base.length >= 3 && (Number(base[0]?.__score) || 0) >= 0.58) return base;
    const gfc = await fcaFetchGoogleFactCheckClaims(cleanedText, signal);
    if (!gfc.length) return base;
    const merged = dedupeClaims([...base, ...gfc]);
    const rescored = merged.map((c) => addScoreToClaim(c, cleanedText));
    rescored.sort((a, b) => (b.__score || 0) - (a.__score || 0));
    return rescored;
  };
  if (primaryUnique.length >= 2 || fallbackQueries.length === 0) {
    const scoredPrimary = primaryUnique.map((c) => addScoreToClaim(c, cleanedText));
    scoredPrimary.sort((a, b) => (b.__score || 0) - (a.__score || 0));
    const withTfc = await maybeAugmentWithTfc(scoredPrimary);
    const augmented = await maybeAugmentWithGoogleFactCheck(withTfc);
    console.log("[FCA] queryFactCheckSmart done claims=", augmented.length, "mode=primary_only");
    return augmented;
  }
  const secondary = await runSearchBatch({
    queries: fallbackQueries,
    langs: fallbackLangs,
    headers,
    now,
    cacheTtlMs,
    signal,
    sessionSnapshot,
    maxPairs: FCA_INDEX_MAX_FALLBACK_PAIRS
  });
  if (signal?.aborted) return [];
  const unique = dedupeClaims([...primaryUnique, ...secondary]);

  const scored = unique.map(c => addScoreToClaim(c, cleanedText));
  scored.sort((a, b) => (b.__score || 0) - (a.__score || 0));
  const withTfc = await maybeAugmentWithTfc(scored);
  const augmented = await maybeAugmentWithGoogleFactCheck(withTfc);
  console.log("[FCA] queryFactCheckSmart done claims=", augmented.length);
  return augmented;
}

function fcaStripHtmlToText(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fcaFetchTfcPostsClaims(text, signal) {
  const q = String(text || "").replace(/\s+/g, " ").trim();
  if (!q || q.length < 4) return [];
  try {
    const qShort = q.slice(0, 72);
    const url =
      `${TFC_WP_POSTS_API_URL}?` +
      `search=${encodeURIComponent(qShort)}` +
      "&per_page=8&page=1&_fields=link,date,title.rendered,excerpt.rendered";
    const res = await fetch(url, { method: "GET", signal });
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const p of rows) {
      const link = String(p?.link || "").trim();
      if (!/^https?:\/\//i.test(link)) continue;
      const title = fcaStripHtmlToText(p?.title?.rendered || "");
      const excerpt = fcaStripHtmlToText(p?.excerpt?.rendered || "");
      const textualRating = title || excerpt.slice(0, 140);
      out.push({
        text: `${title} ${excerpt}`.trim().slice(0, 500),
        claimReview: [
          {
            publisher: { name: "台灣事實查核中心", site: "tfc-taiwan.org.tw" },
            url: link,
            title,
            textualRating,
            languageCode: "zh",
            reviewDate: String(p?.date || "").trim()
          }
        ]
      });
    }
    return dedupeClaims(out);
  } catch {
    return [];
  }
}

async function fcaFetchGoogleFactCheckClaims(text, signal) {
  const q = String(text || "").replace(/\s+/g, " ").trim();
  if (!q || q.length < 8) return [];
  try {
    const bag = await chrome.storage.local.get(["googleFactCheckApiKey", "geminiApiKey"]);
    const keyRaw = String(bag.googleFactCheckApiKey || bag.geminiApiKey || "");
    const apiKey = normalizeGeminiApiKey(keyRaw);
    if (!apiKey) return [];
    const langCandidates = fcaSelectionLooksMostlyLatin(q)
      ? ["en-US", "zh-TW"]
      : ["zh-TW", "en-US"];
    const out = [];
    for (const lang of langCandidates) {
      const url =
        `${GOOGLE_FACTCHECK_API_URL}?` +
        `query=${encodeURIComponent(q.slice(0, 300))}&languageCode=${encodeURIComponent(lang)}&pageSize=8&key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, { method: "GET", signal });
      if (!res.ok) continue;
      const data = await res.json();
      const rows = Array.isArray(data?.claims) ? data.claims : [];
      for (const row of rows) {
        const reviews = Array.isArray(row?.claimReview) ? row.claimReview : [];
        const rev = reviews[0];
        if (!rev?.url) continue;
        const publisherName = String(rev?.publisher?.name || "Google Fact Check").trim();
        const publisherSite = String(rev?.publisher?.site || "toolbox.google.com").trim();
        const textualRating = String(rev?.textualRating || "").trim();
        out.push({
          text: String(row?.text || rev?.title || textualRating || "").trim(),
          claimReview: [
            {
              publisher: { name: publisherName, site: publisherSite },
              url: String(rev.url || "").trim(),
              title: String(rev?.title || "").trim(),
              textualRating,
              languageCode: String(rev?.languageCode || lang).trim(),
              reviewDate: String(rev?.reviewDate || row?.claimDate || "").trim(),
              claimant: String(row?.claimant || "").trim()
            }
          ]
        });
      }
    }
    return dedupeClaims(out);
  } catch {
    return [];
  }
}

/** 主／補搜併行前先讀齊快取鍵，避免兩批各打一次 storage。 */
async function fcaPrefetchSearchCacheSnapshot(
  queries,
  langs,
  fallbackQueries,
  fallbackLangs,
  signal
) {
  if (signal?.aborted) return {};
  const keys = new Set();
  const addPairs = (qs, ls) => {
    for (const query of qs || []) {
      for (const lang of ls || []) {
        keys.add(getCacheKey({ query, lang }));
      }
    }
  };
  addPairs(queries, langs);
  addPairs(fallbackQueries, fallbackLangs);
  const cacheKeys = [...keys];
  if (!cacheKeys.length) return {};
  try {
    return await chrome.storage.session.get(cacheKeys);
  } catch {
    return {};
  }
}

async function runSearchBatch({
  queries,
  langs,
  headers,
  now,
  cacheTtlMs,
  signal,
  sessionSnapshot,
  maxPairs = FCA_INDEX_MAX_PRIMARY_PAIRS
}) {
  const pairs = [];
  for (const query of queries) {
    for (const lang of langs) {
      pairs.push({ query, lang });
    }
  }
  if (!pairs.length || signal?.aborted) return [];
  const cappedPairs =
    Number.isFinite(maxPairs) && maxPairs > 0 ? pairs.slice(0, maxPairs) : pairs;

  let snapshot = sessionSnapshot;
  if (!snapshot || typeof snapshot !== "object") {
    const cacheKeys = cappedPairs.map((p) => getCacheKey(p));
    try {
      snapshot = await chrome.storage.session.get(cacheKeys);
    } catch {
      snapshot = {};
    }
  }

  const fetchPromises = cappedPairs.map((p) =>
    fetchWithCache({
      ...p,
      headers,
      now,
      cacheTtlMs,
      signal,
      sessionSnapshot: snapshot
    })
  );
  const results = await Promise.all(fetchPromises);
  return results.flat();
}

async function fetchJsonArrayWithTimeout(url, options, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cleanup = () => clearTimeout(timer);
  const onExternalAbort = () => {
    cleanup();
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      cleanup();
      return [];
    }
    externalSignal.addEventListener("abort", onExternalAbort);
  }
  try {
    const res = await fetch(url, { ...(options || {}), signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  } finally {
    cleanup();
    try {
      externalSignal?.removeEventListener?.("abort", onExternalAbort);
    } catch {}
  }
}

let _cachedHeaders = null;
let _cachedHeadersAt = 0;

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.apiToken) return;
    _cachedHeaders = null;
    _cachedHeadersAt = 0;
  });
} catch {
  /* ignore */
}

/**
 * 國際查核索引 API 請求標頭。
 * 不再內建共用 secret（上架版解包即可外流）；改由 chrome.storage.local「apiToken」選填。
 * 伺服端應以環境變數驗證金鑰，並對無金鑰請求做嚴格限流，見專案 VERCEL_API.md。
 */
async function getApiHeaders() {
  const cacheMs = 60 * 1000;
  const now = Date.now();
  if (_cachedHeaders && now - _cachedHeadersAt < cacheMs) return _cachedHeaders;

  /** @type {Record<string, string>} */
  const headers = {
    "X-FCA-Client": "fact-check-extension",
    "X-FCA-Extension-Id": typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : ""
  };

  let token = "";
  try {
    const { apiToken } = await chrome.storage.local.get("apiToken");
    if (typeof apiToken === "string" && apiToken.trim()) token = apiToken.trim();
  } catch {}

  if (token) {
    headers["x-secret-token"] = token;
  }

  _cachedHeaders = headers;
  _cachedHeadersAt = now;
  return _cachedHeaders;
}

function detectQueryLangs(text) {
  const s = String(text ?? "");
  const zhCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const enCount = (s.match(/[a-zA-Z]/g) || []).length;
  const total = Math.max(1, zhCount + enCount);
  const zhRatio = zhCount / total;
  const enRatio = enCount / total;

  const hasLongLatnWord = /\b[a-z]{7,}\b/i.test(s);
  const hasZhChunk = zhCount >= 4;

  // 短中文（人名、地名等）查核條目常只標英文語系，需併搜 en 才會命中
  if (zhRatio >= 0.65 && enRatio < 0.2) {
    const t = s.trim();
    if (t.length > 0 && t.length <= 8) return ["zh-TW", "en"];
    if (hasLongLatnWord && enRatio >= 0.06) return ["zh-TW", "en"];
    return ["zh-TW"];
  }
  // 英文為主但含一段中文敘述：國際機構條目可能只收 zh-TW
  if (enRatio >= 0.65 && zhRatio < 0.2) {
    if (hasZhChunk && zhRatio >= 0.06) return ["zh-TW", "en"];
    return ["en"];
  }
  return ["zh-TW", "en"];
}

function getCacheKey({ query, lang }) {
  return `cache:v1:${lang}:${fcaStripBadUtf16(query)}`;
}

/**
 * 網頁選取偶含「孤兒」UTF-16 surrogate，encodeURIComponent 會拋 URIError。
 */
function fcaSafeEncodeURIComponent(value) {
  const stripped = fcaStripBadUtf16(value);
  try {
    return encodeURIComponent(stripped);
  } catch {
    return encodeURIComponent(
      stripped.replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/g, "")
    );
  }
}

/**
 * @param {Record<string, unknown>} [sessionSnapshot] 若由 runSearchBatch 預先 bulk get，可避免每個子查詢各讀一次 storage。
 */
async function fetchWithCache({ query, lang, headers, now, cacheTtlMs, signal, sessionSnapshot }) {
  if (signal?.aborted) return [];
  const cacheKey = getCacheKey({ query, lang });
  try {
    let entry;
    if (sessionSnapshot && typeof sessionSnapshot === "object") {
      entry = sessionSnapshot[cacheKey];
    } else {
      const cached = await chrome.storage.session.get(cacheKey);
      entry = cached?.[cacheKey];
    }
    if (entry && typeof entry.t === "number" && now - entry.t < cacheTtlMs && Array.isArray(entry.v)) {
      return entry.v;
    }
  } catch {}

  const url = `https://fact-check-extension.vercel.app/api/search?query=${fcaSafeEncodeURIComponent(query)}&lang=${fcaSafeEncodeURIComponent(lang)}`;
  console.log("[FCA] API fetch search", { lang, qLen: query.length });
  const data = await fetchJsonArrayWithTimeout(
    url,
    { headers },
    FCA_INDEX_FETCH_TIMEOUT_MS,
    signal
  );
  console.log("[FCA] API response items=", Array.isArray(data) ? data.length : 0);

  try {
    await chrome.storage.session.set({ [cacheKey]: { t: now, v: data } });
  } catch {}

  return data;
}

function dedupeClaims(claims) {
  const seen = new Set();
  const out = [];
  for (const claim of claims) {
    const key =
      typeof claim?.text === "string" ? claim.text :
      claim?.claimReview?.[0]?.url ? claim.claimReview[0].url :
      JSON.stringify(claim);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}

function fcaEnglishDistinctiveTokensForRanking(queryRaw) {
  const s = String(queryRaw || "").toLowerCase();
  const words = s
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter((w) => w.length >= 5 && !FCA_LATIN_TOKEN_GENERIC.has(w));
  return [...new Set(words)];
}

/**
 * 英文主導長句：若反白含多個「非泛詞」卻多數未出現在查核條目，多為 Trump/war 類泛重合，應壓低排序分。
 */
function fcaRefineMatchAgainstEnglishGenericCollision(queryRaw, targetBlob, baseMatch) {
  const q = String(queryRaw || "");
  if (/[\u4e00-\u9fff]/.test(q)) return baseMatch;
  const latN = (q.match(/[a-zA-Z]/g) || []).length;
  if (latN < 20) return baseMatch;

  const toks = fcaEnglishDistinctiveTokensForRanking(q);
  if (toks.length < 4) return baseMatch;

  const hay = normalizeForMatch(targetBlob).toLowerCase();
  let hits = 0;
  for (const w of toks) {
    if (hay.includes(w)) hits++;
  }
  const recall = hits / toks.length;
  if (recall < 0.26) {
    return Math.min(baseMatch, 0.18 + recall * 0.42);
  }
  if (recall < 0.42) {
    return Math.min(baseMatch, baseMatch * (0.62 + recall * 0.55));
  }
  if (recall < 0.55) {
    return Math.min(baseMatch, baseMatch * 0.94);
  }
  return baseMatch;
}

function addScoreToClaim(claim, originalText) {
  const text = typeof claim?.text === "string" ? claim.text : "";
  const review = claim?.claimReview?.[0];
  const rating = typeof review?.textualRating === "string" ? review.textualRating : "";
  const publisherSite = typeof review?.publisher?.site === "string" ? review.publisher.site : "";
  const publisherName = typeof review?.publisher?.name === "string" ? review.publisher.name : "";
  const reviewDate = review?.reviewDate ? new Date(review.reviewDate).getTime() : 0;
  const reviewUrl = typeof review?.url === "string" ? review.url : "";

  const trusted = FCA_TRUSTED_PUBLISHER_SITES.some((s) =>
    publisherSite.includes(s)
  )
    ? 1
    : 0;
  const corpusBlob = `${text} ${publisherName} ${publisherSite} ${rating} ${reviewUrl}`;
  let match = fuzzyMatchScore(originalText, corpusBlob);
  match = fcaRefineMatchAgainstEnglishGenericCollision(originalText, corpusBlob, match);
  const recency = reviewDate ? recencyScore(reviewDate) : 0.15;
  const ratingBoost = ratingScore(rating);

  /** 字面相似優先於新舊度，降低跨主題但較新／較權威稿誤排頂。 */
  let recencyW = recency;
  if (match < 0.38) recencyW *= 0.76;
  if (match < 0.26) recencyW *= 0.86;
  /** 相似度已高時微幅信賴權威來源；低相似時減少「大牌但離題」加分。 */
  const trustW = trusted * (match >= 0.42 ? 1 : match >= 0.3 ? 0.88 : 0.72);
  const score = 0.66 * match + 0.17 * recencyW + 0.11 * trustW + 0.06 * ratingBoost;

  return { ...claim, __score: Math.round(score * 1000) / 1000 };
}

function fuzzyMatchScore(queryText, targetText) {
  const qRaw = String(queryText ?? "");
  const tRaw = String(targetText ?? "");
  const q = normalizeForMatch(qRaw);
  const t = normalizeForMatch(tRaw);
  if (!q || !t) return 0;
  if (t.includes(q)) return 1;

  const hasZhQ = /[\u4e00-\u9fff]/.test(qRaw);
  const hasEnQ = /[a-zA-Z]{4,}/.test(qRaw);

  // 1) token 命中（英文詞、中文詞片）
  const tokenScore = tokenOverlapScore(q, t);

  // 2) 僅取中文部分做 n-gram，避免中英混貼時英文雜訊稀釋 Jaccard
  const zhScore = ngramJaccardScore(qRaw, tRaw);

  if (hasZhQ && hasEnQ) {
    const blended = zhScore * 0.52 + tokenScore * 0.48;
    return Math.max(blended, zhScore, tokenScore);
  }

  return Math.max(tokenScore, zhScore);
}

function tokenOverlapScore(qNorm, tNorm) {
  const qTokens = tokenizeForMatch(qNorm);
  const tTokens = new Set(tokenizeForMatch(tNorm));
  if (qTokens.length === 0) return 0;

  let wHit = 0;
  let wDenom = 0;
  let strong = 0;
  let importantLatin = 0;
  let missedImportantLatin = 0;
  for (const tok of qTokens) {
    const w = FCA_LATIN_TOKEN_GENERIC.has(tok) ? 0.36 : 1;
    wDenom += w;
    const isZh = /[\u4e00-\u9fff]/.test(tok);
    const isImportantLatin = !isZh && tok.length >= 5 && !FCA_LATIN_TOKEN_GENERIC.has(tok);
    if (isImportantLatin) {
      importantLatin++;
      if (!tTokens.has(tok)) missedImportantLatin++;
    }
    if (tTokens.has(tok)) {
      wHit += w;
      if (tok.length >= 6 || /[\u4e00-\u9fff]{4,}/.test(tok)) strong++;
    }
  }
  const denom = Math.min(9, wDenom);
  let base = wDenom > 0 ? Math.min(1, wHit / denom) : 0;
  if (strong >= 1) base = Math.min(1, base + 0.07);
  if (strong >= 2) base = Math.min(1, base + 0.05);
  if (importantLatin >= 3 && missedImportantLatin / importantLatin >= 0.5) {
    base *= 0.74;
  } else if (importantLatin >= 2 && missedImportantLatin === importantLatin) {
    base *= 0.68;
  }
  return base;
}

function extractZhSurface(s) {
  return (String(s ?? "").match(/[\u4e00-\u9fff]+/g) || []).join("");
}

function ngramJaccardScore(queryText, targetText) {
  const qZ = extractZhSurface(queryText);
  const tZ = extractZhSurface(targetText);
  const q = normalizeForNgram(qZ);
  const t = normalizeForNgram(tZ);
  if (!q || !t || q.length < 2) return 0;

  const grams2Q = charNgrams(q, 2);
  const grams2T = charNgrams(t, 2);
  const j2 = jaccard(grams2Q, grams2T);

  const grams3Q = charNgrams(q, 3);
  const grams3T = charNgrams(t, 3);
  const j3 = jaccard(grams3Q, grams3T);

  const grams4Q = q.length >= 4 ? charNgrams(q, 4) : new Set();
  const grams4T = t.length >= 4 ? charNgrams(t, 4) : new Set();
  const j4 =
    grams4Q.size && grams4T.size ? jaccard(grams4Q, grams4T) : 0;

  // 4-gram 利於較長詞組；3-gram 防短詞誤撞；2-gram 保底召回
  return Math.max(j2 * 0.38 + j3 * 0.37 + j4 * 0.25, j3, j4);
}

function normalizeForNgram(s) {
  return String(s ?? "")
    .toLowerCase()
    // 去掉常見標點與空白，保留中英文數字
    .replace(/[！!？?，,。.、；;：:"'“”‘’（）()\[\]{}<>《》【】\s]/g, "")
    // 去掉網址，避免 url 影響相似度
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

function charNgrams(s, n) {
  const set = new Set();
  if (!s || s.length < n) return set;
  for (let i = 0; i <= s.length - n; i++) {
    set.add(s.slice(i, i + n));
  }
  return set;
}

function jaccard(aSet, bSet) {
  if (!aSet || !bSet || aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

function normalizeForMatch(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[！!？?，,。.、；;：:"'“”‘’（）()\[\]{}<>《》【】\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForMatch(s) {
  const out = [];
  const zh = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of zh) {
    if (run.length >= 4 && run.length <= 12) {
      out.push(run);
    }
    const maxN = Math.min(4, run.length);
    const step = run.length > 14 ? 2 : 1;
    for (let n = 2; n <= maxN; n++) {
      for (let i = 0; i <= run.length - n; i += step) {
        out.push(run.slice(i, i + n));
      }
    }
  }
  const latin = s
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, "").toLowerCase())
    .filter((w) => w.length >= 4);
  for (const w of latin) {
    out.push(w);
    if (w.includes("-")) {
      for (const part of w.split("-")) {
        if (part.length >= 4) out.push(part);
      }
    }
  }
  return [...new Set(out)];
}

function recencyScore(tsMs) {
  const ageDays = (Date.now() - tsMs) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0.6;
  // 近一年保持較高分，超過一年後快速衰減
  if (ageDays <= 365) return Math.exp(-ageDays / 260);
  return 0.45 * Math.exp(-(ageDays - 365) / 140);
}

function ratingScore(rating) {
  const r = String(rating ?? "").toLowerCase();
  if (!r) return 0.2;
  if (r.includes("false") || r.includes("錯誤") || r.includes("假")) return 0.9;
  if (r.includes("true") || r.includes("正確") || r.includes("真")) return 0.7;
  if (r.includes("misleading") || r.includes("missing") || r.includes("context") || r.includes("部分")) return 0.6;
  return 0.4;
}
