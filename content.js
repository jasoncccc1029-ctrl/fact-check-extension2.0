/**
 * Content script (MV3). Highlight colors mirror Tailwind v3 tokens (see ensureFcaHighlightStyles).
 * Class names use fca-tw-* prefix so host pages’ utilities never collide.
 * 除錯日誌：於主控台執行 localStorage.setItem("fcaDebug","1") 後重新整理頁面。
 */
const FCA_DEBUG = (() => {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("fcaDebug") === "1";
  } catch {
    return false;
  }
})();

if (FCA_DEBUG) {
  console.log("[FCA] content script inject", window.location.href, "frame=", window === window.top);
}

let lastSelected = "";
let selectionDebounceTimer = null;

const FCA_HIGHLIGHT_STYLE_ID = "fca-highlight-ui-v2";

let fcaPanelAnchorEl = null;
let fcaTriggerHost = null;
let fcaTriggerRange = null;
let fcaTriggerText = "";
let fcaSelectionLastPoint = null;

/** 查核觸發鈕固定於視窗右下角（避開複雜版面位移） */
const FCA_TRIGGER_PIN_KEY = "fcaTriggerPinCorner";
let fcaTriggerPinCorner = false;

/** 使用者收合側欄（點頁面或「收合」） */
let fcaSidebarUserCollapsed = false;

const FCA_Z_FLOAT_PANEL = "2147383647";
const FCA_Z_SIDEBAR = "2147383600";
/** 詳情開啟時側欄收合後可見寬度（px） */
const FCA_SIDEBAR_STRIP_PX = 52;
/** 側欄外層寬度（各站一致；頁內標註已不在 YT 觀看頁插入，無需再縮窄側欄） */
const FCA_SIDEBAR_OUTER_WIDTH_CSS = "min(380px,calc(100vw - 8px))";

/** 側欄與浮動大卡只掛在最上層 frame；在嵌入 iframe 內 fixed 會相對頁面錯位（Threads 等）。 */
function fcaIsUiTopWindow() {
  try {
    return window.self === window.top;
  } catch {
    return true;
  }
}

function fcaAppendExtensionUiHost(host) {
  const el = document.documentElement || document.body;
  el.appendChild(host);
}

function removeFcTriggerIcon() {
  try {
    if (fcaTriggerHost?.parentNode) fcaTriggerHost.remove();
  } catch {
    /* ignore */
  }
  fcaTriggerHost = null;
  fcaTriggerRange = null;
  fcaTriggerText = "";
}

function fcaTriggerIconAnchorRect(range) {
  try {
    const rects = range?.getClientRects?.();
    const bbox = range?.getBoundingClientRect?.();
    const px = Number(fcaSelectionLastPoint?.x);
    const py = Number(fcaSelectionLastPoint?.y);
    let hasPoint = Number.isFinite(px) && Number.isFinite(py);
    // selectionchange 常無伴隨座標，沿用舊滑鼠位置會離選區很遠（YouTube 標題／說明尤甚）
    if (hasPoint && bbox && (bbox.width > 0 || bbox.height > 0)) {
      const pad = 22;
      if (
        px < bbox.left - pad ||
        px > bbox.right + pad ||
        py < bbox.top - pad ||
        py > bbox.bottom + pad
      ) {
        hasPoint = false;
      }
    }

    if (rects && rects.length) {
      if (hasPoint) {
        const inside = [];
        for (const rr of rects) {
          if (!rr || (rr.width <= 0 && rr.height <= 0)) continue;
          if (
            px >= rr.left - 3 &&
            px <= rr.right + 3 &&
            py >= rr.top - 3 &&
            py <= rr.bottom + 3
          ) {
            inside.push(rr);
          }
        }
        if (inside.length) {
          inside.sort((a, b) => a.width * a.height - b.width * b.height);
          return inside[0];
        }
      }

      let bandTop = Infinity;
      if (hasPoint) {
        let nearest = null;
        let nearestD = Infinity;
        for (const rr of rects) {
          if (!rr || (!rr.width && !rr.height)) continue;
          const cx = rr.left + rr.width / 2;
          const cy = rr.top + rr.height / 2;
          const d = Math.hypot(cx - px, cy - py);
          if (d < nearestD) {
            nearestD = d;
            nearest = rr;
          }
        }
        if (nearest) bandTop = nearest.top;
      }
      if (!Number.isFinite(bandTop)) {
        for (const rr of rects) {
          if (!rr || (!rr.width && !rr.height)) continue;
          bandTop = Math.min(bandTop, rr.top);
        }
      }
      let best = null;
      let bestRight = -Infinity;
      for (const rr of rects) {
        if (!rr || (!rr.width && !rr.height)) continue;
        if (Math.abs(rr.top - bandTop) > (fcaIsYoutubeWatchPage() ? 8 : 4)) continue;
        if (rr.right > bestRight) {
          bestRight = rr.right;
          best = rr;
        }
      }
      if (best) return best;
    }
    const r = range?.getBoundingClientRect?.();
    if (r && (r.width || r.height)) return r;
  } catch {
    /* ignore */
  }
  return null;
}

let fcaTriggerRepositionBound = false;
/** 供 YouTube SPA 導覽後重新綁定捲動與版面同步。 */
let fcaTriggerRepositionBump = null;
let fcaTriggerRepositionRaf = null;
let fcaYtScrollCleanups = [];
let fcaYtNavWatchBound = false;
let fcaSidebarHostResizeObs = null;

function fcaUnbindYoutubeScrollContainersForTrigger() {
  for (const fn of fcaYtScrollCleanups) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  fcaYtScrollCleanups = [];
}

/** YouTube 主要捲動在内部容器，window scroll 不會觸發，觸發鈕會卡在舊視座。 */
function fcaBindYoutubeScrollContainersForTrigger(bump) {
  if (!fcaIsYoutubeWatchPage()) return;
  fcaUnbindYoutubeScrollContainersForTrigger();
  const opts = { passive: true };
  const bind = (el) => {
    if (!el) return;
    try {
      el.addEventListener("scroll", bump, opts);
      fcaYtScrollCleanups.push(() => {
        try {
          el.removeEventListener("scroll", bump, opts);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
  };
  for (const sel of [
    "#content",
    "#page-manager",
    "ytd-app",
    "ytd-watch-flexy",
    "#columns",
    "#primary-inner",
    "#secondary-inner"
  ]) {
    bind(document.querySelector(sel));
  }
  bind(document.scrollingElement);
}

function fcaEnsureYoutubeNavigationWatch() {
  if (!fcaIsYoutubeWatchPage() || fcaYtNavWatchBound) return;
  fcaYtNavWatchBound = true;
  const fire = () => {
    if (!fcaTriggerRepositionBump) return;
    fcaBindYoutubeScrollContainersForTrigger(fcaTriggerRepositionBump);
    try {
      fcaTriggerRepositionBump();
    } catch {
      /* ignore */
    }
  };
  document.addEventListener("yt-navigate-finish", fire);
  window.addEventListener("popstate", fire);
}

function fcaEnsureTriggerRepositionListeners() {
  if (fcaTriggerRepositionBound) return;
  fcaTriggerRepositionBound = true;
  const runBump = () => {
    if (!fcaTriggerHost?.isConnected) return;
    if (fcaTriggerPinCorner) {
      positionTriggerHost(fcaTriggerHost, null);
      return;
    }
    if (!fcaTriggerRange) return;
    try {
      const r = fcaTriggerIconAnchorRect(fcaTriggerRange);
      if (r) positionTriggerHost(fcaTriggerHost, r);
    } catch {
      /* ignore */
    }
  };
  const bump = () => {
    if (fcaTriggerRepositionRaf != null) return;
    fcaTriggerRepositionRaf = requestAnimationFrame(() => {
      fcaTriggerRepositionRaf = null;
      runBump();
    });
  };
  fcaTriggerRepositionBump = bump;
  window.addEventListener("resize", bump, { passive: true });
  window.addEventListener("scroll", bump, { capture: true, passive: true });
  fcaBindYoutubeScrollContainersForTrigger(bump);
  fcaEnsureYoutubeNavigationWatch();
}

function positionTriggerHost(host, rect) {
  if (!host) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rr = fcaSidebarGetRightReservedPx();
  const size = 26;
  const pad = 8;
  let left;
  let top;
  if (fcaTriggerPinCorner) {
    left = vw - size - pad - rr;
    top = vh - size - pad;
  } else {
    if (!rect) return;
    /* 緊貼選區「結尾」右側（閱讀順序的後面），垂直與該行對齊；右側不夠再放左側或下一行。 */
    const gap = 6;
    const lineH = rect.height > 4 ? rect.height : 20;
    left = rect.right + gap;
    top = rect.top + (lineH - size) / 2;
    if (left + size > vw - pad - rr) {
      left = rect.left - size - gap;
    }
    if (left < pad) {
      left = Math.min(rect.right + gap, vw - size - pad - rr);
      top = rect.bottom + gap;
    }
  }
  left = Math.max(pad, Math.min(left, vw - size - pad - rr));
  top = Math.max(pad, Math.min(top, vh - size - pad));
  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;
}

function ensureFcTriggerIcon(rangeClone, rawText) {
  if (!fcaIsUiTopWindow()) return;
  const t = String(rawText || "").trim();
  if (!t) {
    removeFcTriggerIcon();
    return;
  }
  const r = fcaTriggerIconAnchorRect(rangeClone);
  if (!r) {
    removeFcTriggerIcon();
    return;
  }

  if (fcaTriggerHost?.isConnected) {
    fcaTriggerRange = rangeClone.cloneRange();
    fcaTriggerText = t;
    positionTriggerHost(fcaTriggerHost, r);
    return;
  }

  const host = document.createElement("div");
  host.setAttribute("data-fca-trigger-host", "1");
  host.style.cssText = [
    "position:fixed",
    "margin:0",
    "padding:0",
    "left:0",
    "top:0",
    "pointer-events:none",
    "z-index:2147383650",
    "font-family:system-ui,-apple-system,'SF Pro Text',Segoe UI,sans-serif",
    "transition:left 0.18s ease,top 0.18s ease,opacity 0.18s ease,transform 0.18s ease"
  ].join(";");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button {
        pointer-events: auto;
        width: 26px;
        height: 26px;
        padding: 0;
        margin: 0;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        background: linear-gradient(
          155deg,
          rgba(15, 23, 42, 0.52) 0%,
          rgba(15, 23, 42, 0.72) 100%
        );
        box-shadow:
          0 0 0 0.55px rgba(255, 255, 255, 0.14),
          0 0 0 1px rgba(110, 231, 183, 0.22),
          0 12px 28px rgba(15, 23, 42, 0.28);
        backdrop-filter: saturate(210%) blur(26px);
        -webkit-backdrop-filter: saturate(210%) blur(26px);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.12s ease, background 0.18s ease, box-shadow 0.18s ease;
      }
      button:hover {
        background: rgba(15, 23, 42, 0.82);
        transform: translateY(-1px);
        box-shadow:
          0 0 0 1px rgba(110, 231, 183, 0.28),
          0 10px 24px rgba(15, 23, 42, 0.26);
      }
      button:active { transform: translateY(0) scale(0.97); }
      button:focus-visible {
        outline: 2px solid rgba(52, 211, 153, 0.9);
        outline-offset: 2px;
      }
      .fca-tech-verify-svg { width: 16px; height: 16px; display:block; }
      .fca-tv-frame { fill: rgba(6, 28, 22, 0.55); stroke: rgba(110, 231, 183, 0.9); stroke-width: 1; }
      .fca-tv-mark { stroke: #b9ffe8; stroke-width: 1.5; }
    </style>
    <button type="button" id="fcaTriggerBtn" aria-label="點擊以開始查核" title="點擊開始查核">${fcaTechVerifiedSvg()}</button>
  `;
  const btn = shadow.getElementById("fcaTriggerBtn");
  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const text = fcaTriggerText;
    const rr = fcaTriggerRange ? fcaTriggerRange.cloneRange() : rangeClone.cloneRange();
    if (FCA_FLOAT_PANEL_DISABLED) {
      fcaStartFactCheckFromSelection(rr, text);
    } else {
      removeFcTriggerIcon();
      showFcFloatingPanel(rr, text);
    }
  });

  fcaAppendExtensionUiHost(host);
  fcaTriggerHost = host;
  fcaTriggerRange = rangeClone.cloneRange();
  fcaTriggerText = t;
  fcaEnsureTriggerRepositionListeners();
  positionTriggerHost(host, r);
}

const FCA_STATUS_LABEL = {
  Red: "錯誤（不實）",
  Orange: "部分錯誤",
  Yellow: "目前無法證實",
  Gray: "目前無法證實",
  Green: "正確（已核實）",
  Blue: "事實釐清"
};

/** 舊版內部鍵 Yellow 視同證據不足（Gray）。 */
function fcaNormalizeLegacyYellowStatus(st) {
  return st === "Yellow" ? "Gray" : st;
}

function fcaLog(...args) {
  if (!FCA_DEBUG) return;
  console.log("[FCA]", ...args);
}

function fcaHostnameNorm() {
  return String(location.hostname || "")
    .replace(/^www\./, "")
    .toLowerCase();
}

/** YouTube 觀看頁（含 youtu.be）；用於版面與浮窗避讓播放器。 */
function fcaIsYoutubeWatchPage() {
  const h = fcaHostnameNorm();
  if (h === "youtu.be") return true;
  if (!/^(m\.)?youtube\.com$/.test(h)) return false;
  return /^\/watch\b/.test(location.pathname || "");
}

function fcaYoutubePlayerBoundingRect() {
  const selectors = [
    "ytd-watch-flexy ytd-player#ytd-player",
    "ytd-watch-flexy ytd-player",
    "#primary-inner ytd-player",
    "#primary ytd-player"
  ];
  let best = null;
  let bestArea = 0;
  const consider = (r) => {
    const a = r.width * r.height;
    if (r.width >= 80 && r.height >= 40 && a > bestArea) {
      best = r;
      bestArea = a;
    }
  };
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    try {
      consider(el.getBoundingClientRect());
    } catch {
      /* ignore */
    }
  }
  const primary =
    document.querySelector("#primary-inner") ||
    document.querySelector("ytd-watch-flexy #primary-inner");
  const vid = primary?.querySelector?.("video");
  if (vid) {
    try {
      consider(vid.getBoundingClientRect());
    } catch {
      /* ignore */
    }
  }
  return best;
}

/** 浮動卡／詳情與 YouTube 播放器不得重疊（矩形以 getBoundingClientRect 座標為準） */
function fcaNudgeBoxAwayFromYoutubePlayer(left, top, panelWidth, panelHeight) {
  if (!fcaIsYoutubeWatchPage() || panelWidth <= 0 || panelHeight <= 0) {
    return { left, top };
  }
  const pr = fcaYoutubePlayerBoundingRect();
  if (!pr) return { left, top };

  const pad = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rr = fcaSidebarGetRightReservedPx();
  const clampX = (x) =>
    Math.max(10, Math.min(x, vw - panelWidth - 10 - rr));
  const clampY = (y) =>
    Math.max(10, Math.min(y, vh - panelHeight - 10));

  const box = (l, t) => ({
    left: l,
    top: t,
    right: l + panelWidth,
    bottom: t + panelHeight
  });
  const hit = (b, p) =>
    b.left < p.right && b.right > p.left && b.top < p.bottom && b.bottom > p.top;

  let l = left;
  let t = top;
  let b0 = box(l, t);
  if (!hit(b0, pr)) return { left: l, top: t };

  t = pr.bottom + pad;
  t = clampY(t);
  b0 = box(l, t);
  if (hit(b0, pr) || t + panelHeight > vh - 8) {
    t = Math.max(10, pr.top - panelHeight - pad);
    t = clampY(t);
  }
  b0 = box(l, t);
  if (hit(b0, pr)) {
    l = clampX(pr.left - panelWidth - pad);
    b0 = box(l, t);
  }
  if (hit(b0, pr)) {
    l = clampX(pr.right + pad);
    b0 = box(l, t);
  }
  if (hit(b0, pr)) {
    l = clampX(12);
    t = clampY(pr.bottom + pad);
  }
  return { left: l, top: t };
}

function ensureFcaYoutubeLayoutPatch() {
  if (!fcaIsYoutubeWatchPage()) return;
  const patchId = "fca-youtube-layout-patch";
  let el = document.getElementById(patchId);
  if (!el) {
    el = document.createElement("style");
    el.id = patchId;
    (document.head || document.documentElement).appendChild(el);
  }
  try {
    const staleOv = document.getElementById("fca-youtube-layout-overrides");
    if (staleOv) staleOv.remove();
  } catch {
    /* ignore */
  }
  /* 觀看頁不再注入頁面標註用 CSS（避免與 YT 內建版面衝突）；僅清舊版變數。 */
  el.textContent = "";
  try {
    document.documentElement.style.removeProperty("--fca-yt-inset");
  } catch {
    /* ignore */
  }
}

function ensureFcaThreadsInstagramLayoutPatch() {
  const h = location.hostname || "";
  const hit =
    /(^|\.)threads\.net$/i.test(h) ||
    /(^|\.)threads\.com$/i.test(h) ||
    /(^|\.)instagram\.com$/i.test(h);
  if (!hit) return;
  if (document.getElementById("fca-threads-ig-layout-patch")) return;
  const el = document.createElement("style");
  el.id = "fca-threads-ig-layout-patch";
  el.textContent = `
/* Threads / Instagram：flex + line-clamp 易把 fca-anno 擠成極窄欄、逐字直排（與 YouTube patch 同理） */
[role="article"] span.fca-anno,
article span.fca-anno {
  display: inline !important;
  white-space: normal !important;
  word-break: break-word !important;
  overflow-wrap: anywhere !important;
  max-width: 100% !important;
  width: fit-content !important;
  vertical-align: baseline !important;
  position: relative !important;
  z-index: auto !important;
  flex: none !important;
  flex-grow: 0 !important;
  flex-shrink: 0 !important;
  flex-basis: auto !important;
  -webkit-line-clamp: unset !important;
  line-clamp: unset !important;
  -webkit-box-orient: unset !important;
  writing-mode: horizontal-tb !important;
  text-orientation: mixed !important;
}
`;
  (document.head || document.documentElement).appendChild(el);
}

function selectionAnchoredInEditable(sel) {
  if (!sel?.anchorNode) return false;
  const n = sel.anchorNode;
  const el = n.nodeType === Node.TEXT_NODE ? n.parentElement : n;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(el.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

function selectionAnchoredInFcaPanel(sel) {
  const node = sel?.anchorNode;
  if (!node) return false;
  const root = node.getRootNode();
  if (root && root instanceof ShadowRoot) {
    const h = root.host;
    if (h && h.getAttribute && h.getAttribute("data-fca-panel-host") === "1") {
      return true;
    }
    if (h?.getAttribute?.("data-fca-sidebar-host") === "1") {
      return true;
    }
  }
  return false;
}

/** 安全讀取錯誤字串（避免 err 帶奇怪 getter 或非標準物件）。 */
function fcaSafeErrorMessage(err) {
  try {
    if (err == null) return "";
    if (typeof err.message === "string") return err.message;
    if (typeof err === "string") return err;
  } catch {
    /* ignore */
  }
  try {
    return String(err);
  } catch {
    return "";
  }
}

function isExtensionRuntimeReachable() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function isExtensionContextInvalidated(err) {
  let m = "";
  try {
    m = fcaSafeErrorMessage(err);
  } catch {
    m = "";
  }
  if (
    m.includes("Extension context invalidated") ||
    m.includes("message port closed") ||
    /receiving end does not exist/i.test(m) ||
    /cannot read properties of undefined \(reading ['"]onmessage['"]\)/i.test(
      m
    ) ||
    /cannot read properties of undefined \(reading ['"]sendmessage['"]\)/i.test(
      m
    )
  ) {
    return true;
  }
  return !isExtensionRuntimeReachable();
}

/** 顯示在側欄／浮動面板上的說明文字（避免直接露出 Chrome 英文錯誤）。 */
function fcaFormatErrorForUi(raw) {
  const s = String(raw ?? "").trim();
  if (s.includes("FACTCHECK_TIMEOUT")) {
    return "查核來源回應逾時（已自動中止等待）。請改短關鍵句重試，或稍後再查。";
  }
  if (isExtensionContextInvalidated({ message: s })) {
    return "擴充功能已重新載入，此分頁與背景程序已斷線。請按 F5（或 Ctrl+R）重新整理本頁後再查核。";
  }
  if (
    /failed to fetch|networkerror|network request failed|load failed|fetch failed|net::err|connection refused|econnrefused/i.test(
      s
    )
  ) {
    return "無法連上查核服務或網路暫時不通。請檢查連線後按「重新嘗試」，或重新整理本頁。";
  }
  if (/429|too many requests|rate limit|quota exceeded/i.test(s)) {
    return "服務暫時過載或已達請求上限。請稍候再按「重新嘗試」。";
  }
  if (/timeout|timed out|超時|time-out/i.test(s)) {
    return "連線逾時。請稍後再試，或按「重新嘗試」。";
  }
  if (/502|503|504|bad gateway|service unavailable/i.test(s)) {
    return "查核服務暫時無法使用（伺服器忙碌）。請稍候再試。";
  }
  return s || "發生錯誤，請稍後再試。";
}

function fcaIsSilentTimeoutError(raw) {
  const s = String(raw ?? "").trim();
  return (
    s.includes("FACTCHECK_TIMEOUT") ||
    s.includes("COFACTS_TIMEOUT") ||
    s.includes("AI_ENRICH_TIMEOUT")
  );
}

/** 查無查核條目時供 Gemini 參考的同頁正文（main/article/body 摘錄）。 */
function fcaPickPageArticleElement() {
  return (
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector('[role="main"]') ||
    document.querySelector("#mw-content-text") ||
    document.body
  );
}

/** 查無查核條目時供 Gemini 參考的同頁正文（main/article/body 摘錄）。 */
function fcaExtractPageArticleContextForAi(maxChars = 4200) {
  try {
    const el = fcaPickPageArticleElement();
    let text = String(el?.innerText || "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 120) {
      text = String(document.body?.innerText || "")
        .replace(/\s+/g, " ")
        .trim();
    }
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}…`;
    }
    return text;
  } catch {
    return "";
  }
}

/** 無 Cofacts／國際索引命中時，Standalone AI 應併入頁面正文以產生新聞語境摘要。 */
function fcaShouldAttachArticleContextForStandaloneAi(claimReview, finalStatus) {
  if (claimReview?.fcaAiReason) return false;
  if (claimReview?.fcaCofacts) return false;
  if (claimReview?.fcaIndexCorpus) return false;
  if (!claimReview) return true;
  return finalStatus === "Yellow" || finalStatus === "Gray";
}

function fcaSendMessage(payload) {
  return new Promise((resolve, reject) => {
    try {
      const go = chrome?.runtime?.sendMessage;
      if (typeof go !== "function") {
        reject(new Error("Extension context invalidated"));
        return;
      }
      go.call(chrome.runtime, payload, (response) => {
        const le = chrome.runtime?.lastError;
        if (le) {
          reject(new Error(le.message));
          return;
        }
        resolve(response);
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function fcaOpenGeminiSettingsInTab() {
  try {
    const r = await fcaSendMessage({ type: "OPEN_GEMINI_SETTINGS_TAB" });
    if (r && r.ok === false) throw new Error(r.error || "fail");
  } catch {
    window.alert(
      "請點瀏覽器工具列的擴充功能圖示，開啟本擴充後展開「AI 二次判讀（Gemini）」貼上金鑰並儲存。"
    );
  }
}

function fcaStorageLocalGet(keys) {
  return new Promise((resolve) => {
    try {
      const loc = globalThis.chrome?.storage?.local;
      if (!loc?.get) {
        resolve({});
        return;
      }
      loc.get(keys, (bag) => {
        try {
          const le = globalThis.chrome?.runtime?.lastError;
          if (le) {
            fcaLog("storage.local.get", le.message);
            resolve({});
            return;
          }
        } catch {
          resolve({});
          return;
        }
        resolve(bag && typeof bag === "object" ? bag : {});
      });
    } catch (e) {
      fcaLog("storage.local.get", e);
      resolve({});
    }
  });
}

void fcaStorageLocalGet(FCA_TRIGGER_PIN_KEY).then((b) => {
  if (b[FCA_TRIGGER_PIN_KEY] === true) fcaTriggerPinCorner = true;
  fcaSidebarSyncTriggerPinButton();
  void fcaSidebarSyncQuickToggles();
});

function fcaStorageLocalSet(items) {
  return new Promise((resolve) => {
    try {
      const loc = globalThis.chrome?.storage?.local;
      if (!loc?.set) {
        fcaLog("storage.local.set: API 不可用（請重新整理頁面或重載擴充）");
        resolve(false);
        return;
      }
      loc.set(items, () => {
        try {
          const le = globalThis.chrome?.runtime?.lastError;
          if (le) {
            fcaLog("storage.local.set", le.message);
            resolve(false);
            return;
          }
        } catch {
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (e) {
      fcaLog("storage.local.set", e);
      resolve(false);
    }
  });
}

function fcaStorageLocalRemove(keyOrList) {
  return new Promise((resolve) => {
    try {
      const loc = globalThis.chrome?.storage?.local;
      if (!loc?.remove) {
        resolve(false);
        return;
      }
      loc.remove(keyOrList, () => {
        try {
          resolve(!globalThis.chrome?.runtime?.lastError);
        } catch {
          resolve(false);
        }
      });
    } catch {
      resolve(false);
    }
  });
}

function fcaStorageSessionSet(items) {
  return new Promise((resolve) => {
    try {
      const s = globalThis.chrome?.storage?.session;
      if (!s?.set) {
        resolve(false);
        return;
      }
      s.set(items, () => {
        try {
          resolve(!globalThis.chrome?.runtime?.lastError);
        } catch {
          resolve(false);
        }
      });
    } catch {
      resolve(false);
    }
  });
}

/** 合併進行中、相同參數的索引查核，避免快速反白或重複觸發時打兩次後端。 */
const fcaQueryFactcheckInflight = new Map();

function fcaQueryFactcheckDeduped(text, preferLatest) {
  const q = String(text || "").trim();
  const key = `QUERY_FACTCHECK|${preferLatest ? "L" : "R"}|${q}`;
  const existing = fcaQueryFactcheckInflight.get(key);
  if (existing) return existing;
  const p = fcaSendMessage({ type: "QUERY_FACTCHECK", text: q }).finally(() => {
    if (fcaQueryFactcheckInflight.get(key) === p) {
      fcaQueryFactcheckInflight.delete(key);
    }
  });
  fcaQueryFactcheckInflight.set(key, p);
  return p;
}

/** 節流 chrome.storage.local 讀取（fcaSkipGemini 等）；變更時透過 onChanged 立即失效。 */
let fcaLocalOptsCache = null;
let fcaLocalOptsCacheAt = 0;
/** 本頁本次載入內按「知道了」後暫時隱藏 Gemini 隱私橫幅（不寫入 storage）。 */
let fcaGeminiPrivacyBannerSessionHidden = false;
const FCA_LOCAL_OPTS_TTL_MS = 2000;
/** AI 摘要／理由在浮窗等顯示上限（含「無查核時依正文摘要」較長敘述） */
const FCA_AI_SUMMARY_MAX_CHARS = 520;
/** 側欄 AI 摘要字數上限（較短以降低壓力；可「顯示全文」展開） */
const FCA_AI_SUMMARY_SIDEBAR_MAX_CHARS = 300;
/** 側欄 AI 摘要超過此字數時預設摺疊，以 <details> 展開全文 */
const FCA_AI_SIDEBAR_BODY_COLLAPSE_AT = 220;
/** 側欄「顯示全文」內 AI 理由上限（高於預覽，仍避免極長文塞滿側欄） */
const FCA_AI_SUMMARY_SIDEBAR_EXPAND_MAX_CHARS = 960;
/** 側欄「判定理由」摘錄：選句／無反白時上限（與 `fcaVerdictReasonSummaryText` 一致） */
const FCA_VERDICT_SIDEBAR_MAX_EXCERPT = 280;
const FCA_VERDICT_SIDEBAR_REPLY_SLICE = 240;
const FCA_VERDICT_SIDEBAR_MAX_FLAT_NO_Q = 300;
/** 判定理由超過此字數或行數時，側欄改為摘要列 + 點開全文 */
const FCA_SIDEBAR_VERDICT_PREVIEW_CHARS = 220;
const FCA_SIDEBAR_VERDICT_PREVIEW_LINES = 5;
const FCA_FACTCHECK_HARD_TIMEOUT_MS = 16000;
/** 查無查核時獨立呼叫 Gemini 的逾時（略長於舊值，避免新聞摘要未完成就被捨棄） */
const FCA_AI_ENRICH_TIMEOUT_MS = 12000;
const FCA_OPT_SKIP_GEMINI = "fcaSkipGemini";
const FCA_OPT_SHOW_TRUSTED_NEWS = "fcaShowTrustedNews";
const FCA_OPT_GEMINI_PRIVACY_DISMISSED = "fcaGeminiPrivacyDismissed";
/** 配額友善：Cofacts 主流程先不打 Gemini，僅在必要情境才走 standalone AI。 */
const FCA_AI_BUDGET_FRIENDLY = true;

// AI 診斷快取：避免每次重繪都讀 storage
let fcaAiDiagCache = { hasKey: null, skipGemini: null, debug: false, at: 0 };
let fcaAiDiagInflight = null;
const FCA_AI_DIAG_TTL_MS = 2500;
/** 從 session storage 快取的 Gemini 冷卻截止時間（content script 同步可讀）。 */
let fcaGeminiCooldownUntilCache = 0;

async function fcaGetExtensionLocalOpts() {
  const now = Date.now();
  if (fcaLocalOptsCache && now - fcaLocalOptsCacheAt < FCA_LOCAL_OPTS_TTL_MS) {
    return fcaLocalOptsCache;
  }
  fcaLocalOptsCache = await fcaStorageLocalGet([
    FCA_OPT_SKIP_GEMINI,
    FCA_OPT_SHOW_TRUSTED_NEWS,
    FCA_OPT_GEMINI_PRIVACY_DISMISSED
  ]);
  fcaLocalOptsCacheAt = now;
  return fcaLocalOptsCache;
}

function fcaAiDiagSnapshot() {
  const now = Date.now();
  if (now - (fcaAiDiagCache.at || 0) > FCA_AI_DIAG_TTL_MS && !fcaAiDiagInflight) {
    fcaAiDiagInflight = (async () => {
      try {
        const bag = await fcaStorageLocalGet([
          "geminiApiKey",
          "fcaSkipGemini",
          "fcaDebugAiDiag"
        ]);
        const hasKey = Boolean(String(bag.geminiApiKey || "").trim());
        const skipGemini = Boolean(bag.fcaSkipGemini);
        const debug = Boolean(bag.fcaDebugAiDiag);
        fcaAiDiagCache = { hasKey, skipGemini, debug, at: Date.now() };
      } catch {
        // ignore
      } finally {
        fcaAiDiagInflight = null;
      }
    })();
  }
  return { ...fcaAiDiagCache };
}

/** 查核結果繪製前強制讀一次金鑰狀態，避免 fcaAiDiagSnapshot 非同步尚未回填而誤顯「無金鑰／未就緒」。 */
async function fcaAiDiagPrimeFromStorage() {
  try {
    const bag = await fcaStorageLocalGet([
      "geminiApiKey",
      "fcaSkipGemini",
      "fcaDebugAiDiag"
    ]);
    fcaAiDiagCache = {
      hasKey: Boolean(String(bag.geminiApiKey || "").trim()),
      skipGemini: Boolean(bag.fcaSkipGemini),
      debug: Boolean(bag.fcaDebugAiDiag),
      at: Date.now()
    };
    /* 同時讀取 Gemini 冷卻截止時間（session storage），供 quota 訊息同步讀取 */
    try {
      const cs = await chrome.storage.session.get("fcaGeminiCooldownUntil");
      fcaGeminiCooldownUntilCache = Number(cs?.fcaGeminiCooldownUntil) || 0;
    } catch {}
  } catch {
    /* ignore */
  }
}

try {
  globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      changes[FCA_OPT_SKIP_GEMINI] ||
      changes[FCA_OPT_SHOW_TRUSTED_NEWS] ||
      changes[FCA_OPT_GEMINI_PRIVACY_DISMISSED]
    ) {
      fcaLocalOptsCache = null;
      if (changes[FCA_OPT_GEMINI_PRIVACY_DISMISSED]?.newValue !== true) {
        fcaGeminiPrivacyBannerSessionHidden = false;
      }
      void fcaSidebarSyncQuickToggles();
    }
    if (changes[FCA_OPT_SKIP_GEMINI] || changes.geminiApiKey || changes.fcaDebugAiDiag) {
      fcaAiDiagCache.at = 0;
    }
  });
} catch {
  /* ignore */
}

function escapeHtmlFc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 方角「已驗證」角標 SVG（線框＋勾選，科技感）。 */
function fcaTechVerifiedSvg() {
  return '<svg class="fca-tech-verify-svg" viewBox="0 0 20 20" aria-hidden="true"><rect class="fca-tv-frame" x="3.35" y="3.35" width="13.3" height="13.3" rx="3.5"/><path class="fca-tv-mark" d="M6.55 10.15 L8.68 12.28 L13.42 6.75" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function fcaSettingsGearSvg() {
  return '<svg class="fca-gear-svg" viewBox="0 0 24 24" aria-hidden="true"><g class="fca-gear-lines"><line x1="12" y1="2.9" x2="12" y2="5.3"/><line x1="12" y1="18.7" x2="12" y2="21.1"/><line x1="2.9" y1="12" x2="5.3" y2="12"/><line x1="18.7" y1="12" x2="21.1" y2="12"/><line x1="5.56" y1="5.56" x2="7.26" y2="7.26"/><line x1="16.74" y1="16.74" x2="18.44" y2="18.44"/><line x1="5.56" y1="18.44" x2="7.26" y2="16.74"/><line x1="16.74" y1="7.26" x2="18.44" y2="5.56"/></g><circle class="fca-gear-ring" cx="12" cy="12" r="5.2"/><circle class="fca-gear-core" cx="12" cy="12" r="2.65"/></svg>';
}

// 舊版側欄外觀開關（false = 使用目前含 AI 摘要的新 UI）。
const FCA_LEGACY_SIDEBAR_UI = false;
// AI 摘要／即時新聞／網域分析改為較早版本的扁平區塊（功能不變）。
const FCA_CLASSIC_AUX_SECTIONS_UI = true;
// 關閉左側「段落查核」浮窗，僅在右側側欄顯示結果（仍會標色反白）。
const FCA_FLOAT_PANEL_DISABLED = true;

const FCA_LOADING_TURTLE_PNG = "assets/fca-loading-turtle.png";

/** 查詢中載入用：手繪風烏龜 PNG（去背，疊於進度條上）。 */
function fcaLoadingTurtleImgHtml() {
  try {
    const u = chrome.runtime.getURL(FCA_LOADING_TURTLE_PNG);
    return `<img class="fca-loading-turtle-img" src="${escapeHtmlFc(u)}" alt="" width="64" height="64" draggable="false" decoding="async" />`;
  } catch {
    return "";
  }
}

/** 查詢血條：以經過時間連續推算（指數逼近），載入中最高約 99%，避免停在某一格不動。 */
const FCA_LOAD_PROGRESS_TAU_MS = 10000;

function fcaLoadProgressPercentWhileLoading(elapsedMs) {
  const x = Math.max(0, Number(elapsedMs) || 0);
  const p = 2 + 97 * (1 - Math.exp(-x / FCA_LOAD_PROGRESS_TAU_MS));
  return Math.max(2, Math.min(99, p));
}

function fcaApplyLoadProgressByTime(fillEl, trackEl, startedAtMs) {
  const pct = fcaLoadProgressPercentWhileLoading(Date.now() - startedAtMs);
  if (fillEl?.style) fillEl.style.width = `${pct.toFixed(2)}%`;
  if (trackEl) {
    try {
      trackEl.setAttribute("aria-valuenow", String(Math.round(pct)));
    } catch {
      /* ignore */
    }
  }
}

/** 判定欄：若為純英文 true，改顯示打勾圖示（輔助科技仍讀出原文）。 */
function fcaVerdictDisplayHtml(textualRating) {
  const raw = String(textualRating ?? "").trim();
  if (!raw) return "";
  if (/^true\.?$/i.test(raw)) {
    return `<span class="fca-verdict-true" role="img" aria-label="true" title="true">${fcaTechVerifiedSvg()}</span>`;
  }
  return escapeHtmlFc(raw);
}

function fcaVerdictReasonFallback(displayStatus) {
  const st = fcaNormalizeLegacyYellowStatus(displayStatus);
  if (st === "Green") {
    return "查核來源將此敘述判為正確。完整論證與引用請見下方出處連結。";
  }
  if (st === "Red") {
    return "查核來源將此敘述判為錯誤、不實或具危害性。完整說明請見下方出處連結。";
  }
  if (st === "Orange") {
    return "查核或語境分析認為此敘述為部分錯誤、具誤導性或真假參半。詳情請見下方出處連結。";
  }
  if (st === "Blue") {
    return "查核或語境分析認為此敘述須搭配背景與脈絡理解，非單純以真假二分。詳情請見下方出處連結。";
  }
  if (st === "Gray") {
    return "查核來源認為目前無法證實或資料不足以斷定。詳情請見下方出處連結。";
  }
  return "請點選下方出處連結閱讀查核原文與補充說明。";
}

/** 側欄判定列：True 改為小圖示＋文字，避免佔滿區塊。 */
function fcaSidebarVerdictLeadHtml(textualRating) {
  const raw = String(textualRating ?? "").trim();
  if (/^true\.?$/i.test(raw)) {
    return `<span class="sb-verdict-inline"><span class="sb-verdict-mini-check" role="img" aria-label="true">${fcaTechVerifiedSvg()}</span><span>${escapeHtmlFc("正確（True）")}</span></span>`;
  }
  return fcaVerdictDisplayHtml(textualRating);
}

function fcaSidebarModeTagHtml(claimReview) {
  if (!fcaWholePageMode) return "";
  const n = String(claimReview?.publisher?.name || "").trim();
  const isSemanticSplit =
    claimReview?.fcaFactOpinionSplit ||
    claimReview?.fcaSubjectiveOnlyHighlights ||
    n === "語意拆解" ||
    n === "語意拆解（事實／觀點）";
  const label = isSemanticSplit ? "整頁語意拆解" : "整頁查核命中";
  return `<div class="sb-mode-tag" role="note">${escapeHtmlFc(label)}</div>`;
}

function removePreviousFcHighlights() {
  document.querySelectorAll("span.fca-anno").forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span);
    }
    parent.removeChild(span);
    parent.normalize();
  });
}

function ensureFcaHighlightStyles() {
  ensureFcaYoutubeLayoutPatch();
  ensureFcaThreadsInstagramLayoutPatch();
  const legacy = document.getElementById("fca-highlight-tw-theme");
  if (legacy) legacy.remove();
  if (document.getElementById(FCA_HIGHLIGHT_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = FCA_HIGHLIGHT_STYLE_ID;
  el.textContent = `
/* Tailwind v3–equivalent tokens (prefixed utilities) */
/* Threads / IG 等 -webkit-line-clamp(-box) 與 flex 子項常把包色 span 擠成極窄欄、逐字直排，需強制還原行內排版 */
span[data-fca-multi-host="1"] {
  display: contents !important;
}
span.fca-anno {
  cursor: inherit;
  border-radius: 0.375rem;
  display: inline !important;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  line-height: inherit;
  font: inherit;
  vertical-align: baseline !important;
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  outline: none;
  background: transparent;
  border: none;
  border-bottom: none;
  text-decoration: none;
  box-shadow: none;
  float: none !important;
  clear: none !important;
  flex: none !important;
  flex-grow: 0 !important;
  flex-shrink: 0 !important;
  flex-basis: auto !important;
  align-self: auto !important;
  justify-content: normal !important;
  order: 0 !important;
  width: auto !important;
  max-width: none !important;
  white-space: normal !important;
  word-break: normal !important;
  overflow-wrap: normal !important;
  writing-mode: horizontal-tb !important;
  text-orientation: mixed !important;
  -webkit-box-orient: unset !important;
  line-clamp: unset !important;
  -webkit-line-clamp: unset !important;
  overflow: visible !important;
}
/* 部分新聞站會對粗體等加底線／ border-bottom，壓過我們的顏色語意 */
span.fca-anno :is(strong, b, em, i, u, ins, abbr) {
  text-decoration: none !important;
  -webkit-text-decoration: none !important;
  border-bottom: none !important;
}
span.fca-anno a {
  text-decoration: underline;
  text-decoration-color: currentColor;
  text-underline-offset: 2px;
}
.fca-tw-bg-red-100 { background-color: #fee2e2; }
.fca-tw-decoration-red-500 { text-decoration-color: #ef4444; }
.fca-tw-border-red-200 { border-color: #fecaca; }

.fca-tw-bg-orange-100 { background-color: #fed7aa; }
.fca-tw-border-orange-300 { border-color: #f97316; }

.fca-tw-bg-yellow-200 { background-color: #fef08a; }
.fca-tw-border-yellow-400 { border-color: #facc15; }

.fca-tw-bg-green-100 { background-color: #dcfce7; }
.fca-tw-border-green-200 { border-color: #bbf7d0; }

.fca-tw-underline-2 {
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 2px;
}
.fca-tw-border-b-2 {
  border-bottom-width: 2px;
  border-bottom-style: solid;
}
.fca-tw-border-1 {
  border-width: 1px;
  border-style: solid;
}

/*
 * 網頁標註：淡色區塊底（類新聞查核標示），與浮動卡「標籤」四色一致
 */
span.fca-anno.fca-anno-red {
  background-color: rgba(254, 202, 202, 0.55);
  padding: 0.12em 0.22em;
  border-radius: 0.3rem;
  border: none;
  text-decoration: none;
  box-shadow: inset 0 -1px 0 rgba(185, 28, 28, 0.22);
}
span.fca-anno.fca-anno-orange {
  background-color: rgba(249, 115, 22, 0.3);
  padding: 0.12em 0.22em;
  border-radius: 0.3rem;
  border: none;
  text-decoration: none;
  box-shadow: inset 0 -1px 0 rgba(154, 52, 18, 0.3);
}
span.fca-anno.fca-anno-yellow {
  background-color: rgba(253, 230, 138, 0.58);
  padding: 0.12em 0.22em;
  border-radius: 0.3rem;
  border: none;
  text-decoration: none;
  box-shadow: inset 0 -1px 0 rgba(161, 98, 7, 0.22);
}
span.fca-anno.fca-anno-green {
  background-color: rgba(209, 250, 229, 0.42);
  padding: 0.12em 0.22em;
  border-radius: 0.3rem;
  border: none;
  text-decoration: none;
  box-shadow: inset 0 -1px 0 rgba(22, 101, 52, 0.1);
}
span.fca-anno.fca-anno-blue {
  background-color: rgba(191, 219, 254, 0.78);
  padding: 0.12em 0.22em;
  border-radius: 0.3rem;
  border: none;
  text-decoration: none;
  box-shadow: inset 0 -1px 0 rgba(29, 78, 216, 0.22);
}
span.fca-anno.fca-anno-gray {
  background-color: rgba(229, 231, 235, 0.85);
  padding: 0.12em 0.22em;
  border-radius: 0.3rem;
  border: none;
  text-decoration: none;
  box-shadow: inset 0 -1px 0 rgba(75, 85, 99, 0.22);
}
span.fca-anno.fca-anno-cyan {
  background-color: rgba(165, 243, 252, 0.62);
  padding: 0.12em 0.22em;
  border-radius: 0.3rem;
  border: none;
  text-decoration: none;
  box-shadow: inset 0 -1px 0 rgba(8, 145, 178, 0.22);
}
`;
  (document.head || document.documentElement).appendChild(el);
}

const FCA_ANNO_SEMANTIC = {
  Red: "fca-anno-red",
  Orange: "fca-anno-orange",
  Yellow: "fca-anno-yellow",
  Green: "fca-anno-green",
  Blue: "fca-anno-blue",
  Gray: "fca-anno-gray",
  Cyan: "fca-anno-cyan"
};

function fcaAnnoLineDataAttr(status) {
  const s = fcaNormalizeLegacyYellowStatus(status);
  if (s === "Red") return "rumor";
  if (s === "Orange") return "partial_false";
  if (s === "Green") return "factual";
  if (s === "Blue") return "fact_clarification";
  if (s === "Gray") return "inconsistent";
  if (s === "Cyan") return "factual_narrative_split";
  return "unverified";
}

/**
 * 網頁標註與判定鍵一致：Red／Orange／Gray／Green／Blue／Cyan（Yellow 視同 Gray）。
 */
function applyStatusVisual(span, status, claimReview = null) {
  ensureFcaHighlightStyles();

  span.removeAttribute("style");
  span.className = "";

  span.classList.add("fca-anno");
  const raw = fcaNormalizeLegacyYellowStatus(String(status || ""));
  const s =
    raw === "Red" ||
    raw === "Orange" ||
    raw === "Green" ||
    raw === "Blue" ||
    raw === "Gray" ||
    raw === "Cyan"
      ? raw
      : "Gray";
  span.setAttribute("data-fca-status", s);
  span.setAttribute("data-fca-line", fcaAnnoLineDataAttr(s));
  if (claimReview?.cofactsReplyType != null) {
    span.setAttribute("data-fca-cofacts-reply-type", claimReview.cofactsReplyType);
  }
  const sem = FCA_ANNO_SEMANTIC[s] || FCA_ANNO_SEMANTIC.Gray;
  span.classList.add(sem);
}

/** 游標暫留時說明每段顏色：主觀 vs 查核為錯／待查等（輔助細讀反白）。 */
function fcaAnnoTitleForSegment(st, mini) {
  const s = fcaNormalizeLegacyYellowStatus(st);
  if (mini?.fcaFactClause) {
    return "偏事實敘述：人、時、地、數字、引述或可驗證宣稱等語氣（淺青底色為語意拆解；≠已查核為真）";
  }
  if (mini?.fcaSubjectiveClause) {
    return "偏觀點／主觀語氣：評論、推測、價值判斷或煽情用語（關鍵字規則；≠已查核為假；請與可驗證敘述分開讀）";
  }
  if (mini?.fcaWeakIndexOverlap) {
    return "此子句與目前查核條目關聯較弱，請勿逕以總判定套用至此句";
  }
  if (mini?.fcaNarrativeChunk) {
    return "一般敘述區段（無查核條目時僅供與橘色煽情／評論語句對照）";
  }
  if (
    mini?.cofactsReplyType === "OPINIONATED" ||
    (s === "Blue" && mini?.fcaCofacts)
  ) {
    return "事實釐清（Cofacts：個人意見／易造成誤解；詳情見右側側欄）";
  }
  if (s === "Red" && (mini?.publisher || mini?.url || mini?.fcaCofacts)) {
    return "與查核「錯誤／含有不實」相關之敘述（詳情見右側側欄）";
  }
  if (s === "Green") {
    return "與查核「正確／不含錯誤」相關之敘述（詳情見右側側欄）";
  }
  if (s === "Orange") {
    return "與查核「部分錯誤／誤導」相關之敘述（詳情見右側側欄）";
  }
  if (s === "Blue") {
    return "事實釐清：須補充脈絡或整體理解（詳情見右側側欄）";
  }
  if (s === "Gray") {
    return "目前無法證實（詳情見右側側欄）";
  }
  if (s === "Cyan") {
    return "語意拆解：偏事實敘述區段（非查核結論）";
  }
  return "";
}

function findFcaAnnoWrappingRange(range) {
  if (!range || range.collapsed) return null;
  const sc = range.startContainer;
  const ec = range.endContainer;
  let el = sc.nodeType === Node.TEXT_NODE ? sc.parentElement : sc;
  if (!el?.closest) return null;
  const anno = el.closest("span.fca-anno");
  if (!anno || !anno.contains(ec)) return null;
  return anno;
}

function resolveClaimMeta(claimReview) {
  const publisher =
    claimReview?.publisher?.name ||
    claimReview?.publisher?.site ||
    "—";
  const textualRating =
    claimReview?.textualRating || (claimReview ? "—" : "查無相關查核資料");
  return { publisher, textualRating };
}

/** AI 覆寫 Cofacts 時，說明「色塊／標籤」與下方原文的關係（避免誤以為原文即採用結論）。 */
function fcaAiOverrideBannerText(displayStatus) {
  const lab =
    FCA_STATUS_LABEL[fcaNormalizeLegacyYellowStatus(displayStatus)] ||
    displayStatus;
  return `採用結論：${lab}（已改採 AI 判讀；下方 Cofacts 原文僅供對照）`;
}

/** 僅允許 http(s) 連結供查核出處／面板按鈕使用。 */
function fcaSafeHttpUrl(raw) {
  const s = String(raw || "").trim();
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

function fcaPageContextOpenLinkHtml(linkLabel = "開啟目前頁面") {
  const url = fcaSafeHttpUrl(window.location.href);
  if (!url) return "";
  return `<a class="fca-panel-open" href="${escapeHtmlFc(url)}" target="_blank" rel="noopener noreferrer">${escapeHtmlFc(
    linkLabel
  )}</a>`;
}

async function fcaWithTimeout(promise, timeoutMs, timeoutMessage) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage || "OP_TIMEOUT"));
    }, Math.max(1200, Number(timeoutMs) || 8000));
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

function fcaNoResultSuggestionPhrases(queryText) {
  const q = String(queryText || "").replace(/\s+/g, " ").trim();
  if (!q) return [];
  const quoted = q.match(/"([^"]+)"/g) || [];
  const cleaned = q
    .replace(/["'“”‘’]/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3);
  const uniq = [...new Set([...quoted.map((x) => x.slice(1, -1)), ...cleaned])];
  const picks = [];
  if (q.length > 18) picks.push(q.slice(0, 28).trim());
  for (const t of uniq) {
    if (t && !picks.includes(t)) picks.push(t);
    if (picks.length >= 3) break;
  }
  return picks.slice(0, 3);
}

function fcaBuildNoResultSuggestionsHtml(queryText) {
  const picks = fcaNoResultSuggestionPhrases(queryText);
  if (!picks.length) return "";
  let html = `<div class="result-hint">${escapeHtmlFc("快速再查：")}</div><div>`;
  for (const p of picks) {
    html += `<a class="ref" href="#" data-fca-query-suggest="${escapeHtmlFc(p)}">${escapeHtmlFc(
      `改查「${p}」`
    )}</a><br/>`;
  }
  html += "</div>";
  return html;
}

function fcaHasCjkText(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ""));
}

function fcaShouldLoadTrustedRealtimeNews(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length >= 6;
}

function fcaIsTrustedNewsVisible() {
  if (!fcaLocalOptsCache) return true;
  return fcaLocalOptsCache[FCA_OPT_SHOW_TRUSTED_NEWS] !== false;
}

async function fcaFetchTrustedRealtimeNews(text, limit = 5) {
  const q = String(text || "").replace(/\s+/g, " ").trim();
  if (!fcaShouldLoadTrustedRealtimeNews(q)) return [];
  try {
    const r = await fcaSendMessage({
      type: "FC_TRUSTED_NEWS_SEARCH",
      text: q,
      limit
    });
    if (!r?.ok || !Array.isArray(r.items)) return [];
    return r.items
      .map((x) => ({
        title: String(x?.title || "").trim(),
        link: fcaSafeHttpUrl(x?.link),
        source: String(x?.source || "").trim(),
        host: String(x?.host || "").trim(),
        publishedAt: Number(x?.publishedAt) || 0
      }))
      .filter((x) => x.title && x.link)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function fcaRelativeTimeLabel(tsMs) {
  const ts = Number(tsMs);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = Date.now() - ts;
  if (!Number.isFinite(d) || d < 0) return "";
  const m = Math.floor(d / 60000);
  if (m < 1) return "剛剛";
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} 天前`;
  return "";
}

/**
 * 索引 API 附帶的 `fcaStatus` 對長篇 `textualRating` 常落成 Gray（與「證據不足」同級），
 * 但條目實際為闢謬時需從標題／評級字串還原有效色階。
 */
function fcaSupplementaryEffectiveFcaStatus(sup) {
  if (!sup) return "Gray";
  const st0 = String(sup.fcaIndexHitStatus || "").trim();
  if (st0 && st0 !== "Gray") return st0;
  const blob = [
    sup.textualRating,
    sup.title,
    sup.headline,
    sup.name,
    String(sup.articleText || "").slice(0, 520)
  ]
    .filter(Boolean)
    .join("\n");
  if (!blob.trim()) return "Gray";
  if (/部分錯誤|片面真實|不完全正確|易誤導|misleading|partially false/i.test(blob)) {
    return "Orange";
  }
  if (
    /(錯誤訊息|不實訊息|錯誤資訊|為假|是假的|並非事實|並非屬實|泛指錯誤|錯誤的|並不正確|假的|捏造|誤傳|訛傳|闢謠|假的圖|假消息)/.test(
      blob
    ) &&
    !/^(待查證|無法證實|未能證實)$/m.test(String(sup.textualRating || "").trim())
  ) {
    return "Red";
  }
  if (/正確|屬實|大致屬實|確有其事/.test(blob) && !/(錯誤|不實|假)/.test(blob)) {
    return "Green";
  }
  if (/(釐清|易造成誤解|有特殊情況|非文章所指)/.test(blob)) return "Blue";
  return "Gray";
}

/**
 * Cofacts 尚無可用社群回覆摘錄，但查核索引另有可採用之判定（含從闢謠字串還原之紅／橘等）時，
 * 主判定改以索引為準（含闢謠稿被後端標成 Gray 之還原）。
 */
function fcaIndexSupersedesWeakCofacts(claimReview) {
  const sup = claimReview?.fcaSupplementaryIndexReview;
  if (!sup || !claimReview?.fcaCofacts) {
    return false;
  }
  if (claimReview.fcaPreferIndexOverCofacts === true) {
    return fcaSupplementaryEffectiveFcaStatus(sup) !== "Gray";
  }
  if (!claimReview.cofactsNoConsensus) return false;
  return fcaSupplementaryEffectiveFcaStatus(sup) !== "Gray";
}

/** 側欄／浮窗「判定」摘錄與 chip 所依據的 claimReview（可能被索引蓋過弱 Cofacts）。 */
function fcaVerdictUiPrimaryClaimReview(claimReview) {
  if (fcaIndexSupersedesWeakCofacts(claimReview)) {
    return claimReview.fcaSupplementaryIndexReview;
  }
  return claimReview;
}

/** 標示結論資料來源，避免與正式媒體查核混淆。 */
function fcaResultProvenanceLine(claimReview) {
  if (!claimReview) return "";
  if (claimReview.fcaSubjectiveOnlyHighlights) return "語氣辨識（無查核條目命中）";
  if (claimReview.fcaStandaloneAiOnly) return "AI 輔助判讀（非查核機構正式結論）";
  if (claimReview?.fcaCofactsAiReplyOnly) {
    return "Cofacts AI 先行回覆（非社群投票共識）";
  }
  if (fcaIndexSupersedesWeakCofacts(claimReview)) {
    return "查核索引（以下判定以索引命中為準）";
  }
  if (claimReview.fcaCofacts) return "Cofacts 社群查核";
  return "國際查核索引";
}

/** 網域分析（僅分型＋主機名，插入浮動面板／側欄） */
function fcaBuildDomainAnalysisSectionHtml(claimReview, mediaExtra) {
  void claimReview;
  void mediaExtra;
  return "";
}

function fcaBuildRealtimeNewsSectionHtml(mediaExtra, opts = {}) {
  if (opts.suppress) return "";
  if (FCA_LEGACY_SIDEBAR_UI) return "";
  if (!fcaIsTrustedNewsVisible()) return "";
  const pending = mediaExtra?.trustedNewsPending === true;
  const hasField =
    mediaExtra && Object.prototype.hasOwnProperty.call(mediaExtra, "trustedNews");
  if (!pending && !hasField) return "";
  const items = Array.isArray(mediaExtra?.trustedNews) ? mediaExtra.trustedNews : [];
  const auxClassic = FCA_CLASSIC_AUX_SECTIONS_UI ? " fca-aux-classic" : "";
  const emb = opts.variant === "embeddedInAi";
  let html = `<div class="fca-realtime-news${auxClassic}${
    emb ? " fca-realtime-news--embedded-in-ai" : ""
  }">`;
  if (emb) {
    html += `<div class="fca-realtime-news__embed-lead">${escapeHtmlFc(
      "下列為可信來源新聞標題，供與反白或查核摘錄交叉比對（非查核結論）："
    )}</div>`;
  }
  html += `<div class="fca-realtime-news__title">${escapeHtmlFc("即時新聞（可信來源）")}</div>`;
  html += `<div class="fca-realtime-news__hint">${escapeHtmlFc(
    "依反白內容關鍵詞搜尋近期新聞，僅顯示較具公信力來源供交叉查證。"
  )}</div>`;
  html += '<div class="fca-realtime-news__list">';
  if (pending) {
    html += `<div class="fca-realtime-news__pending">${escapeHtmlFc("正在載入新聞…")}</div>`;
    if (!FCA_CLASSIC_AUX_SECTIONS_UI) {
      html += '<div class="fca-news-sk">';
      for (let i = 0; i < 3; i++) {
        const w = i === 0 ? "100%" : i === 1 ? "92%" : "78%";
        html += `<div class="fca-news-sk-line" style="width:${w}"></div>`;
      }
      html += "</div>";
    }
  } else if (!items.length) {
    html += `<div class="fca-realtime-news__empty">${escapeHtmlFc(
      "暫無可顯示的可信來源即時新聞。可改短一點關鍵詞後重新查核。"
    )}</div>`;
  } else {
    for (const it of items.slice(0, 5)) {
      html += `<a class="ref fca-realtime-news__link" href="${escapeHtmlFc(
        it.link
      )}" target="_blank" rel="noopener noreferrer">${escapeHtmlFc(it.title)}</a>`;
    }
  }
  html += "</div></div>";
  return html;
}

/**
 * Cofacts 條目是否已有「側欄判定區可呈現」的實質內容（與 `fcaVerdictReasonSummaryText` 一致）。
 * 除首則回覆 `replyText` 外，若理由改取自條目內文 `articleText`，亦視為已有摘錄，避免 AI 區誤判為「無 Cofacts 摘要」。
 */
function fcaHasCofactsVerdictReplySummary(claimReview) {
  if (!claimReview?.fcaCofacts) return false;
  if (claimReview.cofactsNoConsensus) return false;
  const reply = String(claimReview.replyText || "").replace(/\s+/g, " ").trim();
  if (reply && !/^true\.?$/i.test(reply)) {
    const minLen = claimReview.fcaCofactsAiReplyOnly ? 16 : 24;
    const coreLen = reply.replace(/\s/g, "").length;
    if (reply.length >= minLen || coreLen >= 20) return true;
  }
  const art = String(claimReview.articleText || "").replace(/\s+/g, " ").trim();
  return art.length >= 28;
}

/** 判定區塊內嵌：無查核或低關聯時，摘列可信來源新聞標題供交叉比對。 */
function fcaBuildVerdictNewsInlineSummaryHtml(
  queryText,
  mediaExtra,
  ui = "sidebar",
  claimReview = null
) {
  const q = String(queryText || "").trim();
  if (!fcaIsTrustedNewsVisible()) return "";
  const items = Array.isArray(mediaExtra?.trustedNews) ? mediaExtra.trustedNews : [];
  if (!items.length) return "";
  const p = ui === "panel" ? "panel" : "sb";
  const lines = [];
  for (let i = 0; i < Math.min(4, items.length); i++) {
    const it = items[i];
    const t = String(it?.title || "").trim();
    const href = fcaSafeHttpUrl(it?.link);
    if (!t || !href) continue;
    lines.push(
      `<div class="${p}-verdict-news-line">${lines.length + 1}. <a class="ref" href="${escapeHtmlFc(
        href
      )}" target="_blank" rel="noopener noreferrer">${escapeHtmlFc(t)}</a></div>`
    );
  }
  if (!lines.length) return "";
  const summary = fcaBuildTrustedNewsSummaryLine(q, items);
  let title = "相關新聞（無查核條目或關聯偏弱時，可交叉比對）";
  if (!claimReview) {
    title = "相關新聞（查無條目時，可交叉比對）";
  } else if (!claimReview.fcaCofacts) {
    title = "相關新聞（國際索引；無 Cofacts 條目內文，可交叉比對）";
  } else if (!fcaHasCofactsVerdictReplySummary(claimReview)) {
    title = "相關新聞（Cofacts 尚無結論摘錄或內文過短，可交叉比對）";
  }
  const summaryHtml = summary
    ? `<div class="${p}-verdict-news-summary">${escapeHtmlFc(summary)}</div>`
    : "";
  return `<div class="${p}-verdict-news"><div class="${p}-verdict-news-title">${escapeHtmlFc(
    title
  )}</div>${summaryHtml}${lines.join("")}</div>`;
}

function fcaBuildTrustedNewsSummaryLine(queryText, items) {
  const q = String(queryText || "").trim();
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return "";
  const tops = rows
    .map((it) => String(it?.title || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (!tops.length) return "";
  if (!q) return `新聞摘要：${tops[0].slice(0, 68)}${tops[0].length > 68 ? "…" : ""}`;
  const scored = tops.map((t) => ({
    t,
    sc: fcaBigramOverlapRatio(q, t)
  }));
  scored.sort((a, b) => b.sc - a.sc);
  const best = scored[0];
  if (!best || best.sc < 0.06) return "";
  const headline = best.t.length > 76 ? `${best.t.slice(0, 76)}…` : best.t;
  if (scored.length >= 2 && scored[1].sc >= 0.06) {
    return `新聞摘要：多家可信來源均提及「${headline}」`;
  }
  return `新聞摘要：可信來源提及「${headline}」`;
}

function fcaTrustedNewsConsensusStatus(queryText, mediaExtra) {
  if (!fcaIsTrustedNewsVisible()) return null;
  const q = String(queryText || "").trim();
  const items = Array.isArray(mediaExtra?.trustedNews) ? mediaExtra.trustedNews : [];
  if (!q || items.length < 2) return null;
  const scored = items
    .slice(0, 5)
    .map((it) => {
      const t = String(it?.title || "").replace(/\s+/g, " ").trim();
      return { title: t, overlap: t ? fcaBigramOverlapRatio(q, t) : 0 };
    })
    .filter((x) => x.title);
  if (scored.length < 2) return null;
  scored.sort((a, b) => b.overlap - a.overlap);
  const best = scored[0]?.overlap || 0;
  const second = scored[1]?.overlap || 0;
  if (best >= 0.18 && second >= 0.14) {
    return {
      status: "Green",
      summary: fcaBuildTrustedNewsSummaryLine(q, items)
    };
  }
  return null;
}

/**
 * 側欄／浮窗「判定」主句與上方燈號一致：新聞共識升綠時，勿仍顯示索引的「目前無法證實」。
 */
function fcaVerdictTextualRatingAlignedWithChip(claimReview, displayStatus, primaryCr) {
  const raw =
    primaryCr?.textualRating ||
    (primaryCr ? "—" : "查無相關查核資料");
  if (!claimReview?.fcaNewsConsensusUsed) return raw;
  const k = fcaNormalizeLegacyYellowStatus(displayStatus);
  if (k === "Green") {
    return `${FCA_STATUS_LABEL.Green}（新聞交叉比對：多家可信來源標題與反白高度重疊；非機構查核結論）`;
  }
  return raw;
}

function fcaShouldAppendNewsToVerdictBlock(claimReview, reasonBody, chipKey) {
  if (!claimReview) return false;
  if (fcaShouldEmbedTrustedNewsInAi(claimReview, chipKey)) return false;
  if (claimReview.fcaRelatedThemeOnly) return true;
  if (claimReview.fcaSubjectiveOnlyHighlights) return true;
  if (claimReview.fcaNoDirectCofactsMatch) return true;
  if (claimReview?.fcaIndexRelevance?.tier === "低") return true;
  if (String(reasonBody || "").includes("與反白關聯度有限")) return true;
  if (String(reasonBody || "").includes("逐段重疊偏低")) return true;
  if (!claimReview.fcaCofacts) return true;
  if (!fcaHasCofactsVerdictReplySummary(claimReview)) return true;
  return false;
}

/** 證據不足、或非 Cofacts／尚無 Cofacts 結論摘錄時，把即時新聞併入 AI 摘要欄並略過下方重複區塊。 */
function fcaShouldEmbedTrustedNewsInAi(claimReview, chipKey) {
  if (fcaNormalizeLegacyYellowStatus(chipKey || "") === "Gray") return true;
  if (!claimReview) return false;
  if (!claimReview.fcaCofacts) return true;
  if (!fcaHasCofactsVerdictReplySummary(claimReview)) return true;
  return false;
}

function fcaGeminiDiagCode({ keyInvalid, quota, hasReason, skipGemini, gHttp, hasKey }) {
  if (skipGemini) return "GEMINI_SKIPPED";
  if (keyInvalid) return "GEMINI_KEY_INVALID";
  if (quota) return "GEMINI_429";
  if (!hasReason && hasKey === false) return "GEMINI_NO_KEY";
  if (!hasReason && hasKey == null) return "GEMINI_KEY_PENDING";
  if (!hasReason && gHttp >= 500) return "GEMINI_SERVER";
  if (!hasReason && gHttp > 0) return `GEMINI_HTTP_${gHttp}`;
  if (!hasReason && hasKey === true) return "GEMINI_SUMMARY_NONE";
  return hasReason ? "GEMINI_OK" : "GEMINI_NOT_READY";
}

/** 與 manifest 同步，供配對回報／診斷文字標示版本。 */
const FCA_EXTENSION_VERSION = "2.3.73";
const FCA_MATCH_FEEDBACK_LOG_KEY = "fcaMatchFeedbackLog";
const FCA_MATCH_FEEDBACK_MAX = 40;

/**
 * 無 Gemini 摘要時：依既有查核結果產生一句「規則摘要」（不呼叫外部 API）。
 */
function fcaBuildNoAiRuleSummaryLine(claimReview, queryText) {
  const q = String(queryText || "").trim();
  const qlen = q.replace(/\s/g, "").length;
  if (!claimReview) {
    if (qlen >= 10) {
      return "規則摘要：索引與 Cofacts 未命中與此段反白直接對應的條目；建議改選較短關鍵句，並參考下方可信新聞交叉比對。";
    }
    return "規則摘要：反白過短，難以比對；請選含人、事、時、地其中至少兩項的一句話再查。";
  }
  if (claimReview.fcaNoDirectCofactsMatch) {
    return "規則摘要：查核資料庫與此反白未直接對稿；畫面上若見 AI 判讀僅為常識輔助，請勿當成機構查核結論。";
  }
  if (claimReview.fcaStandaloneAiOnly && !claimReview.fcaCofacts) {
    return "規則摘要：目前僅有輔助判讀或語意標示、無正式查核條目；請自行查證。";
  }
  if (claimReview.fcaSubjectiveOnlyHighlights) {
    return "規則摘要：此為語氣／事實敘述拆解（關鍵字規則），不代表該句已遭查核為假。";
  }
  const src = claimReview.fcaCofacts
    ? "Cofacts 社群條目"
    : claimReview.fcaIndexCorpus
    ? "國際查核索引"
    : "查核資料";
  const tr = String(claimReview.textualRating || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  const tier = claimReview.fcaIndexRelevance?.tier;
  const rel =
    tier === "低"
      ? "與反白相似度偏低，"
      : tier === "高"
      ? "與反白相似度較高，"
      : "";
  if (claimReview.fcaRelatedThemeOnly) {
    return `規則摘要：僅主題相近命中${src}；${rel}務必開啟出處核對是否同一可驗證事件。`;
  }
  if (claimReview.cofactsNoConsensus) {
    return `規則摘要：${src}尚無社群共識回覆${tr ? `（條目上顯示：${tr}）` : ""}；請自行查證原文。`;
  }
  if (tr && !/^true\.?$/i.test(tr)) {
    return `規則摘要：依${src}顯示「${tr}」；${rel}仍請對照出處全文與反白是否同一論點。`;
  }
  return `規則摘要：已連結${src}；${rel}請以出處與反白逐句比對。`;
}

function fcaBuildMatchMismatchClipboardText() {
  const st = fcaSidebarLastApplyState;
  const q = String(st?.q || fcaSidebarLastQuery || "").trim();
  let page = "";
  try {
    page = String(window.location?.href || "").trim().slice(0, 800);
  } catch {
    page = "";
  }
  const cr = st?.claimReview || null;
  const fs = String(st?.finalStatus || "");
  const err = String(st?.errorText || "").trim();
  const lines = [
    "=== 事實查核助手：配對可能有誤（本機回報，未上傳）===",
    `時間(ISO): ${new Date().toISOString()}`,
    `擴充版本: ${FCA_EXTENSION_VERSION}`,
    "查核排序: 相關優先（固定）",
    "",
    `【反白／查詢】共 ${q.replace(/\s/g, "").length} 字（最多列出 2000 字）`,
    q.slice(0, 2000),
    "",
    `【finalStatus】 ${fs || "—"}`,
    err ? `【errorText】 ${err}` : "",
    cr
      ? `【來源】 ${cr.publisher?.name || "—"} / ${cr.publisher?.site || "—"}`
      : "【claimReview】 null",
    cr?.url ? `【出處 URL】 ${cr.url}` : "",
    cr?.fcaCofactsNodeId ? `【Cofacts node id】 ${cr.fcaCofactsNodeId}` : "",
    cr?.fcaCofactsMatchHintZh
      ? `【配對說明】 ${cr.fcaCofactsMatchHintZh}`
      : "",
    cr?.fcaIndexRelevance?.label
      ? `【索引相關度】 ${cr.fcaIndexRelevance.label}`
      : "",
    cr?.fcaRelatedThemeOnly ? "【主題相近】 是" : "",
    cr?.fcaNoDirectCofactsMatch ? "【無直接 Cofacts 對稿】 是" : "",
    cr?.textualRating
      ? `【條目判定欄摘要】 ${String(cr.textualRating).slice(0, 240)}`
      : "",
    cr?.articleText
      ? `\n【條目正文摘錄 前 500 字】\n${String(cr.articleText).slice(0, 500)}`
      : "",
    cr?.replyText
      ? `\n【首則回覆摘錄 前 500 字】\n${String(cr.replyText).slice(0, 500)}`
      : "",
    `\n【頁面 URL】\n${page || "—"}`,
    "",
    "--- 請貼給開發者或自行留存，用於調整配對 gate／排序 ---"
  ];
  return lines.filter(Boolean).join("\n");
}

async function fcaAppendMatchFeedbackLog(entry) {
  try {
    const bag = await fcaStorageLocalGet(FCA_MATCH_FEEDBACK_LOG_KEY);
    const prev = Array.isArray(bag[FCA_MATCH_FEEDBACK_LOG_KEY])
      ? bag[FCA_MATCH_FEEDBACK_LOG_KEY]
      : [];
    const next = [entry, ...prev].slice(0, FCA_MATCH_FEEDBACK_MAX);
    await fcaStorageLocalSet({ [FCA_MATCH_FEEDBACK_LOG_KEY]: next });
  } catch (e) {
    fcaLog("fcaAppendMatchFeedbackLog", e);
  }
}

async function fcaRunMatchMismatchReport() {
  const q = String(
    fcaSidebarLastApplyState?.q || fcaSidebarLastQuery || ""
  ).trim();
  if (!q) {
    window.alert("請先完成一次查核（有反白內容）後再回報配對問題。");
    return;
  }
  const text = fcaBuildMatchMismatchClipboardText();
  if (!text.includes("【反白")) {
    window.alert("無法產生診斷內容，請稍後再試。");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.alert(
      `無法寫入剪貼簿，請手動複製以下內容（前 3000 字）：\n\n${text.slice(0, 3000)}`
    );
    return;
  }
  await fcaAppendMatchFeedbackLog({
    t: new Date().toISOString(),
    qPreview: q.slice(0, 160),
    pagePreview: (() => {
      try {
        return String(window.location?.href || "").slice(0, 200);
      } catch {
        return "";
      }
    })(),
    extVersion: FCA_EXTENSION_VERSION,
    hadClaim: Boolean(fcaSidebarLastApplyState?.claimReview)
  });
  window.alert(
    "已複製「配對診斷」全文到剪貼簿，並寫入本機最近 40 筆紀錄（僅存於您的瀏覽器，不上傳）。可貼給開發者調 gate／排序。"
  );
}

function fcaPanelMatchReportSnippetHtml() {
  return `<div class="result-match-actions"><button type="button" class="fca-panel-match-report" data-fca-match-report="1" aria-label="配對可能有誤，複製本機診斷">配對可能有誤（複製診斷）</button></div>`;
}

/** AI 摘要（獨立一格，與網域分析／即時新聞同層；就算無回傳也顯示提示） */
function fcaBuildAiSummarySectionHtml(claimReview, queryText = "", opts = {}) {
  if (FCA_LEGACY_SIDEBAR_UI) return "";
  const sidebar = opts.sidebar === true;
  const fullAiReason = String(claimReview?.fcaAiReason || "").trim();
  const reasonMax = sidebar
    ? FCA_AI_SUMMARY_SIDEBAR_MAX_CHARS
    : FCA_AI_SUMMARY_MAX_CHARS;
  const expandMax = sidebar
    ? FCA_AI_SUMMARY_SIDEBAR_EXPAND_MAX_CHARS
    : FCA_AI_SUMMARY_MAX_CHARS;
  const reasonDisplayed = fullAiReason.slice(0, reasonMax);
  const keyInvalid = claimReview?.fcaGeminiKeyInvalid === true;
  const quota = claimReview?.fcaGeminiQuotaExceeded === true;
  const inactive = !fullAiReason;
  const qLen = String(queryText || "").trim().length;
  const diag = fcaAiDiagSnapshot();
  const debugEnabled = diag.debug === true;
  const skipGemini = diag.skipGemini === true;
  const auxClassic = FCA_CLASSIC_AUX_SECTIONS_UI ? " fca-aux-classic" : "";
  const sbCls = sidebar ? " fca-ai-summary--sidebar" : "";
  const cofactsSummarized =
    Boolean(claimReview) && fcaHasCofactsVerdictReplySummary(claimReview);
  const cofactsAiVerdictOnly =
    !fullAiReason &&
    claimReview?.fcaCofactsAiReplyOnly === true &&
    String(claimReview?.replyText || "")
      .replace(/\s+/g, " ")
      .trim().length >= 12;
  if (
    sidebar &&
    cofactsSummarized &&
    !fullAiReason &&
    !keyInvalid &&
    !quota &&
    !skipGemini &&
    !cofactsAiVerdictOnly
  ) {
    if (opts?.embedTrustedNews && opts?.mediaExtra) {
      const newsInner = fcaBuildRealtimeNewsSectionHtml(opts.mediaExtra, {
        variant: "embeddedInAi"
      });
      if (newsInner) {
        return `<div class="fca-ai-summary fca-ai-summary--inactive fca-ai-summary--news-only${auxClassic}${sbCls}"><div class="fca-ai-summary__title">${escapeHtmlFc(
          "即時新聞"
        )}</div><div class="fca-ai-summary__news">${newsInner}</div></div>`;
      }
    }
    return "";
  }
  const gHttp = Number(claimReview?.fcaGeminiHttpStatus) || 0;
  const gHint = String(claimReview?.fcaGeminiErrHint || "").trim();
  const quotaLikeHint =
    /quota|rate limit|resource_exhausted|too many requests|cooldown/i.test(gHint);

  let body = "";
  let aiPrefix = "";
  if (fullAiReason) {
    const tag = claimReview.fcaNoDirectCofactsMatch
      ? "查核候選與反白主題不符，已改採常識判讀。"
      : claimReview.fcaAiOverrodeCofacts
      ? "AI 與資料庫結論不一致，已採用 AI 結論。"
      : claimReview.fcaAiDisagreedWithCofacts
      ? "AI 與資料庫結論可能不一致（目前仍以資料庫為主）。"
      : "AI 補充說明：";
    const conf =
      typeof claimReview.fcaAiConfidence === "number"
        ? ` 信心約 ${Math.round(claimReview.fcaAiConfidence * 100)}%。`
        : "";
    aiPrefix = tag + conf;
    body = aiPrefix + reasonDisplayed;
  } else if (keyInvalid) {
    body = "Gemini 金鑰無效或過期，請更新後再試。";
  } else if (quota || quotaLikeHint) {
    /* 從快取讀冷卻截止時間（由 fcaAiDiagPrimeFromStorage 非同步填入），顯示剩餘等待時間 */
    const until = fcaGeminiCooldownUntilCache;
    if (until > Date.now()) {
      const secLeft = Math.ceil((until - Date.now()) / 1000);
      if (secLeft > 3600) {
        const h = Math.floor(secLeft / 3600);
        const m = Math.ceil((secLeft % 3600) / 60);
        body = `Gemini 每日配額已耗盡，約 ${h} 小時 ${m} 分後恢復（Google 台灣時間每天早上 8 點重置）。開擴充視窗可查看倒數。`;
      } else if (secLeft > 60) {
        body = `Gemini 速率限制中，約 ${Math.ceil(secLeft / 60)} 分後可用。開擴充視窗可查看倒數。`;
      } else {
        body = `Gemini 速率限制中，約 ${secLeft} 秒後可用。`;
      }
    } else {
      body = "Gemini 配額已達上限（429）。請開擴充視窗查看冷卻狀態。";
    }
  } else if (skipGemini) {
    body =
      "目前已略過 Gemini（AI：關），不會產生 AI 摘要。";
  } else if (diag.hasKey === false) {
    body =
      "尚未儲存 Gemini 金鑰，請開啟 AI 設定後儲存。";
  } else if (diag.hasKey === true && (gHttp > 0 || gHint)) {
    body = `尚未取得 Gemini 回應（HTTP ${gHttp || "?"}）。${gHint ? `細節：${gHint}` : "請稍後再試或檢查金鑰／模型設定。"}`;
  } else if (
    diag.hasKey === true &&
    claimReview?.fcaCofacts &&
    !claimReview.cofactsNoConsensus
  ) {
    body =
      "已有 Cofacts 可查核結論；為節省 API 配額，本次未再呼叫 Gemini 產生段落摘要。說明請以上方「判定理由」與出處連結為準。";
  } else if (diag.hasKey === true && claimReview?.cofactsNoConsensus) {
    body =
      "此條目尚無社群共識；若未見 Gemini 補充摘要，請再查核一次或稍後重試，並確認側欄「AI：開」未關閉。";
  } else if (diag.hasKey === true && claimReview && !claimReview.fcaCofacts) {
    body =
      "本次以查核索引為主；可能未附 Gemini 段落摘要。詳見上方判定與出處。";
  } else if (diag.hasKey === true) {
    body =
      "已偵測到金鑰，但本次未帶出摘要。請再執行查核或重新載入頁面；若剛貼上金鑰，請先開擴充視窗按「儲存」。";
  } else {
    body =
      "正在讀取金鑰狀態…若仍顯示未儲存，請開擴充視窗 AI 區貼上金鑰後按儲存，再回到本頁重試。";
  }

  const ruleOneLiner = !fullAiReason
    ? fcaBuildNoAiRuleSummaryLine(claimReview, queryText)
    : "";
  let html = `<div class="fca-ai-summary${inactive ? " fca-ai-summary--inactive" : ""}${auxClassic}${sbCls}">`;
  html += `<div class="fca-ai-summary__title">${escapeHtmlFc("AI 摘要")}</div>`;
  html += `<div class="fca-ai-summary__hint">${escapeHtmlFc(
    "Gemini 為輔助判讀，非正式查核結論。"
  )}</div>`;
  const cofactsAiInVerdict =
    !fullAiReason &&
    claimReview?.fcaCofactsAiReplyOnly === true &&
    String(claimReview.replyText || "")
      .replace(/\s+/g, " ")
      .trim().length >= 12;
  if (cofactsAiInVerdict) {
    html += `<div class="fca-ai-summary__rule">${escapeHtmlFc(
      "判定理由含 Cofacts 節錄（非逐句對齊）；請以原文為準。此區僅顯示 Gemini。"
    )}</div>`;
  }
  if (ruleOneLiner) {
    html += `<div class="fca-ai-summary__rule">${escapeHtmlFc(ruleOneLiner)}</div>`;
  }
  const cat = String(claimReview?.fcaAiCategory || "AI").trim() || "AI";
  const tagOpen = `<span class="fca-ai-summary__tag">[${escapeHtmlFc(cat)}]</span> `;
  const collapseAi =
    sidebar &&
    fullAiReason &&
    fullAiReason.length > FCA_AI_SIDEBAR_BODY_COLLAPSE_AT;
  if (collapseAi) {
    const peekCore = `${fullAiReason
      .slice(0, FCA_AI_SIDEBAR_BODY_COLLAPSE_AT)
      .trimEnd()}…`;
    const peek = `${aiPrefix}${peekCore}`;
    const expandedCore =
      fullAiReason.length > expandMax
        ? `${fullAiReason.slice(0, expandMax)}…`
        : fullAiReason;
    const expanded = `${aiPrefix}${expandedCore}`;
    html += `<div class="fca-ai-summary__body">${tagOpen}${escapeHtmlFc(peek)}</div>`;
    html += `<details class="fca-ai-summary__more"><summary>${escapeHtmlFc(
      "顯示全文"
    )}</summary><div class="fca-ai-summary__body fca-ai-summary__body--full">${tagOpen}${escapeHtmlFc(
      expanded
    )}</div></details>`;
  } else {
    html += `<div class="fca-ai-summary__body">${tagOpen}${escapeHtmlFc(body)}</div>`;
  }
  const diagCode = fcaGeminiDiagCode({
    keyInvalid,
    quota: quota || quotaLikeHint,
    hasReason: Boolean(fullAiReason),
    skipGemini,
    gHttp,
    hasKey: diag.hasKey
  });
  /* 預期無 AI 段落或金鑰狀態尚未同步時不顯示技術碼，避免誤以為故障（仍可在除錯模式複製診斷）。 */
  const hideDiagCodeLine =
    diagCode === "GEMINI_SUMMARY_NONE" || diagCode === "GEMINI_KEY_PENDING";
  if (!fullAiReason && !hideDiagCodeLine) {
    html += `<div class="fca-ai-summary__diag">${escapeHtmlFc(
      `診斷碼：${diagCode}`
    )}</div>`;
  }
  /* 無摘要時務必顯示操作列：先前僅在 keyInvalid/429/HTTP 時顯示，未存金鑰者看不到「開啟 AI 設定」。 */
  const showActionRow =
    !fullAiReason || keyInvalid || quota || skipGemini;
  if (showActionRow) {
    html += '<div class="fca-ai-summary__actions">';
    if (skipGemini) {
      html += `<button type="button" class="fca-ai-summary__fix" data-fca-ai-fix="enableGemini">${escapeHtmlFc(
        "關閉略過 Gemini"
      )}</button>`;
    }
    if (!fullAiReason || keyInvalid || quota || gHttp > 0) {
      html += `<button type="button" class="fca-ai-summary__fix" data-fca-ai-fix="openGeminiSettings">${escapeHtmlFc(
        "開啟 AI 設定"
      )}</button>`;
      if (!hideDiagCodeLine) {
        html += `<button type="button" class="fca-ai-summary__fix" data-fca-ai-fix="copyDiag" data-fca-diag-code="${escapeHtmlFc(
          diagCode
        )}">${escapeHtmlFc("複製診斷碼")}</button>`;
      }
    }
    html += "</div>";
  }
  const privacyDismissedPerm =
    fcaLocalOptsCache?.[FCA_OPT_GEMINI_PRIVACY_DISMISSED] === true;
  const privacyDismissed =
    privacyDismissedPerm || fcaGeminiPrivacyBannerSessionHidden;
  if (diag.hasKey && !privacyDismissed) {
    html += `<div class="fca-ai-summary__diag">${escapeHtmlFc(
      "隱私提醒：啟用 Gemini 時，會將你反白的文字片段傳送至 Google AI API。請避免在敏感內容上使用。"
    )}</div><div class="fca-ai-summary__actions"><button type="button" class="fca-ai-summary__fix" data-fca-ai-privacy="dismiss">${escapeHtmlFc(
      "知道了"
    )}</button><button type="button" class="fca-ai-summary__fix" data-fca-ai-privacy="never">${escapeHtmlFc(
      "不再顯示"
    )}</button></div>`;
  }
  if (debugEnabled) {
    const hasKeyLabel =
      diag.hasKey == null ? "?" : diag.hasKey ? "有" : "無";
    const skipLabel =
      diag.skipGemini == null ? "?" : diag.skipGemini ? "是" : "否";
    html += `<div class="fca-ai-summary__diag">${escapeHtmlFc(
      `診斷：Key=${hasKeyLabel}｜略過Gemini=${skipLabel}｜反白字數=${qLen}${gHttp ? `｜GeminiHTTP=${gHttp}` : ""}`
    )}</div>`;
    if (!fullAiReason && (gHttp || gHint)) {
      html += `<div class="fca-ai-summary__diag">${escapeHtmlFc(
        `Gemini 錯誤摘要：${gHint || "（無）"}`
      )}</div>`;
    }
  }
  if (opts?.embedTrustedNews && opts?.mediaExtra) {
    const newsInner = fcaBuildRealtimeNewsSectionHtml(opts.mediaExtra, {
      variant: "embeddedInAi"
    });
    if (newsInner) {
      html += `<div class="fca-ai-summary__news">${newsInner}</div>`;
    }
  }
  html += "</div>";
  if (sidebar && cofactsSummarized && fullAiReason) {
    return `<details class="fca-ai-summary__cofacts-fold${sbCls}${auxClassic}"><summary>${escapeHtmlFc(
      "Gemini 補充（選開；上方已有 Cofacts 摘錄）"
    )}</summary>${html}</details>`;
  }
  return html;
}

function fcaFloatingPanelTitle(errorText, claimReview) {
  if (errorText) return "查核未完成";
  if (!claimReview) return "查無相關查核資料";
  return "查核結果";
}

/** Elasticsearch 相關度：`edges.score`（與 orderBy _score 一致；提高以壓低遠親命中） */
/** Cofacts ES 命中：相對於最高分須達此比例才保留，提高以降低遠親誤配 */
const FCA_COFACTS_MIN_RELATIVE_SCORE = 0.58;

/** articleReplies.replyType：RUMOR / OPINIONATED / NOT_RUMOR / NOT_ARTICLE（映射四色判定） */
const COFACTS_LIST_ARTICLES_QUERY = `
query FcaListArticles($filter: ListArticleFilter!) {
  ListArticles(filter: $filter, orderBy: [{ _score: DESC }], first: 16) {
    edges {
      score
      node {
        id
        text
        createdAt
        updatedAt
        replyCount
        articleReplies(statuses: [NORMAL]) {
          replyType
          reply {
            text
            type
            reference
            createdAt
          }
        }
        aiReplies {
          status
          text
          createdAt
        }
      }
    }
  }
}
`;

/** `ListArticles` 的 ES 命中有時不帶巢狀 `articleReplies`，網站則用 `GetArticle` 載入；補抓後再轉 claimReview。 */
const COFACTS_GET_ARTICLE_QUERY = `
query FcaGetArticle($id: String!) {
  GetArticle(id: $id) {
    id
    text
    createdAt
    updatedAt
    replyCount
    articleReplies(statuses: [NORMAL]) {
      replyType
      reply {
        text
        type
        reference
        createdAt
      }
    }
    aiReplies {
      status
      text
      createdAt
    }
  }
}
`;

/** Cofacts 在尚無人類查核回覆時，官網仍可能顯示 AI 先行稿（aiReplies SUCCESS）。 */
function fcaCofactsFirstAiReplyRecord(node) {
  for (const x of node?.aiReplies || []) {
    if (String(x?.status || "").toUpperCase() !== "SUCCESS") continue;
    const t = String(x?.text || "").replace(/\s+/g, " ").trim();
    if (t.length >= 12) return x;
  }
  return null;
}

function fcaCofactsFirstAiReplyText(node) {
  const r = fcaCofactsFirstAiReplyRecord(node);
  return r ? String(r.text || "").replace(/\s+/g, " ").trim() : "";
}

function fcaCofactsNodeReplyBodyForGates(node) {
  const r = String(node?.articleReplies?.[0]?.reply?.text || "").trim();
  if (r) return r;
  return fcaCofactsFirstAiReplyText(node);
}

function fcaCofactsNodeHasDisplayableReply(node) {
  return (
    (node?.articleReplies || []).length > 0 ||
    Boolean(fcaCofactsFirstAiReplyText(node))
  );
}

/** 是否已有「人類查核者」之 NORMAL 回覆（與僅 aiReplies 區分；排序時優先採人類結論）。 */
function fcaCofactsNodeHasHumanArticleReply(node) {
  return Array.isArray(node?.articleReplies) && node.articleReplies.length > 0;
}

/** Cofacts AI 常見「1.／2.」條列；多段時不可把整篇當成與反白同論點。 */
function fcaCofactsAiReplyHasMultipleNumberedPoints(text) {
  const t = String(text || "").replace(/\r\n/g, "\n");
  const dotted = t.match(/(?:^|\n)\s*\d+\.\s/g);
  const zhComma = t.match(/(?:^|\n)\s*\d+、/g);
  const n = (dotted?.length || 0) + (zhComma?.length || 0);
  return Boolean(
    (dotted && dotted.length >= 2) ||
      (zhComma && zhComma.length >= 2) ||
      n >= 2
  );
}

/**
 * 自整篇 AI 稿挑出與反白較相關的一段，供推斷 RUMOR／NOT_RUMOR（避免第 2 點寫「可能是假」卻套用到第 1 點主題）。
 */
function fcaCofactsTextForAiVerdictInference(userQuery, fullAiBody) {
  const b = String(fullAiBody || "").replace(/\r\n/g, "\n").trim();
  const q = String(userQuery || "").trim();
  if (!b) return "";
  if (q.length < 8) return b.slice(0, 600);
  const blocks = b
    .split(/\n(?=\s*\d+\.\s)/)
    .map((x) => x.trim())
    .filter((x) => x.replace(/\s/g, "").length > 12);
  if (blocks.length < 2) return b.slice(0, 600);
  let best = blocks[0];
  let bestTot = -1;
  for (const blk of blocks) {
    const sc = fcaBigramOverlapRatio(q, blk);
    const { need, hits } = fcaVerdictMeaningfulZhAnchorsInBlob(q, blk);
    const bonus = need > 0 && hits >= need ? 0.06 : Math.min(0.05, hits * 0.022);
    const tot = sc + bonus;
    if (tot > bestTot) {
      bestTot = tot;
      best = blk;
    }
  }
  return (best || b).slice(0, 600);
}

/**
 * 整篇 AI 稿中僅在出現「社群式強烈闢謠」用語時才推 RUMOR（與反白對齊段無結論時的補救）。
 */
function fcaCofactsInferAiOnlyRumorFromCofactsStyleDebunk(full) {
  const s = String(full || "").replace(/\s+/g, " ").trim().slice(0, 2200);
  if (!s) return null;
  if (
    /假的[,，。].{0,200}(生成式|ＡＩ頻道|AI頻道|銀齡)/.test(s) ||
    /含有錯誤資訊/.test(s)
  ) {
    return "RUMOR";
  }
  if (
    /並沒有.{0,10}(所謂|「).{0,24}(VIP|免費升等|全額折抵)/.test(s) &&
    /假訊息|不實/.test(s)
  ) {
    return "RUMOR";
  }
  return null;
}

/**
 * 僅有 AI 稿、尚無 articleReplies 時，從常見查核用語粗判是否等同 RUMOR／NOT_RUMOR（供燈號用；保守）。
 * 排除「可能是假／若無證實則…」等語氣句，避免與反白主題錯置時仍亮紅燈。
 */
function fcaCofactsInferAiOnlyReplyTypeFromZh(text) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  if (!s) return null;
  if (/可能[^。]{0,16}(假訊息|假消息|謠言)/.test(s)) return null;
  if (/如果沒有[^。]{0,22}(假|謠|證實)/.test(s)) return null;
  if (/若無[^。]{0,12}證實/.test(s) && /假|謠/.test(s)) return null;
  const rumorRes = [
    /含有錯誤資訊/,
    /^並非事實/,
    /不實(訊息|消息|說法|影片|內容)/,
    /錯誤(訊息|資訊)/,
    /^(?:【)?假的[,，。\s]/,
    /^假的[,，。]/,
    /這是假訊息/,
    /這是假消息/,
    /(?:^|。)假的[,，。]/
  ];
  for (const re of rumorRes) {
    if (re.test(s)) return "RUMOR";
  }
  const notRes = [/不含錯誤資訊/, /並非謠言/, /屬實/, /大致正確/, /為真/];
  for (const re of notRes) {
    if (re.test(s)) return "NOT_RUMOR";
  }
  return null;
}

/** 自文字摘出 YouTube video id（與 Cofacts 多筆同片連結稿比對用）。 */
function fcaExtractYoutubeVideoIds(blob) {
  const s = String(blob || "");
  const ids = new Set();
  const re =
    /(?:youtube\.com\/watch[^\s#]*[?&]v=|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})\b/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

function fcaCofactsYoutubeIdOverlapScore(userQ, node) {
  const qu = fcaExtractYoutubeVideoIds(userQ);
  if (!qu.size) return 0;
  const blob = `${node?.text || ""}\n${fcaCofactsNodeReplyBodyForGates(node)}`;
  const inNode = fcaExtractYoutubeVideoIds(blob);
  for (const id of qu) {
    if (inNode.has(id)) return 1;
  }
  return 0;
}

/** 合併多次 ListArticles 結果（同 node.id 保留較佳 _score）。 */
function fcaMergeCofactsEdgesByNodeId(a, b) {
  const map = new Map();
  for (const e of [...(a || []), ...(b || [])]) {
    const id = e?.node?.id;
    if (!id) continue;
    const prev = map.get(id);
    const sa = Number(e?.score);
    const sp = Number(prev?.score);
    if (
      !prev ||
      (Number.isFinite(sa) && Number.isFinite(sp) && sa > sp) ||
      (!Number.isFinite(sp) && Number.isFinite(sa))
    ) {
      map.set(id, e);
    }
  }
  return [...map.values()].sort((x, y) => {
    const sx = Number(x?.score);
    const sy = Number(y?.score);
    if (Number.isFinite(sx) && Number.isFinite(sy) && sx !== sy) return sy - sx;
    if (Number.isFinite(sy) && !Number.isFinite(sx)) return 1;
    if (Number.isFinite(sx) && !Number.isFinite(sy)) return -1;
    return 0;
  });
}

/**
 * 反白與條目為**同一 YouTube 影片 id**（Cofacts 常存連結於主文）：對稿優先於字級 gate，避免 title/年份微差擋下真實查核稿。
 */
function fcaCofactsEdgeMatchesYoutubeAnchor(userQ, node) {
  if (!userQ || !node) return false;
  if (fcaCofactsYoutubeIdOverlapScore(userQ, node) !== 1) return false;
  const art = String(node.text || "");
  const replies = node.articleReplies || [];
  const replyBody = String(replies[0]?.reply?.text || "");
  if (!fcaCofactsCrossTopicOk(userQ, art, replyBody)) return false;
  if (!fcaCofactsPathogenBucketCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsDishMarkerCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsVisitDateAnchorRequiredCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsVisitVersusSurrenderRumorCompat(userQ, art, replyBody)) return false;
  return true;
}

/**
 * 以標準化影片連結補抓 Cofacts（與長標題 moreLikeThis 互補 recall），不帶 replyType 篩選。
 */
function fcaCofactsYoutubeBoostFilters(searchText) {
  const ids = [...fcaExtractYoutubeVideoIds(String(searchText || ""))].slice(
    0,
    2
  );
  if (!ids.length) return [];
  const out = [];
  for (const id of ids) {
    out.push({
      moreLikeThis: { like: `https://youtu.be/${id}`, minimumShouldMatch: "18%" }
    });
    out.push({
      moreLikeThis: {
        like: `https://www.youtube.com/watch?v=${id}`,
        minimumShouldMatch: "22%"
      }
    });
  }
  return out;
}

/**
 * 在 YouTube 觀看頁將網址併入查詢字串，Cofacts 主文常含完整 youtu.be 連結。
 */
function fcaCofactsAugmentSearchTextWithWatchUrl(searchText) {
  const q = String(searchText || "").trim();
  if (!q) return q;
  let href = "";
  try {
    href = String(window.location?.href || "").trim();
  } catch {
    return q;
  }
  if (!href) return q;
  const base = href.split("#")[0];
  const low = base.toLowerCase();
  if (
    !low.includes("youtube.com/") &&
    !low.includes("youtu.be/")
  ) {
    return q;
  }
  if (q.includes(base) || q.includes(low)) return q;
  return `${q}\n${base}`;
}

async function fcaCofactsAugmentEdgesWithYoutubeSearch(existingEdges, searchText) {
  const boosts = fcaCofactsYoutubeBoostFilters(searchText);
  if (!boosts.length) return existingEdges || [];
  let merged = [...(existingEdges || [])];
  for (const filter of boosts) {
    try {
      const r = await fcaSendMessage({
        type: "FC_COFACTS_GRAPHQL",
        query: COFACTS_LIST_ARTICLES_QUERY,
        variables: { filter },
        selectionText: "",
        skipGemini: true,
        thematicSupplementary: true
      });
      if (r?.ok && !r.json?.errors?.length) {
        merged = fcaMergeCofactsEdgesByNodeId(
          merged,
          r.json?.data?.ListArticles?.edges || []
        );
      }
    } catch (e) {
      fcaLog("Cofacts YouTube boost fetch error", e);
    }
  }
  return merged;
}

/**
 * 同次搜尋常回傳多筆「同支 YouTube、相似標題」稿，僅高分那筆可能尚無回覆。
 * 優先採「人類 articleReplies」條目（避免僅 AI 先行稿因 ES 分數較高而蓋過已有 RUMOR 等共識稿）；
 * 其次可顯示回覆、replyCount、與反白重疊、YouTube id、ES 分數。
 */
function fcaCofactsRankEdgesForPick(edges, userQ) {
  const q = String(userQ || "").trim();
  const overlapPick = (edge) => {
    const n = edge?.node;
    if (!n || !q) return 0;
    const art = String(n.text || "");
    const rep = fcaCofactsNodeReplyBodyForGates(n);
    return Math.max(
      fcaBigramOverlapRatio(q, art),
      fcaBigramOverlapRatio(q, rep)
    );
  };
  return [...edges].sort((a, b) => {
    const ha = fcaCofactsNodeHasHumanArticleReply(a.node) ? 1 : 0;
    const hb = fcaCofactsNodeHasHumanArticleReply(b.node) ? 1 : 0;
    if (ha !== hb) return hb - ha;

    const ra = fcaCofactsNodeHasDisplayableReply(a.node) ? 1 : 0;
    const rb = fcaCofactsNodeHasDisplayableReply(b.node) ? 1 : 0;
    if (ra > 0 && rb === 0) return -1;
    if (rb > 0 && ra === 0) return 1;

    const rca = Number(a?.node?.replyCount);
    const rcb = Number(b?.node?.replyCount);
    const ca = Number.isFinite(rca) ? rca : 0;
    const cb = Number.isFinite(rcb) ? rcb : 0;
    if (ca !== cb) return cb - ca;

    if (q.length >= 16) {
      const oa = overlapPick(a);
      const ob = overlapPick(b);
      if (Math.abs(oa - ob) > 0.012) return ob - oa;
    }
    if (q) {
      const yta = fcaCofactsYoutubeIdOverlapScore(q, a.node);
      const ytb = fcaCofactsYoutubeIdOverlapScore(q, b.node);
      if (yta !== ytb) return ytb - yta;
    }
    const sa = Number(a?.score);
    const sb = Number(b?.score);
    if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sb - sa;
    if (Number.isFinite(sb) && !Number.isFinite(sa)) return 1;
    if (Number.isFinite(sa) && !Number.isFinite(sb)) return -1;
    return 0;
  });
}

/** 長中文反白：除 bigram 外，至少兩段中意片語須同時出現在條目／首則回覆，壓低泛詞誤配。 */
function fcaCofactsPostPickZhAnchorsOk(userQ, node) {
  const chunks = fcaCofactsMeaningfulZhChunks(String(userQ || ""), 4, 14);
  if (chunks.length < 2) return true;
  const art = String(node?.text || "");
  const rep = fcaCofactsNodeReplyBodyForGates(node);
  const blob = `${art}\n${rep}`;
  const bn = fcaNormalizeForCofactsOverlap(blob);
  let hits = 0;
  for (const ch of chunks) {
    if (ch.length < 4) continue;
    const cn = fcaNormalizeForCofactsOverlap(ch);
    if (!cn || cn.length < 4) continue;
    if (blob.includes(ch) || bn.includes(cn)) hits++;
  }
  return hits >= 2;
}

/** 通過字級 gate 後：過低 bigram 重疊者不採用，改試下一筆候選。 */
function fcaCofactsPostPickOverlapOk(userQ, node) {
  const q = String(userQ || "").trim();
  const nlen = q.replace(/\s/g, "").length;
  if (nlen < 22 || !node) return true;
  const art = String(node.text || "");
  const rep = fcaCofactsNodeReplyBodyForGates(node);
  const r = Math.max(
    fcaBigramOverlapRatio(q, art),
    fcaBigramOverlapRatio(q, rep)
  );
  if (fcaCofactsVisitItinerarySignals(q)) {
    if (r < 0.042) return false;
  }
  if (nlen > 52 && r < 0.054) return false;
  if (nlen > 28 && r < 0.036) return false;
  if (nlen >= 24 && !fcaCofactsPostPickZhAnchorsOk(userQ, node)) return false;
  return true;
}

function fcaCofactsBuildCofactsMatchHintZh(userQ, node, thematicOnly = false) {
  if (thematicOnly) {
    return "主題相近命中：僅部分關鍵詞重合，請開啟原文確認是否同一可驗證事件。";
  }
  const art = String(node?.text || "");
  const rep = fcaCofactsNodeReplyBodyForGates(node);
  const r = Math.max(
    fcaBigramOverlapRatio(userQ, art),
    fcaBigramOverlapRatio(userQ, rep)
  );
  const pct = Math.round(r * 100);
  const visit = fcaCofactsVisitItinerarySignals(userQ);
  const anchors = fcaCofactsExtractCnMonthDayAnchors(userQ);
  if (visit && anchors.length) {
    return `已要求條目含「${anchors.slice(0, 2).join("、")}」等日期線索；反白與條目用字重疊約 ${pct}%，仍請開全文核對行程是否一致。`;
  }
  if (pct < 13) {
    return `反白與此條 Cofacts（標題＋內文＋回覆）用字重疊僅約 ${pct}%（偏低），較可能不同事件或只沾到少數字；請開條目全文確認。`;
  }
  return `反白與此條 Cofacts（標題＋內文＋回覆）用字重疊約 ${pct}%，只幫你判斷是否點錯條目；請仍開全文核對是否同一論點。`;
}

function buildCofactsListFilter(searchText, userStatus) {
  const filter = {
    moreLikeThis: {
      like: searchText,
      minimumShouldMatch: searchText.length < 10 ? "40%" : "50%"
    }
  };
  const typesByStatus = {
    Red: ["RUMOR"],
    Green: ["NOT_RUMOR"],
    Orange: ["OPINIONATED"],
    Yellow: null
  };
  const replyTypes = typesByStatus[userStatus];
  if (replyTypes) {
    filter.articleReply = { replyTypes };
  }
  return filter;
}

function cofactsReplyTypeLabel(t) {
  const map = {
    RUMOR: "含有錯誤資訊（謠言）",
    NOT_RUMOR: "不含錯誤資訊",
    OPINIONATED: "出自個人意見（易造成誤解）",
    NOT_ARTICLE: "非完整文章或無法查證"
  };
  return map[t] || (t ? String(t) : "尚無查核回應");
}

/**
 * Cofacts articleReplies[].replyType → 內部判定鍵（與五級語意色對應）。
 * RUMOR→錯誤、NOT_RUMOR→正確、OPINIONATED→事實釐清（Blue）、NOT_ARTICLE→事實釐清（Blue，非「查無事實」而是「不宜當謠言條目查核」）、未知→證據不足（Gray）。
 */
function cofactsReplyTypeToFcaStatus(t) {
  const map = {
    RUMOR: "Red",
    NOT_RUMOR: "Green",
    OPINIONATED: "Blue",
    NOT_ARTICLE: "Blue"
  };
  return map[t] || "Gray";
}

function normalizeAiCategory(c) {
  const u = String(c || "")
    .toUpperCase()
    .trim();
  if (["RUMOR", "OPINION", "FACT", "OUTDATED"].includes(u)) return u;
  return null;
}

function fcaAiCategoryToStatus(cat) {
  const c = normalizeAiCategory(cat);
  if (!c) return "Gray";
  if (c === "RUMOR") return "Red";
  if (c === "OPINION" || c === "OUTDATED") return "Blue";
  if (c === "FACT") return "Green";
  return "Gray";
}

/** 與 Gemini 回傳之 category 對齊，供比對是否與 Cofacts 標籤不符。 */
function cofactsReplyTypeToAiCategory(t) {
  if (!t) return null;
  const map = {
    RUMOR: "RUMOR",
    OPINIONATED: "OPINION",
    NOT_RUMOR: "FACT",
    NOT_ARTICLE: "NOT_ARTICLE"
  };
  return map[t] || null;
}

/**
 * 合併 background 回傳之 AI 判定（保守版）：
 * - 預設「Cofacts 社群標籤」優先，AI 只做補充說明。
 * - 僅在 Cofacts 無共識時，才允許 AI 影響顯示結論（避免 AI 過度覆蓋資料庫結果）。
 * @param {{ category: string, reason: string, confidence: number }} ai
 */
function fcaMergeAiVerdictIntoClaimReview(claimReview, ai) {
  if (!claimReview || !ai) return;
  const aiCat = normalizeAiCategory(ai.category);
  if (!aiCat) return;

  claimReview.fcaAiCategory = aiCat;
  claimReview.fcaAiReason = String(ai.reason || "")
    .trim()
    .slice(0, FCA_AI_SUMMARY_MAX_CHARS);
  let conf = Number(ai.confidence);
  if (!Number.isFinite(conf)) conf = 0;
  claimReview.fcaAiConfidence = Math.min(1, Math.max(0, conf));

  const aiStatus = fcaAiCategoryToStatus(aiCat);
  const cofStatus = cofactsReplyTypeToFcaStatus(claimReview.cofactsReplyType);
  claimReview.fcaAiSuggestedStatus = aiStatus;

  if (claimReview.cofactsNoConsensus) {
    claimReview.fcaResolvedStatus = aiStatus;
    claimReview.fcaAiOverrodeCofacts = true;
    return;
  }

  if (claimReview.fcaCofactsAiReplyOnly && !claimReview.cofactsReplyType) {
    claimReview.fcaAiDisagreedWithCofacts = false;
    claimReview.fcaAiOverrodeCofacts = false;
    claimReview.fcaResolvedStatus = "Blue";
    return;
  }

  const cofCat = cofactsReplyTypeToAiCategory(claimReview.cofactsReplyType);
  const disagree = cofCat != null && aiCat !== cofCat;
  claimReview.fcaAiDisagreedWithCofacts = disagree;
  claimReview.fcaAiOverrodeCofacts = false;
  claimReview.fcaResolvedStatus = cofStatus;
}

function fcaRatingLabelForStandaloneAi(aiCat) {
  const c = normalizeAiCategory(aiCat);
  const map = {
    RUMOR: "AI：疑為錯誤資訊（僅供參考）",
    OPINION: "AI：主觀或難客觀驗證（僅供參考）",
    FACT: "AI：傾向為可接受事實（僅供參考）",
    OUTDATED: "AI：可能已過時（僅供參考）"
  };
  return map[c] || "AI 輔助判定（僅供參考）";
}

/** 查無索引／Cofacts 時，僅依 Gemini 反白判讀產生最小 claimReview。 */
function fcaBuildSyntheticAiOnlyClaimReview(selectionText, ai) {
  const aiCat = normalizeAiCategory(ai.category);
  if (!aiCat) return null;
  let conf = Number(ai.confidence);
  if (!Number.isFinite(conf)) conf = 0;
  conf = Math.min(1, Math.max(0, conf));
  const st = fcaAiCategoryToStatus(aiCat);
  const syn = {
    publisher: { name: "Gemini AI", site: "AI 輔助（非正式查核）" },
    textualRating: fcaRatingLabelForStandaloneAi(aiCat),
    url: "",
    fcaAiCategory: aiCat,
    fcaAiReason: String(ai.reason || "")
      .trim()
      .slice(0, FCA_AI_SUMMARY_MAX_CHARS),
    fcaAiConfidence: conf,
    fcaResolvedStatus: st,
    fcaAiOverrodeCofacts: false,
    fcaStandaloneAiOnly: true,
    articleText: String(selectionText || "").trim().slice(0, 800)
  };
  return syn;
}

/**
 * 查無索引／Cofacts 且 Gemini 失敗或回傳無法合成 claimReview 時，仍產生最小物件供側欄顯示「AI 摘要」與錯誤狀態。
 * @param {object|null} air FC_AI_STANDALONE 回傳
 * @param {{ category?: string, reason?: string }|null} aiStandalone
 */
function fcaBuildGeminiOnlyUiShell(air, aiStandalone, selectionText = "") {
  const base = {
    publisher: { name: "—", site: "" },
    textualRating: "目前無法證實",
    url: "",
    fcaStandaloneAiOnly: true,
    fcaResolvedStatus: "Gray",
    fcaAiReason: "",
    fcaAiCategory: "AI",
    articleText: String(selectionText || "").trim().slice(0, 800)
  };
  if (air) {
    if (air.geminiQuotaExceeded) base.fcaGeminiQuotaExceeded = true;
    if (air.geminiKeyInvalid) base.fcaGeminiKeyInvalid = true;
    const gh = Number(air.geminiHttpStatus) || 0;
    if (gh > 0) {
      base.fcaGeminiHttpStatus = gh;
      base.fcaGeminiErrHint = String(air.geminiErrHint || "").trim().slice(0, 260);
    } else if (String(air.error || "").trim()) {
      base.fcaGeminiErrHint = String(air.error || "").trim().slice(0, 260);
    }
  }
  if (aiStandalone) {
    base.fcaAiReason = String(aiStandalone.reason || "")
      .trim()
      .slice(0, FCA_AI_SUMMARY_MAX_CHARS);
    const cat = normalizeAiCategory(aiStandalone.category);
    if (cat) {
      base.fcaAiCategory = cat;
      base.fcaResolvedStatus = fcaAiCategoryToStatus(cat);
      base.textualRating = fcaRatingLabelForStandaloneAi(cat);
    }
  }
  return base;
}

/**
 * 多機構索引命中（非 Cofacts）時，將獨立 AI 判讀併入（保守版）：
 * - 預設「索引四色」優先，AI 僅補充。
 * - 只有在「查無資料需要合成」時才以 AI 當結論（該情況由 fcaBuildSyntheticAiOnlyClaimReview 處理）。
 */
function fcaMergeStandaloneAiWithIndexClaim(claimReview, indexStatus, ai) {
  if (!claimReview || !ai) return;
  const aiCat = normalizeAiCategory(ai.category);
  if (!aiCat) return;
  if (claimReview.fcaAiReason) return;

  claimReview.fcaAiCategory = aiCat;
  claimReview.fcaAiReason = String(ai.reason || "")
    .trim()
    .slice(0, FCA_AI_SUMMARY_MAX_CHARS);
  let conf = Number(ai.confidence);
  if (!Number.isFinite(conf)) conf = 0;
  claimReview.fcaAiConfidence = Math.min(1, Math.max(0, conf));

  const aiSt = fcaAiCategoryToStatus(aiCat);
  const idx = fcaNormalizeLegacyYellowStatus(indexStatus);
  const base =
    idx === "Red" ||
    idx === "Orange" ||
    idx === "Green" ||
    idx === "Gray" ||
    idx === "Blue"
      ? idx
      : "Gray";
  claimReview.fcaAiSuggestedStatus = aiSt;
  claimReview.fcaAiDisagreedWithCofacts = aiSt !== base;
  claimReview.fcaAiOverrodeCofacts = false;
  claimReview.fcaResolvedStatus = base;
}

/**
 * 在查核 API 結果之上套用「反白專用」AI：查無資料時建立合成結果；有資料且尚未有 AI 理由時再合併。
 * @returns {{ claimReview: object|null, finalStatus: string, fetchError: string }}
 */
async function fcaEnrichWithStandaloneAi(textSnapshot, {
  claimReview,
  finalStatus,
  fetchError,
  fixedUserStatus,
  articleContext = ""
}) {
  let cr = claimReview;
  let fs = finalStatus;
  let err = fetchError || "";

  if (fixedUserStatus) {
    return { claimReview: cr, finalStatus: fs, fetchError: err };
  }

  const { fcaSkipGemini: skipAi } = await fcaGetExtensionLocalOpts();
  if (skipAi) {
    return { claimReview: cr, finalStatus: fs, fetchError: err };
  }

  if (cr?.fcaAiReason) {
    return { claimReview: cr, finalStatus: fs, fetchError: err };
  }
  if (FCA_AI_BUDGET_FRIENDLY && cr) {
    const needsAiFallback =
      cr.cofactsNoConsensus === true ||
      cr.fcaNoDirectCofactsMatch === true ||
      (!cr.fcaCofacts && !cr.fcaIndexCorpus);
    if (!needsAiFallback) {
      return { claimReview: cr, finalStatus: fs, fetchError: err };
    }
  }

  // 背景／前段已回 429、配額或金鑰無效：勿再送 FC_AI_STANDALONE，避免同一筆查核重複打 Gemini。
  if (
    cr &&
    (cr.fcaGeminiQuotaExceeded === true ||
      cr.fcaGeminiKeyInvalid === true ||
      Number(cr.fcaGeminiHttpStatus) === 429)
  ) {
    return { claimReview: cr, finalStatus: fs, fetchError: err };
  }

  let aiStandalone = null;
  let air = null;
  try {
    air = await fcaSendMessage({
      type: "FC_AI_STANDALONE",
      text: textSnapshot,
      articleContext: String(articleContext || "").trim().slice(0, 4500)
    });
    if (air?.ok && air.ai) aiStandalone = air.ai;
    if (air?.geminiQuotaExceeded && cr) cr.fcaGeminiQuotaExceeded = true;
    if (air?.geminiKeyInvalid && cr) cr.fcaGeminiKeyInvalid = true;
    if (cr && Number(air?.geminiHttpStatus) > 0) {
      cr.fcaGeminiHttpStatus = Number(air.geminiHttpStatus) || 0;
      cr.fcaGeminiErrHint = String(air.geminiErrHint || "").trim().slice(0, 260);
    } else if (cr && !aiStandalone && air?.error) {
      cr.fcaGeminiErrHint = String(air.error || "").trim().slice(0, 260);
    }
  } catch (e) {
    fcaLog("FC_AI_STANDALONE", e);
  }

  const syn = () => fcaBuildSyntheticAiOnlyClaimReview(textSnapshot, aiStandalone);

  if (!aiStandalone) {
    if (!cr && air) {
      cr = fcaBuildGeminiOnlyUiShell(air, null, textSnapshot);
    }
    return { claimReview: cr, finalStatus: fs, fetchError: err };
  }

  if (err && !cr) {
    const built = syn();
    if (built) {
      return { claimReview: built, finalStatus: built.fcaResolvedStatus || fs, fetchError: "" };
    }
    cr = fcaBuildGeminiOnlyUiShell(air, aiStandalone, textSnapshot);
    return { claimReview: cr, finalStatus: cr.fcaResolvedStatus || fs, fetchError: err };
  }

  if (!err) {
    if (!cr) {
      const built = syn();
      if (built) {
        return { claimReview: built, finalStatus: built.fcaResolvedStatus || fs, fetchError: err };
      }
      cr = fcaBuildGeminiOnlyUiShell(air, aiStandalone, textSnapshot);
      return { claimReview: cr, finalStatus: cr.fcaResolvedStatus || fs, fetchError: err };
    } else if (!cr.fcaAiReason) {
      if (cr.fcaCofacts) {
        fcaMergeAiVerdictIntoClaimReview(cr, aiStandalone);
        fs =
          cr.fcaResolvedStatus || cofactsReplyTypeToFcaStatus(cr.cofactsReplyType);
      } else {
        fcaMergeStandaloneAiWithIndexClaim(cr, fs, aiStandalone);
        fs = cr.fcaResolvedStatus || fs;
      }
    }
  }

  return { claimReview: cr, finalStatus: fs, fetchError: err };
}

function fcaNormalizeForCofactsOverlap(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\n\r！!？?，,。.、；;：:「」『』【】《》()（）\[\]'"｜|]+/g, "");
}

/** 英文以「兩字元 bigram」估重疊時，`in`/`an`/`es` 等極易誤命中無關稿，改以較長字詞判定。 */
const FCA_LATIN_GENERIC_WORD = new Set(
  `the and for are but not you all any can had her was one our out has his how its may new now old see who get use way let put say too did she man day more this that with from have been they were will would could should other than when what which their there such into about after again also back before being below between both came come does done down even ever every first found gave give goes going gone good great still made make many might most much must same seem seen shall should since take them then these those though three through today together under until very were where while within without yours your year years week world work well just like last long only over some very here long`.split(
    /\s+/
  )
);

const FCA_RE_TAIWAN_ISSUE =
  /台灣|臺灣|賴清德|蔡英文|疑美論|\bTaiwan\b|\bTaipei\b/i;
const FCA_RE_UKRAINE =
  /\bzelensky\b|\bukraine\b|\bkyiv\b|\bukrainian\b/i;
const FCA_RE_GAZA_HAMAS_SEL = /\bgaza\b|\bhamas\b/;
const FCA_RE_IRAN = /\biran\b/;
const FCA_RE_ISRAELI = /\bisraeli\b/;

/** 短稿英文詞袋快取（Cofacts 比對內層迴圈重複命中同一 corpus）。 */
const FCA_LATIN_WORD_SET_MAX = 96;
/** @type {Map<string, Set<string>>} */
const fcaLatinWordSetCache = new Map();

function fcaSelectionLooksMostlyLatin(text) {
  const t = String(text || "");
  const lat = (t.match(/[a-zA-Z]/g) || []).length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return lat >= 14 && lat >= cjk * 2 + 2;
}

function fcaLatinWordSetFromBlob(blob) {
  const lower = String(blob || "").toLowerCase();
  if (!lower.length) return new Set();
  if (lower.length <= 640) {
    let set = fcaLatinWordSetCache.get(lower);
    if (set) return set;
    const words = lower.match(/[a-z]{3,}/g) || [];
    set = new Set(words);
    if (fcaLatinWordSetCache.size >= FCA_LATIN_WORD_SET_MAX) {
      const k = fcaLatinWordSetCache.keys().next().value;
      fcaLatinWordSetCache.delete(k);
    }
    fcaLatinWordSetCache.set(lower, set);
    return set;
  }
  return new Set(lower.match(/[a-z]{3,}/g) || []);
}

const FCA_MEANINGFUL_TOKEN_CACHE_MAX = 48;
/** @type {Map<string, string[]>} */
const fcaMeaningfulTokenCache = new Map();

/** 取查詢中較有辨識度的英文片段（≥5 字元且非泛用字），用於排除與主題無關的 Cofacts 命中。 */
function fcaMeaningfulLatinTokens(userQuery) {
  const lower = String(userQuery || "").toLowerCase();
  if (lower.length > 0 && lower.length <= 360) {
    const hit = fcaMeaningfulTokenCache.get(lower);
    if (hit) return hit;
  }
  const raw = lower.match(/[a-z]{5,}/g) || [];
  const out = [];
  for (const w of raw) {
    if (FCA_LATIN_GENERIC_WORD.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  const result = out.slice(0, 24);
  if (lower.length > 0 && lower.length <= 360) {
    if (fcaMeaningfulTokenCache.size >= FCA_MEANINGFUL_TOKEN_CACHE_MAX) {
      const k = fcaMeaningfulTokenCache.keys().next().value;
      fcaMeaningfulTokenCache.delete(k);
    }
    fcaMeaningfulTokenCache.set(lower, result);
  }
  return result;
}

function fcaLatinMeaningfulHitsInArticle(userQuery, articleText) {
  const meaningful = fcaMeaningfulLatinTokens(userQuery);
  if (!meaningful.length) return null;
  const art = fcaLatinWordSetFromBlob(articleText);
  let hits = 0;
  for (const tok of meaningful) {
    if (art.has(tok)) hits++;
  }
  let need =
    meaningful.length >= 2 ? 2 : meaningful[0].length >= 8 ? 1 : 2;
  if (meaningful.length >= 6) {
    need = 3;
  } else if (meaningful.length >= 4) {
    need = Math.max(need, 2);
  }
  return { hits, need };
}

function fcaBlobTaiwanIssueSignals(blob) {
  return FCA_RE_TAIWAN_ISSUE.test(String(blob || ""));
}

function fcaBlobUkraineSignals(blob) {
  return FCA_RE_UKRAINE.test(String(blob || ""));
}

function fcaBlobMideastIranSignals(blob) {
  const raw = String(blob || "");
  const s = raw.toLowerCase();
  const sw = fcaLatinWordSetFromBlob(blob);
  if (/伊朗|荷姆茲|霍爾木茲|波斯灣|美伊|以伊/.test(raw)) {
    return true;
  }
  if (sw.has("iran") || sw.has("iranian") || sw.has("tehran") || sw.has("hormuz")) {
    return true;
  }
  if (
    (s.includes("ceasefire") || s.includes("cease fire")) &&
    (FCA_RE_IRAN.test(s) || sw.has("iranian") || s.includes("hormuz"))
  ) {
    return true;
  }
  if (FCA_RE_ISRAELI.test(s) && FCA_RE_IRAN.test(s)) return true;
  return false;
}

/**
 * 英文語境下「海峽／能源外交」常見搭配（例：blockade the strait、reopened），
 * 未必出現 Iran／Hormuz 字面，但仍不應連到無海峽敘述之中國論壇／人物稿。
 */
function fcaStraitEnergyEnglishSignals(text) {
  const low = String(text || "").toLowerCase();
  if (!/\bstrait\b/.test(low)) return false;
  return (
    /\bblockad/i.test(low) ||
    /\breopen/i.test(low) ||
    /\bhormuz\b/.test(low) ||
    /\biran\b/.test(low) ||
    /\btanker\b/.test(low) ||
    (/\boil\b/.test(low) && /\bstrait\b/.test(low))
  );
}

/** 習近平／馬凱碩／KAS 等「中國國際論述」類 Cofacts 常見主軸，與荷姆茲封鎖英文反白易因 Trump 等泛詞誤配。 */
function fcaBlobChinaLeadershipGeopoliticsSignals(blob) {
  const raw = String(blob || "");
  if (!raw.trim()) return false;
  const low = raw.toLowerCase();
  if (/習近平|习近平/.test(raw)) return true;
  if (/xi\s*jinping/i.test(low)) return true;
  if (/馬凱碩|马凯硕|mahbubani|kishore/.test(low)) return true;
  if (/konrad[\s_-]*adenauer|adenauer[\s_-]*stiftung/i.test(low)) return true;
  if (/shifting\s+world|中國角色|中国角色|china'?s\s+role/i.test(low)) return true;
  return false;
}

/** 荷姆茲海峽／Strait of Hormuz 等辨識度高錨點（避免僅「Trump／Iran」泛詞讓台灣稿通過中東 gate）。 */
function fcaCofactsStrongHormuzStraitSignals(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  const low = raw.toLowerCase();
  if (/\bhormuz\b/.test(low)) return true;
  if (/strait\s+of\s+hormuz/.test(low)) return true;
  if (/\bstrait\b/.test(low) && /\bblockad/i.test(low)) return true;
  if (/\bstrait\b/.test(low) && /\breopen/i.test(low)) return true;
  if (/荷姆茲|霍爾木茲|霍爾木兹|霍爾木茲海峽|霍爾木兹海峡|荷姆茲海峽|荷姆茲海峡/.test(raw)) {
    return true;
  }
  return false;
}

/**
 * Cofacts 向量搜尋常命中「字疊但主題不同」的稿（例：CNN 伊朗戰事 vs 台灣政論謠言，皆含 Trump／總統等字）。
 */
function fcaCofactsCrossTopicOk(sel, articleText, replyText) {
  const blob = `${articleText}\n${replyText}`;
  const twC = fcaBlobTaiwanIssueSignals(blob);
  const twS = fcaBlobTaiwanIssueSignals(sel);
  const midC = fcaBlobMideastIranSignals(blob);
  const midS =
    fcaBlobMideastIranSignals(sel) ||
    (fcaSelectionLooksMostlyLatin(sel) && fcaStraitEnergyEnglishSignals(sel));
  const ukC = fcaBlobUkraineSignals(blob);
  const ukS = fcaBlobUkraineSignals(sel);
  const cnC = fcaBlobChinaLeadershipGeopoliticsSignals(blob);
  const cnS = fcaBlobChinaLeadershipGeopoliticsSignals(sel);

  if (midS && twC && !twS && !midC) return false;
  if (midS && cnC && !cnS && !midC) return false;
  if (twS && midC && !midS && !twC) return false;
  if (ukS && twC && !twS && !ukC) return false;
  if (twS && ukC && !ukS && !twC) return false;
  return true;
}

/**
 * 英文反白為主、Cofacts 條目／回覆以中文為主時：反白若帶明顯地緣錨點，條目側必須出現對應訊號，
 * 避免僅因 trump／china 等泛英文詞誤連到台灣政治類謠言稿。
 */
function fcaCofactsLatinVsZhCorpusGeoAnchorOk(sel, articleText, replyText) {
  if (!fcaSelectionLooksMostlyLatin(sel)) return true;
  const blob = `${articleText}\n${replyText}`;
  if (
    fcaCofactsStrongHormuzStraitSignals(sel) &&
    fcaBlobTaiwanIssueSignals(blob) &&
    !fcaBlobTaiwanIssueSignals(sel) &&
    !fcaCofactsStrongHormuzStraitSignals(blob)
  ) {
    return false;
  }
  if (
    fcaStraitEnergyEnglishSignals(sel) &&
    fcaBlobChinaLeadershipGeopoliticsSignals(blob) &&
    !fcaBlobChinaLeadershipGeopoliticsSignals(sel) &&
    !fcaBlobMideastIranSignals(blob) &&
    !fcaCofactsStrongHormuzStraitSignals(blob)
  ) {
    return false;
  }
  const cjk = (blob.match(/[\u4e00-\u9fff]/g) || []).length;
  const latB = (blob.match(/[a-zA-Z]/g) || []).length;
  const twBlob = fcaBlobTaiwanIssueSignals(blob);
  const twSel = fcaBlobTaiwanIssueSignals(sel);
  // 英文反白卻命中「台灣政治／人物」類中文稿：不可僅因條目內英引文多就放行（先前 latB 門檻會略過此檢查）。
  if (twBlob && !twSel && cjk >= 8) {
    return false;
  }
  if (cjk < 28 || latB >= cjk * 0.45) return true;
  if (twBlob && !twSel) return false;
  if (fcaBlobMideastIranSignals(sel) && !fcaBlobMideastIranSignals(blob)) return false;
  if (fcaBlobUkraineSignals(sel) && !fcaBlobUkraineSignals(blob)) return false;
  return true;
}

/** 常見食媒／傳染病病原：反白與條目分屬不同桶時不連稿（例：沙門 vs 李斯特）。 */
const FCA_COFACTS_PATHOGEN_MARKERS = [
  { id: "salmonella", re: /沙門氏菌|沙門氏桿菌|沙門菌|salmonella|傷寒桿菌/i },
  { id: "listeria", re: /李斯特菌|李斯特桿菌|listeria|李斯特症/i },
  { id: "norovirus", re: /諾羅病毒|諾羅|諾瓦克|norovirus/i },
  { id: "e_coli", re: /大腸桿菌|大腸菌|e\.?\s*coli|o157|腸出血性/i },
  { id: "staph", re: /金黃色葡萄球菌|staphylococcus|\bstaph\b/i },
  { id: "campylobacter", re: /曲狀桿菌|曲状杆菌|campylobacter/i },
  { id: "botulism", re: /肉毒桿菌|肉毒杆菌|botulism|botulinum/i },
  { id: "hepatitis_a", re: /a型肝炎|Ａ型肝炎|A肝|甲肝|hepatitis\s*a/i },
  { id: "covid", re: /新冠病毒|新冠肺炎|covid|武漢肺炎/i },
  { id: "cholera", re: /霍亂|cholera/i },
  { id: "shigella", re: /志賀氏菌|志贺氏菌|痢疾|shigella/i },
  { id: "rotavirus", re: /輪狀病毒|轮状病毒|rotavirus/i },
  { id: "enterovirus", re: /腸病毒|肠病毒|enterovirus|手足口病/i }
];

function fcaCofactsPathogenIdsInText(blob) {
  const s = String(blob || "");
  const ids = new Set();
  for (const { id, re } of FCA_COFACTS_PATHOGEN_MARKERS) {
    if (re.test(s)) ids.add(id);
  }
  return ids;
}

/**
 * 反白已指涉具體病原、條目／回覆亦指涉具體病原時，須至少一類重合才採用。
 * 若條目未出現任何列表病原，維持放行（交由字重疊與其他 gate）。
 */
function fcaCofactsPathogenBucketCompat(sel, articleText, replyText) {
  const u = fcaCofactsPathogenIdsInText(sel);
  if (!u.size) return true;
  const corp = fcaCofactsPathogenIdsInText(`${articleText}\n${replyText}`);
  if (!corp.size) return true;
  for (const id of u) {
    if (corp.has(id)) return true;
  }
  return false;
}

/** 具名餐點／品項：反白有提及則條目正文或回覆須同字，避免「春捲」配到「滑蛋蝦仁飯」。 */
const FCA_COFACTS_DISH_MARKERS = [
  "滑蛋蝦仁飯",
  "蝦仁飯",
  "春捲",
  "金針菇",
  "臭豆腐",
  "蛋餅",
  "刈包",
  "割包",
  "肉粽",
  "飯糰",
  "潤餅",
  "鹹酥雞",
  "雞排",
  "滷肉飯",
  "牛肉麵",
  "滑蛋",
  "寶林茶室",
  "涼麵",
  "米糕",
  "粿條",
  "自助餐",
  "吃到飽"
];

/** 連鎖通路／大型通路名：反白有提則條文須同址，避免不同分店／品牌誤配。 */
const FCA_COFACTS_VENUE_MARKERS = [
  "全聯福利中心",
  "丁丁連鎖藥局",
  "全聯",
  "家樂福",
  "好市多",
  "Costco",
  "costco",
  "大潤發",
  "愛買",
  "美廉社",
  "寶雅",
  "屈臣氏",
  "康是美",
  "沃爾瑪",
  "IKEA",
  "ikea"
];

function fcaCofactsDishMarkerCompat(sel, articleText, replyText) {
  const corp = `${articleText}\n${replyText}`;
  const cn = fcaNormalizeForCofactsOverlap(corp);
  const sn = String(sel || "");
  for (const m of FCA_COFACTS_DISH_MARKERS) {
    if (!m || !sn.includes(m)) continue;
    const mn = fcaNormalizeForCofactsOverlap(m);
    if (!corp.includes(m) && !cn.includes(mn)) return false;
  }
  return true;
}

function fcaCofactsVenueMarkerCompat(sel, articleText, replyText) {
  const cn = fcaNormalizeForCofactsOverlap(`${articleText}\n${replyText}`);
  const selN = fcaNormalizeForCofactsOverlap(sel);
  if (selN.length < 2 || cn.length < 2) return true;
  for (const m of FCA_COFACTS_VENUE_MARKERS) {
    const mn = fcaNormalizeForCofactsOverlap(m);
    if (mn.length < 2 || !selN.includes(mn)) continue;
    if (!cn.includes(mn)) return false;
  }
  return true;
}

function fcaCofactsExtractYearSet(blob) {
  const set = new Set();
  for (const y of String(blob || "").match(/\b(?:19|20)\d{2}\b/g) || []) {
    set.add(y);
  }
  return set;
}

/**
 * 反白與條目皆含四位西元年且互不交疊時，視為不同時間軸稿件（精準度優先）。
 */
function fcaCofactsYearAnchorCompat(sel, articleText, replyText) {
  const ys = fcaCofactsExtractYearSet(sel);
  if (!ys.size) return true;
  const yc = fcaCofactsExtractYearSet(`${articleText}\n${replyText}`);
  if (!yc.size) return true;
  for (const y of ys) {
    if (yc.has(y)) return true;
  }
  return false;
}

/** 全形數字轉半形，避免「４月７日」抽不出錨點。 */
function fcaCofactsNormalizeFullwidthDigits(s) {
  return String(s || "").replace(/[\uFF10-\uFF19]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

/** 自反白抽出「月／日」錨點（含 X月Y日至Z日、4/7），供與條目比對是否同一則行程敘述。 */
function fcaCofactsExtractCnMonthDayAnchors(text) {
  const s = fcaCofactsNormalizeFullwidthDigits(String(text || ""));
  const set = new Set();
  let m;
  const rSpan = /(\d{1,2})\s*月\s*(\d{1,2})\s*日至\s*(\d{1,2})\s*日/g;
  while ((m = rSpan.exec(s)) !== null) {
    set.add(`${m[1]}月${m[2]}日`);
    set.add(`${m[1]}月${m[3]}日`);
    set.add(`${m[1]}月${m[2]}`);
    set.add(`${m[1]}月${m[3]}`);
  }
  const rSingle = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  while ((m = rSingle.exec(s)) !== null) {
    set.add(`${m[1]}月${m[2]}日`);
    set.add(`${m[1]}月${m[2]}`);
  }
  const rSlash = /(\d{1,2})\/(\d{1,2})(?:\s*[-–~～]\s*(\d{1,2})\/(\d{1,2}))?/g;
  while ((m = rSlash.exec(s)) !== null) {
    set.add(`${m[1]}/${m[2]}`);
    set.add(`${m[1]}月${m[2]}日`);
    set.add(`${m[1]}月${m[2]}`);
    if (m[3] && m[4]) {
      set.add(`${m[3]}/${m[4]}`);
      set.add(`${m[1]}月${m[4]}日`);
      set.add(`${m[1]}月${m[4]}`);
    }
  }
  return [...set].filter(Boolean);
}

/** 反白像「官方／受邀出訪、行程」敘述（與網傳投降談判類謠言區隔）。 */
function fcaCofactsVisitItinerarySignals(sel) {
  const t = fcaCofactsNormalizeFullwidthDigits(String(sel || "")).trim();
  if (!t) return false;
  if (/訪問中國|訪問大陸|訪中國|赴陸|赴大陸/.test(t)) return true;
  if (/率團.*訪|訪問行程|出訪/.test(t)) return true;
  if (/應.*邀請.{0,24}訪|受邀.{0,16}訪/.test(t)) return true;
  if (/\d{1,2}\s*月\s*\d{1,2}\s*日?\s*至[^訪]{0,18}訪/.test(t)) return true;
  if (/應.*邀/.test(t) && /\d{1,2}\s*月/.test(t) && /訪問中國|訪問大陸|訪中國|訪中|赴陸|出訪/.test(t)) {
    return true;
  }
  if (/(國民黨|民進黨).{0,10}主席/.test(t) && /\d{1,2}\s*月\s*\d{1,2}/.test(t) && /訪/.test(t)) {
    return true;
  }
  return false;
}

/**
 * 條目／回覆為「鄭麗文＋明年赴京＋投降／統一協議」類網傳謠言稿（與真實出訪日期稿易共用人物名）。
 */
function fcaCofactsStraitSurrenderNegotiationRumorSignals(blob) {
  const t = fcaCofactsNormalizeFullwidthDigits(String(blob || "")).replace(/\s/g, "");
  if (!t) return false;
  if (/投降.{0,5}統一|統一.{0,5}協議|談投降|投降協議|降共/.test(t)) return true;
  if (
    /(?:北京|赴京|中南海).{0,18}習近平.{0,22}(談|商談|會談).{0,14}(投降|統一|協議)/.test(
      t
    )
  ) {
    return true;
  }
  if (/鄭麗文.{0,40}宣布.{0,20}(?:明年|翌年).{0,36}(?:北京|習近平).{0,40}(?:投降|統一)/.test(t)) {
    return true;
  }
  if (
    /宣布.{0,14}(?:明年|上半年|下半年).{0,28}(?:北京|習近平).{0,36}(?:投降|統一協議)/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /(?:國民黨|黨主席).{0,24}(?:明年|翌年|上半年|下半年).{0,40}(?:北京|赴京).{0,36}(?:投降|統一|協議|賣台)/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/**
 * 出訪行程且反白含月日錨點時：條目／索引內文須出現至少一個錨點（共用於 Cofacts gate 與國際索引）。
 */
function fcaCofactsSelectionMonthAnchorsSatisfiedByBlob(sel, blob) {
  if (!fcaCofactsVisitItinerarySignals(sel)) return true;
  const anchors = fcaCofactsExtractCnMonthDayAnchors(sel);
  if (!anchors.length) return true;
  const blob0 = String(blob || "");
  const b = fcaCofactsNormalizeFullwidthDigits(blob0);
  const corpN = fcaNormalizeForCofactsOverlap(blob0);
  for (const a of anchors) {
    if (!a) continue;
    const an = fcaNormalizeForCofactsOverlap(a);
    if (b.includes(a) || (an.length >= 2 && corpN.includes(an))) return true;
  }
  return false;
}

/**
 * 反白為出訪行程且含具體月／日：條目正文或回覆須至少出現一個相同錨點（阻擋僅人名重疊的不同事件稿）。
 */
function fcaCofactsVisitDateAnchorRequiredCompat(sel, articleText, replyText) {
  return fcaCofactsSelectionMonthAnchorsSatisfiedByBlob(
    sel,
    `${articleText}\n${replyText}`
  );
}

/**
 * 反白為具體出訪行程、條目卻為「投降／統一協議」類謠言且未出現相同月日錨點 → 視為誤配。
 */
function fcaCofactsVisitVersusSurrenderRumorCompat(sel, articleText, replyText) {
  if (!fcaCofactsVisitItinerarySignals(sel)) return true;
  const blob = `${articleText}\n${replyText}`;
  if (!fcaCofactsStraitSurrenderNegotiationRumorSignals(blob)) return true;
  const anchors = fcaCofactsExtractCnMonthDayAnchors(sel);
  const corpN = fcaNormalizeForCofactsOverlap(blob);
  for (const a of anchors) {
    const an = fcaNormalizeForCofactsOverlap(a);
    if (an.length >= 3 && (blob.includes(a) || corpN.includes(an))) return true;
  }
  if (anchors.length) return false;
  if (
    /\d{1,2}\s*月\s*\d{1,2}/.test(sel) &&
    !/明年|翌年|上半年|下半年/.test(String(sel)) &&
    /明年|上半年|下半年/.test(blob)
  ) {
    return false;
  }
  return true;
}

/** 四字窗口若以泛語開頭則不當「事件錨點」（主題相近用）。 */
function fcaCofactsSlidingFourIsWeak(sub) {
  if (sub.length !== 4) return true;
  if (FCA_COFACTS_THEMATIC_GENERIC.test(sub)) return true;
  const weakStarts = [
    "除了",
    "知道",
    "可能",
    "造成",
    "感染",
    "事件",
    "食物",
    "中毒",
    "早安",
    "大家",
    "這樣",
    "如果",
    "所以",
    "目前",
    "建議",
    "注意",
    "提醒",
    "真的",
    "是否",
    "網傳",
    "報導",
    "有驗",
    "驗出",
    "查出",
    "血管",
    "破裂",
    "上吐",
    "下瀉",
    "已知",
    "據稱"
  ];
  for (const w of weakStarts) {
    if (sub.startsWith(w)) return true;
  }
  return false;
}

/**
 * 主題相近：反白各分句內滑動四字中，凡屬「非泛語」窗口至少須有一個完整出現在條目／回覆（同地不同案時常只剩地名能對上）。
 */
function fcaCofactsThematicSubstantiveFourGate(sel, articleText, replyText) {
  const corp = `${articleText}\n${replyText}`;
  const cn = fcaNormalizeForCofactsOverlap(corp);
  const clauses = String(sel || "")
    .split(/[，。！？、；：\s~～]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const seen = new Set();
  const candidates = [];
  for (const cl of clauses) {
    const only = cl.replace(/[^\u4e00-\u9fff]/g, "");
    if (only.length < 4) continue;
    for (let i = 0; i + 4 <= only.length; i++) {
      const sub = only.slice(i, i + 4);
      if (fcaCofactsSlidingFourIsWeak(sub)) continue;
      if (seen.has(sub)) continue;
      seen.add(sub);
      candidates.push(sub);
    }
  }
  if (!candidates.length) return true;
  for (const sub of candidates) {
    const subn = fcaNormalizeForCofactsOverlap(sub);
    if (cn.includes(subn) || corp.includes(sub)) return true;
  }
  return false;
}

/** 滑動三字錨點：開頭兩字常為行政／媒體套語者不當錨點（精確配對用）。 */
const FCA_COFACTS_TRIGRAM_WEAK2 = new Set([
  "目前", "相關", "單位", "政府", "網傳", "報導", "訊息", "消息", "記者", "媒體",
  "呼籲", "提醒", "指出", "表示", "說明", "公告", "聲明", "據稱", "經過", "由於",
  "雖然", "但是", "然而", "因此", "所以", "如果", "當時", "今日", "昨日", "近日",
  "明天", "今年", "去年",   "本月", "上月"
]);

function fcaCofactsSlidingThreeIsWeak(sub) {
  if (sub.length !== 3) return true;
  return FCA_COFACTS_TRIGRAM_WEAK2.has(sub.slice(0, 2));
}

/**
 * 精確配對：反白夠長時至少須有一個「非套語」三字組出現在條目／回覆，避免僅靠地名＋中毒等新聞詞誤連稿。
 */
function fcaCofactsSubstantiveTrigramGate(sel, articleText, replyText) {
  const only = String(sel || "").replace(/[^\u4e00-\u9fff]/g, "");
  if (only.length < 8) return true;
  const corp = `${articleText}\n${replyText}`;
  const cn = fcaNormalizeForCofactsOverlap(corp);
  const seen = new Set();
  const candidates = [];
  for (let i = 0; i + 3 <= only.length; i++) {
    const sub = only.slice(i, i + 3);
    if (seen.has(sub)) continue;
    seen.add(sub);
    if (fcaCofactsSlidingThreeIsWeak(sub)) continue;
    candidates.push(sub);
  }
  if (!candidates.length) return true;
  for (const sub of candidates) {
    const subn = fcaNormalizeForCofactsOverlap(sub);
    if (cn.includes(subn) || corp.includes(sub)) return true;
  }
  return false;
}

/**
 * 短中文反白（如「台灣雲豹」）容易被「台灣」等泛詞帶偏；
 * 要求條目至少命中 3-4 字錨點，避免只靠二字重疊誤配。
 * @returns {boolean|null} true=確定命中錨點；false=確定不命中；null=不適用此規則
 */
function fcaCofactsShortZhAnchorHit(userQuery, articleText) {
  const qzh = String(userQuery || "").replace(/[^\u4e00-\u9fff]/g, "");
  if (qzh.length < 4 || qzh.length > 8) return null;
  const azh = fcaNormalizeForCofactsOverlap(articleText).replace(/[^\u4e00-\u9fff]/g, "");
  if (!azh.length) return false;
  if (azh.includes(qzh)) return true;

  let sawStrong = false;
  for (let i = 0; i + 4 <= qzh.length; i++) {
    const sub4 = qzh.slice(i, i + 4);
    if (azh.includes(sub4)) return true;
    sawStrong = true;
  }
  for (let i = 0; i + 3 <= qzh.length; i++) {
    const sub3 = qzh.slice(i, i + 3);
    if (fcaCofactsSlidingThreeIsWeak(sub3)) continue;
    sawStrong = true;
    if (azh.includes(sub3)) return true;
  }
  return sawStrong ? false : null;
}

/**
 * 若回傳文章全文與使用者查詢幾乎無字詞重疊，多為無關搜尋命中；視為無結果以免誤判。
 */
function fcaCofactsArticleMatchesUserQuery(userQuery, articleText) {
  const q = fcaNormalizeForCofactsOverlap(userQuery);
  const a = fcaNormalizeForCofactsOverlap(articleText);
  if (q.length < 2 || a.length < 2) return false;
  if (a.includes(q)) return true;
  const shortZhAnchor = fcaCofactsShortZhAnchorHit(userQuery, articleText);
  if (shortZhAnchor === true) return true;
  if (shortZhAnchor === false) return false;

  if (fcaSelectionLooksMostlyLatin(userQuery)) {
    const wordRel = fcaLatinMeaningfulHitsInArticle(userQuery, articleText);
    if (wordRel) {
      return wordRel.hits >= wordRel.need;
    }
    let b = 0;
    for (let i = 0; i < q.length - 1; i++) {
      if (a.includes(q.slice(i, i + 2))) b++;
    }
    const bigrams = Math.max(1, q.length - 1);
    const minRatio = q.length > 40 ? 0.24 : q.length > 22 ? 0.2 : 0.18;
    const minHits = q.length > 45 ? 10 : q.length > 28 ? 7 : 5;
    return b >= minHits && b / bigrams >= minRatio;
  }

  let hits = 0;
  for (let i = 0; i < q.length - 1; i++) {
    if (a.includes(q.slice(i, i + 2))) hits++;
  }
  const bigrams = Math.max(1, q.length - 1);
  if (q.length <= 4) {
    return hits >= 1 && hits / bigrams >= 0.4;
  }
  if (q.length <= 12) {
    const ratio = hits / bigrams;
    if (q.length >= 8) {
      return hits >= 3 || (hits >= 2 && ratio >= 0.36);
    }
    return hits >= 2;
  }
  const ratio = hits / bigrams;
  if (q.length > 22) {
    return hits >= 4 && ratio >= 0.155;
  }
  if (q.length > 14) {
    return hits >= 4 || (hits >= 3 && ratio >= 0.165);
  }
  return hits >= 3 && ratio >= 0.145;
}

/** 使用者查詢是否與文章本文或首則查核回覆內文有足够字詞重疊 */
function fcaCofactsEdgeMatchesUserQuery(userQ, node) {
  if (!userQ || !node) return false;
  const art = String(node.text || "");
  const replies = node.articleReplies || [];
  const replyBody = String(replies[0]?.reply?.text || "");
  if (fcaCofactsEdgeMatchesYoutubeAnchor(userQ, node)) return true;
  const artOk = fcaCofactsArticleMatchesUserQuery(userQ, art);
  const repOk = fcaCofactsArticleMatchesUserQuery(userQ, replyBody);
  if (!artOk && !repOk) return false;
  const qnZh = fcaNormalizeForCofactsOverlap(userQ).replace(/[^\u4e00-\u9fff]/g, "");
  const repLen = String(replyBody || "").replace(/\s/g, "").length;
  if (qnZh.length >= 24 && repLen >= 42 && (!artOk || !repOk)) return false;
  if (!fcaCofactsCrossTopicOk(userQ, art, replyBody)) return false;
  if (!fcaCofactsLatinVsZhCorpusGeoAnchorOk(userQ, art, replyBody)) return false;
  if (!fcaCofactsPathogenBucketCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsDishMarkerCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsVenueMarkerCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsYearAnchorCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsVisitDateAnchorRequiredCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsVisitVersusSurrenderRumorCompat(userQ, art, replyBody)) return false;
  return fcaCofactsSubstantiveTrigramGate(userQ, art, replyBody);
}

const FCA_COFACTS_THEMATIC_GENERIC =
  /^(為什麼|你知道|除了|可能會|消息|訊息|網傳|報導|記者|媒體|請看|提醒大家)/;

/** 從反白抽出可用於主題補搜的中意片段（排除過泛開頭）。 */
function fcaCofactsMeaningfulZhChunks(userQ, minLen = 4, maxLen = 12) {
  const re = new RegExp(`[\\u4e00-\\u9fff]{${minLen},${maxLen}}`, "g");
  const runs = String(userQ || "").match(re) || [];
  return [...new Set(runs)].filter((r) => !FCA_COFACTS_THEMATIC_GENERIC.test(r));
}

function fcaLooksLikeZhFactQuestion(userQ) {
  const q = String(userQ || "");
  if (!q) return false;
  if (/[？?]/.test(q)) return true;
  return /(哪|哪個|哪一|何|誰|幾|是否|有沒有|怎麼|為何|嗎)/.test(q);
}

function fcaCofactsArticleMatchesUserQueryThematic(userQuery, articleText) {
  const rawQ = String(userQuery || "").trim();
  const art = String(articleText || "");
  if (rawQ.length < 3 || art.length < 8) return false;
  const qn = fcaNormalizeForCofactsOverlap(userQuery);
  const an = fcaNormalizeForCofactsOverlap(articleText);
  if (qn.length < 2 || an.length < 2) return false;
  if (an.includes(qn)) return true;

  const chunks = fcaCofactsMeaningfulZhChunks(rawQ, 4, 14);
  let chunkHits = 0;
  for (const ch of chunks) {
    if (ch.length < 4) continue;
    if (art.includes(ch) || an.includes(fcaNormalizeForCofactsOverlap(ch))) {
      chunkHits++;
    }
  }
  const isZhQuestion = fcaLooksLikeZhFactQuestion(rawQ);
  if (chunkHits > 0) {
    /*
     * 問句型短文（例：哪兩文明、哪一國、誰說的）容易被 Cofacts 的泛主題詞誤命中。
     * 這類型要求至少兩個實質中文片段命中，才視為同題。
     */
    if (isZhQuestion && chunks.length >= 2 && chunkHits < 2) return false;
    return true;
  }

  if (fcaSelectionLooksMostlyLatin(userQuery)) {
    const wordRel = fcaLatinMeaningfulHitsInArticle(userQuery, articleText);
    if (wordRel && wordRel.hits >= wordRel.need) return true;
    const rawQ = String(userQuery || "");
    const toks = fcaMeaningfulLatinTokens(rawQ).filter((w) => w.length >= 7).slice(0, 3);
    if (toks.length >= 2) {
      const aw = fcaLatinWordSetFromBlob(articleText);
      let strongHits = 0;
      for (const t of toks) {
        if (aw.has(t)) strongHits++;
      }
      if (strongHits < 2) return false;
    }
    let hits = 0;
    for (let i = 0; i < qn.length - 1; i++) {
      if (an.includes(qn.slice(i, i + 2))) hits++;
    }
    const bigrams = Math.max(1, qn.length - 1);
    return hits >= 3 && hits / bigrams >= 0.12;
  }

  let hits = 0;
  for (let i = 0; i < qn.length - 1; i++) {
    if (an.includes(qn.slice(i, i + 2))) hits++;
  }
  const bigrams = Math.max(1, qn.length - 1);
  const ratio = hits / bigrams;
  // 中文主題補搜：若查詢已可抽出多個中意片語，卻一個都沒命中，視為主題不一致。
  if (!fcaSelectionLooksMostlyLatin(userQuery) && qn.length >= 12 && chunks.length >= 2) {
    return false;
  }
  if (isZhQuestion && chunks.length >= 2 && chunkHits < 2) return false;
  if (qn.length <= 14) {
    return hits >= 2 && ratio >= 0.12;
  }
  return hits >= 3 && ratio >= 0.085;
}

function fcaCofactsEdgeMatchesUserQueryThematic(userQ, node) {
  if (!userQ || !node) return false;
  const art = String(node.text || "");
  const replies = node.articleReplies || [];
  const replyBody = String(replies[0]?.reply?.text || "");
  if (fcaCofactsEdgeMatchesYoutubeAnchor(userQ, node)) return true;
  const artOk = fcaCofactsArticleMatchesUserQueryThematic(userQ, art);
  const repOk = fcaCofactsArticleMatchesUserQueryThematic(userQ, replyBody);
  if (!artOk && !repOk) return false;
  // 短中文反白（4~8字）在主題補搜也套用錨點檢查，避免「手繭/技藝」被泛詞誤配。
  const shortArt = fcaCofactsShortZhAnchorHit(userQ, art);
  const shortRep = fcaCofactsShortZhAnchorHit(userQ, replyBody);
  if (shortArt === false && shortRep === false) return false;
  if (!fcaCofactsCrossTopicOk(userQ, art, replyBody)) return false;
  if (!fcaCofactsLatinVsZhCorpusGeoAnchorOk(userQ, art, replyBody)) return false;
  if (!fcaCofactsPathogenBucketCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsDishMarkerCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsVenueMarkerCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsYearAnchorCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsVisitDateAnchorRequiredCompat(userQ, art, replyBody)) return false;
  if (!fcaCofactsVisitVersusSurrenderRumorCompat(userQ, art, replyBody)) return false;
  return fcaCofactsThematicSubstantiveFourGate(userQ, art, replyBody);
}

function fcaCofactsSortPreparedByScoreDesc(list) {
  if (!list?.length) return [];
  return [...list].sort((a, b) => {
    const sa = Number(a?.score);
    const sb = Number(b?.score);
    if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sb - sa;
    if (Number.isFinite(sb) && !Number.isFinite(sa)) return 1;
    if (Number.isFinite(sa) && !Number.isFinite(sb)) return -1;
    return 0;
  });
}

/** 濃縮反白供第二次 moreLikeThis（略過地名情緒句，拉高主題召回）。 */
function fcaExtractCofactsThematicSeed(rawText) {
  const t = String(rawText || "").replace(/\s+/g, " ").trim();
  if (t.length < 8) return "";
  const chunks = fcaCofactsMeaningfulZhChunks(t, 5, 16);
  if (chunks.length) {
    const sorted = [...chunks].sort((a, b) => b.length - a.length);
    return sorted[0].slice(0, 18);
  }
  const m = t.match(/\b[a-zA-Z]{5,}\b/g);
  if (m?.length) {
    const u = [...new Set(m.map((x) => x))];
    u.sort((a, b) => b.length - a.length);
    return u[0].slice(0, 24);
  }
  return t.slice(0, 20);
}

function cofactsClaimReviewFromPreparedListThematic(list, opts = {}) {
  if (!list?.length) return null;
  const userQ = String(opts.userQuery || "").trim();
  if (!userQ) return null;
  const sorted = fcaCofactsSortPreparedByScoreDesc(list);
  const matches = sorted.filter((e) =>
    fcaCofactsEdgeMatchesUserQueryThematic(userQ, e.node)
  );
  if (!matches.length) return null;
  const ranked = fcaCofactsRankEdgesForPick(matches, userQ);
  for (const e of ranked) {
    const node = e?.node;
    if (!node?.id) continue;
    if (!fcaCofactsPostPickOverlapOk(userQ, node)) continue;
    const cr = cofactsNodeToClaimReview(node, { userQueryForAiInfer: userQ });
    if (!cr) continue;
    cr.fcaRelatedThemeOnly = true;
    cr.fcaCofactsMatchHintZh = fcaCofactsBuildCofactsMatchHintZh(
      userQ,
      node,
      true
    );
    return cr;
  }
  return null;
}

/** 與 cofactsEdgesToClaimReview 相同：相對分數篩選 + 可選依日期排序。 */
function fcaPrepareCofactsEdgeList(edges, opts = {}) {
  if (!edges?.length) return null;
  let list = edges.filter((e) => e?.node?.id);
  if (!list.length) return null;
  const numericScores = list
    .map((e) => Number(e?.score))
    .filter((s) => Number.isFinite(s) && s > 0);
  if (numericScores.length >= 2) {
    const topScore = Math.max(...numericScores);
    const minAbs = Math.max(
      topScore * FCA_COFACTS_MIN_RELATIVE_SCORE,
      topScore * 0.44
    );
    const scoreFiltered = list.filter((e) => {
      const s = Number(e?.score);
      if (!Number.isFinite(s) || s <= 0) return true;
      return s >= minAbs;
    });
    if (scoreFiltered.length) list = scoreFiltered;
    else {
      fcaLog("Cofacts: all scored edges below relative threshold", {
        topScore,
        n: list.length
      });
      return null;
    }
  }
  if (opts.preferLatest) {
    list = [...list].sort((a, b) => {
      const ta = Date.parse(a?.node?.updatedAt || a?.node?.createdAt || "") || 0;
      const tb = Date.parse(b?.node?.updatedAt || b?.node?.createdAt || "") || 0;
      return tb - ta;
    });
  }
  return list;
}

function cofactsNodeToClaimReview(node, opts = {}) {
  if (!node?.id) return null;
  const userQInfer = String(opts.userQueryForAiInfer || "").trim();
  const humanReplies = node.articleReplies || [];
  const hasHuman = humanReplies.length > 0;
  const aiRec = fcaCofactsFirstAiReplyRecord(node);
  const aiText = aiRec ? String(aiRec.text || "").replace(/\s+/g, " ").trim() : "";
  let replyList = humanReplies;
  let aiOnly = false;
  if (!hasHuman && aiText) {
    aiOnly = true;
    replyList = [
      {
        replyType: null,
        reply: {
          text: aiText,
          type: null,
          reference: "",
          createdAt: String(aiRec.createdAt || aiRec.updatedAt || "").trim()
        }
      }
    ];
  }
  const cofactsNoConsensus = !hasHuman && !aiText;
  const ar = cofactsNoConsensus ? null : replyList[0];
  const reply = ar?.reply;
  const type = cofactsNoConsensus
    ? null
    : ar?.replyType ?? reply?.type ?? null;
  const body = (reply?.text || "").trim();
  let inferredFromAiZh = null;
  if (aiOnly && body) {
    const focus = fcaCofactsTextForAiVerdictInference(userQInfer, body);
    inferredFromAiZh = fcaCofactsInferAiOnlyReplyTypeFromZh(focus);
    if (!inferredFromAiZh) {
      inferredFromAiZh =
        fcaCofactsInferAiOnlyRumorFromCofactsStyleDebunk(body);
    }
  }
  const effectiveType = type || inferredFromAiZh || null;
  const label = cofactsNoConsensus
    ? "尚無社群查核回應"
    : cofactsReplyTypeLabel(effectiveType);
  let textualRating;
  if (cofactsNoConsensus) {
    textualRating = "目前社群尚無查核回應，無法依共識判定";
  } else if (aiOnly) {
    textualRating = inferredFromAiZh
      ? `${label}（Cofacts AI 先行稿用語推斷；尚無人類投票共識，請以原文為準）`
      : "Cofacts AI 先行回覆（尚無人類查核者共識；供參考，非最終定案）";
  } else {
    // 不在「判定」列內嵌摘要：下方理由區已用 replyText 顯示全文，避免兩格重複。
    textualRating = label;
  }
  const out = {
    publisher: { name: "Cofacts 真的假的", site: "cofacts.tw" },
    textualRating,
    url: `https://cofacts.tw/article/${encodeURIComponent(node.id)}`,
    replyText: body,
    articleText: ((node.text || "").trim()).slice(0, 800),
    articleUpdatedAt: node.updatedAt || "",
    articleCreatedAt: node.createdAt || "",
    replyCreatedAt: reply?.createdAt || "",
    cofactsReplyType: effectiveType,
    cofactsNoConsensus,
    fcaCofacts: true,
    fcaCofactsNodeId: node.id
  };
  if (aiOnly) {
    out.fcaCofactsAiReplyOnly = true;
    if (inferredFromAiZh) {
      out.fcaCofactsAiInferredReplyType = inferredFromAiZh;
    }
  }
  if ((reply?.reference || "").trim()) {
    out.reference = reply.reference.trim();
  }
  return out;
}

function fcaBigramOverlapRatio(sel, articleText) {
  const q = fcaNormalizeForCofactsOverlap(sel);
  const a = fcaNormalizeForCofactsOverlap(articleText);
  if (q.length < 1 || a.length < 1) return 0;
  if (q.length === 1) return a.includes(q) ? 0.12 : 0;
  let hits = 0;
  for (let i = 0; i < q.length - 1; i++) {
    if (a.includes(q.slice(i, i + 2))) hits++;
  }
  return hits / Math.max(1, q.length - 1);
}

/** 判定摘要區：與反白 bigram 重疊門檻（略低於索引 gate，避免過度裁切）。 */
function fcaVerdictSummaryMinOverlap(query) {
  const n = String(query || "").replace(/\s/g, "").length;
  if (n < 8) return 0.048;
  if (n < 22) return 0.064;
  if (n < 44) return 0.078;
  return 0.094;
}

/** 判定理由摘錄：反白中含義較足的中文在候選文中出現幾段（補純 bigram 易混之洞）。 */
function fcaVerdictMeaningfulZhAnchorsInBlob(query, blob) {
  const chunks = fcaCofactsMeaningfulZhChunks(String(query || ""), 4, 14);
  if (!chunks.length) return { need: 0, hits: 0 };
  const raw = String(blob || "");
  const n = fcaNormalizeForCofactsOverlap(raw);
  let hits = 0;
  for (const ch of chunks) {
    if (ch.length < 4) continue;
    const cn = fcaNormalizeForCofactsOverlap(ch);
    if (!cn || cn.length < 4) continue;
    if (raw.includes(ch) || n.includes(cn)) hits++;
  }
  const need = chunks.length >= 3 ? 2 : 1;
  return { need, hits };
}

/**
 * 判定理由摘錄：反白與候選段是否「實質」對齊（中意片語／英文關鍵詞＋bigram）。
 * 通過時才允許顯示該段全文摘要，否則改走標題／評級警語路徑。
 */
function fcaVerdictSubstantiveAlignOk(query, blob, bigramRatio) {
  const q = String(query || "").trim();
  if (!q) return true;
  const minB = fcaVerdictSummaryMinOverlap(q);
  if (fcaSelectionLooksMostlyLatin(q)) {
    const rel = fcaLatinMeaningfulHitsInArticle(q, blob);
    if (rel && rel.hits >= rel.need) return true;
    if (
      rel &&
      rel.hits >= Math.max(1, rel.need - 1) &&
      bigramRatio >= minB * 0.94
    ) {
      return true;
    }
    return bigramRatio >= Math.max(minB * 1.24, 0.105);
  }
  const { need, hits } = fcaVerdictMeaningfulZhAnchorsInBlob(q, blob);
  if (need > 0 && hits >= need) return true;
  if (need > 0 && hits >= 1 && bigramRatio >= minB * 1.06) return true;
  const qzh = q.replace(/[^\u4e00-\u9fff]/g, "");
  if (qzh.length <= 6 && bigramRatio >= 0.062) return true;
  if (!fcaCofactsMeaningfulZhChunks(q, 4, 14).length && bigramRatio >= minB * 1.04) {
    return true;
  }
  if (need > 0 && hits === 0) {
    return bigramRatio >= minB * 1.32;
  }
  return bigramRatio >= minB * 1.14;
}

/**
 * 自長文（查核內文／回覆）挑出與反白較相關的句段，降低「判定理由」答非所問。
 */
function fcaBestExcerptForQuery(query, body, maxLen = 760) {
  const q = String(query || "").trim();
  const raw = String(body || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (!q) return raw.length > maxLen ? `${raw.slice(0, maxLen)}…` : raw;
  const minOv = fcaVerdictSummaryMinOverlap(q);
  const whole = fcaBigramOverlapRatio(q, raw);
  const multiNumbered =
    fcaCofactsAiReplyHasMultipleNumberedPoints(raw) &&
    raw.replace(/\s/g, "").length > 140;
  if (
    raw.length <= maxLen &&
    !multiNumbered &&
    whole >= minOv * 0.96 &&
    fcaVerdictSubstantiveAlignOk(q, raw, whole) &&
    !fcaVerdictBodyTooJunkyForDisplay(raw, 0.34)
  ) {
    return raw;
  }
  const splitRe = /[。！？!?；;\n]+/;
  let chunks = raw
    .split(splitRe)
    .map((x) => x.trim())
    .filter((x) => x.replace(/\s/g, "").length >= 10);
  if (!chunks.length && raw.replace(/\s/g, "").length >= 36) {
    const L = raw.length;
    const cuts = [0, Math.max(0, Math.floor(L / 2) - 80), Math.max(0, L - 220)];
    const seen = new Set();
    for (const c0 of cuts) {
      const s = raw.slice(c0, c0 + 260).trim();
      const k = s.slice(0, 72);
      if (s.replace(/\s/g, "").length >= 28 && !seen.has(k)) {
        seen.add(k);
        chunks.push(s);
      }
    }
  }
  chunks = chunks.filter((ch) => !fcaVerdictBodyTooJunkyForDisplay(ch, 0.4));
  let best = "";
  let bestSc = 0;
  let secondSc = 0;
  for (const ch of chunks) {
    const sc = fcaBigramOverlapRatio(q, ch);
    if (sc > bestSc) {
      secondSc = bestSc;
      bestSc = sc;
      best = ch;
    } else if (sc > secondSc) {
      secondSc = sc;
    }
  }
  const ambiguous =
    Boolean(best) &&
    secondSc > 0 &&
    bestSc < minOv * 1.48 &&
    secondSc >= bestSc * 0.88;
  if (
    best &&
    bestSc >= minOv &&
    !ambiguous &&
    fcaVerdictSubstantiveAlignOk(q, best, bestSc) &&
    !fcaVerdictBodyTooJunkyForDisplay(best, 0.38)
  ) {
    return best.length > maxLen ? `${best.slice(0, maxLen)}…` : best;
  }
  const win = raw.slice(0, Math.min(raw.length, maxLen + 140));
  const sw = fcaBigramOverlapRatio(q, win);
  if (
    !ambiguous &&
    sw >= minOv * 0.82 &&
    fcaVerdictSubstantiveAlignOk(q, win, sw) &&
    !fcaVerdictBodyTooJunkyForDisplay(win, 0.38)
  ) {
    return win.length > maxLen ? `${win.slice(0, maxLen)}…` : win;
  }
  return "";
}

/**
 * 反白有內容、但選句失敗時：在回覆全文內找與反白 bigram 重疊最高的一窗（側欄用），避免一律顯示開頭泛用導言。
 * 對齊仍偏弱時回傳空字串，交由上層改顯示警語／評級列。
 */
function fcaReplyAlignedWindowForQuery(query, flat, maxLen) {
  const q = String(query || "").trim();
  const raw = String(flat || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (!q) return raw.length > maxLen ? `${raw.slice(0, maxLen)}…` : raw;
  const minOv = fcaVerdictSummaryMinOverlap(q);
  const cap = Math.max(120, Math.min(maxLen, 520));
  const winSize = Math.min(raw.length, cap);
  if (raw.length <= winSize) {
    const sc = fcaBigramOverlapRatio(q, raw);
    return sc >= minOv * 0.7 && fcaVerdictSubstantiveAlignOk(q, raw, sc)
      ? raw
      : "";
  }
  let bestStart = 0;
  let bestSc = -1;
  const step = Math.max(10, Math.floor(winSize / 6));
  for (let start = 0; start + 48 <= raw.length; start += step) {
    const end = Math.min(raw.length, start + winSize);
    const w = raw.slice(start, end);
    const sc = fcaBigramOverlapRatio(q, w);
    if (sc > bestSc) {
      bestSc = sc;
      bestStart = start;
    }
  }
  let cand = raw.slice(bestStart, Math.min(raw.length, bestStart + winSize)).trim();
  if (!cand) return "";
  cand = cand.replace(/^[,，、．.;；:：\s]+/, "").trim();
  if (cand.replace(/\s/g, "").length < 16) return "";
  const sc = fcaBigramOverlapRatio(q, cand);
  if (sc < minOv * 0.66 || !fcaVerdictSubstantiveAlignOk(q, cand, sc)) return "";
  let out = cand;
  if (bestStart > 0) out = `…${out}`;
  if (bestStart + winSize < raw.length) out = `${out}…`;
  return out;
}

/**
 * 偵測條目主文是否多為影音時間軸、短連結、留言碎片（常見於轉貼 YouTube 描述），不適合當「判定理由」摘錄。
 * 回傳 0～1，愈高愈不宜直接顯示原文片段。
 */
function fcaVerdictBodyJunkScore(blob) {
  const s = String(blob || "").trim();
  if (!s) return 0;
  const t = s.slice(0, 1400);
  const lower = t.toLowerCase();
  let score = 0;
  const mmss = t.match(/\b\d{1,2}:\d{2}\b/g);
  if (mmss && mmss.length >= 2) {
    score += Math.min(0.55, (mmss.length - 1) * 0.14);
  }
  if (/youtu\.?be|youtube\.com\/watch|\/shorts\/|\/live\//i.test(lower)) {
    score += 0.3;
  }
  if (/https?:\/\/|t\.co\/|bit\.ly\/|ps:\/\//i.test(lower)) {
    score += 0.12;
  }
  const compact = t.replace(/\s/g, "");
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const ratio = cjk / Math.max(1, compact.length);
  if (compact.length > 48 && ratio < 0.24) {
    score += 0.18;
  }
  if (/\bQ\s+si=|\|\d{4}|\s\|\s*\d/.test(t)) {
    score += 0.14;
  }
  if ((t.match(/\b[a-z]{1,3}\d{2,}\b/gi) || []).length >= 6) {
    score += 0.1;
  }
  return Math.min(1, score);
}

function fcaVerdictBodyTooJunkyForDisplay(blob, threshold = 0.36) {
  return fcaVerdictBodyJunkScore(blob) >= threshold;
}

function fcaVerdictCompactMetaLine(claimReview) {
  const tr = String(claimReview?.textualRating || "").replace(/\s+/g, " ").trim();
  const hd = String(
    claimReview?.headline || claimReview?.title || claimReview?.name || ""
  )
    .replace(/\s+/g, " ")
    .trim();
  const parts = [];
  if (tr && !/^true\.?$/i.test(tr)) parts.push(tr);
  if (hd) parts.push(hd);
  const line = parts.join(" — ");
  if (!line) return "";
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}

/**
 * 側欄「判定理由」：依反白與查核內文重疊選句；重疊低時改顯示標題／評級並加警語。
 * @param {string} [queryText] 使用者反白（與查核摘要對齊用）
 * @param {{ ui?: "sidebar"|"panel" }} [opts] 側欄用較短摘錄，減少右欄牆式長文
 */
function fcaVerdictReasonSummaryText(
  claimReview,
  displayStatus,
  queryText = "",
  opts = {}
) {
  if (!claimReview) return fcaVerdictReasonFallback(displayStatus);
  if (
    claimReview.fcaNewsConsensusUsed &&
    fcaNormalizeLegacyYellowStatus(displayStatus) === "Green"
  ) {
    return claimReview.fcaNewsSummaryLine
      ? ""
      : "多家可信新聞標題與反白高度重疊（非機構查核結論）；請以出處連結核對原文。";
  }
  const q = String(queryText || "").trim();
  const sidebarUi = opts.ui === "sidebar";
  const maxFlatNoQ = sidebarUi ? FCA_VERDICT_SIDEBAR_MAX_FLAT_NO_Q : 800;
  const maxExcerpt = sidebarUi ? FCA_VERDICT_SIDEBAR_MAX_EXCERPT : 800;
  const replySlice = sidebarUi ? FCA_VERDICT_SIDEBAR_REPLY_SLICE : 760;
  const lowRel =
    claimReview?.fcaIndexRelevance?.tier === "低" ||
    (typeof claimReview?.fcaIndexRelevance?.overlap === "number" &&
      claimReview.fcaIndexRelevance.overlap < 0.11 &&
      Boolean(claimReview.fcaIndexCorpus));

  const wrapCaution = (body) => {
    const t = String(body || "").trim();
    if (!t) return "";
    if (lowRel || claimReview?.fcaRelatedThemeOnly) {
      return `與反白關聯度有限，僅供參考。\n\n${t}`;
    }
    return t;
  };

  const pick = (blob, pickOpts = {}) => {
    const isReply = pickOpts.isReply === true;
    if (!blob) return "";
    const flat = String(blob).replace(/\s+/g, " ").trim();
    if (!flat) return "";
    if (fcaVerdictBodyTooJunkyForDisplay(flat)) {
      const meta = fcaVerdictCompactMetaLine(claimReview);
      if (meta) {
        return wrapCaution(
          `條目內容較雜，不適合摘錄；請直接看 Cofacts 原文。\n\n${meta}`
        );
      }
    }
    if (!q) {
      if (fcaVerdictBodyTooJunkyForDisplay(flat)) {
        const meta = fcaVerdictCompactMetaLine(claimReview);
        return meta ? wrapCaution(meta) : "";
      }
      return flat.length > maxFlatNoQ
        ? `${flat.slice(0, maxFlatNoQ)}…`
        : flat;
    }
    const ex = fcaBestExcerptForQuery(q, flat, maxExcerpt);
    if (ex) return wrapCaution(ex);
    const meta = fcaVerdictCompactMetaLine(claimReview);
    const flatCoreLen = flat.replace(/\s/g, "").length;
    const replyBody =
      flat.length > replySlice ? `${flat.slice(0, replySlice)}…` : flat;
    const hasReplySnippet =
      isReply &&
      claimReview?.fcaCofacts &&
      !lowRel &&
      !claimReview?.fcaRelatedThemeOnly &&
      flatCoreLen >= 20;
    if (hasReplySnippet) {
      if (sidebarUi && q) {
        const win = fcaReplyAlignedWindowForQuery(q, flat, replySlice);
        if (win) return wrapCaution(win);
        const looseExcerpt = (() => {
          const picked = fcaBestExcerptForQuery(q, flat, Math.min(replySlice, 280));
          if (picked) return picked;
          const chunks = String(flat)
            .split(/[。！？!?；;\n]+/)
            .map((x) => x.trim())
            .filter((x) => x.replace(/\s/g, "").length >= 8)
            .filter((x) => !fcaVerdictBodyTooJunkyForDisplay(x, 0.42));
          let best = "";
          let bestSc = 0;
          for (const ch of chunks) {
            const sc = fcaBigramOverlapRatio(q, ch);
            if (sc > bestSc) {
              bestSc = sc;
              best = ch;
            }
          }
          if (!best || bestSc < 0.035) return "";
          return best.length > 220 ? `${best.slice(0, 220)}…` : best;
        })();
        const fallbackSummary = looseExcerpt || "";
        if (meta) {
          return fallbackSummary
            ? wrapCaution(`${meta}\n\n${fallbackSummary}`)
            : wrapCaution(meta);
        }
        return fallbackSummary || "";
      }
      return wrapCaution(replyBody);
    }
    if (meta) {
      return wrapCaution(meta);
    }
    return "";
  };

  const reply = String(claimReview.replyText || "").replace(/\s+/g, " ").trim();
  if (reply && !/^true\.?$/i.test(reply)) {
    const got = pick(reply, { isReply: true });
    if (got) return got;
  }

  const art = String(claimReview.articleText || "").replace(/\s+/g, " ").trim();
  if (art.length >= 28) {
    const got = pick(art, { isReply: false });
    if (got) return got;
  }

  const metaOnly = fcaVerdictCompactMetaLine(claimReview);
  if (metaOnly) return wrapCaution(metaOnly);

  const tr = String(claimReview.textualRating || "").trim();
  if (tr && !/^true\.?$/i.test(tr)) return wrapCaution(tr);
  return fcaVerdictReasonFallback(displayStatus);
}

/** 以 Cofacts 候選邊為一句子挑最相近的一則 node（不依賴 AI）。 */
function fcaBestCofactsNodeForSegment(segmentText, list, primaryNode) {
  const seg = String(segmentText || "").trim();
  if (!list?.length || seg.replace(/\s/g, "").length < 1) return null;
  let bestNode = null;
  let bestScore = -1;
  for (const e of list) {
    const node = e?.node;
    if (!node?.id) continue;
    if (!fcaCofactsEdgeMatchesUserQuery(seg, node)) continue;
    const art = String(node.text || "");
    const rep = fcaCofactsNodeReplyBodyForGates(node);
    const bigram = Math.max(
      fcaBigramOverlapRatio(seg, art),
      fcaBigramOverlapRatio(seg, rep)
    );
    const s = Math.max(bigram, 0.16);
    const rlen = fcaCofactsNodeHasDisplayableReply(node) ? 1 : 0;
    const brlen = bestNode ? (fcaCofactsNodeHasDisplayableReply(bestNode) ? 1 : 0) : 0;
    if (
      s > bestScore ||
      (s === bestScore && rlen > 0 && brlen === 0)
    ) {
      bestScore = s;
      bestNode = node;
    }
  }
  const weak = bestScore < 0.045;
  if (weak && primaryNode?.id && fcaCofactsEdgeMatchesUserQuery(seg, primaryNode)) {
    return { node: primaryNode, score: 0.11 };
  }
  if (weak || !bestNode) return null;
  return { node: bestNode, score: bestScore };
}

function fcaSplitSelectionIntoSentences(text) {
  const t = String(text || "");
  const out = [];
  const re =
    /[^。！？!?\n]+(?:[。！？!?]|\.(?=\s|\n|$)|\n|$)|[^。！？!?\n]+$/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const piece = m[0];
    const start = m.index;
    const end = start + piece.length;
    if (piece.replace(/\s/g, "").length >= 2) {
      out.push({ start, end, text: piece });
    }
  }
  if (!out.length && t.replace(/\s/g, "").length >= 2) {
    out.push({ start: 0, end: t.length, text: t });
  }
  return out;
}

/** 長段僅有一句標點時，用空行拆成多則（適合 CNN 等英文條列）。 */
function fcaExpandParagraphBullets(units) {
  if (units.length !== 1) return units;
  const u = units[0];
  const t = u.text;
  if (t.length < 36 || !/\n\s*\n/.test(t)) return units;
  const blocks = t
    .split(/\n\s*\n+/)
    .map((x) => x.trim())
    .filter((x) => x.replace(/\s/g, "").length >= 8);
  if (blocks.length < 2) return units;
  const out = [];
  let searchFrom = 0;
  for (const b of blocks) {
    const idx = t.indexOf(b, searchFrom);
    if (idx < 0) continue;
    out.push({
      start: u.start + idx,
      end: u.start + idx + b.length,
      text: b
    });
    searchFrom = idx + Math.max(1, b.length);
  }
  return out.length >= 2 ? out : units;
}

function fcaSelectionUnitsForHighlighting(fullText) {
  const units = fcaSplitSelectionIntoSentences(fullText);
  return fcaExpandParagraphBullets(units);
}

/**
 * 若文法上僅一句但含逗號／分號，拆成子句再對索引／Cofacts 估重疊，以便紅（錯誤宣稱）與黃／橘分開顯示。
 */
function fcaExpandSingleSentenceIntoClauses(units) {
  if (units.length !== 1) return units;
  const u = units[0];
  const t = u.text;
  const indices = [0];
  for (let i = 0; i < t.length; i++) {
    if (/[,，;；、]/.test(t[i])) {
      indices.push(i + 1);
    }
  }
  indices.push(t.length);
  const sorted = [...new Set(indices.filter((n) => n >= 0 && n <= t.length))].sort(
    (a, b) => a - b
  );
  const chunks = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const raw = t.slice(a, b);
    const lead = (raw.match(/^\s*/) || [""])[0].length;
    const trimmed = raw.trim();
    if (trimmed.replace(/\s/g, "").length < 5) continue;
    const start = u.start + a + lead;
    chunks.push({
      start,
      end: start + trimmed.length,
      text: trimmed
    });
  }
  return chunks.length >= 2 ? chunks : units;
}

/**
 * 第一人稱、揣測、價值判斷、反思語氣（句長須 ≥8 字才比對，降低誤标）。
 */
const FCA_SUBJ_ZH_CORE =
  /我認為|我覺得|我想|依我看|在我看來|個人認為|主觀而言|某程度上|說不定|或許是|想必|恐怕|應該是|八成是|肯定是|絕對是|我推測|我估計|我猜|我猜測|依筆者|筆者認為|編輯手記|個人淺見|淺見而言|太離譜|真噁心|真恶心|令人髮指|非常誇張|非常夸张|不負責任|誇大其詞|聳人聽聞|譁眾取寵|耐人尋味|令人玩味|值得深思|不難想像|可想而知|顯然已|一望即知|無須贅言|不言自明|毋遑多談|豈止於此|何止於此|歸根究柢|說穿了就是|說白了就是|說到底就是|無可諱言|平心而論|老實說|坦白說|老實講|說真的|說實話/;
/**
 * 媒體／社群煽情、帶風向、標題式渲染（句長 ≥4 即比對；與可驗證敘述分開標示）。
 */
const FCA_SUBJ_ZH_EDITORIAL =
  /人人自危|場面一度火爆|場面.{0,6}火爆|更令人憤怒的是|更令人憤怒|令人憤怒的是|令人氣結|令人咋舌|令人不齒|令人髮指|令人譁然|令人傻眼|令人無言以對|怒嗆|怒呛|狠酸|狂噴|狂酸|開酸|開嗆|砲轟|炮轟|痛批|嚴詞|譁然|一片譁然|全場譁然|震驚全場|震驚全台|網友.{0,6}(怒|酸|炸鍋|傻眼|罵翻|灌爆)|一面倒|一面倒酸|一面倒讚|自知理虧|氣焰全消|氣燄全消|氣焰|囂張|囂張跋扈|態度惡劣|氣燄高張|簡直離譜|根本離譜|扯到爆|扯爆了|實在太離譜|太誇張了|誇張至極|有夠扯|扯翻天|簡直扯|瞎爆了|匪夷所思|醜態百出|醜態|吃相難看|見鬼了|氣死人|氣到發抖|氣炸鍋|豈有此理|天理難容|沒天理|無言以對|說穿了|說白了|說到底|顯而易見的是|不言可喻|無庸置疑的是|真的是夠了|真的有夠|豈能|難道不是|豈不是|諷刺的是|諷刺性|下場悽慘|下場慘|下場堪慮|結果悽慘|狼狽|顏面盡失|灰頭土臉|踢到鐵板|報應|報應來了|活該|活該被|炎上|翻車|翻車了|大翻車|徹底翻車|驚爆|驚傳|驚見|沒想到竟|沒想到竟然|真相竟是|案情不單純|背後竟是|現形記|原形畢露|狠狠打臉|打臉|打臉現場|酸爆|群起撻伐|撻伐|眾矢之的|全民公敵|火力全開|砲火猛烈|延燒|延燒中|燒不停|劇情神展開|神展開|峰迴路轉|大逆轉|不忍直視|不忍卒睹|美呆了|醜爆了|全部傻眼|集體傻眼|集體氣炸|罵翻|狂賀|淚崩|看哭|網瘋傳|瘋傳|全網瘋傳|網友酸爆|演都不演|裝都不裝|離譜到不行|荒腔走板|遜爆|丟臉|見笑|顏面掃地|撕破臉|懶得辯|懶得演|懶得裝|囂張至極|太狂了|狂到|囂張無極限|被抓包|說謊被抓包|謊話連篇|睜眼說瞎話|公然說謊/;
const FCA_SUBJ_EN_RE =
  /\b(i think|i believe|i feel|in my opinion|imo\b|i'd say|we think|personally|i guess|i suppose|hopefully|unfortunately|tragically|shocking|outrageous|obviously|clearly(?!\s+stated)|frankly|honestly|ridiculous|absurd|disgraceful|pathetic|make no mistake)\b/i;

function fcaFirstMatchIndex(s, re) {
  const m = re.exec(s);
  return m && m.index >= 0 ? m.index : -1;
}

/** 明顯主觀、評論或揣測語氣（僅標示，非 AI）。 */
function fcaSegmentLooksSubjective(text) {
  const t = String(text || "").trim();
  if (t.length < 4) return false;
  if (FCA_SUBJ_ZH_EDITORIAL.test(t)) {
    return true;
  }
  if (t.length < 8) return false;
  if (FCA_SUBJ_ZH_CORE.test(t)) {
    return true;
  }
  if (FCA_SUBJ_EN_RE.test(t)) {
    return true;
  }
  return false;
}

/** 句內最早出現的主觀語氣起點（用於同一段反白拆成客觀句＋主觀尾句）。 */
function fcaFirstSubjectivePhraseIndex(text) {
  const s = String(text || "");
  let best = -1;
  const idxEd = fcaFirstMatchIndex(s, FCA_SUBJ_ZH_EDITORIAL);
  if (idxEd >= 0) best = idxEd;
  const idxCore = fcaFirstMatchIndex(s, FCA_SUBJ_ZH_CORE);
  if (idxCore >= 0 && (best < 0 || idxCore < best)) best = idxCore;
  const idxEn = fcaFirstMatchIndex(s, FCA_SUBJ_EN_RE);
  if (idxEn >= 0 && (best < 0 || idxEn < best)) best = idxEn;
  return best;
}

/**
 * 若某句前段為敘事、後段出現主觀起首詞，拆成兩個標註單元（仍沿用字元 offset）。
 */
function fcaExpandUnitsWithSubjectiveSplits(units) {
  if (!units?.length) return units || [];
  const out = [];
  for (const u of units) {
    const text = u.text;
    if (fcaSegmentLooksSubjective(text)) {
      out.push(u);
      continue;
    }
    const idx = fcaFirstSubjectivePhraseIndex(text);
    if (idx < 0) {
      out.push(u);
      continue;
    }
    const left = text.slice(0, idx);
    const right = text.slice(idx);
    if (left.replace(/\s/g, "").length >= 6) {
      out.push({ start: u.start, end: u.start + idx, text: left });
    }
    out.push({ start: u.start + idx, end: u.end, text: right });
  }
  return out;
}

/** 索引／Cofacts 多段標色共用：拆句 → 子句 → 主觀詞切分。 */
function fcaPrepareHighlightUnits(fullText) {
  let units = fcaSelectionUnitsForHighlighting(String(fullText || ""));
  units = fcaExpandSingleSentenceIntoClauses(units);
  units = fcaExpandUnitsWithSubjectiveSplits(units);
  return units;
}

function fcaSubjectiveSegmentClaimReview() {
  return {
    publisher: { name: "語氣標示", site: "事實查核助手" },
    textualRating:
      "此段依**關鍵字規則**辨識為：可能含主觀評價、情緒渲染、帶風向或標題式煽情、第一人稱／推測語氣；**不表示內容為假**，也**非**查核機構結論。請與同段「可驗證數字、處分、引述、時地人」等客觀陳述分開閱讀；要查核具體宣稱時，請改反白該宣稱句再查。",
    url: "",
    fcaSubjectiveClause: true
  };
}

function fcaWeakIndexOverlapClaimReview() {
  return {
    publisher: { name: "關聯標示", site: "事實查核助手" },
    textualRating:
      "此句與目前索引命中的查核主題重疊度較低，不應逕以旁側查核結論套用在這一句。建議縮短反白範圍或改用文中具體地名、人名、數字等關鍵語再查。",
    url: "",
    fcaWeakIndexOverlap: true
  };
}

function fcaIndexCorpusFromTop(top) {
  const cr = top?.claimReview?.[0] ?? {};
  const claimText = String(top?.text || "").trim();
  const extra = [cr.title, cr.headline, cr.name, cr.alternateName, cr.textualRating]
    .filter(Boolean)
    .join(" ");
  return `${claimText} ${extra}`.trim().slice(0, 4000);
}

/**
 * 字詞重疊已過關後，擋下「反白在談 A 地／事件、索引條目明顯在談 B」的常見誤配
 * （例如：伊朗戰事停火談判 vs. Snopes 迦薩／拜登「同一套協議」謠言，皆含 Trump、總統等字）。
 */
function fcaIndexCrossTopicDivergenceOk(sel, corpus) {
  const s = String(sel || "").toLowerCase();
  const c = String(corpus || "").toLowerCase();
  const sw = fcaLatinWordSetFromBlob(sel);
  const corpUkr = FCA_RE_UKRAINE.test(c) || /\bzelenskyy\b/.test(c) || /\bcrimea\b/.test(c);
  const selUkr = FCA_RE_UKRAINE.test(s) || /\bzelenskyy\b/.test(s) || /\bcrimea\b/.test(s);
  const corpMidSealanes =
    /\bhormuz\b/.test(c) ||
    (/\bstrait\b/.test(c) && (FCA_RE_IRAN.test(c) || /\btanker\b/.test(c) || /\bshipping\b/.test(c))) ||
    (FCA_RE_IRAN.test(c) && /\b(oil|tanker|sanction|ceasefire)\b/.test(c));
  const selMidSealanes =
    /\bhormuz\b/.test(s) ||
    (/\bstrait\b/.test(s) && (/\biran\b/.test(s) || /\boil\b/.test(s) || /\btanker\b/.test(s))) ||
    (/\bcease[-\s]?fire\b/.test(s) && (FCA_RE_IRAN.test(s) || /\bhormuz\b/.test(s)));
  if (corpUkr && !corpMidSealanes && selMidSealanes && !selUkr) {
    return false;
  }
  if (selUkr && corpMidSealanes && !corpUkr) {
    return false;
  }
  const corpusGaza = FCA_RE_GAZA_HAMAS_SEL.test(c);
  const selGaza = FCA_RE_GAZA_HAMAS_SEL.test(s);
  if (!corpusGaza || selGaza) {
    /* 反白已含巴勒斯坦語境，或索引不含迦薩主軸 */
  } else {
    const selIranSphere =
      FCA_RE_IRAN.test(s) ||
      sw.has("iranian") ||
      sw.has("tehran") ||
      sw.has("hormuz");
    if (selIranSphere && !FCA_RE_IRAN.test(c) && !sw.has("iranian")) {
      return false;
    }
    const userCeasefire = s.includes("ceasefire") || s.includes("cease fire");
    const corpBidenGazaDeal =
      corpusGaza && (c.includes("biden") || c.includes("exact deal"));
    if (userCeasefire && corpBidenGazaDeal && !FCA_RE_IRAN.test(c)) {
      return false;
    }
  }
  return true;
}

/**
 * 國際索引常因「Pakistan／Iran／minister／conflict」等泛詞，把即時政經稿
 * （例：CNN 巴基斯坦總理邀請、區域情勢）誤配到另一則「印度國會深偽影片／Amit Shah」查核。
 * 若查核內文明顯屬此類而反白未含對應錨點，不應採用該索引命中。
 */
function fcaIndexIndiaDeepfakeClipCorpusMismatch(sel, corpus) {
  const s = String(sel || "").toLowerCase();
  const c = String(corpus || "").toLowerCase();
  if (!s || !c) return true;
  const corpClipTopic =
    /\bdeepfake\b/.test(c) ||
    /\blok sabha\b/.test(c) ||
    /\bsansad tv\b/.test(c) ||
    /\bsansad\b/.test(c) ||
    (/\bviral\b/.test(c) && /\bvideo\b/.test(c) && /\bparliament\b/.test(c));
  const corpAmitShah = /\bamit\b/.test(c) && /\bshah\b/.test(c);
  if (!corpClipTopic && !corpAmitShah) return true;
  const userHasAnchor =
    /\bdeepfake\b/.test(s) ||
    /\blok sabha\b/.test(s) ||
    /\bsansad\b/.test(s) ||
    (/\bamit\b/.test(s) && /\bshah\b/.test(s)) ||
    /\bakhand bharat\b/.test(s) ||
    /\basim munir\b/.test(s) ||
    (/\bviral\b/.test(s) && /\bvideo\b/.test(s));
  if (!userHasAnchor) return false;
  return true;
}

/**
 * 荷姆茲／伊朗情境下，索引常因 iran、Hormuz、strait、tanker 等泛詞重合，
 * 把「停火、重開海峽」外交敘述誤配到「舊影片／Stena Impero／扣押油輪謠言」類查核稿。
 */
/**
 * 國際索引：反白含多段中意詞時，查核內文須命中足夠段數，避免僅 bigram 像就採用。
 */
function fcaIndexZhSubstantiveAnchorsOk(userQ, corpus) {
  const chunks = fcaCofactsMeaningfulZhChunks(String(userQ || ""), 4, 14);
  if (!chunks.length) return true;
  const c = String(corpus || "");
  const cn = fcaNormalizeForCofactsOverlap(c);
  let hits = 0;
  for (const ch of chunks) {
    if (ch.length < 4) continue;
    const cj = fcaNormalizeForCofactsOverlap(ch);
    if (cj && (c.includes(ch) || cn.includes(cj))) hits++;
  }
  const need = chunks.length >= 3 ? 2 : 1;
  return hits >= need;
}

function fcaIndexHormuzOldTankerFootageVsDiplomacyMismatch(sel, corpus) {
  const s = String(sel || "").toLowerCase();
  const c = String(corpus || "").toLowerCase();
  if (!s || !c) return true;
  const corpStenaPair = /\bstena\b/.test(c) && /\bimpero\b/.test(c);
  const corpOldTankerVideo =
    corpStenaPair ||
    /\bold footage\b/.test(c) ||
    (/\bjuly\b/.test(c) &&
      /\b2019\b/.test(c) &&
      /\b(seiz|tanker|footage|video|vessel|ship)\b/.test(c)) ||
    (/\bfootage\b/.test(c) && /\bactually from\b/.test(c));
  if (!corpOldTankerVideo) return true;
  const userMediaSeizureAnchor =
    /\bvideo\b/.test(s) ||
    /\bfootage\b/.test(s) ||
    /\bclip\b/.test(s) ||
    /\bviral\b/.test(s) ||
    (/\bstena\b/.test(s) && /\bimpero\b/.test(s)) ||
    (/\btanker\b/.test(s) && /\bseiz/.test(s));
  const userCeasefireStraitDiplomacy =
    /\bcease[-\s]?fire\b/.test(s) ||
    (/\breopen\b/.test(s) && /\bstrait\b/.test(s)) ||
    (/\bagreed\b/.test(s) && /\biran\b/.test(s) && /\b(trump|president)\b/.test(s));
  if (userCeasefireStraitDiplomacy && !userMediaSeizureAnchor) return false;
  return true;
}

function fcaIndexHitMatchesSelection(userQ, top) {
  const corpus = fcaIndexCorpusFromTop(top);
  const q = String(userQ || "").trim();
  if (!q || !corpus) return false;
  if (!fcaCofactsSelectionMonthAnchorsSatisfiedByBlob(q, corpus)) return false;
  if (!fcaIndexIndiaDeepfakeClipCorpusMismatch(q, corpus)) return false;
  if (!fcaIndexHormuzOldTankerFootageVsDiplomacyMismatch(q, corpus)) return false;
  if (fcaCofactsArticleMatchesUserQuery(q, corpus)) {
    if (!fcaIndexZhSubstantiveAnchorsOk(q, corpus)) return false;
    return fcaIndexCrossTopicDivergenceOk(q, corpus);
  }
  const head = q.slice(0, Math.min(q.length, 320));
  const ratio = fcaBigramOverlapRatio(head, corpus);
  /*
   * 英文若已有「夠長的辨識詞」卻未達字詞重疊門檻，僅因字元 bigram 略像就放行
   * 易把伊朗／停火稿錯配到迦薩／拜登等另一則（皆含 Trump、war 等泛詞）。
   */
  if (fcaSelectionLooksMostlyLatin(q)) {
    const wordRel = fcaLatinMeaningfulHitsInArticle(q, corpus);
    if (wordRel && wordRel.hits < wordRel.need) {
      if (ratio >= 0.33 && !fcaIndexCrossTopicDivergenceOk(q, corpus)) {
        return false;
      }
      if (ratio >= 0.25 && ratio < 0.33 && !fcaIndexCrossTopicDivergenceOk(q, corpus)) {
        return false;
      }
      return ratio >= 0.33;
    }
    if (ratio >= 0.185 && !fcaIndexCrossTopicDivergenceOk(q, corpus)) {
      return false;
    }
    if (ratio >= 0.2 && ratio < 0.24 && !fcaIndexCrossTopicDivergenceOk(q, corpus)) {
      return false;
    }
    return ratio >= 0.185;
  }
  /** 中文／混合：略提高 bigram 門檻，並以中意片語錨點補強 */
  const qzhLen = q.replace(/\s/g, "").length;
  const ratioOk = qzhLen > 28 ? ratio >= 0.145 : ratio >= 0.134;
  if (!ratioOk) return false;
  return fcaIndexZhSubstantiveAnchorsOk(q, corpus);
}

/**
 * 國際索引命中：逐句標主觀（橘）／與索引有關之查證色／證據不足（灰）。
 */
function fcaBuildIndexMixedPhraseHighlights(fullText, displayStatus, claimReview, indexCorpus) {
  const raw = String(fullText || "");
  const units = fcaPrepareHighlightUnits(raw);
  if (units.length < 2) return [];
  const rawSegs = [];
  const ds = fcaNormalizeLegacyYellowStatus(displayStatus);
  const st =
    ds === "Red" ||
    ds === "Orange" ||
    ds === "Green" ||
    ds === "Blue" ||
    ds === "Gray"
      ? ds
      : "Gray";
  for (const u of units) {
    let segSt = st === "Green" ? "Green" : "Gray";
    let mini = st === "Green" ? claimReview : fcaWeakIndexOverlapClaimReview();
    if (fcaSegmentLooksSubjective(u.text)) {
      segSt = "Orange";
      mini = fcaSubjectiveSegmentClaimReview();
    } else if (
      indexCorpus &&
      (fcaCofactsArticleMatchesUserQuery(u.text, indexCorpus) ||
        fcaBigramOverlapRatio(u.text, indexCorpus) >= 0.108)
    ) {
      segSt = st;
      mini = claimReview;
    }
    rawSegs.push({
      start: u.start,
      end: u.end,
      text: u.text,
      status: segSt,
      claimReviewMini: mini
    });
  }
  const merged = fcaMergeAdjacentPhraseHighlights(rawSegs);
  return merged.length > 1 ? merged : [];
}

function fcaApplySubjectiveOverlayToPhrases(phrases) {
  if (!phrases?.length) return phrases;
  const mapped = phrases.map((p) => {
    if (fcaSegmentLooksSubjective(p.text)) {
      return {
        ...p,
        status: "Orange",
        claimReviewMini: fcaSubjectiveSegmentClaimReview()
      };
    }
    return p;
  });
  return fcaMergeAdjacentPhraseHighlights(mapped);
}

function fcaPhraseHighlightMergeKey(seg) {
  if (seg.claimReviewMini?.fcaSubjectiveClause) return "subj|Orange";
  if (seg.claimReviewMini?.fcaFactClause) return "fact|Cyan";
  if (seg.claimReviewMini?.fcaWeakIndexOverlap) return `weak|${seg.status}`;
  if (seg.claimReviewMini?.fcaNarrativeChunk) return `narr|${seg.status}`;
  return `${seg.status}|${seg.claimReviewMini?.url || ""}`;
}

/**
 * 查無索引／Cofacts 時：語意拆解（事實／觀點）— 淺青＝偏事實敘述、橘＝偏觀點（關鍵字規則；與查核「事實釐清」藍色分開）。
 */
function fcaFactClauseSegmentClaimReview() {
  return {
    publisher: { name: "語意拆解", site: "事實查核助手" },
    textualRating:
      "此段依**關鍵字規則**標為偏**事實敘述**（人、時、地、數據、引述或可驗證宣稱語氣）；**不**表示已經查核為真，亦**非**查核機構結論。請與橘色「觀點／評論」語句分開閱讀。",
    url: "",
    fcaFactClause: true
  };
}

function fcaBuildSubjectiveOnlyPhraseHighlights(trimmed) {
  const t = String(trimmed || "").trim();
  if (t.replace(/\s/g, "").length < 12) return null;
  const uu = fcaPrepareHighlightUnits(t);
  if (uu.length < 2) return null;
  const rawSegs = [];
  for (const u of uu) {
    const subj = fcaSegmentLooksSubjective(u.text);
    rawSegs.push({
      start: u.start,
      end: u.end,
      text: u.text,
      status: subj ? "Orange" : "Cyan",
      claimReviewMini: subj
        ? fcaSubjectiveSegmentClaimReview()
        : fcaFactClauseSegmentClaimReview()
    });
  }
  const merged = fcaMergeAdjacentPhraseHighlights(rawSegs);
  const hasO = merged.some((m) => m.status === "Orange");
  const hasC = merged.some((m) => m.status === "Cyan");
  if (merged.length <= 1 || !hasO || !hasC) return null;
  return {
    publisher: { name: "語意拆解（事實／觀點）", site: "事實查核助手" },
    textualRating:
      "查無可直接對照之查核條目。**淺青色**＝偏事實敘述；**橘色**＝偏觀點／主觀語氣。（查核結論若為「事實釐清」則另以**藍色**顯示，勿混淆。）僅依關鍵字粗分，**不**代表已查核真偽。",
    url: "",
    fcaSubjectiveOnlyHighlights: true,
    fcaFactOpinionSplit: true,
    fcaPhraseHighlights: merged,
    fcaHighlightSourceText: t
  };
}

function fcaMergeAdjacentPhraseHighlights(segs) {
  if (!segs.length) return [];
  const out = [{ ...segs[0] }];
  for (let i = 1; i < segs.length; i++) {
    const p = segs[i];
    const prev = out[out.length - 1];
    if (fcaPhraseHighlightMergeKey(prev) === fcaPhraseHighlightMergeKey(p) && prev.end === p.start) {
      prev.end = p.end;
      prev.text = `${prev.text}${p.text}`;
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

/**
 * 將反白拆句，每句對應最相近的 Cofacts 候選與社群標籤（僅資料庫）。
 * @returns {Array<{start:number,end:number,text:string,status:string,claimReviewMini:object|null}>}
 */
function fcaBuildCofactsPhraseHighlights(
  fullText,
  list,
  primaryNode,
  claimReviewForTone = null
) {
  const raw = String(fullText || "");
  const units = fcaPrepareHighlightUnits(raw);
  if (units.length < 2) return [];
  let padGreen = false;
  if (claimReviewForTone && primaryNode) {
    const rs = String(claimReviewForTone.fcaResolvedStatus || "").trim();
    let eff = rs ? fcaNormalizeLegacyYellowStatus(rs) : "";
    if (!eff && claimReviewForTone.cofactsReplyType) {
      eff = fcaNormalizeLegacyYellowStatus(
        cofactsReplyTypeToFcaStatus(claimReviewForTone.cofactsReplyType)
      );
    }
    padGreen = eff === "Green";
  }
  const rawSegs = [];
  for (const u of units) {
    const hit = fcaBestCofactsNodeForSegment(u.text, list, primaryNode);
    let status = "Gray";
    let mini = null;
    if (hit) {
      mini = cofactsNodeToClaimReview(hit.node, {
        userQueryForAiInfer: u.text
      });
      const replies = hit.node.articleReplies || [];
      if (replies.length) {
        const ar0 = replies[0];
        const rt = ar0?.replyType ?? ar0?.reply?.type ?? null;
        status = cofactsReplyTypeToFcaStatus(rt);
      } else if (
        padGreen &&
        primaryNode &&
        String(hit.node?.id ?? "") === String(primaryNode.id ?? "")
      ) {
        status = "Green";
      }
    } else if (padGreen && primaryNode) {
      status = "Green";
      mini = cofactsNodeToClaimReview(primaryNode, {
        userQueryForAiInfer: u.text
      });
    }
    rawSegs.push({
      start: u.start,
      end: u.end,
      text: u.text,
      status,
      claimReviewMini: mini
    });
  }
  const merged = fcaMergeAdjacentPhraseHighlights(rawSegs);
  const withSubj = fcaApplySubjectiveOverlayToPhrases(merged);
  return withSubj.length > 1 ? withSubj : [];
}

function fcaGetTextChunksInRange(range) {
  const chunks = [];
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) {
    const tn = root;
    const s = range.startOffset;
    const e = range.endOffset;
    if (e > s) chunks.push({ node: tn, start: s, end: e, len: e - s });
    return chunks;
  }
  const doc = root.ownerDocument || document;
  const iter = doc.createNodeIterator(root, NodeFilter.SHOW_TEXT);
  let n = iter.nextNode();
  while (n) {
    let intersects = true;
    try {
      intersects = range.intersectsNode(n);
    } catch {
      intersects = true;
    }
    if (!intersects) {
      n = iter.nextNode();
      continue;
    }
    let start = 0;
    let end = n.length;
    if (n === range.startContainer) start = range.startOffset;
    if (n === range.endContainer) end = range.endOffset;
    if (end > start) chunks.push({ node: n, start, end, len: end - start });
    n = iter.nextNode();
  }
  return chunks;
}

function fcaSeekInChunks(chunks, c) {
  let acc = 0;
  for (const ch of chunks) {
    if (c <= acc + ch.len) {
      return { node: ch.node, offset: ch.start + (c - acc) };
    }
    acc += ch.len;
  }
  return null;
}

function fcaSubRangeFromCharOffsets(range, c0, c1) {
  const chunks = fcaGetTextChunksInRange(range);
  if (!chunks.length) return null;
  const a = fcaSeekInChunks(chunks, c0);
  const b = fcaSeekInChunks(chunks, c1);
  if (!a || !b) return null;
  const r = range.cloneRange();
  try {
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
  } catch {
    return null;
  }
  return r;
}

/**
 * 反白內多段著色。
 * @returns {HTMLElement|null} 文件順序第一段的 span（供錨定浮動面板）
 */
function wrapRangeWithPhrases(
  range,
  phrases,
  fallbackClaimReview,
  fallbackStatus
) {
  ensureFcaHighlightStyles();
  removePreviousFcHighlights();

  const outer = document.createElement("span");
  outer.setAttribute("data-fca-multi-host", "1");
  try {
    const frag = range.extractContents();
    outer.appendChild(frag);
    range.insertNode(outer);
  } catch (e) {
    fcaLog("wrapRangeWithPhrases extract/insert failed", e);
    return null;
  }

  const sorted = [...phrases].sort((a, b) => b.start - a.start);
  const anchorStart = Math.min(...phrases.map((p) => p.start));
  let anchorSpan = null;
  const doc = outer.ownerDocument;

  for (const ph of sorted) {
    const innerRange = doc.createRange();
    innerRange.selectNodeContents(outer);
    const sub = fcaSubRangeFromCharOffsets(innerRange, ph.start, ph.end);
    if (!sub || sub.collapsed) continue;
    const span = document.createElement("span");
    const mini = ph.claimReviewMini || fallbackClaimReview;
    const st =
      ph.status === "Red" ||
      ph.status === "Orange" ||
      ph.status === "Green" ||
      ph.status === "Blue" ||
      ph.status === "Gray" ||
      ph.status === "Cyan"
        ? ph.status
        : "Gray";
    applyStatusVisual(span, st, mini);
    const tip = fcaAnnoTitleForSegment(st, mini);
    if (tip) span.setAttribute("title", tip);
    const { publisher, textualRating } = resolveClaimMeta(mini);
    span.setAttribute("data-fca-publisher", publisher);
    span.setAttribute("data-fca-rating", textualRating);
    try {
      sub.surroundContents(span);
    } catch {
      const frag2 = sub.extractContents();
      span.appendChild(frag2);
      sub.insertNode(span);
    }
    if (ph.start === anchorStart) anchorSpan = span;
  }

  const parent = outer.parentNode;
  if (parent) {
    while (outer.firstChild) {
      parent.insertBefore(outer.firstChild, outer);
    }
    parent.removeChild(outer);
  }

  return anchorSpan || null;
}

function fcaAiCategoryLabelForUi(cat) {
  const c = normalizeAiCategory(cat);
  const map = {
    RUMOR: "錯誤／謠言傾向",
    OPINION: "主觀意見／難客觀驗證",
    FACT: "正確／事實傾向",
    OUTDATED: "可能過時"
  };
  return map[c] || "待釐清";
}

function fcaNoDirectCofactsHeadline(aiCat) {
  const zh = fcaAiCategoryLabelForUi(aiCat);
  return `查無直接相關的查核條目，Gemini AI 根據最新新聞與公眾常識初步判定為：【${zh}】（無即時搜尋，僅供參考）`;
}

/** AI 判定 Cofacts 候選与反白無關時的合成結果（保留獨立判讀結論） */
function fcaBuildSyntheticDiscardedCofacts(selectionText, ai, discardReason) {
  const base = fcaBuildSyntheticAiOnlyClaimReview(selectionText, ai);
  if (!base) return null;
  base.fcaNoDirectCofactsMatch = true;
  base.fcaDiscardCofactsReason = String(discardReason || "").trim().slice(0, 400);
  base.textualRating = fcaNoDirectCofactsHeadline(ai?.category);
  return base;
}

function cofactsClaimReviewFromPreparedList(list, opts = {}) {
  if (!list?.length) return null;
  const userQ = String(opts.userQuery || "").trim();
  let candidates;
  if (userQ) {
    candidates = list.filter((e) =>
      fcaCofactsEdgeMatchesUserQuery(userQ, e.node)
    );
    if (!candidates.length) {
      fcaLog("Cofacts: no edge passed text-overlap gate", {
        qlen: userQ.length,
        n: list.length
      });
      return null;
    }
  } else {
    candidates = list.slice();
  }
  const ranked = fcaCofactsRankEdgesForPick(candidates, userQ);
  const rankedHuman = ranked.filter((e) =>
    fcaCofactsNodeHasHumanArticleReply(e?.node)
  );

  for (const e of rankedHuman) {
    const node = e?.node;
    if (!node?.id) continue;
    if (!fcaCofactsPostPickOverlapOk(userQ, node)) continue;
    const cr = cofactsNodeToClaimReview(node, { userQueryForAiInfer: userQ });
    if (!cr) continue;
    cr.fcaCofactsMatchHintZh = fcaCofactsBuildCofactsMatchHintZh(
      userQ,
      node,
      false
    );
    return cr;
  }

  // 若嚴格 gate 把所有「人類回覆」候選都擋掉，仍優先救援最相近的人類條目，避免退回到僅 AI 先行稿。
  for (const e of rankedHuman) {
    const node = e?.node;
    if (!node?.id) continue;
    const art = String(node?.text || "");
    const rep = fcaCofactsNodeReplyBodyForGates(node);
    const r = Math.max(
      fcaBigramOverlapRatio(userQ, art),
      fcaBigramOverlapRatio(userQ, rep)
    );
    if (userQ && r < 0.02) continue;
    const cr = cofactsNodeToClaimReview(node, { userQueryForAiInfer: userQ });
    if (!cr) continue;
    cr.fcaCofactsMatchHintZh = fcaCofactsBuildCofactsMatchHintZh(
      userQ,
      node,
      false
    );
    cr.fcaCofactsHumanReplyRescue = true;
    return cr;
  }

  for (const e of ranked) {
    const node = e?.node;
    if (!node?.id) continue;
    if (!fcaCofactsPostPickOverlapOk(userQ, node)) continue;
    const cr = cofactsNodeToClaimReview(node, { userQueryForAiInfer: userQ });
    if (!cr) continue;
    cr.fcaCofactsMatchHintZh = fcaCofactsBuildCofactsMatchHintZh(
      userQ,
      node,
      false
    );
    return cr;
  }
  return null;
}

function cofactsEdgesToClaimReview(edges, opts = {}) {
  const list = fcaPrepareCofactsEdgeList(edges, opts);
  return cofactsClaimReviewFromPreparedList(list, opts);
}

async function fcaCofactsFetchGetArticle(articleId) {
  const id = String(articleId || "").trim();
  if (!id) return null;
  try {
    const resp = await fcaSendMessage({
      type: "FC_COFACTS_GRAPHQL",
      query: COFACTS_GET_ARTICLE_QUERY,
      variables: { id },
      selectionText: "",
      skipGemini: true
    });
    if (!resp?.ok) return null;
    const j = resp.json;
    if (j?.errors?.length) {
      fcaLog("Cofacts GetArticle GraphQL errors", j.errors);
      return null;
    }
    return j?.data?.GetArticle || null;
  } catch (e) {
    fcaLog("Cofacts GetArticle failed", e);
    return null;
  }
}

/**
 * 當 ListArticles 的 node 沒有帶入 articleReplies，但條目實際有查核回覆時，用 GetArticle 補齊。
 * 同步更新 prepared 內對應 node，供後續片語 highlight 等使用。
 */
async function fcaCofactsHydrateClaimReviewFromGetArticle(
  claimReview,
  prepared,
  searchText
) {
  if (!claimReview?.fcaCofacts || !claimReview.fcaCofactsNodeId) {
    return claimReview;
  }
  const pid = String(claimReview.fcaCofactsNodeId).trim();
  if (!pid) return claimReview;
  const pe = prepared?.find?.(
    (e) => String(e?.node?.id ?? "") === pid
  );
  let node = pe?.node;
  if (node && fcaCofactsNodeHasDisplayableReply(node)) return claimReview;
  if (!node) {
    /* ListArticles 與 pick 之 id 型別不一致、或 prepared 已變更時，仍應對該 id 打 GetArticle */
    node = {
      id: pid,
      text: String(claimReview.articleText || "").replace(/\s+/g, " ").trim(),
      createdAt: claimReview.articleCreatedAt || "",
      updatedAt: claimReview.articleUpdatedAt || "",
      articleReplies: []
    };
    fcaLog("Cofacts hydrate: no prepared node match, using minimal node", {
      pid
    });
  }

  const art = await fcaCofactsFetchGetArticle(pid);
  if (!art) return claimReview;
  const replies = art.articleReplies || [];
  const hasAiFromGet = Boolean(fcaCofactsFirstAiReplyText(art));
  if (!replies.length && !hasAiFromGet) return claimReview;

  const textFromArt = String(art.text || "").trim();
  const merged = {
    ...node,
    text: textFromArt.length ? textFromArt : String(node.text || "").trim(),
    createdAt: art.createdAt || node.createdAt,
    updatedAt: art.updatedAt || node.updatedAt,
    replyCount: Number.isFinite(Number(art.replyCount))
      ? Number(art.replyCount)
      : node.replyCount,
    articleReplies: replies.length ? replies : node.articleReplies || [],
    aiReplies: art.aiReplies ?? node.aiReplies ?? []
  };
  const cr2 = cofactsNodeToClaimReview(merged, {
    userQueryForAiInfer: String(searchText || "").trim()
  });
  if (!cr2) return claimReview;
  if (claimReview.fcaRelatedThemeOnly) cr2.fcaRelatedThemeOnly = true;
  cr2.fcaCofactsMatchHintZh =
    claimReview.fcaCofactsMatchHintZh ||
    fcaCofactsBuildCofactsMatchHintZh(
      String(searchText || "").trim(),
      merged,
      false
    );
  if (pe?.node) pe.node = merged;
  fcaLog("Cofacts hydrated via GetArticle", {
    id: pid,
    humanReplies: replies.length,
    aiReply: hasAiFromGet
  });
  return cr2;
}

async function fcaApplyCofactsPostProcess(
  claimReview,
  prepared,
  searchText,
  resp,
  skipGemini,
  blockRespAiMerge
) {
  if (!claimReview) return null;
  claimReview = await fcaCofactsHydrateClaimReviewFromGetArticle(
    claimReview,
    prepared,
    searchText
  );
  if (!claimReview) return null;
  if (claimReview.fcaCofacts) {
    const q = String(searchText || "").trim();
    if (prepared?.length && q.length >= 8) {
      let primaryNode = null;
      const pid = String(claimReview.fcaCofactsNodeId || "").trim();
      if (pid) {
        const pe = prepared.find(
          (e) => String(e?.node?.id ?? "") === pid
        );
        primaryNode = pe?.node || null;
      }
      const ph = fcaBuildCofactsPhraseHighlights(q, prepared, primaryNode, claimReview);
      if (ph.length > 1) {
        claimReview.fcaPhraseHighlights = ph;
        claimReview.fcaHighlightSourceText = q;
      }
    }
  }
  if (claimReview && resp.geminiQuotaExceeded) {
    claimReview.fcaGeminiQuotaExceeded = true;
  }
  if (claimReview && resp.geminiKeyInvalid) {
    claimReview.fcaGeminiKeyInvalid = true;
  }
  if (claimReview && Number(resp.geminiHttpStatus) > 0) {
    claimReview.fcaGeminiHttpStatus = Number(resp.geminiHttpStatus) || 0;
    claimReview.fcaGeminiErrHint = String(resp.geminiErrHint || "").trim().slice(0, 260);
  }
  if (
    claimReview &&
    resp.ai &&
    !blockRespAiMerge &&
    !claimReview.fcaRelatedThemeOnly
  ) {
    fcaMergeAiVerdictIntoClaimReview(claimReview, resp.ai);
    fcaLog("Cofacts + AI", {
      ai: resp.ai,
      resolved: claimReview.fcaResolvedStatus,
      overrode: claimReview.fcaAiOverrodeCofacts
    });
  }

  if (
    claimReview?.cofactsNoConsensus &&
    !claimReview.fcaAiReason &&
    !skipGemini &&
    !claimReview.fcaGeminiQuotaExceeded &&
    claimReview.fcaGeminiKeyInvalid !== true &&
    Number(claimReview.fcaGeminiHttpStatus) !== 429
  ) {
    try {
      const air = await fcaSendMessage({
        type: "FC_AI_STANDALONE",
        text: searchText
      });
      if (air?.geminiQuotaExceeded) claimReview.fcaGeminiQuotaExceeded = true;
      if (air?.geminiKeyInvalid) claimReview.fcaGeminiKeyInvalid = true;
      if (Number(air?.geminiHttpStatus) > 0) {
        claimReview.fcaGeminiHttpStatus = Number(air.geminiHttpStatus) || 0;
        claimReview.fcaGeminiErrHint = String(air.geminiErrHint || "").trim().slice(0, 260);
      }
      if (air?.ok && air.ai) {
        fcaMergeAiVerdictIntoClaimReview(claimReview, air.ai);
        fcaLog("Cofacts no consensus; standalone AI fallback", air.ai);
      }
    } catch (e) {
      fcaLog("FC_AI_STANDALONE after no consensus", e);
    }
  }

  return claimReview;
}

async function fetchCofactsClaimReview(searchText, userStatus, fetchOpts = {}) {
  const { fcaSkipGemini } = await fcaGetExtensionLocalOpts();
  const skipGemini = Boolean(fcaSkipGemini) || Boolean(fetchOpts.forceSkipGemini);
  const skipGeminiInCofactsReq = skipGemini || FCA_AI_BUDGET_FRIENDLY;
  const fastMode = Boolean(fetchOpts.fastMode);
  const queryText = fcaCofactsAugmentSearchTextWithWatchUrl(searchText);
  const filter = buildCofactsListFilter(queryText, userStatus);
  fcaLog("Cofacts GraphQL via background proxy", {
    qLen: queryText.length,
    userStatus,
    preferLatest: Boolean(fetchOpts.preferLatest),
    skipGemini: skipGeminiInCofactsReq
  });

  const resp = await fcaSendMessage({
    type: "FC_COFACTS_GRAPHQL",
    query: COFACTS_LIST_ARTICLES_QUERY,
    variables: { filter },
    selectionText: queryText,
    skipGemini: skipGeminiInCofactsReq
  });

  if (!resp?.ok) {
    throw new Error(
      resp?.error || "無法連線至 Cofacts（請確認已重新載入擴充功能）"
    );
  }

  const json = resp.json;
  if (json?.errors?.length) {
    const gqlMsg = json.errors.map((e) => e.message).join("; ");
    fcaLog("Cofacts GraphQL errors", gqlMsg);
    throw new Error(gqlMsg);
  }

  const preparedOpts = { preferLatest: Boolean(fetchOpts.preferLatest) };
  let rawEdges = json?.data?.ListArticles?.edges || [];
  rawEdges = await fcaCofactsAugmentEdgesWithYoutubeSearch(
    rawEdges,
    queryText
  );
  let prepared = fcaPrepareCofactsEdgeList(rawEdges, preparedOpts);
  let workingResp = resp;

  const pickStrict = (pr) =>
    cofactsClaimReviewFromPreparedList(pr, {
      ...preparedOpts,
      userQuery: queryText
    });
  const pickThematic = (pr) =>
    cofactsClaimReviewFromPreparedListThematic(pr, {
      ...preparedOpts,
      userQuery: queryText
    });

  async function runThematicSupplementaryQuery(seed) {
    const s = String(seed || "").trim();
    const full = String(searchText || "").trim();
    if (s.length < 4 || full.length < 8) return null;
    const sn = fcaNormalizeForCofactsOverlap(s);
    const fn = fcaNormalizeForCofactsOverlap(full);
    if (!sn || sn === fn || fn.length < sn.length + 4) return null;
    fcaLog("Cofacts thematic supplementary query", { seedLen: s.length });
    const r2 = await fcaSendMessage({
      type: "FC_COFACTS_GRAPHQL",
      query: COFACTS_LIST_ARTICLES_QUERY,
      variables: { filter: buildCofactsListFilter(s, userStatus) },
      selectionText: searchText,
      skipGemini: true,
      thematicSupplementary: true
    });
    if (!r2?.ok || r2.json?.errors?.length) return null;
    const prep2 = fcaPrepareCofactsEdgeList(
      r2.json?.data?.ListArticles?.edges,
      preparedOpts
    );
    if (!prep2?.length) return null;
    return { prepared: prep2, resp: r2 };
  }

  if (resp.cofactsDiscarded) {
    // 背景端已判定「候選與反白主題不符」：勿從同一批 GraphQL 結果再做 thematic 救援，易誤連無關條目。
    let claimReview = null;
    let blockAi = true;
    if (!claimReview && !fastMode) {
      const sup = await runThematicSupplementaryQuery(
        fcaExtractCofactsThematicSeed(searchText)
      );
      if (sup) {
        prepared = sup.prepared;
        workingResp = sup.resp;
        claimReview = pickStrict(sup.prepared);
        if (claimReview && !claimReview.fcaRelatedThemeOnly) {
          claimReview.fcaRelatedThemeOnly = true;
        }
      }
    }
    if (claimReview) {
      fcaLog("Cofacts thematic rescue after discard", {
        nodeId: claimReview.fcaCofactsNodeId
      });
      return fcaApplyCofactsPostProcess(
        claimReview,
        prepared,
        searchText,
        workingResp,
        skipGemini,
        blockAi
      );
    }
    if (resp.ai) {
      const syn = fcaBuildSyntheticDiscardedCofacts(
        searchText,
        resp.ai,
        resp.cofactsDiscardReason || ""
      );
      fcaLog("Cofacts discarded unrelated; standalone AI only", {
        ai: resp.ai,
        reason: resp.cofactsDiscardReason
      });
      return syn;
    }
    return null;
  }

  const geminiUnreliable =
    Boolean(workingResp?.geminiQuotaExceeded) ||
    Number(workingResp?.geminiHttpStatus) === 429;
  const skipThematicWhenGeminiDown =
    geminiUnreliable && fcaSelectionLooksMostlyLatin(queryText);

  let claimReview = pickStrict(prepared);
  if (!claimReview && prepared?.length && !skipThematicWhenGeminiDown) {
    claimReview = pickThematic(prepared);
  }
  if (!claimReview && !fastMode) {
    const sup = await runThematicSupplementaryQuery(
      fcaExtractCofactsThematicSeed(searchText)
    );
    if (sup) {
      const strictSup = pickStrict(sup.prepared);
      const themSup = skipThematicWhenGeminiDown
        ? null
        : pickThematic(sup.prepared);
      if (strictSup) {
        claimReview = strictSup;
        prepared = sup.prepared;
        workingResp = sup.resp;
      } else if (themSup) {
        claimReview = themSup;
        prepared = sup.prepared;
        workingResp = sup.resp;
      }
    }
  }

  return fcaApplyCofactsPostProcess(
    claimReview,
    prepared,
    searchText,
    workingResp,
    skipGemini,
    false
  );
}

/** 國際索引無命中時，改走 Cofacts（與舊版行為一致，短關鍵字召回較佳）。 */
async function fetchCofactsAsFallback(q, preferLatest, logTag, fetchOpts = {}) {
  try {
    const cof = await fetchCofactsClaimReview(q, "Yellow", {
      preferLatest,
      ...(fetchOpts || {})
    });
    if (!cof) return null;
    const fs =
      cof.fcaResolvedStatus ||
      cofactsReplyTypeToFcaStatus(cof.cofactsReplyType);
    return { finalStatus: fs, claimReview: cof, error: "" };
  } catch (e) {
    fcaLog(logTag || "cofacts fallback", e);
    return {
      finalStatus: "Yellow",
      claimReview: null,
      error: String(e?.message || e)
    };
  }
}

function fcaIndexHitUrlLower(top) {
  return String(top?.claimReview?.[0]?.url || "")
    .trim()
    .toLowerCase();
}

/**
 * 僅保留通過反白門檻的索引命中；其中 **tfc-taiwan.org.tw** 排前，其餘依 __score。
 * 呼叫前若需「最新優先」，請先對 `arr` 排好序（與舊版 ListArticles 邏輯一致）。
 */
function fcaIndexHitsPassingSelection(q, arr) {
  const list = Array.isArray(arr) ? arr : [];
  const out = [];
  for (const top of list) {
    if (!top?.claimReview?.[0]) continue;
    if (!fcaIndexHitMatchesSelection(q, top)) continue;
    out.push(top);
  }
  out.sort((a, b) => {
    const at = fcaIndexHitUrlLower(a).includes("tfc-taiwan.org.tw") ? 1 : 0;
    const bt = fcaIndexHitUrlLower(b).includes("tfc-taiwan.org.tw") ? 1 : 0;
    if (bt !== at) return bt - at;
    return (Number(b.__score) || 0) - (Number(a.__score) || 0);
  });
  return out;
}

/**
 * 嚴格 `fcaIndexHitMatchesSelection` 對長標題＋查核稿易過嚴，導致 TFC／MyGoPen 無法掛成補充命中。
 * 僅用於「Cofacts 已弱命中、需補一筆台灣查核索引」時；仍保留跨題與月份錨點安全檢查。
 */
function fcaIndexHitTwTrustedSupplementGate(userQ, top) {
  const corpus = fcaIndexCorpusFromTop(top);
  const q = String(userQ || "").trim();
  if (!q || !corpus || !fcaHasCjkText(q)) return false;
  const url = fcaIndexHitUrlLower(top);
  if (!url.includes("tfc-taiwan.org.tw") && !url.includes("mygopen.com")) {
    return false;
  }
  if (!fcaCofactsSelectionMonthAnchorsSatisfiedByBlob(q, corpus)) return false;
  if (!fcaIndexIndiaDeepfakeClipCorpusMismatch(q, corpus)) return false;
  if (!fcaIndexHormuzOldTankerFootageVsDiplomacyMismatch(q, corpus)) return false;
  if (!fcaIndexCrossTopicDivergenceOk(q, corpus)) return false;
  const head = q.slice(0, Math.min(q.length, 320));
  const ratio = fcaBigramOverlapRatio(head, corpus);
  if (ratio < 0.108) return false;
  if (fcaCofactsArticleMatchesUserQuery(q, corpus)) return true;
  if (ratio >= 0.122) return true;
  return fcaIndexZhSubstantiveAnchorsOk(q, corpus);
}

function fcaEnrichIndexTopClaimReview(top, q) {
  const cr = top?.claimReview?.[0] ?? null;
  if (!cr) return null;
  const corpusFull = fcaIndexCorpusFromTop(top);
  const headQ = q.slice(0, Math.min(320, q.length));
  const overlap =
    corpusFull && headQ ? fcaBigramOverlapRatio(headQ, corpusFull) : 0;
  const idxScore = Number(top.__score) || 0;
  let relTier = "中";
  if (overlap >= 0.22) relTier = "高";
  else if (overlap < 0.14) relTier = "低";
  const relLabel = `與索引內文相似度約 ${Math.round(overlap * 100)}%（${relTier}）${
    idxScore ? ` · 排序分 ${Math.round(idxScore)}` : ""
  }`;
  return {
    ...cr,
    articleText: String(top?.text || "").slice(0, 800),
    headline: cr.title || cr.headline || "",
    fcaIndexCorpus: corpusFull,
    fcaIndexRelevance: { overlap, idxScore, tier: relTier, label: relLabel },
    fcaIndexHitStatus: top.fcaStatus || "Yellow"
  };
}

function fcaAttachSupplementaryIndexToWeakCofacts(claimReview, q, arr) {
  const latinPrefer = fcaSelectionLooksMostlyLatin(q);
  if (
    !claimReview?.fcaCofacts ||
    (!latinPrefer && fcaHasCofactsVerdictReplySummary(claimReview))
  ) {
    return claimReview;
  }
  let passing = fcaIndexHitsPassingSelection(q, arr);
  if (!passing.length) {
    const list = Array.isArray(arr) ? arr : [];
    const loose = list.filter(
      (top) =>
        top?.claimReview?.[0] && fcaIndexHitTwTrustedSupplementGate(q, top)
    );
    loose.sort((a, b) => {
      const at = fcaIndexHitUrlLower(a).includes("tfc-taiwan.org.tw") ? 1 : 0;
      const bt = fcaIndexHitUrlLower(b).includes("tfc-taiwan.org.tw") ? 1 : 0;
      if (bt !== at) return bt - at;
      return (Number(b.__score) || 0) - (Number(a.__score) || 0);
    });
    if (loose.length) passing = loose;
  }
  if (!passing.length) return claimReview;
  const enriched = fcaEnrichIndexTopClaimReview(passing[0], q);
  if (!enriched) return claimReview;
  const supStatus = fcaSupplementaryEffectiveFcaStatus(enriched);
  const supOverlap = Number(enriched?.fcaIndexRelevance?.overlap) || 0;
  if (
    latinPrefer &&
    fcaHasCofactsVerdictReplySummary(claimReview) &&
    supStatus !== "Gray" &&
    supOverlap >= 0.16
  ) {
    claimReview.fcaPreferIndexOverCofacts = true;
  }
  claimReview.fcaSupplementaryIndexReview = enriched;
  fcaLog("Supplementary index hit alongside weak Cofacts", {
    url: enriched.url,
    tfc: fcaIndexHitUrlLower(passing[0]).includes("tfc-taiwan.org.tw")
  });
  return claimReview;
}

function fcaDedupeIndexClaims(arr) {
  const map = new Map();
  for (const c of arr || []) {
    const u = String(c?.claimReview?.[0]?.url || "")
      .trim()
      .toLowerCase();
    const key = u || String(c?.text || "").trim().slice(0, 160);
    if (!key) continue;
    const sc = Number(c?.__score) || 0;
    const prev = map.get(key);
    const sp = Number(prev?.__score) || 0;
    if (!prev || sc > sp) map.set(key, c);
  }
  return [...map.values()].sort(
    (a, b) => (Number(b.__score) || 0) - (Number(a.__score) || 0)
  );
}

/**
 * 長標題／整段反白常讓索引 0 筆；用主題種子與中文片語再查，合併後供補充命中（TFC 等）。
 */
async function fcaExpandIndexCandidatesForSupplement(q, preferLatest, seedArr) {
  let merged = fcaDedupeIndexClaims(Array.isArray(seedArr) ? [...seedArr] : []);
  const qn = String(q || "").replace(/\s+/g, " ").trim();
  if (!qn) return merged;
  const tried = new Set();
  const tryQuery = async (raw) => {
    const t = String(raw || "").replace(/\s+/g, " ").trim();
    if (t.length < 5) return;
    const sig = t.slice(0, 200);
    if (tried.has(sig)) return;
    tried.add(sig);
    const r = await fcaQueryFactcheckDeduped(t, preferLatest);
    const chunk = Array.isArray(r) ? r : [];
    merged = fcaDedupeIndexClaims([...merged, ...chunk]);
  };
  await tryQuery(qn);
  if (merged.length >= 2) return merged;
  const th = fcaExtractCofactsThematicSeed(qn);
  if (th && th.length >= 5 && th !== qn.slice(0, th.length)) await tryQuery(th);
  const zhRuns = qn.match(/[\u4e00-\u9fff]{5,22}/g);
  if (zhRuns) {
    const uniq = [...new Set(zhRuns)];
    for (const run of uniq.slice(0, 6)) {
      if (merged.length >= 5) break;
      await tryQuery(run);
    }
  }
  if (merged.length) return merged;
  if (qn.length > 26) await tryQuery(qn.slice(0, 28).trim());
  if (qn.length > 44) await tryQuery(qn.slice(0, 48).trim());
  return merged;
}

async function fcaWeakCofactsPackWithSupplementaryIndex(
  pack,
  q,
  arr,
  preferLatest
) {
  if (!pack?.claimReview) return pack;
  if (fcaHasCofactsVerdictReplySummary(pack.claimReview)) return pack;
  const expanded = await fcaExpandIndexCandidatesForSupplement(
    q,
    preferLatest,
    arr
  );
  pack.claimReview = fcaAttachSupplementaryIndexToWeakCofacts(
    pack.claimReview,
    q,
    expanded
  );
  return pack;
}

/**
 * 與 popup 相同資料來源：background `queryFactCheckSmart`（多機構查核索引）。
 * @returns {{ finalStatus: string, claimReview: object|null, error: string }}
 */
async function fetchFactCheckToolTopClaim(searchText, opts = {}) {
  const preferLatest = Boolean(opts.preferLatest);
  const q = String(searchText || "").trim();
  if (!q) {
    return { finalStatus: "Yellow", claimReview: null, error: "" };
  }
  try {
    const result = await fcaQueryFactcheckDeduped(q, preferLatest);
    let arr = Array.isArray(result) ? [...result] : [];
    if (!arr.length) {
      const cofPack = await fetchCofactsAsFallback(
        q,
        preferLatest,
        "cofacts fallback after empty index"
      );
      if (cofPack) {
        return await fcaWeakCofactsPackWithSupplementaryIndex(
          cofPack,
          q,
          arr,
          preferLatest
        );
      }
      return { finalStatus: "Yellow", claimReview: null, error: "" };
    }
    if (preferLatest) {
      arr.sort((a, b) => {
        const da = new Date(a?.claimReview?.[0]?.reviewDate || 0).getTime();
        const db = new Date(b?.claimReview?.[0]?.reviewDate || 0).getTime();
        if (db !== da) return db - da;
        return (Number(b.__score) || 0) - (Number(a.__score) || 0);
      });
    }
    const passing = fcaIndexHitsPassingSelection(q, arr);
    const top = passing[0];
    if (top) {
      const cr = top?.claimReview?.[0] ?? null;
      const finalStatus = top?.fcaStatus || "Yellow";
      if (!cr) {
        const cofPack = await fetchCofactsAsFallback(
          q,
          preferLatest,
          "cofacts fallback after missing claimReview"
        );
        if (cofPack) {
          return await fcaWeakCofactsPackWithSupplementaryIndex(
            cofPack,
            q,
            arr,
            preferLatest
          );
        }
        return { finalStatus, claimReview: null, error: "" };
      }
      const enriched = fcaEnrichIndexTopClaimReview(top, q);
      if (!enriched) {
        const cofPack = await fetchCofactsAsFallback(
          q,
          preferLatest,
          "cofacts fallback after enrich failed"
        );
        if (cofPack) {
          return await fcaWeakCofactsPackWithSupplementaryIndex(
            cofPack,
            q,
            arr,
            preferLatest
          );
        }
        return { finalStatus: "Yellow", claimReview: null, error: "" };
      }
      return { finalStatus, claimReview: enriched, error: "" };
    }

    fcaLog("index: no hit passed selection", { n: arr.length, qLen: q.length });
    const cofPack = await fetchCofactsAsFallback(
      q,
      preferLatest,
      "cofacts fallback after index relevance fail"
    );
    if (cofPack) {
      return await fcaWeakCofactsPackWithSupplementaryIndex(
        cofPack,
        q,
        arr,
        preferLatest
      );
    }
    return { finalStatus: "Yellow", claimReview: null, error: "" };
  } catch (e) {
    return {
      finalStatus: "Yellow",
      claimReview: null,
      error: String(e?.message || e)
    };
  }
}

function fcaSidebarGetRightReservedPx() {
  if (!fcaSidebarHost?.isConnected) return 0;
  if (fcaSidebarHost.classList.contains("fca-sb-strip")) {
    return FCA_SIDEBAR_STRIP_PX + 8;
  }
  try {
    const r = fcaSidebarHost.getBoundingClientRect();
    const vw = window.innerWidth;
    const overlap = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    return Math.min(Math.ceil(overlap) + 4, Math.floor(vw * 0.5));
  } catch {
    return 0;
  }
}

/** 右側側欄為完整寬度（非窄條）時，與浮動大卡視為「詳細查核」主介面，左側浮窗改為小圖示。 */
function fcaSidebarIsFullExpanded() {
  return Boolean(
    fcaSidebarHost?.isConnected &&
      !fcaSidebarHost.classList.contains("fca-sb-strip")
  );
}

function fcaSidebarUpdateToggleChrome() {
  if (!fcaSidebarShadow) return;
  const edge = fcaSidebarShadow.getElementById("sbEdgeToggle");
  const headBtn = fcaSidebarShadow.getElementById("sbHeaderCollapse");
  if (!edge || !headBtn) return;
  if (fcaSidebarUserCollapsed) {
    edge.style.display = "flex";
    headBtn.style.display = "none";
    edge.textContent = "⟩";
    edge.setAttribute("aria-label", "展開側欄");
    edge.disabled = false;
    edge.style.opacity = "1";
    edge.style.pointerEvents = "auto";
  } else {
    edge.style.display = "none";
    headBtn.style.display = "flex";
  }
}

function fcaSidebarSyncLayout() {
  if (!fcaSidebarHost?.isConnected) return;

  try {
    fcaSidebarHost.style.width = FCA_SIDEBAR_OUTER_WIDTH_CSS;
  } catch {
    /* ignore */
  }

  if (fcaSidebarUserCollapsed) {
    fcaSidebarHost.classList.add("fca-sb-strip");
    fcaSidebarHost.style.transform = `translateX(calc(100% - ${FCA_SIDEBAR_STRIP_PX}px))`;
    fcaSidebarHost.style.opacity = "0.9";
    fcaSidebarHost.style.transition =
      "transform 0.32s cubic-bezier(0.25,0.82,0.28,1),opacity 0.28s ease";
    fcaSidebarHost.setAttribute(
      "title",
      "側欄已收合；點右緣「展開」或使用標題列「收合／展開」。"
    );
  } else {
    fcaSidebarHost.classList.remove("fca-sb-strip");
    fcaSidebarHost.style.transform = "translateX(0)";
    fcaSidebarHost.style.opacity = "";
    fcaSidebarHost.removeAttribute("title");
  }
  fcaSidebarUpdateToggleChrome();
  fcaPanelRefreshDualUiMode();
}

const FCA_SIDEBAR_STORAGE_KEY = "fcaSidebarHistory";
const FCA_SIDEBAR_THEME_KEY = "fcaSidebarTheme";

async function fcaSidebarLoadTheme() {
  try {
    const bag = await fcaStorageLocalGet(FCA_SIDEBAR_THEME_KEY);
    // 預設與統一外觀：淺色（與截圖一致）；僅在使用者明確選「深色」時為 dark
    return bag[FCA_SIDEBAR_THEME_KEY] === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function fcaSidebarApplyThemeClass(shadowEl, theme) {
  const r = shadowEl?.getElementById?.("sbRoot");
  if (!r) return;
  const isLight = theme === "light";
  r.classList.toggle("theme-light", isLight);
  const btn = shadowEl.getElementById("sbThemeToggle");
  if (btn) {
    btn.textContent = isLight ? "深色" : "淺色";
    btn.setAttribute(
      "aria-label",
      isLight ? "切換為深色（iOS 風 Liquid Glass）" : "切換為淺色（iOS 風 Liquid Glass）"
    );
    btn.title = isLight ? "切換為深色" : "切換為淺色（iOS 風玻璃）";
  }
}

function fcaSidebarSyncTriggerPinButton() {
  const btn = fcaSidebarShadow?.getElementById("sbTriggerPinToggle");
  if (!btn) return;
  btn.setAttribute("aria-pressed", fcaTriggerPinCorner ? "true" : "false");
  btn.classList.toggle("is-active", fcaTriggerPinCorner);
}

function fcaSidebarSyncSettingsPanel() {
  if (!fcaSidebarEls) return;
  const open = Boolean(fcaSidebarSettingsOpen);
  if (fcaSidebarEls.settingsPanel) {
    fcaSidebarEls.settingsPanel.style.display = open ? "" : "none";
  }
  if (fcaSidebarEls.settingsToggle) {
    fcaSidebarEls.settingsToggle.setAttribute("aria-pressed", open ? "true" : "false");
    fcaSidebarEls.settingsToggle.classList.toggle("active", open);
    fcaSidebarEls.settingsToggle.setAttribute("aria-label", open ? "收合設定" : "開啟設定");
    fcaSidebarEls.settingsToggle.setAttribute("title", open ? "收合設定" : "開啟設定");
  }
}

async function fcaSidebarSyncQuickToggles() {
  if (!fcaSidebarEls) return;
  const opts = await fcaGetExtensionLocalOpts();
  const skipGemini = Boolean(opts[FCA_OPT_SKIP_GEMINI]);
  const showNews = opts[FCA_OPT_SHOW_TRUSTED_NEWS] !== false;
  if (fcaSidebarEls.quickGemini) {
    fcaSidebarEls.quickGemini.textContent = skipGemini ? "AI：關" : "AI：開";
    fcaSidebarEls.quickGemini.setAttribute("aria-pressed", skipGemini ? "false" : "true");
    fcaSidebarEls.quickGemini.classList.toggle("active", !skipGemini);
  }
  if (fcaSidebarEls.quickNews) {
    fcaSidebarEls.quickNews.textContent = showNews ? "新聞：開" : "新聞：關";
    fcaSidebarEls.quickNews.setAttribute("aria-pressed", showNews ? "true" : "false");
    fcaSidebarEls.quickNews.classList.toggle("active", showNews);
  }
  if (fcaSidebarEls.quickTrigger) {
    fcaSidebarEls.quickTrigger.textContent = fcaTriggerPinCorner ? "觸發鈕：固定" : "觸發鈕：自動";
    fcaSidebarEls.quickTrigger.setAttribute("aria-pressed", fcaTriggerPinCorner ? "true" : "false");
    fcaSidebarEls.quickTrigger.classList.toggle("active", fcaTriggerPinCorner);
  }
}

/** Bumped on each new panel / re-query to ignore stale async fetches. */
let fcaPanelFetchGeneration = 0;

let fcaSidebarHost = null;
let fcaSidebarShadow = null;
/** @type {null | { queryLine: HTMLElement; relRow: HTMLElement; loadRow: HTMLElement; loadPhaseEl: HTMLElement; loadHpFillEl: HTMLElement; loadHpTrackEl: HTMLElement; emptyEl: HTMLElement; detailEl: HTMLElement; statusChip: HTMLElement; pubEl: HTMLElement; rateEl: HTMLElement; linkEl: HTMLElement; noteEl: HTMLElement; histList: HTMLElement }} */
let fcaSidebarEls = null;
let fcaSidebarLastQuery = "";
let fcaSidebarPreferLatest = false;
let fcaSidebarUiBound = false;
let fcaSidebarAltGen = 0;
let fcaSidebarSettingsOpen = false;
/** YouTube 觀看頁首次建立側欄時預設收成窄條，避免 fixed 寬面板壓住主內容與推薦欄。 */
let fcaSidebarYtAutoStripDone = false;
/** 上一筆側欄呈現狀態（供僅重試新聞、還原查核文案） */
let fcaSidebarLastApplyState = null;

/** 載入時輪播文案：對應實際查核管線（索引、Cofacts、新聞、脈絡、合併）。 */
const FCA_LOAD_SOURCE_PHASES = [
  "正在查詢國際查核索引（Google Fact Check Tools）…",
  "正在比對補充關鍵字與本機快取…",
  "正在連線 Cofacts 社群資料庫…",
  "正在彙整可信即時新聞…",
  "正在分析頁面與媒體來源…",
  "正在合併結果並排序相關度…"
];
let fcaSidebarLoadTicker = null;
let fcaSidebarLoadHpTicker = null;
let fcaSidebarTypewriterToken = 0;

function fcaSidebarQuerySnippet(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "尚無查詢";
  const show = t.length > 56 ? `${t.slice(0, 56)}…` : t;
  return show;
}

function fcaSidebarTipForStatus(statusKey) {
  const k = fcaNormalizeLegacyYellowStatus(statusKey);
  const m = {
    Green: "查核判定為正確仍請打開原文，並交叉比對其他權威來源。",
    Red: "查核判定為不實：請打開原文確認論點與引用是否完整。",
    Orange: "查核判定為部分錯誤或具誤導性，請留意是否斷章取義。",
    Gray: "目前無法證實：可改選較短關鍵句，或至 Cofacts 等平台查證。",
    Blue: "事實釐清：請閱讀查核全文以掌握背景與脈絡，勿僅以單句標籤理解。"
  };
  return m[k] || m.Gray;
}

function fcaSidebarAnimateVerdictReasonTyping() {
  const host = fcaSidebarEls?.rateEl;
  if (!host) return;
  const mainBlock = host.querySelector(
    ".sb-verdict-block:not(.sb-verdict-block--supp)"
  );
  if (mainBlock?.querySelector(".sb-verdict-reason-fold")) return;
  const reasonEl =
    mainBlock?.querySelector(".sb-verdict-reason") ||
    host.querySelector(".sb-verdict-reason");
  if (!reasonEl) return;
  const full = String(reasonEl.textContent || "");
  const compactLen = full.replace(/\s/g, "").length;
  if (compactLen < 18) return;
  const token = ++fcaSidebarTypewriterToken;
  reasonEl.textContent = "";
  const charsPerTick = compactLen > 220 ? 3 : 2;
  const tickMs = compactLen > 220 ? 13 : 16;
  let i = 0;
  const tick = () => {
    if (token !== fcaSidebarTypewriterToken) return;
    i = Math.min(full.length, i + charsPerTick);
    reasonEl.textContent = full.slice(0, i);
    if (i < full.length) {
      setTimeout(tick, tickMs);
    }
  };
  tick();
}

function ensureFcSidebar() {
  if (!fcaIsUiTopWindow()) return;
  if (fcaSidebarHost?.isConnected) {
    fcaSidebarSyncLayout();
    return;
  }

  const host = document.createElement("div");
  host.setAttribute("data-fca-sidebar-host", "1");
  host.style.cssText = [
    "position:fixed",
    "top:0",
    "bottom:0",
    "right:0",
    `width:${FCA_SIDEBAR_OUTER_WIDTH_CSS}`,
    `z-index:${FCA_Z_SIDEBAR}`,
    "pointer-events:none",
    "font-family:system-ui,-apple-system,'Segoe UI',sans-serif",
    "transition:transform 0.28s ease",
    "transform:translateX(100%)"
  ].join(";");

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      button:focus-visible,
      a.ref:focus-visible {
        outline: 2px solid rgba(147, 197, 253, 0.95);
        outline-offset: 2px;
      }
      .root.theme-light button:focus-visible,
      .root.theme-light a.ref:focus-visible {
        outline-color: rgba(37, 99, 235, 0.92);
      }
      .sb-error-wrap {
        text-align: left;
        max-width: 100%;
      }
      .sb-error-msg {
        margin: 0 0 12px;
        color: rgba(255, 255, 255, 0.84);
        line-height: 1.55;
      }
      .root.theme-light .sb-error-msg {
        color: rgba(55, 65, 81, 0.95);
      }
      #sbRetryFull,
      #sbRetryNewsOnly { width: 100%; }
      .sb-error-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 4px;
      }
      .btn-page-ghost {
        background: rgba(255, 255, 255, 0.1) !important;
        border: 0.55px solid rgba(255, 255, 255, 0.32) !important;
      }
      .root.theme-light .btn-page-ghost {
        background: rgba(255, 255, 255, 0.52) !important;
        border: 1px solid rgba(0, 0, 0, 0.08) !important;
      }
      .sb-trigger-pin {
        margin-left: 6px;
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 600;
        border-radius: 10px;
        border: 0.55px solid rgba(255, 255, 255, 0.32);
        background: rgba(255, 255, 255, 0.11);
        color: rgba(255, 255, 255, 0.86);
        cursor: pointer;
        backdrop-filter: blur(52px) saturate(195%);
        -webkit-backdrop-filter: blur(52px) saturate(195%);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
      }
      .sb-trigger-pin.is-active {
        border-color: rgba(52, 211, 153, 0.45);
        background: rgba(16, 185, 129, 0.12);
        color: rgba(167, 243, 208, 0.98);
      }
      .root.theme-light .sb-trigger-pin {
        border-color: rgba(0, 0, 0, 0.1);
        background: rgba(255, 255, 255, 0.62);
        color: rgba(28, 28, 34, 0.9);
      }
      .root.theme-light .sb-trigger-pin.is-active {
        border-color: rgba(5, 150, 105, 0.45);
        background: rgba(16, 185, 129, 0.12);
        color: rgba(4, 120, 87, 0.95);
      }
      @keyframes fca-sk-pulse {
        0%,
        100% {
          opacity: 0.42;
        }
        50% {
          opacity: 0.92;
        }
      }
      .fca-news-sk-line {
        height: 11px;
        border-radius: 5px;
        background: rgba(148, 163, 184, 0.55);
        animation: fca-sk-pulse 1.12s ease-in-out infinite;
      }
      .root.theme-light .fca-news-sk-line {
        background: rgba(100, 116, 139, 0.4);
      }
      .sb-reason-details {
        margin-top: 6px;
        border-radius: 18px;
        border: 0.55px solid rgba(255, 255, 255, 0.32);
        background: rgba(255, 255, 255, 0.12);
        backdrop-filter: blur(56px) saturate(195%);
        -webkit-backdrop-filter: blur(56px) saturate(195%);
        padding: 6px 8px;
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.4),
          0 4px 16px rgba(0, 0, 0, 0.08);
      }
      .root.theme-light .sb-reason-details {
        border-color: rgba(0, 0, 0, 0.08);
        background: rgba(255, 255, 255, 0.82);
        backdrop-filter: blur(52px) saturate(200%);
        -webkit-backdrop-filter: blur(52px) saturate(200%);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
      }
      .sb-reason-details summary {
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        color: rgba(147, 197, 253, 0.95);
        user-select: none;
      }
      .root.theme-light .sb-reason-details summary {
        color: rgba(37, 99, 235, 0.95);
      }
      .sb-reason-body {
        margin-top: 8px;
        font-size: 12px;
        line-height: 1.55;
        white-space: pre-wrap;
        color: rgba(255, 255, 255, 0.88);
      }
      .root.theme-light .sb-reason-body {
        color: rgba(30, 41, 59, 0.92);
      }
      .sb-verdict-preview {
        font-size: 12px;
        line-height: 1.55;
        opacity: 0.92;
      }
      .sb-verdict-block--aux {
        margin-top: 10px;
      }
      .sb-verdict-block--supp {
        margin-top: 12px;
        padding: 10px 12px;
        border-radius: 14px;
        background: rgba(99, 102, 241, 0.12);
        border: 0.55px solid rgba(165, 180, 252, 0.45);
      }
      .root.theme-light .sb-verdict-block--supp {
        background: rgba(238, 242, 255, 0.95);
        border-color: rgba(129, 140, 248, 0.35);
      }
      .sb-supp-lead {
        font-size: 11px;
        line-height: 1.5;
        margin-bottom: 8px;
        opacity: 0.9;
      }
      .root.theme-light .sb-supp-lead {
        color: rgba(30, 41, 59, 0.88);
      }
      .sb-verdict-news {
        margin-top: 10px;
        padding: 10px 12px;
        border-radius: 18px;
        font-size: 11px;
        line-height: 1.5;
        color: rgba(255, 255, 255, 0.88);
        background: rgba(255, 255, 255, 0.1);
        border: 0.55px solid rgba(255, 255, 255, 0.28);
      }
      .sb-verdict-news-title {
        font-weight: 700;
        margin-bottom: 6px;
        color: rgba(255, 255, 255, 0.92);
      }
      .sb-verdict-news-line {
        margin-top: 4px;
        word-break: break-word;
      }
      .sb-verdict-news-line .ref {
        color: rgba(186, 230, 253, 0.98);
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .root.theme-light .sb-verdict-news {
        color: rgba(30, 41, 59, 0.9);
        background: rgba(255, 255, 255, 0.72);
        border-color: rgba(0, 0, 0, 0.08);
      }
      .root.theme-light .sb-verdict-news-title {
        color: rgba(15, 23, 42, 0.92);
      }
      .root.theme-light .sb-verdict-news-line .ref {
        color: #1d4ed8;
      }
      .sb-relevance-row {
        display: none;
        margin: 6px 0 8px;
        padding: 8px 11px;
        font-size: 11px;
        line-height: 1.45;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: rgba(226, 240, 255, 0.94);
        border-radius: 18px;
        border: 0.55px solid rgba(255, 255, 255, 0.32);
        background: rgba(255, 255, 255, 0.12);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.4),
          0 6px 20px rgba(0, 0, 0, 0.1);
        backdrop-filter: blur(56px) saturate(195%);
        -webkit-backdrop-filter: blur(56px) saturate(195%);
      }
      .sb-relevance-row.is-visible {
        display: block;
      }
      .root.theme-light .sb-relevance-row {
        color: rgba(30, 58, 95, 0.92);
        border-color: rgba(0, 0, 0, 0.08);
        background: linear-gradient(
          145deg,
          rgba(255, 255, 255, 0.92) 0%,
          rgba(250, 251, 253, 0.88) 100%
        );
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
        backdrop-filter: saturate(220%) blur(56px);
        -webkit-backdrop-filter: saturate(220%) blur(56px);
      }

      .fca-domain-scan {
        margin-top: 10px;
        padding: 11px 12px;
        border-radius: 22px;
        font-size: 12px;
        line-height: 1.55;
        border: 0.55px solid rgba(125, 211, 252, 0.42);
        background: linear-gradient(
          155deg,
          rgba(56, 189, 248, 0.18) 0%,
          rgba(25, 35, 58, 0.55) 100%
        );
        backdrop-filter: blur(64px) saturate(205%);
        -webkit-backdrop-filter: blur(64px) saturate(205%);
        color: rgba(224, 242, 254, 0.96);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.38),
          0 10px 34px rgba(0, 0, 0, 0.14);
      }
      .fca-domain-scan__title {
        font-weight: 700;
        margin-bottom: 6px;
        color: rgba(186, 230, 253, 0.98);
        font-size: 12px;
        letter-spacing: 0.02em;
      }
      .fca-domain-scan__hint {
        font-size: 11px;
        margin-bottom: 8px;
        color: rgba(147, 197, 253, 0.85);
        line-height: 1.45;
      }
      .fca-domain-scan__row {
        margin-bottom: 6px;
      }
      .fca-domain-scan__meta {
        margin-bottom: 6px;
        font-size: 11px;
        color: rgba(148, 163, 184, 0.88);
      }
      .fca-domain-scan__body {
        margin-top: 2px;
      }
      .fca-domain-scan__code {
        font-size: 11px;
        padding: 2px 7px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.18);
        border: 0.55px solid rgba(255, 255, 255, 0.38);
      }

      .fca-realtime-news {
        margin-top: 10px;
        padding: 12px 14px;
        border-radius: 22px;
        font-size: 12px;
        line-height: 1.55;
        border: 0.55px solid rgba(255, 255, 255, 0.32);
        background: linear-gradient(
          160deg,
          rgba(255, 255, 255, 0.24) 0%,
          rgba(28, 32, 48, 0.58) 100%
        );
        backdrop-filter: blur(64px) saturate(200%);
        -webkit-backdrop-filter: blur(64px) saturate(200%);
        color: rgba(241, 245, 249, 0.94);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.45),
          0 10px 34px rgba(0, 0, 0, 0.13);
      }
      .fca-realtime-news__title {
        font-weight: 700;
        margin-bottom: 6px;
        color: rgba(248, 250, 252, 0.95);
        font-size: 12px;
      }
      .fca-realtime-news__hint {
        font-size: 11px;
        margin-bottom: 8px;
        color: rgba(203, 213, 225, 0.82);
        line-height: 1.45;
      }
      .fca-realtime-news__digest {
        font-size: 11px;
        margin-bottom: 8px;
        color: rgba(226, 232, 240, 0.94);
        line-height: 1.45;
      }
      .fca-realtime-news--embedded-in-ai {
        margin-top: 0;
        padding: 10px 11px;
        border-radius: 14px;
      }
      .fca-realtime-news__embed-lead {
        font-size: 11px;
        line-height: 1.45;
        margin-bottom: 8px;
        padding: 6px 8px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.08);
        border: 0.55px solid rgba(255, 255, 255, 0.14);
        color: rgba(237, 233, 254, 0.92);
      }
      .fca-realtime-news__list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .fca-realtime-news__pending,
      .fca-realtime-news__empty {
        font-size: 11px;
        color: rgba(148, 163, 184, 0.9);
      }
      .fca-news-sk {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .fca-realtime-news__link {
        margin-top: 0;
      }

      .fca-ai-summary {
        margin-top: 10px;
        padding: 11px 12px;
        border-radius: 22px;
        font-size: 12px;
        line-height: 1.55;
        border: 0.55px solid rgba(167, 139, 250, 0.45);
        background: linear-gradient(
          155deg,
          rgba(139, 92, 246, 0.2) 0%,
          rgba(30, 27, 55, 0.52) 100%
        );
        backdrop-filter: blur(64px) saturate(205%);
        -webkit-backdrop-filter: blur(64px) saturate(205%);
        color: rgba(237, 233, 254, 0.96);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.35),
          0 10px 34px rgba(0, 0, 0, 0.14);
      }
      .fca-ai-summary__title {
        font-weight: 700;
        margin-bottom: 6px;
        color: rgba(221, 214, 254, 0.98);
        font-size: 12px;
        letter-spacing: 0.02em;
      }
      .fca-ai-summary__hint {
        font-size: 11px;
        margin-bottom: 8px;
        color: rgba(221, 214, 254, 0.96);
        line-height: 1.45;
      }
      .fca-ai-summary__rule {
        font-size: 11px;
        line-height: 1.45;
        margin: -2px 0 8px;
        padding: 7px 9px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.08);
        border: 0.55px solid rgba(255, 255, 255, 0.16);
        color: rgba(237, 233, 254, 0.96);
      }
      .fca-ai-summary__news {
        margin-top: 6px;
        padding-top: 8px;
        border-top: 0.55px solid rgba(255, 255, 255, 0.14);
      }
      .fca-ai-summary__news .fca-realtime-news {
        margin-top: 0;
      }
      .fca-ai-summary--news-only {
        margin-top: 6px;
        padding: 8px 10px 10px;
      }
      .fca-ai-summary--news-only .fca-ai-summary__title {
        margin-bottom: 4px;
        font-size: 11px;
        font-weight: 600;
      }
      .fca-ai-summary--news-only .fca-ai-summary__news {
        margin-top: 0;
        padding-top: 0;
        border-top: none;
      }
      .fca-ai-summary__body {
        white-space: pre-wrap;
        word-break: break-word;
        color: rgba(255, 255, 255, 0.98);
      }
      .fca-ai-summary__more {
        margin-top: 6px;
        padding: 6px 8px 8px;
        border-radius: 12px;
        background: rgba(0, 0, 0, 0.12);
        border: 0.55px solid rgba(255, 255, 255, 0.12);
      }
      .fca-ai-summary__more > summary {
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        color: rgba(233, 213, 255, 0.95);
        list-style: none;
      }
      .fca-ai-summary__more > summary::-webkit-details-marker {
        display: none;
      }
      .fca-ai-summary__body--full {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 0.55px solid rgba(255, 255, 255, 0.14);
        white-space: pre-wrap;
        word-break: break-word;
        color: rgba(255, 255, 255, 0.96);
      }
      .fca-ai-summary__cofacts-fold {
        margin-top: 6px;
        padding: 6px 8px 8px;
        border-radius: 14px;
        border: 0.55px solid rgba(167, 139, 250, 0.28);
        background: rgba(30, 27, 55, 0.35);
      }
      .fca-ai-summary__cofacts-fold > summary {
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        color: rgba(233, 213, 255, 0.95);
        list-style: none;
      }
      .fca-ai-summary__cofacts-fold > summary::-webkit-details-marker {
        display: none;
      }
      .fca-ai-summary__cofacts-fold .fca-ai-summary {
        margin-top: 8px;
      }
      .fca-ai-summary__tag {
        font-weight: 600;
        color: rgba(233, 213, 255, 0.98);
      }
      .fca-ai-summary__diag {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 0.55px solid rgba(255, 255, 255, 0.14);
        font-size: 10px;
        line-height: 1.35;
        color: rgba(226, 232, 240, 0.6);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fca-ai-summary__actions {
        margin-top: 8px;
        display: flex !important;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 6px;
        visibility: visible !important;
        opacity: 1 !important;
      }
      .fca-ai-summary__fix {
        cursor: pointer;
        font: 11px/1 system-ui, -apple-system, sans-serif;
        font-weight: 600;
        padding: 7px 10px;
        border-radius: 999px;
        border: 0.55px solid rgba(255, 255, 255, 0.28);
        background: rgba(255, 255, 255, 0.12);
        color: rgba(245, 243, 255, 0.95);
        display: inline-flex !important;
        align-items: center;
        justify-content: center;
        visibility: visible !important;
        opacity: 1 !important;
        backdrop-filter: blur(38px) saturate(180%);
        -webkit-backdrop-filter: blur(38px) saturate(180%);
        transition: background 0.18s ease, border-color 0.18s ease, transform 0.12s ease;
      }
      .fca-ai-summary__fix:hover {
        background: rgba(255, 255, 255, 0.18);
        border-color: rgba(255, 255, 255, 0.36);
        transform: translateY(-1px);
      }
      .fca-ai-summary--inactive {
        opacity: 0.9;
        filter: saturate(0.92);
      }
      .fca-ai-summary--inactive .fca-ai-summary__body {
        color: rgba(226, 232, 240, 0.88);
      }
      .root.theme-light .fca-ai-summary--inactive .fca-ai-summary__body {
        color: rgba(51, 65, 85, 0.86);
      }

      .root.theme-light .fca-domain-scan {
        border-color: rgba(14, 165, 233, 0.22);
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.94) 0%,
          rgba(248, 252, 255, 0.9) 52%,
          rgba(255, 255, 255, 0.88) 100%
        );
        color: rgba(12, 74, 110, 0.88);
        backdrop-filter: blur(60px) saturate(220%);
        -webkit-backdrop-filter: blur(60px) saturate(220%);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.65),
          0 10px 32px rgba(15, 23, 42, 0.08);
      }
      .root.theme-light .fca-domain-scan__title {
        color: rgba(7, 89, 133, 0.94);
      }
      .root.theme-light .fca-domain-scan__hint {
        color: rgba(3, 105, 161, 0.78);
      }
      .root.theme-light .fca-domain-scan__meta {
        color: rgba(71, 85, 105, 0.85);
      }
      .root.theme-light .fca-domain-scan__code {
        background: rgba(255, 255, 255, 0.45);
        border-color: rgba(14, 165, 233, 0.22);
        color: rgba(12, 74, 110, 0.95);
      }

      .root.theme-light .fca-realtime-news {
        border-color: rgba(0, 0, 0, 0.07);
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.94) 0%,
          rgba(252, 252, 254, 0.9) 100%
        );
        color: rgba(30, 41, 59, 0.9);
        backdrop-filter: blur(58px) saturate(215%);
        -webkit-backdrop-filter: blur(58px) saturate(215%);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.72),
          0 10px 30px rgba(15, 23, 42, 0.07);
      }
      .root.theme-light .fca-realtime-news__title {
        color: rgba(15, 23, 42, 0.92);
      }
      .root.theme-light .fca-realtime-news__digest {
        color: rgba(51, 65, 85, 0.9);
      }
      .root.theme-light .fca-realtime-news__hint {
        color: rgba(71, 85, 105, 0.82);
      }
      .root.theme-light .fca-realtime-news__embed-lead {
        background: rgba(248, 250, 252, 0.96);
        border-color: rgba(0, 0, 0, 0.06);
        color: rgba(51, 65, 85, 0.92);
      }
      .root.theme-light .fca-realtime-news__pending,
      .root.theme-light .fca-realtime-news__empty {
        color: rgba(100, 116, 139, 0.88);
      }
      .root.theme-light .fca-ai-summary {
        border-color: rgba(124, 58, 237, 0.22);
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.95) 0%,
          rgba(253, 251, 255, 0.9) 52%,
          rgba(255, 255, 255, 0.88) 100%
        );
        color: rgba(49, 46, 129, 0.9);
        backdrop-filter: blur(60px) saturate(218%);
        -webkit-backdrop-filter: blur(60px) saturate(218%);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.7),
          0 10px 32px rgba(15, 23, 42, 0.08);
      }
      .root.theme-light .fca-ai-summary__title {
        color: rgba(76, 29, 149, 0.92);
      }
      .root.theme-light .fca-ai-summary__hint {
        color: rgba(76, 29, 149, 0.88);
      }
      .root.theme-light .fca-ai-summary__rule {
        background: rgba(124, 58, 237, 0.06);
        border-color: rgba(124, 58, 237, 0.14);
        color: rgba(67, 56, 202, 0.92);
      }
      .root.theme-light .fca-ai-summary__news {
        border-top-color: rgba(0, 0, 0, 0.08);
      }
      .root.theme-light .fca-ai-summary--news-only .fca-ai-summary__news {
        border-top: none;
      }
      .root.theme-light .fca-ai-summary__body {
        color: rgba(30, 27, 75, 0.98);
      }
      .root.theme-light .fca-ai-summary__more {
        background: rgba(248, 250, 252, 0.92);
        border-color: rgba(0, 0, 0, 0.06);
      }
      .root.theme-light .fca-ai-summary__more > summary {
        color: rgba(67, 56, 202, 0.92);
      }
      .root.theme-light .fca-ai-summary__body--full {
        border-top-color: rgba(0, 0, 0, 0.08);
        color: rgba(30, 27, 75, 0.96);
      }
      .root.theme-light .fca-ai-summary__cofacts-fold {
        background: rgba(248, 250, 252, 0.88);
        border-color: rgba(124, 58, 237, 0.14);
      }
      .root.theme-light .fca-ai-summary__cofacts-fold > summary {
        color: rgba(67, 56, 202, 0.92);
      }
      .root.theme-light .fca-ai-summary__tag {
        color: rgba(76, 29, 149, 0.95);
      }
      .root.theme-light .fca-ai-summary__diag {
        border-top-color: rgba(0, 0, 0, 0.08);
        color: rgba(71, 85, 105, 0.7);
      }

      /* 經典輔助區塊（與早期側欄相近：扁平、少漸層） */
      .fca-domain-scan.fca-aux-classic,
      .fca-realtime-news.fca-aux-classic,
      .fca-ai-summary.fca-aux-classic {
        border-radius: 10px;
        padding: 10px 12px;
        margin-top: 12px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.06);
        backdrop-filter: blur(16px) saturate(150%);
        -webkit-backdrop-filter: blur(16px) saturate(150%);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
      }
      .fca-domain-scan.fca-aux-classic .fca-domain-scan__title,
      .fca-realtime-news.fca-aux-classic .fca-realtime-news__title,
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__title {
        margin-bottom: 6px;
        color: rgba(255, 255, 255, 0.9);
        letter-spacing: 0;
      }
      .fca-domain-scan.fca-aux-classic .fca-domain-scan__hint,
      .fca-realtime-news.fca-aux-classic .fca-realtime-news__hint,
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__hint {
        color: rgba(255, 255, 255, 0.52);
      }
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__rule {
        background: rgba(0, 0, 0, 0.2);
        border-color: rgba(255, 255, 255, 0.12);
        color: rgba(226, 232, 240, 0.9);
      }
      .fca-domain-scan.fca-aux-classic .fca-domain-scan__row,
      .fca-domain-scan.fca-aux-classic .fca-domain-scan__body {
        color: rgba(255, 255, 255, 0.72);
      }
      .fca-domain-scan.fca-aux-classic .fca-domain-scan__meta {
        color: rgba(255, 255, 255, 0.48);
      }
      .fca-domain-scan.fca-aux-classic .fca-domain-scan__code {
        background: rgba(0, 0, 0, 0.22);
        border-color: rgba(255, 255, 255, 0.14);
        color: rgba(255, 255, 255, 0.88);
      }
      .fca-realtime-news.fca-aux-classic .fca-realtime-news__pending,
      .fca-realtime-news.fca-aux-classic .fca-realtime-news__empty {
        color: rgba(255, 255, 255, 0.48);
      }
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__body {
        color: rgba(255, 255, 255, 0.88);
      }
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__tag {
        color: rgba(196, 210, 255, 0.95);
      }
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__diag {
        border-top-color: rgba(255, 255, 255, 0.12);
        color: rgba(255, 255, 255, 0.45);
        white-space: normal;
      }
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__fix {
        border-radius: 8px;
        padding: 6px 10px;
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.22);
      }
      .root.theme-light .fca-domain-scan.fca-aux-classic,
      .root.theme-light .fca-realtime-news.fca-aux-classic,
      .root.theme-light .fca-ai-summary.fca-aux-classic {
        border-color: rgba(0, 0, 0, 0.1);
        background: rgba(255, 255, 255, 0.78);
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
      }
      .root.theme-light .fca-domain-scan.fca-aux-classic .fca-domain-scan__title,
      .root.theme-light .fca-realtime-news.fca-aux-classic .fca-realtime-news__title,
      .root.theme-light .fca-ai-summary.fca-aux-classic .fca-ai-summary__title {
        color: rgba(15, 23, 42, 0.92);
      }
      .root.theme-light .fca-domain-scan.fca-aux-classic .fca-domain-scan__hint,
      .root.theme-light .fca-realtime-news.fca-aux-classic .fca-realtime-news__hint,
      .root.theme-light .fca-ai-summary.fca-aux-classic .fca-ai-summary__hint {
        color: rgba(71, 85, 105, 0.78);
      }
      .root.theme-light .fca-ai-summary.fca-aux-classic .fca-ai-summary__rule {
        background: rgba(241, 245, 249, 0.95);
        border-color: rgba(0, 0, 0, 0.08);
        color: rgba(30, 41, 59, 0.9);
      }
      .root.theme-light .fca-domain-scan.fca-aux-classic .fca-domain-scan__row,
      .root.theme-light .fca-domain-scan.fca-aux-classic .fca-domain-scan__body {
        color: rgba(30, 41, 59, 0.88);
      }
      .root.theme-light .fca-domain-scan.fca-aux-classic .fca-domain-scan__meta {
        color: rgba(100, 116, 139, 0.85);
      }
      .root.theme-light .fca-domain-scan.fca-aux-classic .fca-domain-scan__code {
        background: rgba(241, 245, 249, 0.95);
        border-color: rgba(0, 0, 0, 0.08);
        color: rgba(15, 23, 42, 0.9);
      }
      .root.theme-light .fca-realtime-news.fca-aux-classic .fca-realtime-news__pending,
      .root.theme-light .fca-realtime-news.fca-aux-classic .fca-realtime-news__empty {
        color: rgba(100, 116, 139, 0.85);
      }
      .root.theme-light .fca-ai-summary.fca-aux-classic .fca-ai-summary__body {
        color: rgba(30, 27, 75, 0.95);
      }
      .root.theme-light .fca-ai-summary.fca-aux-classic .fca-ai-summary__tag {
        color: rgba(76, 29, 149, 0.9);
      }
      .root.theme-light .fca-ai-summary.fca-aux-classic .fca-ai-summary__diag {
        border-top-color: rgba(0, 0, 0, 0.08);
        color: rgba(71, 85, 105, 0.72);
      }

      .root {
        pointer-events: auto;
        position: relative;
        height: 100%;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-size: 13px;
        line-height: 1.45;
        color: rgba(255, 255, 255, 0.94);
        -webkit-font-smoothing: antialiased;
        text-rendering: optimizeLegibility;
        background: linear-gradient(
          118deg,
          rgba(18, 22, 42, 0.82) 0%,
          rgba(6, 8, 20, 0.84) 38%,
          rgba(12, 10, 32, 0.8) 100%
        );
        backdrop-filter: saturate(238%) blur(112px) brightness(1.05) contrast(1.02);
        -webkit-backdrop-filter: saturate(238%) blur(112px) brightness(1.05) contrast(1.02);
        border-left: 1px solid rgba(255, 255, 255, 0.38);
        box-shadow:
          inset 0 0 0 0.5px rgba(255, 255, 255, 0.14),
          inset 3px 0 64px rgba(255, 255, 255, 0.06),
          inset 1px 0 0 rgba(255, 255, 255, 0.5),
          -20px 0 56px rgba(0, 0, 0, 0.12),
          0 0 96px rgba(99, 102, 241, 0.09),
          0 0 72px rgba(56, 189, 248, 0.07);
      }
      .root::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background:
          radial-gradient(125% 90% at 8% -2%, rgba(255, 255, 255, 0.34) 0%, transparent 54%),
          radial-gradient(100% 75% at 100% 100%, rgba(186, 210, 255, 0.18) 0%, transparent 58%),
          radial-gradient(75% 55% at 72% 10%, rgba(220, 200, 255, 0.08) 0%, transparent 48%),
          linear-gradient(170deg, rgba(255, 255, 255, 0.18) 0%, transparent 40%);
        opacity: 0.58;
      }
      .root::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 120px;
        pointer-events: none;
        background: linear-gradient(
          to top,
          rgba(0, 0, 0, 0.38) 0%,
          transparent 100%
        );
        opacity: 1;
      }
      .scroll {
        position: relative;
        z-index: 1;
        flex: 1;
        overflow: auto;
        overscroll-behavior: contain;
        padding: 16px 14px 24px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.28) rgba(0, 0, 0, 0.22);
      }
      .scroll::-webkit-scrollbar {
        width: 5px;
      }
      .scroll::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 99px;
      }
      .scroll::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.32);
        border-radius: 99px;
      }
      .head-title {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        flex-wrap: wrap;
        width: 100%;
      }
      .head-title h2 { order: 1; }
      .head-title .beta { order: 2; }
      .sb-theme-toggle {
        order: 3;
        margin-left: auto;
        flex-shrink: 0;
        padding: 7px 12px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        cursor: pointer;
        border: 1px solid rgba(255, 255, 255, 0.42);
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.22) 0%,
          rgba(255, 255, 255, 0.08) 100%
        );
        backdrop-filter: saturate(215%) blur(64px);
        -webkit-backdrop-filter: saturate(215%) blur(64px);
        color: rgba(255, 255, 255, 0.92);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.55),
          0 8px 24px rgba(0, 0, 0, 0.12),
          0 0 20px rgba(99, 102, 241, 0.06);
        transition: background 0.25s ease, border-color 0.25s ease, transform 0.15s ease;
      }
      .sb-theme-toggle:hover {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.48);
      }
      .sb-theme-toggle:active { transform: scale(0.96); }
      #sbSettingsToggle {
        width: 34px;
        height: 34px;
        padding: 0;
        border-radius: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 17px;
        line-height: 1;
      }
      .fca-gear-svg {
        width: 18px;
        height: 18px;
        display: block;
        transform: translateY(0.2px);
      }
      .fca-gear-lines line,
      .fca-gear-ring,
      .fca-gear-core {
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .fca-gear-lines line { stroke-width: 1.7; opacity: 0.84; }
      .fca-gear-ring { stroke-width: 1.8; opacity: 0.96; }
      .fca-gear-core { stroke-width: 1.65; opacity: 0.94; }
      #sbSettingsToggle .fca-gear-svg {
        transition: transform 0.35s cubic-bezier(0.2, 0.75, 0.2, 1), opacity 0.25s ease;
      }
      #sbSettingsToggle.active {
        background: rgba(255, 255, 255, 0.28);
        border-color: rgba(255, 255, 255, 0.56);
      }
      #sbSettingsToggle.active .fca-gear-svg { transform: translateY(0.2px) rotate(24deg); }
      .sb-header-collapse {
        order: 4;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        padding: 0;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.42);
        background: linear-gradient(
          155deg,
          rgba(255, 255, 255, 0.22) 0%,
          rgba(255, 255, 255, 0.08) 100%
        );
        backdrop-filter: saturate(215%) blur(64px);
        -webkit-backdrop-filter: saturate(215%) blur(64px);
        color: rgba(255, 255, 255, 0.88);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.52),
          0 8px 24px rgba(0, 0, 0, 0.12);
        transition: background 0.25s ease, border-color 0.25s ease, transform 0.15s ease;
      }
      .sb-header-collapse:hover {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.48);
      }
      .sb-header-collapse:active { transform: scale(0.96); }
      .sb-edge-toggle {
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        z-index: 6;
        display: none;
        align-items: center;
        justify-content: center;
        width: 26px;
        min-height: 88px;
        margin: 0;
        padding: 0;
        border: 0.55px solid rgba(255, 255, 255, 0.34);
        border-right: none;
        border-radius: 18px 0 0 18px;
        background: rgba(255, 255, 255, 0.16);
        backdrop-filter: saturate(200%) blur(64px);
        -webkit-backdrop-filter: saturate(200%) blur(64px);
        color: rgba(28, 28, 32, 0.85);
        font-size: 17px;
        font-weight: 600;
        cursor: pointer;
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.48),
          -6px 0 24px rgba(0, 0, 0, 0.14);
        transition: background 0.25s ease, opacity 0.2s ease;
      }
      .sb-edge-toggle:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.24);
        color: rgba(12, 12, 16, 0.9);
      }
      .sb-edge-toggle:disabled {
        cursor: default;
      }
      .head-title h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        letter-spacing: -0.035em;
        color: rgba(255, 255, 255, 0.98);
      }
      .sb-role {
        margin: 2px 0 10px;
        font-size: 10px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.42);
        letter-spacing: 0.02em;
      }
      .beta {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 4px 8px;
        border-radius: 999px;
        color: rgba(255, 255, 255, 0.84);
        background: rgba(255, 255, 255, 0.12);
        backdrop-filter: saturate(200%) blur(56px);
        -webkit-backdrop-filter: saturate(200%) blur(56px);
        border: 0.55px solid rgba(255, 255, 255, 0.36);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.38),
          0 2px 10px rgba(0, 0, 0, 0.08);
      }
      .query-line {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.72);
        word-break: break-word;
        margin-bottom: 12px;
        padding: 12px 14px;
        border-radius: 26px;
        background: linear-gradient(
          155deg,
          rgba(255, 255, 255, 0.32) 0%,
          rgba(255, 255, 255, 0.14) 45%,
          rgba(186, 200, 255, 0.08) 100%
        );
        backdrop-filter: blur(80px) saturate(232%) brightness(1.03);
        -webkit-backdrop-filter: blur(80px) saturate(232%) brightness(1.03);
        border: 1px solid rgba(255, 255, 255, 0.48);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.78),
          inset 0 0 0 0.5px rgba(255, 255, 255, 0.12),
          inset 0 -1px 0 rgba(0, 0, 0, 0.08),
          0 14px 40px rgba(0, 0, 0, 0.12),
          0 0 36px rgba(120, 140, 255, 0.11);
      }
      .query-line strong { color: rgba(255, 255, 255, 0.96); font-weight: 600; }
      .btn-page {
        --fca-ease: cubic-bezier(0.25, 0.82, 0.28, 1);
        width: 100%;
        padding: 12px 14px;
        border-radius: 26px;
        font-weight: 600;
        cursor: pointer;
        margin-bottom: 10px;
        color: rgba(255, 255, 255, 0.96);
        background: linear-gradient(
          160deg,
          rgba(255, 255, 255, 0.24) 0%,
          rgba(255, 255, 255, 0.1) 100%
        );
        backdrop-filter: blur(80px) saturate(232%) brightness(1.03);
        -webkit-backdrop-filter: blur(80px) saturate(232%) brightness(1.03);
        border: 1px solid rgba(255, 255, 255, 0.5);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.72),
          inset 0 0 0 0.5px rgba(255, 255, 255, 0.1),
          inset 0 -1px 0 rgba(0, 0, 0, 0.06),
          0 14px 36px rgba(0, 0, 0, 0.12),
          0 0 28px rgba(99, 102, 241, 0.1);
        transition:
          background 0.32s var(--fca-ease),
          border-color 0.32s var(--fca-ease),
          box-shadow 0.32s var(--fca-ease),
          transform 0.2s var(--fca-ease);
      }
      .btn-page:hover {
        background: linear-gradient(
          160deg,
          rgba(255, 255, 255, 0.34) 0%,
          rgba(255, 255, 255, 0.16) 100%
        );
        border-color: rgba(255, 255, 255, 0.58);
        transform: translateY(-1px);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.78),
          0 16px 40px rgba(0, 0, 0, 0.16),
          0 0 32px rgba(120, 170, 255, 0.18),
          0 0 24px rgba(56, 189, 248, 0.08);
      }
      .btn-page:active {
        transform: translateY(0);
        transition-duration: 0.1s;
      }
      .load-row {
        display: none;
        flex-direction: column;
        gap: 10px;
        padding: 12px 14px 13px;
        margin-bottom: 10px;
        border-radius: 26px;
        color: rgba(255, 255, 255, 0.82);
        font-size: 12px;
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.22) 0%,
          rgba(255, 255, 255, 0.09) 100%
        );
        backdrop-filter: blur(68px) saturate(205%);
        -webkit-backdrop-filter: blur(68px) saturate(205%);
        border: 1px solid rgba(255, 255, 255, 0.38);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.52),
          0 8px 26px rgba(0, 0, 0, 0.12),
          0 0 36px rgba(56, 189, 248, 0.08);
      }
      .load-row.visible { display: flex; }
      .sb-load-top {
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      .sb-load-mascot-col {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0;
        width: 74px;
      }
      .sb-load-mascot-stack {
        position: relative;
        width: 100%;
        padding-top: 38px;
      }
      .sb-load-turtle-on-bar {
        position: absolute;
        left: 50%;
        bottom: 4px;
        transform: translateX(-50%);
        width: 58px;
        height: 52px;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        z-index: 3;
        pointer-events: none;
        filter: drop-shadow(0 4px 16px rgba(37, 99, 235, 0.32));
      }
      .sb-load-turtle-on-bar .fca-loading-turtle-img {
        width: 54px;
        height: 54px;
        display: block;
        object-fit: contain;
        pointer-events: none;
        user-select: none;
      }
      .sb-load-hp-track {
        position: relative;
        z-index: 1;
        width: 100%;
        height: 10px;
        padding: 2px;
        border-radius: 999px;
        box-sizing: border-box;
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.11) 0%,
          rgba(0, 0, 0, 0.42) 100%
        );
        border: 1px solid rgba(255, 255, 255, 0.22);
        box-shadow:
          inset 0 2px 8px rgba(0, 0, 0, 0.5),
          inset 0 -1px 0 rgba(255, 255, 255, 0.12),
          0 0 0 0.5px rgba(37, 99, 235, 0.22),
          0 4px 14px rgba(0, 0, 0, 0.15);
        overflow: hidden;
      }
      .sb-load-hp-fill {
        position: relative;
        height: 100%;
        width: 5%;
        min-width: 4px;
        border-radius: 999px;
        box-sizing: border-box;
        background: linear-gradient(
          128deg,
          #dbeafe 0%,
          #93c5fd 22%,
          #3b82f6 48%,
          #2563eb 72%,
          #1e3a8a 100%
        );
        box-shadow:
          0 0 18px rgba(59, 130, 246, 0.48),
          inset 0 1px 0 rgba(255, 255, 255, 0.58),
          inset 0 -3px 6px rgba(30, 58, 138, 0.38);
        transition: width 0.52s cubic-bezier(0.33, 1, 0.28, 1);
      }
      .sb-load-hp-fill::before {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        height: 48%;
        border-radius: 999px 999px 0 0;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.65), transparent);
        opacity: 0.75;
        pointer-events: none;
      }
      .sb-load-hp-shine {
        position: absolute;
        top: 0;
        bottom: 0;
        left: -55%;
        width: 50%;
        border-radius: inherit;
        background: linear-gradient(
          105deg,
          transparent 0%,
          rgba(255, 255, 255, 0.1) 35%,
          rgba(255, 255, 255, 0.45) 50%,
          rgba(255, 255, 255, 0.08) 65%,
          transparent 100%
        );
        animation: fca-hp-shine-sweep 2.1s ease-in-out infinite;
        pointer-events: none;
      }
      @keyframes fca-hp-shine-sweep {
        0% {
          transform: translateX(0);
          opacity: 0;
        }
        12% {
          opacity: 1;
        }
        100% {
          transform: translateX(280%);
          opacity: 0;
        }
      }
      .sb-load-text {
        flex: 1;
        min-width: 0;
      }
      .sb-load-title-line {
        font-weight: 600;
        font-size: 13px;
        letter-spacing: 0.02em;
        color: rgba(255, 255, 255, 0.92);
      }
      .sb-load-dots {
        display: inline-block;
        margin-left: 1px;
        animation: fca-sb-load-dots 1.1s steps(4, end) infinite;
      }
      @keyframes fca-sb-load-dots {
        0%,
        20% {
          opacity: 0.35;
        }
        50% {
          opacity: 1;
        }
        100% {
          opacity: 0.35;
        }
      }
      .sb-load-phase {
        margin-top: 5px;
        font-size: 11px;
        line-height: 1.45;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.72);
        animation: fca-load-phase-in 0.42s cubic-bezier(0.25, 0.82, 0.28, 1);
      }
      @keyframes fca-load-phase-in {
        from {
          opacity: 0.25;
          transform: translateY(4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @keyframes fca-liquid-sweep {
        0% {
          transform: translate3d(-52%, 6%, 0) skewX(-11deg) scaleY(1.03);
        }
        38% {
          transform: translate3d(72%, -5%, 0) skewX(-15deg) scaleY(1.09);
        }
        100% {
          transform: translate3d(320%, 4%, 0) skewX(-9deg) scaleY(1.04);
        }
      }
      .sb-theme-toggle,
      .sb-header-collapse,
      .sb-trigger-pin,
      .btn-page,
      .btn-page-ghost,
      .sort-row button,
      .btn-report,
      .hist-head button {
        position: relative;
        overflow: hidden;
      }
      .sb-edge-toggle {
        overflow: hidden;
      }
      .sb-theme-toggle::after,
      .sb-header-collapse::after,
      .sb-trigger-pin::after,
      .btn-page::after,
      .btn-page-ghost::after,
      .sort-row button::after,
      .btn-report::after,
      .hist-head button::after,
      .sb-edge-toggle::after {
        content: "";
        position: absolute;
        top: -40%;
        bottom: -40%;
        left: -55%;
        width: 78%;
        pointer-events: none;
        background: linear-gradient(
          104deg,
          transparent 0%,
          rgba(255, 255, 255, 0) 18%,
          rgba(255, 255, 255, 0.14) 38%,
          rgba(255, 255, 255, 0.42) 48%,
          rgba(210, 235, 255, 0.38) 50%,
          rgba(255, 255, 255, 0.36) 52%,
          rgba(255, 255, 255, 0.12) 64%,
          rgba(255, 255, 255, 0) 82%,
          transparent 100%
        );
        opacity: 0;
        filter: blur(1.4px);
        will-change: transform;
        animation: fca-liquid-sweep 1.05s cubic-bezier(0.33, 0.02, 0.25, 1) infinite;
        animation-play-state: paused;
        transition: opacity 0.35s ease;
      }
      .sb-theme-toggle:hover::after,
      .sb-header-collapse:hover::after,
      .sb-trigger-pin:hover::after,
      .btn-page:hover::after,
      .btn-page-ghost:hover::after,
      .sort-row button:hover::after,
      .btn-report:hover::after,
      .hist-head button:hover::after,
      .sb-edge-toggle:hover:not(:disabled)::after {
        opacity: 1;
        animation-play-state: running;
      }
      .root.theme-light .sb-theme-toggle::after,
      .root.theme-light .sb-header-collapse::after,
      .root.theme-light .sb-trigger-pin::after,
      .root.theme-light .btn-page::after,
      .root.theme-light .btn-page-ghost::after,
      .root.theme-light .sort-row button::after,
      .root.theme-light .btn-report::after,
      .root.theme-light .hist-head button::after,
      .root.theme-light .sb-edge-toggle::after {
        background: linear-gradient(
          104deg,
          transparent 0%,
          rgba(255, 255, 255, 0) 16%,
          rgba(56, 189, 248, 0.18) 36%,
          rgba(255, 255, 255, 0.82) 49%,
          rgba(147, 197, 253, 0.35) 50%,
          rgba(255, 255, 255, 0.78) 51%,
          rgba(99, 102, 241, 0.16) 62%,
          rgba(255, 255, 255, 0) 80%,
          transparent 100%
        );
        filter: blur(1.6px);
      }
      @media (prefers-reduced-motion: reduce) {
        .sb-theme-toggle::after,
        .sb-header-collapse::after,
        .sb-trigger-pin::after,
        .btn-page::after,
        .btn-page-ghost::after,
        .sort-row button::after,
        .btn-report::after,
        .hist-head button::after,
        .sb-edge-toggle::after {
          animation: none !important;
          opacity: 0 !important;
        }
        .sb-load-dots,
        .sb-load-phase {
          animation: none !important;
        }
        .sb-load-hp-fill {
          transition: none !important;
        }
        .sb-load-hp-shine {
          animation: none !important;
          opacity: 0 !important;
        }
        .sb-load-phase {
          opacity: 1;
          transform: none;
        }
      }
      .sort-row {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
      }
      .sort-row button {
        --fca-ease: cubic-bezier(0.25, 0.82, 0.28, 1);
        flex: 1;
        padding: 9px 8px;
        font-size: 11px;
        font-weight: 600;
        border-radius: 20px;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.72);
        background: linear-gradient(
          180deg,
          rgba(255, 255, 255, 0.16) 0%,
          rgba(255, 255, 255, 0.06) 100%
        );
        backdrop-filter: blur(56px) saturate(205%);
        -webkit-backdrop-filter: blur(56px) saturate(205%);
        border: 1px solid rgba(255, 255, 255, 0.32);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.4),
          0 4px 16px rgba(0, 0, 0, 0.08);
        transition:
          color 0.28s var(--fca-ease),
          background 0.28s var(--fca-ease),
          border-color 0.28s var(--fca-ease),
          transform 0.2s var(--fca-ease),
          box-shadow 0.28s var(--fca-ease);
      }
      .sort-row button:hover {
        color: rgba(255, 255, 255, 0.9);
        background: rgba(255, 255, 255, 0.16);
        border-color: rgba(255, 255, 255, 0.4);
        transform: translateY(-0.5px);
      }
      .sort-row button.active {
        color: rgba(255, 255, 255, 1);
        background: rgba(255, 255, 255, 0.26);
        border-color: rgba(255, 255, 255, 0.55);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.62),
          0 4px 18px rgba(0, 0, 0, 0.12),
          0 0 16px rgba(120, 170, 255, 0.14);
      }
      .result-card {
        padding: 16px;
        border-radius: 28px;
        margin-bottom: 12px;
        background: linear-gradient(
          155deg,
          rgba(255, 255, 255, 0.34) 0%,
          rgba(255, 255, 255, 0.14) 38%,
          rgba(200, 210, 255, 0.08) 100%
        );
        backdrop-filter: blur(88px) saturate(238%) brightness(1.03);
        -webkit-backdrop-filter: blur(88px) saturate(238%) brightness(1.03);
        border: 1px solid rgba(255, 255, 255, 0.52);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.82),
          inset 0 0 0 0.5px rgba(255, 255, 255, 0.14),
          inset 0 -1px 0 rgba(0, 0, 0, 0.1),
          0 18px 52px rgba(0, 0, 0, 0.14),
          0 0 44px rgba(120, 140, 255, 0.12);
      }
      .chip {
        display: inline-block;
        padding: 5px 12px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        margin-bottom: 8px;
        letter-spacing: 0.02em;
        backdrop-filter: saturate(195%) blur(56px);
        -webkit-backdrop-filter: saturate(195%) blur(56px);
      }
      .chip-red {
        background: #fee2e2;
        color: #b91c1c;
        border: 0.5px solid rgba(185, 28, 28, 0.35);
      }
      .chip-orange {
        background: #fed7aa;
        color: #9a3412;
        border: 0.5px solid rgba(249, 115, 22, 0.52);
      }
      .chip-yellow {
        background: #fef9c3;
        color: #a16207;
        border: 0.5px solid rgba(161, 98, 7, 0.35);
      }
      .chip-green {
        background: #ecfdf5;
        color: #166534;
        border: 0.5px solid rgba(34, 197, 94, 0.22);
      }
      .chip-gray {
        background: #e5e7eb;
        color: #374151;
        border: 0.5px solid rgba(107, 114, 128, 0.45);
      }
      .chip-blue {
        background: #dbeafe;
        color: #1d4ed8;
        border: 0.5px solid rgba(59, 130, 246, 0.45);
      }
      .meta { font-size: 12px; color: rgba(255, 255, 255, 0.64); margin-top: 8px; word-break: break-word; }
      .meta b { color: rgba(255, 255, 255, 0.82); font-weight: 600; }
      .sb-prov {
        font-size: 10px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.45);
        letter-spacing: 0.06em;
        text-transform: uppercase;
        margin-bottom: 6px;
      }
      .sb-match-hint {
        font-size: 11px;
        line-height: 1.45;
        color: rgba(226, 240, 255, 0.82);
        margin: 0 0 8px;
        padding: 8px 10px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.08);
        border: 0.55px solid rgba(255, 255, 255, 0.22);
      }
      #sbRate {
        padding: 11px 12px;
        margin-top: 10px;
        border-radius: 26px;
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.3) 0%,
          rgba(255, 255, 255, 0.12) 100%
        );
        backdrop-filter: blur(80px) saturate(232%) brightness(1.03);
        -webkit-backdrop-filter: blur(80px) saturate(232%) brightness(1.03);
        border: 1px solid rgba(255, 255, 255, 0.46);
        color: rgba(255, 255, 255, 0.88);
        line-height: 1.52;
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.68),
          inset 0 0 0 0.5px rgba(255, 255, 255, 0.1),
          inset 0 -1px 0 rgba(0, 0, 0, 0.06),
          0 14px 36px rgba(0, 0, 0, 0.1),
          0 0 32px rgba(99, 102, 241, 0.09);
      }
      /* 查核結果主卡：依判定著色（與上方 chip 語意一致；Gray 維持預設中性） */
      #sbRate.sb-rate-tone--green {
        background: linear-gradient(
          165deg,
          rgba(34, 197, 94, 0.12) 0%,
          rgba(16, 185, 129, 0.06) 100%
        );
        border: 1px solid rgba(52, 211, 153, 0.22);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.32),
          inset 0 0 0 0.5px rgba(52, 211, 153, 0.06),
          0 14px 36px rgba(6, 78, 59, 0.08),
          0 0 32px rgba(34, 197, 94, 0.05);
      }
      #sbRate.sb-rate-tone--green .sb-verdict-reason {
        background: rgba(21, 128, 61, 0.12);
        border-color: rgba(52, 211, 153, 0.22);
        color: rgba(248, 250, 249, 0.95);
      }
      #sbRate.sb-rate-tone--red {
        background: linear-gradient(
          165deg,
          rgba(248, 113, 113, 0.28) 0%,
          rgba(220, 38, 38, 0.14) 100%
        );
        border: 1px solid rgba(252, 165, 165, 0.45);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.32),
          0 14px 36px rgba(127, 29, 29, 0.16),
          0 0 28px rgba(248, 113, 113, 0.1);
      }
      #sbRate.sb-rate-tone--red .sb-verdict-reason {
        background: rgba(153, 27, 27, 0.22);
        border-color: rgba(252, 165, 165, 0.38);
        color: rgba(255, 241, 242, 0.96);
      }
      #sbRate.sb-rate-tone--orange {
        background: linear-gradient(
          165deg,
          rgba(251, 146, 60, 0.28) 0%,
          rgba(234, 88, 12, 0.14) 100%
        );
        border: 1px solid rgba(253, 186, 116, 0.48);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.32),
          0 14px 36px rgba(124, 45, 18, 0.14),
          0 0 28px rgba(251, 146, 60, 0.1);
      }
      #sbRate.sb-rate-tone--orange .sb-verdict-reason {
        background: rgba(154, 52, 18, 0.2);
        border-color: rgba(253, 186, 116, 0.36);
        color: rgba(255, 247, 237, 0.96);
      }
      #sbRate.sb-rate-tone--blue {
        background: linear-gradient(
          165deg,
          rgba(96, 165, 250, 0.28) 0%,
          rgba(37, 99, 235, 0.16) 100%
        );
        border: 1px solid rgba(147, 197, 253, 0.45);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.32),
          0 14px 36px rgba(30, 58, 138, 0.14),
          0 0 28px rgba(59, 130, 246, 0.1);
      }
      #sbRate.sb-rate-tone--blue .sb-verdict-reason {
        background: rgba(30, 64, 175, 0.22);
        border-color: rgba(147, 197, 253, 0.35);
        color: rgba(239, 246, 255, 0.96);
      }
      #sbRate.sb-rate-tone--cyan {
        background: linear-gradient(
          165deg,
          rgba(45, 212, 191, 0.26) 0%,
          rgba(13, 148, 136, 0.16) 100%
        );
        border: 1px solid rgba(94, 234, 212, 0.42);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.3),
          0 14px 36px rgba(17, 94, 89, 0.14),
          0 0 28px rgba(45, 212, 191, 0.1);
      }
      #sbRate.sb-rate-tone--cyan .sb-verdict-reason {
        background: rgba(15, 118, 110, 0.22);
        border-color: rgba(94, 234, 212, 0.35);
        color: rgba(240, 253, 250, 0.96);
      }
      #sbRate.sb-rate-tone--green .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(21, 128, 61, 0.12);
        border-color: rgba(52, 211, 153, 0.22);
        color: rgba(248, 250, 249, 0.95);
      }
      #sbRate.sb-rate-tone--red .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(153, 27, 27, 0.22);
        border-color: rgba(252, 165, 165, 0.38);
        color: rgba(255, 241, 242, 0.96);
      }
      #sbRate.sb-rate-tone--orange .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(154, 52, 18, 0.2);
        border-color: rgba(253, 186, 116, 0.36);
        color: rgba(255, 247, 237, 0.96);
      }
      #sbRate.sb-rate-tone--blue .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(30, 64, 175, 0.22);
        border-color: rgba(147, 197, 253, 0.35);
        color: rgba(239, 246, 255, 0.96);
      }
      #sbRate.sb-rate-tone--cyan .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(15, 118, 110, 0.22);
        border-color: rgba(94, 234, 212, 0.35);
        color: rgba(240, 253, 250, 0.96);
      }
      .sb-verdict-block {
        margin: 0;
      }
      .sb-verdict-row {
        font-size: 12px;
        margin-bottom: 10px;
        color: rgba(255, 255, 255, 0.88);
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        line-height: 1.4;
      }
      .sb-verdict-row b {
        color: rgba(255, 255, 255, 0.92);
        font-weight: 600;
      }
      .sb-mode-tag {
        display: inline-flex;
        align-items: center;
        margin: 0 0 8px;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1.2;
        font-weight: 700;
        letter-spacing: 0.01em;
        color: rgba(255, 255, 255, 0.94);
        background: rgba(255, 255, 255, 0.14);
        border: 1px solid rgba(255, 255, 255, 0.3);
      }
      .sb-verdict-inline {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.94);
      }
      .sb-verdict-mini-check {
        display: inline-flex;
        width: 15px;
        height: 15px;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        filter: drop-shadow(0 0 6px rgba(52, 211, 153, 0.22));
      }
      .sb-verdict-mini-check .fca-tech-verify-svg {
        width: 15px;
        height: 15px;
        display: block;
      }
      .sb-verdict-mini-check .fca-tv-frame {
        fill: rgba(4, 18, 14, 0.78);
        stroke: rgba(110, 231, 183, 0.82);
        stroke-width: 1;
      }
      .sb-verdict-mini-check .fca-tv-mark {
        stroke: #c6ffea;
        stroke-width: 1.45;
      }
      .sb-verdict-reason {
        font-size: 12px;
        line-height: 1.58;
        color: rgba(255, 255, 255, 0.86);
        padding: 11px 12px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.12);
        backdrop-filter: blur(60px) saturate(195%);
        -webkit-backdrop-filter: blur(60px) saturate(195%);
        border: 0.55px solid rgba(255, 255, 255, 0.32);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.42),
          0 6px 22px rgba(0, 0, 0, 0.1);
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
        overflow-x: hidden;
      }
      .sb-verdict-reason-fold {
        margin-top: 2px;
      }
      .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        list-style: none;
        cursor: pointer;
        font-size: 12px;
        line-height: 1.55;
        color: rgba(255, 255, 255, 0.86);
        padding: 10px 11px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.1);
        border: 0.55px solid rgba(255, 255, 255, 0.26);
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
      }
      .sb-verdict-reason-fold > summary.sb-verdict-reason-sum::-webkit-details-marker {
        display: none;
      }
      .sb-verdict-reason-fold:not([open]) .sb-verdict-sum-open {
        display: none;
      }
      .sb-verdict-reason-fold[open] .sb-verdict-sum-collapsed {
        display: none;
      }
      .sb-verdict-sum-open {
        font-size: 11px;
        font-weight: 600;
        color: rgba(233, 213, 255, 0.95);
        letter-spacing: 0.02em;
      }
      .sb-verdict-reason-more {
        font-size: 11px;
        font-weight: 600;
        color: rgba(233, 213, 255, 0.92);
        margin-left: 4px;
        white-space: nowrap;
      }
      .sb-verdict-reason--full {
        margin-top: 8px;
      }
      .empty-msg {
        text-align: center;
        color: rgba(255, 255, 255, 0.42);
        padding: 20px 10px;
        font-size: 13px;
        letter-spacing: 0.01em;
      }
      .note {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.72);
        padding: 12px 14px;
        border-radius: 22px;
        margin-bottom: 12px;
        line-height: 1.5;
        background: rgba(255, 255, 255, 0.12);
        backdrop-filter: blur(60px) saturate(195%);
        -webkit-backdrop-filter: blur(60px) saturate(195%);
        border: 0.55px solid rgba(255, 255, 255, 0.32);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.42),
          0 6px 22px rgba(0, 0, 0, 0.1);
      }
      .btn-report {
        --fca-ease: cubic-bezier(0.25, 0.82, 0.28, 1);
        width: 100%;
        padding: 13px;
        border-radius: 22px;
        border: 0.55px solid rgba(255, 255, 255, 0.45);
        color: rgba(255, 255, 255, 0.98);
        font-weight: 600;
        cursor: pointer;
        margin-bottom: 18px;
        letter-spacing: 0.02em;
        background: rgba(255, 255, 255, 0.22);
        backdrop-filter: blur(68px) saturate(200%);
        -webkit-backdrop-filter: blur(68px) saturate(200%);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.6),
          0 8px 28px rgba(0, 0, 0, 0.14);
        transition:
          background 0.34s var(--fca-ease),
          border-color 0.34s var(--fca-ease),
          box-shadow 0.34s var(--fca-ease),
          transform 0.2s var(--fca-ease);
      }
      .btn-report:hover {
        background: rgba(255, 255, 255, 0.3);
        border-color: rgba(255, 255, 255, 0.58);
        transform: translateY(-1px);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.72),
          0 12px 36px rgba(0, 0, 0, 0.16),
          0 0 22px rgba(120, 170, 255, 0.14);
      }
      .btn-report:active {
        transform: translateY(0);
        transition-duration: 0.1s;
      }
      .sb-report-row {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 18px;
      }
      .sb-report-row .btn-report {
        margin-bottom: 0;
      }
      .btn-report--secondary {
        padding: 11px 13px;
        font-size: 12.5px;
        font-weight: 600;
        letter-spacing: 0.01em;
        color: rgba(255, 255, 255, 0.9);
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.28);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.28),
          0 4px 18px rgba(0, 0, 0, 0.1);
      }
      .btn-report--secondary:hover {
        background: rgba(255, 255, 255, 0.18);
        border-color: rgba(255, 255, 255, 0.42);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.42),
          0 8px 26px rgba(0, 0, 0, 0.12);
      }
      .hist-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .hist-head span {
        font-weight: 600;
        color: rgba(255, 255, 255, 0.88);
        font-size: 13px;
        letter-spacing: -0.01em;
      }
      .hist-head button {
        --fca-ease: cubic-bezier(0.25, 0.82, 0.28, 1);
        background: rgba(255, 255, 255, 0.12);
        color: rgba(255, 255, 255, 0.82);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        padding: 6px 12px;
        border-radius: 999px;
        border: 0.55px solid rgba(255, 255, 255, 0.32);
        backdrop-filter: blur(52px) saturate(195%);
        -webkit-backdrop-filter: blur(52px) saturate(195%);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.38),
          0 4px 14px rgba(0, 0, 0, 0.1);
        transition:
          background 0.3s var(--fca-ease),
          color 0.3s var(--fca-ease),
          border-color 0.3s var(--fca-ease),
          transform 0.2s var(--fca-ease);
      }
      .hist-head button:hover {
        background: rgba(255, 255, 255, 0.2);
        color: rgba(255, 255, 255, 0.96);
        border-color: rgba(255, 255, 255, 0.46);
        transform: translateY(-0.5px);
      }
      .hist-item {
        padding: 12px 14px;
        margin-top: 8px;
        border-radius: 22px;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.84);
        background: rgba(255, 255, 255, 0.12);
        backdrop-filter: blur(60px) saturate(195%);
        -webkit-backdrop-filter: blur(60px) saturate(195%);
        border: 0.55px solid rgba(255, 255, 255, 0.32);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.42),
          0 6px 22px rgba(0, 0, 0, 0.1);
      }
      .hist-item .t { color: rgba(255, 255, 255, 0.45); margin-top: 6px; font-size: 10px; }
      .hist-item .s { font-size: 10px; margin-top: 5px; color: rgba(196, 181, 253, 0.9); }

      /* 淺色：iOS 系 Liquid Glass（柔折射、大模糊、淡彩暈） */
      .root.theme-light {
        color: rgba(28, 28, 32, 0.94);
        background: linear-gradient(
          158deg,
          rgba(255, 255, 255, 0.94) 0%,
          rgba(248, 250, 255, 0.86) 38%,
          rgba(252, 253, 255, 0.9) 100%
        );
        backdrop-filter: saturate(225%) blur(112px) brightness(1.04) contrast(1.01);
        -webkit-backdrop-filter: saturate(225%) blur(112px) brightness(1.04) contrast(1.01);
        border-left: 1px solid rgba(255, 255, 255, 0.88);
        box-shadow:
          inset 0 0 0 0.5px rgba(255, 255, 255, 0.92),
          inset 3px 0 48px rgba(255, 255, 255, 0.42),
          inset 1px 0 0 rgba(255, 255, 255, 1),
          -22px 0 60px rgba(99, 102, 241, 0.1),
          0 0 80px rgba(56, 189, 248, 0.08),
          -12px 0 28px rgba(0, 0, 0, 0.035);
      }
      .root.theme-light::before {
        background:
          radial-gradient(115% 85% at 12% -2%, rgba(255, 255, 255, 0.92) 0%, transparent 52%),
          radial-gradient(95% 65% at 100% 92%, rgba(219, 234, 254, 0.38) 0%, transparent 58%),
          linear-gradient(168deg, rgba(255, 255, 255, 0.55) 0%, transparent 42%);
        opacity: 0.78;
      }
      .root.theme-light::after {
        background: linear-gradient(
          to top,
          rgba(255, 255, 255, 0.65) 0%,
          transparent 100%
        );
        height: 100px;
        opacity: 1;
      }
      .root.theme-light .scroll {
        scrollbar-color: rgba(0, 0, 0, 0.2) rgba(0, 0, 0, 0.04);
      }
      .root.theme-light .scroll::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.04);
      }
      .root.theme-light .scroll::-webkit-scrollbar-thumb {
        background: rgba(0, 0, 0, 0.18);
      }
      .root.theme-light .head-title h2 {
        color: rgba(20, 20, 25, 0.95);
        text-shadow: none;
      }
      .root.theme-light .sb-role {
        color: rgba(60, 60, 67, 0.5);
      }
      .root.theme-light .beta {
        color: rgba(28, 28, 32, 0.88);
        background: rgba(255, 255, 255, 0.72);
        border: 0.5px solid rgba(0, 0, 0, 0.08);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
        backdrop-filter: saturate(195%) blur(52px);
        -webkit-backdrop-filter: saturate(195%) blur(52px);
      }
      .root.theme-light .sb-theme-toggle {
        color: rgba(28, 28, 32, 0.9);
        background: rgba(255, 255, 255, 0.72);
        border: 0.5px solid rgba(0, 0, 0, 0.08);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
        backdrop-filter: saturate(200%) blur(64px);
        -webkit-backdrop-filter: saturate(200%) blur(64px);
      }
      .root.theme-light .sb-theme-toggle:hover {
        background: rgba(255, 255, 255, 0.94);
        border-color: rgba(0, 0, 0, 0.1);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 1),
          0 8px 28px rgba(99, 102, 241, 0.09);
      }
      .root.theme-light .sb-header-collapse {
        color: rgba(28, 28, 32, 0.9);
        background: rgba(255, 255, 255, 0.72);
        border: 0.5px solid rgba(0, 0, 0, 0.08);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
        backdrop-filter: saturate(200%) blur(64px);
        -webkit-backdrop-filter: saturate(200%) blur(64px);
      }
      .root.theme-light .sb-header-collapse:hover {
        background: rgba(255, 255, 255, 0.94);
        border-color: rgba(0, 0, 0, 0.1);
      }
      .root.theme-light .sb-edge-toggle {
        color: rgba(28, 28, 32, 0.92);
        background: rgba(255, 255, 255, 0.76);
        border: none;
        box-shadow:
          inset 1px 0 0 rgba(255, 255, 255, 0.8),
          -2px 0 12px rgba(0, 0, 0, 0.06);
        backdrop-filter: saturate(205%) blur(62px);
        -webkit-backdrop-filter: saturate(205%) blur(62px);
      }
      .root.theme-light .sb-edge-toggle:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.94);
      }
      .root.theme-light .query-line {
        color: rgba(40, 40, 48, 0.88);
        border-radius: 26px;
        background: linear-gradient(
          158deg,
          rgba(255, 255, 255, 0.94) 0%,
          rgba(252, 253, 255, 0.78) 50%,
          rgba(248, 250, 255, 0.88) 100%
        );
        border: 1px solid rgba(255, 255, 255, 0.95);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 1),
          inset 0 0 0 0.5px rgba(255, 255, 255, 0.65),
          inset 0 -1px 0 rgba(0, 0, 0, 0.04),
          0 14px 40px rgba(0, 0, 0, 0.05),
          0 0 36px rgba(99, 102, 241, 0.09);
        backdrop-filter: saturate(228%) blur(84px) brightness(1.04) contrast(1.01);
        -webkit-backdrop-filter: saturate(228%) blur(84px) brightness(1.04) contrast(1.01);
      }
      .root.theme-light .query-line strong {
        color: rgba(20, 20, 25, 0.92);
      }
      .root.theme-light .btn-page {
        color: rgba(28, 28, 32, 0.94);
        border-radius: 26px;
        background: linear-gradient(
          162deg,
          rgba(255, 255, 255, 0.92) 0%,
          rgba(250, 251, 255, 0.72) 100%
        );
        border: 1px solid rgba(255, 255, 255, 0.92);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 1),
          0 10px 32px rgba(0, 0, 0, 0.07),
          0 0 24px rgba(56, 189, 248, 0.08);
        backdrop-filter: saturate(228%) blur(84px) brightness(1.04) contrast(1.01);
        -webkit-backdrop-filter: saturate(228%) blur(84px) brightness(1.04) contrast(1.01);
      }
      .root.theme-light .btn-page:hover {
        background: linear-gradient(
          162deg,
          rgba(255, 255, 255, 0.98) 0%,
          rgba(255, 255, 255, 0.88) 100%
        );
        border-color: rgba(255, 255, 255, 1);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 1),
          0 14px 40px rgba(0, 0, 0, 0.08),
          0 0 32px rgba(99, 102, 241, 0.1);
      }
      .root.theme-light .load-row {
        color: rgba(55, 55, 65, 0.88);
        background: rgba(255, 255, 255, 0.78);
        border: 0.5px solid rgba(0, 0, 0, 0.06);
        backdrop-filter: saturate(190%) blur(62px);
        -webkit-backdrop-filter: saturate(190%) blur(62px);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.95),
          0 8px 28px rgba(0, 0, 0, 0.06),
          0 0 32px rgba(37, 99, 235, 0.06);
      }
      .root.theme-light .sb-load-title-line {
        color: rgba(28, 28, 34, 0.94);
      }
      .root.theme-light .sb-load-phase {
        color: rgba(75, 80, 95, 0.88);
      }
      .root.theme-light .sb-load-hp-track {
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.75) 0%,
          rgba(239, 246, 255, 0.55) 100%
        );
        border-color: rgba(0, 0, 0, 0.1);
        box-shadow:
          inset 0 2px 6px rgba(0, 0, 0, 0.08),
          inset 0 -1px 0 rgba(255, 255, 255, 0.9),
          0 0 0 0.5px rgba(59, 130, 246, 0.2),
          0 4px 16px rgba(59, 130, 246, 0.12);
      }
      .root.theme-light .sb-load-turtle-on-bar {
        filter: drop-shadow(0 4px 14px rgba(37, 99, 235, 0.22));
      }
      .root.theme-light .sort-row button {
        color: rgba(55, 55, 65, 0.8);
        background: rgba(255, 255, 255, 0.68);
        border: 0.5px solid rgba(0, 0, 0, 0.07);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
        backdrop-filter: saturate(195%) blur(60px);
        -webkit-backdrop-filter: saturate(195%) blur(60px);
      }
      .root.theme-light .sort-row button:hover {
        color: rgba(28, 28, 32, 0.92);
        background: rgba(255, 255, 255, 0.88);
        border-color: rgba(0, 0, 0, 0.09);
      }
      .root.theme-light .sort-row button.active {
        color: rgba(20, 20, 25, 0.95);
        background: rgba(255, 255, 255, 0.96);
        border-color: rgba(0, 0, 0, 0.12);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 1),
          0 4px 18px rgba(0, 0, 0, 0.08);
      }
      .root.theme-light .result-card {
        border-radius: 28px;
        background: linear-gradient(
          155deg,
          rgba(255, 255, 255, 0.96) 0%,
          rgba(252, 253, 255, 0.76) 40%,
          rgba(248, 250, 255, 0.86) 100%
        );
        border: 1px solid rgba(255, 255, 255, 0.95);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 1),
          inset 0 0 0 0.5px rgba(255, 255, 255, 0.7),
          inset 0 -1px 0 rgba(0, 0, 0, 0.04),
          0 18px 52px rgba(0, 0, 0, 0.06),
          0 0 48px rgba(99, 102, 241, 0.1);
        backdrop-filter: saturate(238%) blur(92px) brightness(1.04) contrast(1.01);
        -webkit-backdrop-filter: saturate(238%) blur(92px) brightness(1.04) contrast(1.01);
      }
      .root.theme-light .chip-red,
      .root.theme-light .chip-orange,
      .root.theme-light .chip-yellow,
      .root.theme-light .chip-green,
      .root.theme-light .chip-gray,
      .root.theme-light .chip-blue {
        backdrop-filter: saturate(190%) blur(34px);
        -webkit-backdrop-filter: saturate(190%) blur(34px);
      }
      .root.theme-light .chip-yellow {
        background: rgba(254, 249, 195, 0.52);
        border-color: rgba(161, 98, 7, 0.28);
      }
      .root.theme-light .chip-red {
        background: rgba(254, 226, 226, 0.52);
        border-color: rgba(185, 28, 28, 0.28);
      }
      .root.theme-light .chip-orange {
        background: rgba(254, 215, 170, 0.52);
        border-color: rgba(249, 115, 22, 0.35);
      }
      .root.theme-light .chip-green {
        background: rgba(236, 253, 245, 0.78);
        color: rgba(22, 84, 48, 0.9);
        border-color: rgba(34, 197, 94, 0.18);
      }
      .root.theme-light .chip-gray {
        background: rgba(229, 231, 235, 0.55);
        border-color: rgba(75, 85, 99, 0.28);
      }
      .root.theme-light .chip-blue {
        background: rgba(219, 234, 254, 0.58);
        border-color: rgba(37, 99, 235, 0.32);
      }
      .root.theme-light .meta {
        color: rgba(60, 60, 67, 0.72);
      }
      .root.theme-light .meta b {
        color: rgba(28, 28, 30, 0.92);
      }
      .root.theme-light .sb-prov {
        color: rgba(60, 60, 67, 0.52);
      }
      .root.theme-light .sb-match-hint {
        color: rgba(30, 58, 95, 0.88);
        background: rgba(255, 255, 255, 0.55);
        border-color: rgba(0, 0, 0, 0.08);
      }
      .root.theme-light #sbRate {
        border-radius: 26px;
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.94) 0%,
          rgba(252, 253, 255, 0.78) 100%
        );
        border: 1px solid rgba(255, 255, 255, 0.92);
        color: rgba(40, 40, 48, 0.9);
        backdrop-filter: saturate(232%) blur(84px) brightness(1.04) contrast(1.01);
        -webkit-backdrop-filter: saturate(232%) blur(84px) brightness(1.04) contrast(1.01);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 1),
          inset 0 0 0 0.5px rgba(255, 255, 255, 0.65),
          0 12px 36px rgba(0, 0, 0, 0.05),
          0 0 32px rgba(147, 197, 253, 0.14);
      }
      .root.theme-light #sbRate.sb-rate-tone--green {
        background: linear-gradient(
          165deg,
          rgba(248, 252, 250, 0.98) 0%,
          rgba(232, 249, 238, 0.42) 46%,
          rgba(255, 255, 255, 0.94) 100%
        );
        border: 1px solid rgba(34, 197, 94, 0.16);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.96),
          0 12px 36px rgba(22, 101, 52, 0.03),
          0 0 28px rgba(34, 197, 94, 0.04);
      }
      .root.theme-light #sbRate.sb-rate-tone--red {
        background: linear-gradient(
          165deg,
          rgba(254, 226, 226, 0.95) 0%,
          rgba(254, 202, 202, 0.65) 50%,
          rgba(255, 255, 255, 0.9) 100%
        );
        border: 1px solid rgba(248, 113, 113, 0.45);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.92),
          0 12px 36px rgba(127, 29, 29, 0.06),
          0 0 24px rgba(248, 113, 113, 0.1);
      }
      .root.theme-light #sbRate.sb-rate-tone--orange {
        background: linear-gradient(
          165deg,
          rgba(255, 237, 213, 0.96) 0%,
          rgba(254, 215, 170, 0.7) 50%,
          rgba(255, 255, 255, 0.9) 100%
        );
        border: 1px solid rgba(251, 146, 60, 0.42);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.92),
          0 12px 36px rgba(124, 45, 18, 0.06),
          0 0 24px rgba(251, 146, 60, 0.1);
      }
      .root.theme-light #sbRate.sb-rate-tone--blue {
        background: linear-gradient(
          165deg,
          rgba(219, 234, 254, 0.96) 0%,
          rgba(191, 219, 254, 0.72) 50%,
          rgba(255, 255, 255, 0.92) 100%
        );
        border: 1px solid rgba(96, 165, 250, 0.42);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.94),
          0 12px 36px rgba(30, 58, 138, 0.05),
          0 0 24px rgba(59, 130, 246, 0.1);
      }
      .root.theme-light #sbRate.sb-rate-tone--cyan {
        background: linear-gradient(
          165deg,
          rgba(204, 251, 241, 0.96) 0%,
          rgba(153, 246, 228, 0.68) 50%,
          rgba(255, 255, 255, 0.92) 100%
        );
        border: 1px solid rgba(45, 212, 191, 0.38);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.92),
          0 12px 36px rgba(17, 94, 89, 0.05),
          0 0 24px rgba(45, 212, 191, 0.1);
      }
      .root.theme-light .sb-verdict-row {
        color: rgba(28, 28, 30, 0.88);
      }
      .root.theme-light .sb-verdict-row b {
        color: rgba(20, 20, 25, 0.95);
      }
      .root.theme-light .sb-mode-tag {
        color: rgba(30, 41, 59, 0.92);
        background: rgba(226, 232, 240, 0.58);
        border-color: rgba(148, 163, 184, 0.36);
      }
      .root.theme-light .sb-verdict-inline {
        color: rgba(21, 128, 61, 0.95);
      }
      .root.theme-light .sb-verdict-mini-check {
        filter: drop-shadow(0 0 5px rgba(16, 185, 129, 0.18));
      }
      .root.theme-light .sb-verdict-mini-check .fca-tv-frame {
        fill: rgba(236, 253, 245, 0.95);
        stroke: rgba(5, 150, 105, 0.5);
      }
      .root.theme-light .sb-verdict-mini-check .fca-tv-mark {
        stroke: rgba(4, 120, 87, 0.95);
      }
      .root.theme-light .sb-verdict-reason {
        color: rgba(40, 40, 48, 0.92);
        background: rgba(255, 255, 255, 0.78);
        border: 0.5px solid rgba(0, 0, 0, 0.07);
        backdrop-filter: blur(48px) saturate(210%);
        -webkit-backdrop-filter: blur(48px) saturate(210%);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5);
      }
      .root.theme-light #sbRate.sb-rate-tone--green .sb-verdict-reason {
        background: rgba(241, 253, 247, 0.72);
        border: 0.5px solid rgba(34, 197, 94, 0.14);
        color: rgba(24, 48, 32, 0.9);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.82);
      }
      .root.theme-light #sbRate.sb-rate-tone--red .sb-verdict-reason {
        background: rgba(254, 226, 226, 0.88);
        border: 0.5px solid rgba(239, 68, 68, 0.28);
        color: rgba(60, 20, 20, 0.94);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
      }
      .root.theme-light #sbRate.sb-rate-tone--orange .sb-verdict-reason {
        background: rgba(255, 237, 213, 0.9);
        border: 0.5px solid rgba(249, 115, 22, 0.3);
        color: rgba(55, 30, 12, 0.94);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
      }
      .root.theme-light #sbRate.sb-rate-tone--blue .sb-verdict-reason {
        background: rgba(219, 234, 254, 0.9);
        border: 0.5px solid rgba(59, 130, 246, 0.28);
        color: rgba(22, 40, 70, 0.94);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.78);
      }
      .root.theme-light #sbRate.sb-rate-tone--cyan .sb-verdict-reason {
        background: rgba(204, 251, 241, 0.9);
        border: 0.5px solid rgba(20, 184, 166, 0.3);
        color: rgba(15, 50, 45, 0.94);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.78);
      }
      .root.theme-light .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        color: rgba(40, 40, 48, 0.92);
        background: rgba(255, 255, 255, 0.78);
        border: 0.5px solid rgba(0, 0, 0, 0.07);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5);
      }
      .root.theme-light .sb-verdict-reason-more {
        color: rgba(67, 56, 202, 0.88);
      }
      .root.theme-light .sb-verdict-sum-open {
        color: rgba(67, 56, 202, 0.9);
      }
      .root.theme-light #sbRate.sb-rate-tone--green .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(241, 253, 247, 0.72);
        border-color: rgba(34, 197, 94, 0.14);
        color: rgba(24, 48, 32, 0.9);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.82);
      }
      .root.theme-light #sbRate.sb-rate-tone--red .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(254, 226, 226, 0.88);
        border-color: rgba(239, 68, 68, 0.28);
        color: rgba(60, 20, 20, 0.94);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
      }
      .root.theme-light #sbRate.sb-rate-tone--orange .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(255, 237, 213, 0.9);
        border-color: rgba(249, 115, 22, 0.3);
        color: rgba(55, 30, 12, 0.94);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
      }
      .root.theme-light #sbRate.sb-rate-tone--blue .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(219, 234, 254, 0.9);
        border-color: rgba(59, 130, 246, 0.28);
        color: rgba(22, 40, 70, 0.94);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.78);
      }
      .root.theme-light #sbRate.sb-rate-tone--cyan .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(204, 251, 241, 0.9);
        border-color: rgba(20, 184, 166, 0.3);
        color: rgba(15, 50, 45, 0.94);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.78);
      }
      .root.theme-light .empty-msg {
        color: rgba(60, 60, 67, 0.5);
      }
      .root.theme-light .note {
        color: rgba(45, 45, 55, 0.86);
        background: rgba(255, 255, 255, 0.8);
        border: 0.5px solid rgba(0, 0, 0, 0.06);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
        backdrop-filter: saturate(200%) blur(64px);
        -webkit-backdrop-filter: saturate(200%) blur(64px);
      }
      .root.theme-light .btn-report {
        color: rgba(24, 24, 30, 0.96);
        background: rgba(255, 255, 255, 0.8);
        border: 0.5px solid rgba(0, 0, 0, 0.1);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.9),
          0 8px 28px rgba(0, 0, 0, 0.08);
        backdrop-filter: saturate(205%) blur(70px);
        -webkit-backdrop-filter: saturate(205%) blur(70px);
      }
      .root.theme-light .btn-report:hover {
        background: rgba(255, 255, 255, 0.96);
        border-color: rgba(0, 0, 0, 0.12);
      }
      .root.theme-light .btn-report--secondary {
        color: rgba(40, 40, 50, 0.9);
        background: rgba(248, 250, 252, 0.92);
        border-color: rgba(0, 0, 0, 0.08);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.95),
          0 4px 16px rgba(0, 0, 0, 0.06);
      }
      .root.theme-light .btn-report--secondary:hover {
        background: rgba(255, 255, 255, 0.98);
        border-color: rgba(0, 0, 0, 0.1);
      }
      .root.theme-light .hist-head span {
        color: rgba(28, 28, 30, 0.92);
      }
      .root.theme-light .hist-head button {
        background: rgba(255, 255, 255, 0.76);
        color: rgba(28, 28, 30, 0.8);
        border: 0.5px solid rgba(0, 0, 0, 0.07);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
        backdrop-filter: saturate(195%) blur(56px);
        -webkit-backdrop-filter: saturate(195%) blur(56px);
      }
      .root.theme-light .hist-head button:hover {
        background: rgba(255, 255, 255, 0.94);
        color: rgba(20, 20, 25, 0.95);
      }
      .root.theme-light .hist-item {
        color: rgba(40, 40, 48, 0.9);
        background: rgba(255, 255, 255, 0.72);
        border: 0.5px solid rgba(0, 0, 0, 0.06);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
        backdrop-filter: saturate(195%) blur(58px);
        -webkit-backdrop-filter: saturate(195%) blur(58px);
      }
      .root.theme-light .hist-item .t {
        color: rgba(60, 60, 67, 0.48);
      }
      .root.theme-light .hist-item .s {
        color: rgba(109, 40, 217, 0.88);
      }
      .root.theme-light a.ref {
        color: rgba(37, 99, 235, 0.95);
        border-bottom-color: rgba(37, 99, 235, 0.35);
      }
      .root.theme-light a.ref:hover {
        color: rgba(29, 78, 216, 1);
        border-bottom-color: rgba(29, 78, 216, 0.45);
      }

      a.ref {
        display: inline-block;
        margin-top: 10px;
        color: rgba(147, 197, 253, 0.95);
        font-size: 12px;
        font-weight: 500;
        text-decoration: none;
        border-bottom: 1px solid rgba(147, 197, 253, 0.35);
      }
      a.ref:hover { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.5); }

      /* 統一介面（與截圖：淺灰白底、約 12px 圓角、柔和陰影）— 僅在淺色主題 + fca-ui-unified */
      .root.fca-ui-unified.theme-light {
        background: linear-gradient(180deg, #f4f6f9 0%, #eef1f6 100%);
        border-left: 1px solid rgba(0, 0, 0, 0.06);
        box-shadow: -8px 0 24px rgba(15, 23, 42, 0.06);
      }
      .root.fca-ui-unified.theme-light::before {
        opacity: 0.35;
      }
      .root.fca-ui-unified.theme-light::after {
        opacity: 0.5;
      }
      .root.fca-ui-unified.theme-light .query-line {
        border-radius: 12px;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
      }
      .root.fca-ui-unified.theme-light .sort-row button {
        border-radius: 10px;
      }
      .root.fca-ui-unified.theme-light .result-card {
        border-radius: 12px;
        background: #ffffff;
        border: 1px solid rgba(0, 0, 0, 0.06);
        box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
      .root.fca-ui-unified.theme-light #sbRate {
        border-radius: 12px;
        background: #ffffff;
        border: 1px solid rgba(0, 0, 0, 0.06);
        box-shadow: 0 1px 4px rgba(15, 23, 42, 0.05);
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--green {
        background: linear-gradient(180deg, #f8fcfa 0%, #f2faf5 32%, #ffffff 100%);
        border: 1px solid rgba(34, 197, 94, 0.12);
        box-shadow:
          0 1px 4px rgba(22, 101, 52, 0.03),
          0 0 0 1px rgba(34, 197, 94, 0.03) inset;
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--red {
        background: linear-gradient(180deg, #fef2f2 0%, #fff1f2 45%, #ffffff 100%);
        border: 1px solid rgba(248, 113, 113, 0.35);
        box-shadow: 0 1px 4px rgba(127, 29, 29, 0.05);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--orange {
        background: linear-gradient(180deg, #fff7ed 0%, #ffedd5 42%, #ffffff 100%);
        border: 1px solid rgba(251, 146, 60, 0.32);
        box-shadow: 0 1px 4px rgba(124, 45, 18, 0.05);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--blue {
        background: linear-gradient(180deg, #eff6ff 0%, #dbeafe 42%, #ffffff 100%);
        border: 1px solid rgba(59, 130, 246, 0.28);
        box-shadow: 0 1px 4px rgba(30, 58, 138, 0.05);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--cyan {
        background: linear-gradient(180deg, #f0fdfa 0%, #ccfbf1 40%, #ffffff 100%);
        border: 1px solid rgba(45, 212, 191, 0.28);
        box-shadow: 0 1px 4px rgba(17, 94, 89, 0.05);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--green .sb-verdict-reason {
        background: rgba(241, 253, 247, 0.78);
        border: 1px solid rgba(34, 197, 94, 0.12);
        color: rgba(26, 52, 34, 0.9);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--red .sb-verdict-reason {
        background: rgba(254, 226, 226, 0.92);
        border: 1px solid rgba(239, 68, 68, 0.22);
        color: rgba(70, 20, 22, 0.95);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--orange .sb-verdict-reason {
        background: rgba(255, 237, 213, 0.94);
        border: 1px solid rgba(249, 115, 22, 0.22);
        color: rgba(70, 35, 12, 0.95);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--blue .sb-verdict-reason {
        background: rgba(219, 234, 254, 0.94);
        border: 1px solid rgba(59, 130, 246, 0.22);
        color: rgba(25, 45, 85, 0.95);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--cyan .sb-verdict-reason {
        background: rgba(204, 251, 241, 0.94);
        border: 1px solid rgba(20, 184, 166, 0.24);
        color: rgba(15, 55, 50, 0.95);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--green .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(241, 253, 247, 0.78);
        border: 1px solid rgba(34, 197, 94, 0.12);
        color: rgba(26, 52, 34, 0.9);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--red .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(254, 226, 226, 0.92);
        border: 1px solid rgba(239, 68, 68, 0.22);
        color: rgba(70, 20, 22, 0.95);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--orange .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(255, 237, 213, 0.94);
        border: 1px solid rgba(249, 115, 22, 0.22);
        color: rgba(70, 35, 12, 0.95);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--blue .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(219, 234, 254, 0.94);
        border: 1px solid rgba(59, 130, 246, 0.22);
        color: rgba(25, 45, 85, 0.95);
      }
      .root.fca-ui-unified.theme-light #sbRate.sb-rate-tone--cyan .sb-verdict-reason-fold > summary.sb-verdict-reason-sum {
        background: rgba(204, 251, 241, 0.94);
        border: 1px solid rgba(20, 184, 166, 0.24);
        color: rgba(15, 55, 50, 0.95);
      }
      .root.fca-ui-unified.theme-light .load-row {
        border-radius: 12px;
        box-shadow: 0 1px 4px rgba(15, 23, 42, 0.05);
      }
      .root.fca-ui-unified.theme-light .hist-item {
        border-radius: 12px;
      }
      .root.fca-ui-unified.theme-light .btn-page {
        border-radius: 12px;
      }
      .root.fca-ui-unified.theme-light .fca-domain-scan.fca-aux-classic,
      .root.fca-ui-unified.theme-light .fca-realtime-news.fca-aux-classic,
      .root.fca-ui-unified.theme-light .fca-ai-summary.fca-aux-classic {
        border-radius: 12px;
        background: #f8fafc;
        border: 1px solid rgba(0, 0, 0, 0.06);
        box-shadow: none;
      }
    </style>
    <div class="root theme-light fca-ui-unified" id="sbRoot" role="complementary" aria-labelledby="sbHeading">
      <button type="button" class="sb-edge-toggle" id="sbEdgeToggle" aria-label="展開側欄">⟩</button>
      <div class="scroll">
        <div class="head-title">
          <h2 id="sbHeading">事實查核結果</h2>
          <span class="beta">Beta</span>
          <button type="button" class="sb-theme-toggle" id="sbSettingsToggle" aria-label="開啟設定" title="開啟設定" aria-pressed="false" style="${FCA_LEGACY_SIDEBAR_UI ? "display:none;" : ""}">${fcaSettingsGearSvg()}</button>
          <button type="button" class="sb-header-collapse" id="sbHeaderCollapse" aria-label="收合側欄" title="收合側欄">⟨</button>
        </div>
        <p class="sb-role">全域工具與查詢紀錄（本次重點請看選取文字旁說明）</p>
        <div class="query-line" id="sbQuery">| 查詢：<strong>「尚無查詢」</strong></div>
        <button type="button" class="btn-page" id="sbCheckWholePage" aria-label="整頁查核">整頁查核</button>
        <div class="sb-relevance-row" id="sbRelRow" aria-live="polite"></div>
        <div class="result-card" id="sbSettingsPanel" style="display:${FCA_LEGACY_SIDEBAR_UI ? "none" : "none"};">
          <div class="meta"><b>設定</b></div>
          <div class="sort-row" role="group" aria-label="快速開關">
            <button type="button" id="sbQuickGemini" aria-pressed="false">AI：關</button>
            <button type="button" id="sbQuickNews" aria-pressed="true">新聞：開</button>
            <button type="button" id="sbQuickTrigger" aria-pressed="false">觸發鈕：自動</button>
          </div>
          <div class="sort-row" role="group" aria-label="外觀與位置">
            <button type="button" id="sbThemeToggle" aria-label="切換為淺色（iOS 風 Liquid Glass）" title="切換為淺色（iOS 風玻璃）">淺色</button>
            <button type="button" class="sb-trigger-pin" id="sbTriggerPinToggle" aria-pressed="false" aria-label="查核觸發鈕固定於視窗右下角" title="觸發鈕固定右下角（複雜版面較穩定）">右下角</button>
          </div>
        </div>
        <div class="load-row" id="sbLoad" role="status" aria-live="polite" aria-atomic="true">
          <div class="sb-load-top">
            <div class="sb-load-mascot-col">
              <div class="sb-load-mascot-stack" aria-hidden="true">
                <div
                  class="sb-load-hp-track"
                  id="sbLoadHpTrack"
                  role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuenow="5"
                  aria-label="查詢進度示意"
                >
                  <div class="sb-load-hp-fill" id="sbLoadHpFill">
                    <span class="sb-load-hp-shine" aria-hidden="true"></span>
                  </div>
                </div>
                <div class="sb-load-turtle-on-bar">${fcaLoadingTurtleImgHtml()}</div>
              </div>
            </div>
            <div class="sb-load-text">
              <div class="sb-load-title-line">查詢中<span class="sb-load-dots" aria-hidden="true">…</span></div>
              <div class="sb-load-phase" id="sbLoadPhase"></div>
            </div>
          </div>
        </div>
        <div class="result-card" id="sbCard">
          <div class="empty-msg" id="sbEmpty">查無相關查核資料</div>
          <div id="sbDetail" style="display:none;">
            <span class="chip" id="sbChip"></span>
            <div class="meta" id="sbPub"></div>
            <div class="meta" id="sbRate"></div>
            <a class="ref" id="sbLink" href="#" target="_blank" rel="noopener noreferrer" style="display:none;">開啟查核出處</a>
          </div>
        </div>
        <div class="note" id="sbNote">專家說法要確認是否斷章取義</div>
        <div class="sb-report-row">
          <button type="button" class="btn-report" id="sbReport">回報為可疑線索</button>
          <button type="button" class="btn-report btn-report--secondary" id="sbMatchReport">配對有誤（複製診斷）</button>
        </div>
        <div class="hist-head">
          <span>最近查詢記錄</span>
          <button type="button" id="sbHistClr">清除</button>
        </div>
        <div id="sbHistList"></div>
      </div>
    </div>
  `;

  fcaAppendExtensionUiHost(host);
  fcaSidebarHost = host;
  fcaSidebarShadow = shadow;

  const $ = (id) => shadow.getElementById(id);
  fcaSidebarEls = {
    queryLine: $("sbQuery"),
    relRow: $("sbRelRow"),
    loadRow: $("sbLoad"),
    loadPhaseEl: $("sbLoadPhase"),
    loadHpFillEl: $("sbLoadHpFill"),
    loadHpTrackEl: $("sbLoadHpTrack"),
    emptyEl: $("sbEmpty"),
    detailEl: $("sbDetail"),
    statusChip: $("sbChip"),
    pubEl: $("sbPub"),
    rateEl: $("sbRate"),
    linkEl: $("sbLink"),
    noteEl: $("sbNote"),
    histList: $("sbHistList"),
    settingsToggle: $("sbSettingsToggle"),
    settingsPanel: $("sbSettingsPanel"),
    quickGemini: $("sbQuickGemini"),
    quickNews: $("sbQuickNews"),
    quickTrigger: $("sbQuickTrigger")
  };

  if (!fcaSidebarUiBound) {
    fcaSidebarUiBound = true;
    $("sbSettingsToggle").addEventListener("click", (e) => {
      e.stopPropagation();
      fcaSidebarSettingsOpen = !fcaSidebarSettingsOpen;
      fcaSidebarSyncSettingsPanel();
    });
    shadow.addEventListener("click", (e) => {
      const suggest = e.target?.closest?.("[data-fca-query-suggest]");
      if (suggest) {
        e.preventDefault();
        e.stopPropagation();
        const q2 = String(suggest.getAttribute("data-fca-query-suggest") || "").trim();
        if (!q2) return;
        fcaSidebarApplyLoading(q2);
        void fcaPanelAlignedSidebarRefetch();
        return;
      }
      const id = e.target?.id;
      if (id === "sbRetryFull" || id === "sbRetryQuery") {
        e.stopPropagation();
        void fcaPanelAlignedSidebarRefetch();
        return;
      }
      if (id === "sbCheckWholePage") {
        e.stopPropagation();
        void fcaStartFactCheckWholePage();
        return;
      }
      if (id === "sbRetryNewsOnly") {
        e.stopPropagation();
        void fcaSidebarRetryNewsOnly();
        return;
      }
      const fix = e.target?.closest?.("[data-fca-ai-fix]");
      if (fix) {
        e.stopPropagation();
        const act = String(fix.getAttribute("data-fca-ai-fix") || "");
        const diagCode = String(fix.getAttribute("data-fca-diag-code") || "").trim();
        void (async () => {
          if (act === "enableGemini") {
            await fcaStorageLocalSet({ [FCA_OPT_SKIP_GEMINI]: false });
          } else if (act === "openGeminiSettings") {
            await fcaOpenGeminiSettingsInTab();
          } else if (act === "copyDiag" && diagCode) {
            try {
              await navigator.clipboard.writeText(diagCode);
              window.alert(`已複製診斷碼：${diagCode}`);
            } catch {
              window.alert(`診斷碼：${diagCode}`);
            }
          }
          fcaAiDiagCache.at = 0;
          fcaLocalOptsCache = null;
          await fcaSidebarSyncQuickToggles();
          try {
            const st = fcaSidebarLastApplyState;
            if (st) {
              await fcaSidebarApplyResult(
                st.q || fcaSidebarLastQuery,
                st.finalStatus,
                st.claimReview,
                st.errorText || "",
                st.mediaExtra || null
              );
            }
          } catch {
            /* ignore */
          }
        })();
        return;
      }
      const privacy = e.target?.closest?.("[data-fca-ai-privacy]");
      if (privacy) {
        e.stopPropagation();
        const mode = String(privacy.getAttribute("data-fca-ai-privacy") || "");
        void (async () => {
          if (mode === "never") {
            await fcaStorageLocalSet({ [FCA_OPT_GEMINI_PRIVACY_DISMISSED]: true });
          } else {
            fcaGeminiPrivacyBannerSessionHidden = true;
          }
          fcaLocalOptsCache = await fcaStorageLocalGet([
            FCA_OPT_SKIP_GEMINI,
            FCA_OPT_SHOW_TRUSTED_NEWS,
            FCA_OPT_GEMINI_PRIVACY_DISMISSED
          ]);
          fcaLocalOptsCacheAt = Date.now();
          const st = fcaSidebarLastApplyState;
          if (st) {
            await fcaSidebarApplyResult(
              st.q || fcaSidebarLastQuery,
              st.finalStatus,
              st.claimReview,
              st.errorText || "",
              st.mediaExtra || null
            );
          }
        })();
        return;
      }
    });
    $("sbTriggerPinToggle").addEventListener("click", (e) => {
      e.stopPropagation();
      fcaTriggerPinCorner = !fcaTriggerPinCorner;
      void fcaStorageLocalSet({ [FCA_TRIGGER_PIN_KEY]: fcaTriggerPinCorner });
      fcaSidebarSyncTriggerPinButton();
      void fcaSidebarSyncQuickToggles();
      if (fcaTriggerHost?.isConnected) {
        if (fcaTriggerPinCorner) {
          positionTriggerHost(fcaTriggerHost, null);
        } else if (fcaTriggerRange) {
          const r = fcaTriggerIconAnchorRect(fcaTriggerRange);
          if (r) positionTriggerHost(fcaTriggerHost, r);
        }
      }
    });
    $("sbQuickGemini").addEventListener("click", (e) => {
      e.stopPropagation();
      void (async () => {
        const opts = await fcaGetExtensionLocalOpts();
        const nextSkip = !Boolean(opts[FCA_OPT_SKIP_GEMINI]);
        await fcaStorageLocalSet({ [FCA_OPT_SKIP_GEMINI]: nextSkip });
        fcaAiDiagCache.at = 0;
        fcaLocalOptsCache = null;
        await fcaSidebarSyncQuickToggles();
      })();
    });
    $("sbQuickNews").addEventListener("click", (e) => {
      e.stopPropagation();
      void (async () => {
        const opts = await fcaGetExtensionLocalOpts();
        const current = opts[FCA_OPT_SHOW_TRUSTED_NEWS] !== false;
        await fcaStorageLocalSet({ [FCA_OPT_SHOW_TRUSTED_NEWS]: !current });
        fcaLocalOptsCache = null;
        await fcaSidebarSyncQuickToggles();
        const st = fcaSidebarLastApplyState;
        if (st) {
          await fcaSidebarApplyResult(
            st.q || fcaSidebarLastQuery,
            st.finalStatus,
            st.claimReview,
            st.errorText || "",
            st.mediaExtra || null
          );
        }
      })();
    });
    $("sbQuickTrigger").addEventListener("click", (e) => {
      e.stopPropagation();
      fcaTriggerPinCorner = !fcaTriggerPinCorner;
      void fcaStorageLocalSet({ [FCA_TRIGGER_PIN_KEY]: fcaTriggerPinCorner });
      fcaSidebarSyncTriggerPinButton();
      void fcaSidebarSyncQuickToggles();
      if (fcaTriggerHost?.isConnected) {
        if (fcaTriggerPinCorner) {
          positionTriggerHost(fcaTriggerHost, null);
        } else if (fcaTriggerRange) {
          const r = fcaTriggerIconAnchorRect(fcaTriggerRange);
          if (r) positionTriggerHost(fcaTriggerHost, r);
        }
      }
    });
    $("sbReport").addEventListener("click", (e) => {
      e.stopPropagation();
      const q = fcaSidebarLastQuery.trim();
      const url = q
        ? `https://cofacts.tw/search?type=messages&q=${encodeURIComponent(q.slice(0, 500))}`
        : "https://cofacts.tw/";
      window.open(url, "_blank", "noopener,noreferrer");
    });
    $("sbMatchReport").addEventListener("click", (e) => {
      e.stopPropagation();
      void fcaRunMatchMismatchReport();
    });
    $("sbHistClr").addEventListener("click", (e) => {
      e.stopPropagation();
      void fcaSidebarClearHistory();
    });
    $("sbHeaderCollapse").addEventListener("click", (e) => {
      e.stopPropagation();
      fcaSidebarUserCollapsed = true;
      fcaSidebarSyncLayout();
    });
    $("sbEdgeToggle").addEventListener("click", (e) => {
      e.stopPropagation();
      fcaSidebarUserCollapsed = false;
      fcaSidebarSyncLayout();
    });
    $("sbThemeToggle").addEventListener("click", (e) => {
      e.stopPropagation();
      const r = shadow.getElementById("sbRoot");
      const next = r?.classList.contains("theme-light") ? "dark" : "light";
      fcaSidebarApplyThemeClass(shadow, next);
      void fcaStorageLocalSet({ [FCA_SIDEBAR_THEME_KEY]: next });
    });
  }

  void fcaSidebarLoadTheme().then((t) => {
    fcaSidebarApplyThemeClass(shadow, t);
    fcaSidebarSyncTriggerPinButton();
    void fcaSidebarSyncQuickToggles();
    fcaSidebarSyncSettingsPanel();
  });

  if (fcaIsYoutubeWatchPage() && !fcaSidebarYtAutoStripDone) {
    fcaSidebarYtAutoStripDone = true;
    fcaSidebarUserCollapsed = true;
  }

  requestAnimationFrame(() => {
    fcaSidebarSyncLayout();
  });

  void fcaSidebarRenderHistory();

  if (typeof ResizeObserver !== "undefined" && host && !fcaSidebarHostResizeObs) {
    fcaSidebarHostResizeObs = new ResizeObserver(() => {
      try {
        fcaTriggerRepositionBump?.();
      } catch {
        /* ignore */
      }
      try {
        fcaPanelScheduleRelayout?.();
      } catch {
        /* ignore */
      }
    });
    try {
      fcaSidebarHostResizeObs.observe(host);
    } catch {
      /* ignore */
    }
  }
}

/** 判定 chip 文案與 FCA_STATUS_LABEL 一致。 */
function fcaStatusChipSetLabel(chipEl, finalStatus) {
  if (!chipEl) return;
  const k = fcaNormalizeLegacyYellowStatus(finalStatus);
  chipEl.textContent = FCA_STATUS_LABEL[k] || k;
}

function fcaSidebarSetQueryLine(text) {
  if (!fcaSidebarEls) return;
  const snip = fcaSidebarQuerySnippet(text);
  fcaSidebarEls.queryLine.innerHTML = `| 查詢：<strong>「${escapeHtmlFc(snip)}」</strong>`;
}

function fcaSidebarStopLoadTicker() {
  if (fcaSidebarLoadTicker != null) {
    clearInterval(fcaSidebarLoadTicker);
    fcaSidebarLoadTicker = null;
  }
  if (fcaSidebarLoadHpTicker != null) {
    clearInterval(fcaSidebarLoadHpTicker);
    fcaSidebarLoadHpTicker = null;
  }
}

function fcaSidebarStartLoadTicker() {
  fcaSidebarStopLoadTicker();
  const el = fcaSidebarEls?.loadPhaseEl;
  if (!el) return;
  const phases = FCA_LOAD_SOURCE_PHASES;
  const n = phases.length;
  let idx = 0;
  const fill = fcaSidebarEls?.loadHpFillEl;
  const track = fcaSidebarEls?.loadHpTrackEl;
  const startedAt = Date.now();
  const bumpHp = () => {
    if (!fcaSidebarEls?.loadHpFillEl?.isConnected) {
      fcaSidebarStopLoadTicker();
      return;
    }
    fcaApplyLoadProgressByTime(fcaSidebarEls.loadHpFillEl, fcaSidebarEls.loadHpTrackEl, startedAt);
  };
  bumpHp();
  fcaSidebarLoadHpTicker = setInterval(bumpHp, 120);
  const tick = () => {
    if (!fcaSidebarEls?.loadPhaseEl?.isConnected) {
      fcaSidebarStopLoadTicker();
      return;
    }
    const row = fcaSidebarEls.loadPhaseEl;
    const step = Math.min(idx, n - 1);
    row.textContent = phases[step];
    row.style.animation = "none";
    void row.offsetHeight;
    row.style.animation = "";
    if (idx < n - 1) idx += 1;
  };
  tick();
  fcaSidebarLoadTicker = setInterval(tick, 1400);
}

function fcaSidebarSetLoadingUi(isLoading) {
  if (!fcaSidebarEls) return;
  fcaSidebarEls.loadRow.classList.toggle("visible", isLoading);
  fcaSidebarEls.loadRow.setAttribute("aria-busy", isLoading ? "true" : "false");
  if (isLoading) fcaSidebarStartLoadTicker();
  else {
    if (fcaSidebarEls.loadHpFillEl?.style) {
      fcaSidebarEls.loadHpFillEl.style.width = "100%";
    }
    if (fcaSidebarEls.loadHpTrackEl) {
      fcaSidebarEls.loadHpTrackEl.setAttribute("aria-valuenow", "100");
    }
    fcaSidebarStopLoadTicker();
  }
}

function fcaSidebarApplyLoading(queryText) {
  ensureFcSidebar();
  fcaSidebarLastQuery = String(queryText || "").trim();
  fcaSidebarSetQueryLine(fcaSidebarLastQuery);
  fcaSidebarSetLoadingUi(true);
  if (fcaSidebarEls.relRow) {
    fcaSidebarEls.relRow.classList.remove("is-visible");
    fcaSidebarEls.relRow.textContent = "";
  }
  fcaSidebarEls.emptyEl.style.display = "";
  fcaSidebarEls.detailEl.style.display = "none";
  fcaSidebarEls.emptyEl.textContent = "查詢中…";
}

/**
 * Cofacts：優先 fcaResolvedStatus（AI 與社群合併）。
 * 主題參考且尚無共識／無回覆類型時改以事實釐清（藍）呈現，避免與「索引命中且明確證據不足」同灰造成疲勞；側欄仍會提示主題僅供參考。
 */
function fcaDisplayStatusForUi(finalStatus, claimReview) {
  if (claimReview?.fcaResolvedStatus) {
    return claimReview.fcaResolvedStatus;
  }
  if (
    claimReview?.fcaCofactsAiReplyOnly &&
    !claimReview.cofactsReplyType
  ) {
    return "Blue";
  }
  if (fcaIndexSupersedesWeakCofacts(claimReview)) {
    return fcaSupplementaryEffectiveFcaStatus(
      claimReview.fcaSupplementaryIndexReview
    );
  }
  if (claimReview?.fcaRelatedThemeOnly) {
    if (!claimReview.cofactsNoConsensus && claimReview.cofactsReplyType) {
      return cofactsReplyTypeToFcaStatus(claimReview.cofactsReplyType);
    }
    return "Blue";
  }
  if (claimReview?.fcaCofacts) {
    return cofactsReplyTypeToFcaStatus(claimReview.cofactsReplyType);
  }
  return finalStatus;
}

function fcaSidebarCaptureApplyState(finalStatus, claimReview, errorText, mediaExtra) {
  try {
    fcaSidebarLastApplyState = {
      q: fcaSidebarLastQuery,
      finalStatus,
      claimReview: claimReview ? JSON.parse(JSON.stringify(claimReview)) : null,
      errorText: errorText ? String(errorText) : "",
      localScan: mediaExtra?.localScan
        ? JSON.parse(JSON.stringify(mediaExtra.localScan))
        : null
    };
  } catch {
    fcaSidebarLastApplyState = null;
  }
}

/** Cofacts 無可用共識／摘錄時，顯示同一反白下查核索引（含 TFC 等）的另一筆命中。 */
function fcaBuildSupplementaryIndexSectionHtml(claimReview, queryText, which) {
  const sup = claimReview?.fcaSupplementaryIndexReview;
  if (!sup) return "";
  if (fcaIndexSupersedesWeakCofacts(claimReview)) return "";
  const q = String(queryText || "").trim();
  const pub = sup?.publisher?.name || sup?.publisher?.site || "查核索引";
  const site = (sup?.publisher?.site || "").replace(/^www\./, "").trim();
  const pubLine =
    site && pub !== site && !pub.includes(site) ? `${pub}（${site}）` : pub;
  const displaySt = fcaSupplementaryEffectiveFcaStatus(sup);
  const textualRating =
    sup?.textualRating || (sup ? "—" : "查無相關查核資料");
  const lead =
    which === "sidebar"
      ? fcaSidebarVerdictLeadHtml(textualRating)
      : fcaVerdictDisplayHtml(textualRating);
  const reasonBody = fcaVerdictReasonSummaryText(sup, displaySt, q, {
    ui: which === "sidebar" ? "sidebar" : "panel"
  });
  const reasonFmt =
    which === "sidebar"
      ? fcaSidebarFormatVerdictReasonHtml(reasonBody)
      : fcaPanelFormatVerdictReasonHtml(reasonBody);
  const rel = sup.fcaIndexRelevance?.label
    ? which === "sidebar"
      ? `<div class="sb-match-hint" role="note">${escapeHtmlFc(
          sup.fcaIndexRelevance.label
        )}</div>`
      : `<div class="result-match-hint" role="note">${escapeHtmlFc(
          sup.fcaIndexRelevance.label
        )}</div>`
    : "";
  const safeUrl = fcaSafeHttpUrl(sup.url);
  const link =
    safeUrl && which === "sidebar"
      ? `<div style="margin-top:8px;"><a class="ref" href="${escapeHtmlFc(
          safeUrl
        )}" target="_blank" rel="noopener noreferrer">${escapeHtmlFc(
          "開啟此查核出處"
        )}</a></div>`
      : safeUrl && which === "panel"
        ? `<div style="margin-top:6px;"><a class="fca-panel-open" href="${escapeHtmlFc(
            safeUrl
          )}" target="_blank" rel="noopener noreferrer">${escapeHtmlFc(
            "開啟此查核出處"
          )}</a></div>`
        : "";
  if (which === "sidebar") {
    return `<div class="sb-verdict-block sb-verdict-block--supp"><div class="sb-verdict-row"><b>其他查核機構</b>（查核索引）</div><div class="sb-supp-lead">${escapeHtmlFc(
      "以下為同一反白在查核索引中的另一筆命中（例如台灣事實查核中心）；請自行核對是否與 Cofacts 條目為同一論點。"
    )}</div>${rel}<div style="font-size:11px;margin-bottom:6px;line-height:1.45;"><b>來源</b>：${escapeHtmlFc(
      pubLine
    )}</div><div class="sb-verdict-row"><b>判定</b>：${lead}</div>${reasonFmt}${link}</div>`;
  }
  return `<div class="verdict-scroll sb-supp-panel-wrap"><b>其他查核機構</b>（索引）<div class="result-hint" style="margin:6px 0;line-height:1.45;">${escapeHtmlFc(
    "以下為查核索引中另筆命中；請核對是否與上方 Cofacts 為同一論點。"
  )}</div>${rel}<div style="font-size:11px;margin-bottom:4px;"><b>來源</b>：${escapeHtmlFc(
    pubLine
  )}</div><b>判定</b>：${lead}${reasonFmt}${link}</div>`;
}

function fcaTruncateVerdictReasonAtBoundary(text, maxLen) {
  const t = String(text || "").trim();
  if (t.length <= maxLen) return t;
  const slice = t.slice(0, maxLen);
  const punct = "。！？!?；;";
  let best = -1;
  for (let i = 0; i < punct.length; i++) {
    const j = slice.lastIndexOf(punct[i]);
    if (j > best) best = j;
  }
  const minKeep = Math.max(48, Math.floor(maxLen * 0.42));
  if (best >= minKeep) return slice.slice(0, best + 1).trimEnd();
  return `${slice.trimEnd()}…`;
}

function fcaSidebarFormatVerdictReasonHtml(reasonBody) {
  const raw = String(reasonBody || "").trim();
  if (!raw) return "";
  const maxCh = FCA_SIDEBAR_VERDICT_PREVIEW_CHARS;
  const maxLn = FCA_SIDEBAR_VERDICT_PREVIEW_LINES;
  const lines = raw.split(/\n/);
  const nonempty = lines.map((x) => x.trimEnd()).filter((x) => x.length);
  const long =
    raw.length > maxCh || nonempty.length > maxLn;
  if (!long) {
    return `<div class="sb-verdict-reason">${escapeHtmlFc(raw)}</div>`;
  }
  let preview =
    nonempty.length > maxLn
      ? nonempty.slice(0, maxLn).join("\n")
      : fcaTruncateVerdictReasonAtBoundary(raw, maxCh);
  if (preview.length >= raw.length - 2) {
    return `<div class="sb-verdict-reason">${escapeHtmlFc(raw)}</div>`;
  }
  let sumLead = preview;
  if (!sumLead.endsWith("…")) sumLead += "…";
  return `<details class="sb-verdict-reason-fold"><summary class="sb-verdict-reason-sum"><span class="sb-verdict-sum-collapsed">${escapeHtmlFc(
    sumLead
  )}<span class="sb-verdict-reason-more">${escapeHtmlFc(
    "（顯示全文）"
  )}</span></span><span class="sb-verdict-sum-open">${escapeHtmlFc(
    "收合摘錄"
  )}</span></summary><div class="sb-verdict-reason sb-verdict-reason--full">${escapeHtmlFc(
    raw
  )}</div></details>`;
}

function fcaPanelFormatVerdictReasonHtml(reasonBody) {
  const raw = String(reasonBody || "").trim();
  if (!raw) return "";
  const lines = raw.split(/\n/);
  const long = raw.length >= 200 || lines.length > 3;
  const cls = long
    ? "panel-verdict-reason panel-verdict-reason--scroll"
    : "panel-verdict-reason";
  return `<div class="${cls}">${escapeHtmlFc(raw)}</div>`;
}

async function fcaSidebarRetryNewsOnly() {
  const st = fcaSidebarLastApplyState;
  const q = (fcaSidebarLastQuery || st?.q || "").trim();
  if (!q) return;
  ensureFcSidebar();
  fcaSidebarSetLoadingUi(true);
  try {
    const trustedNews = await fcaFetchTrustedRealtimeNews(q, 5).catch(() => []);
    let localScan = st?.localScan ?? null;
    try {
      const r = await fcaSendMessage({
        type: "FC_LOCAL_MEDIA_SCAN",
        text: q,
        host: typeof location !== "undefined" ? location.hostname : ""
      });
      if (r?.ok) localScan = r.scan;
    } catch (e) {
      fcaLog("retry news scan", e);
    }
    const err = st?.errorText || "";
    const claim = st?.claimReview || null;
    const fs = st?.finalStatus || "Yellow";
    const mediaExtra = { localScan, trustedNews };
    await fcaSidebarApplyResult(q, fs, claim, err, mediaExtra);
  } catch (e) {
    await fcaSidebarApplyResult(q, "Yellow", null, String(e?.message || e));
  }
}

/** 側欄查核主卡 #sbRate：依判定套用色調（Gray 等維持中性 `meta`） */
function fcaSidebarApplyRateToneClass(chipKey) {
  const el = fcaSidebarEls?.rateEl;
  if (!el) return;
  const tk = String(chipKey || "Gray").toLowerCase();
  const toned = new Set(["green", "red", "orange", "blue", "cyan"]);
  el.className = toned.has(tk) ? `meta sb-rate-tone sb-rate-tone--${tk}` : "meta";
}

async function fcaSidebarApplyResult(
  queryText,
  finalStatus,
  claimReview,
  errorText,
  mediaExtra = null
) {
  if (!fcaSidebarEls) return undefined;
  await fcaGetExtensionLocalOpts();
  await fcaAiDiagPrimeFromStorage();
  fcaSidebarLastQuery = String(queryText || "").trim();
  fcaSidebarSetQueryLine(fcaSidebarLastQuery);
  fcaSidebarSetLoadingUi(false);

  const chipKind = {
    Red: "chip-red",
    Orange: "chip-orange",
    Yellow: "chip-gray",
    Gray: "chip-gray",
    Green: "chip-green",
    Blue: "chip-blue"
  };

  if (errorText && !fcaIsSilentTimeoutError(errorText)) {
    if (fcaSidebarEls.relRow) {
      fcaSidebarEls.relRow.classList.remove("is-visible");
      fcaSidebarEls.relRow.textContent = "";
    }
    fcaSidebarEls.emptyEl.style.display = "";
    fcaSidebarEls.detailEl.style.display = "none";
    fcaSidebarEls.rateEl.className = "meta";
    const msg = fcaFormatErrorForUi(errorText);
    const extra = isExtensionContextInvalidated({ message: errorText })
      ? "重新整理本頁後，內容腳本會重新連線至擴充功能，查核即可恢復正常。"
      : "若仍失敗，請確認網路、稍候再試，或重新載入擴充功能。";
    fcaSidebarEls.emptyEl.innerHTML = `<div class="sb-error-wrap" role="alert"><p class="sb-error-msg">${escapeHtmlFc(
      msg
    )}</p><div class="sb-error-actions"><button type="button" class="btn-page" id="sbRetryFull">${escapeHtmlFc(
      "重新嘗試（完整查核）"
    )}</button><button type="button" class="btn-page btn-page-ghost" id="sbRetryNewsOnly">${escapeHtmlFc(
      "僅重新載入新聞"
    )}</button></div></div>`;
    fcaSidebarEls.noteEl.textContent = extra;
    fcaSidebarEls.noteEl.style.display = "";
    fcaSidebarCaptureApplyState(finalStatus, claimReview, errorText, mediaExtra);
    return undefined;
  }

  if (!claimReview) {
    if (fcaSidebarEls.relRow) {
      fcaSidebarEls.relRow.classList.remove("is-visible");
      fcaSidebarEls.relRow.textContent = "";
    }
    fcaSidebarEls.emptyEl.style.display = "";
    fcaSidebarEls.detailEl.style.display = "none";
    fcaSidebarEls.rateEl.className = "meta";
    const pageUrl = fcaSafeHttpUrl(window.location.href);
    const baseEmpty = pageUrl
      ? `${escapeHtmlFc("查無相關查核資料")}<br/><a class="ref" href="${escapeHtmlFc(
          pageUrl
        )}" target="_blank" rel="noopener noreferrer">${escapeHtmlFc(
          "開啟選文所在頁面"
        )}</a>`
      : escapeHtmlFc("查無相關查核資料");
    const suggest0 = fcaBuildNoResultSuggestionsHtml(queryText);
    const ml0 = fcaBuildDomainAnalysisSectionHtml(null, mediaExtra);
    const verdictNews = fcaBuildVerdictNewsInlineSummaryHtml(
      queryText,
      mediaExtra,
      "sidebar",
      null
    );
    const embedNewsInAi = fcaShouldEmbedTrustedNewsInAi(null, "Gray");
    const news0 = fcaBuildRealtimeNewsSectionHtml(mediaExtra, { suppress: embedNewsInAi });
    const ai0 =
      fcaBuildAiSummarySectionHtml(null, queryText, {
        mediaExtra,
        embedTrustedNews: embedNewsInAi,
        sidebar: true
      }) || "";
    fcaSidebarEls.emptyEl.innerHTML =
      baseEmpty +
      (suggest0 || "") +
      (verdictNews
        ? `<div class="sb-verdict-block sb-verdict-block--aux">${verdictNews}</div>`
        : "") +
      (ml0 || "") +
      (news0 || "") +
      ai0;
    fcaSidebarEls.noteEl.textContent = "";
    fcaSidebarEls.noteEl.style.display = "none";
    fcaSidebarCaptureApplyState("Gray", null, "", mediaExtra);
    return undefined;
  }

  fcaSidebarEls.emptyEl.style.display = "none";
  fcaSidebarEls.detailEl.style.display = "block";
  fcaSidebarEls.noteEl.style.display = "";
  let displayStatus = fcaDisplayStatusForUi(finalStatus, claimReview);
  if (
    claimReview &&
    !claimReview.fcaCofacts &&
    !claimReview.fcaNoDirectCofactsMatch
  ) {
    const newsConsensus = fcaTrustedNewsConsensusStatus(queryText, mediaExtra);
    if (
      newsConsensus &&
      (displayStatus === "Gray" || displayStatus === "Blue" || displayStatus === "Yellow")
    ) {
      displayStatus = newsConsensus.status;
      claimReview.fcaNewsConsensusUsed = true;
      if (newsConsensus.summary) claimReview.fcaNewsSummaryLine = newsConsensus.summary;
    }
  }
  const chipKey = fcaNormalizeLegacyYellowStatus(displayStatus);
  fcaSidebarEls.statusChip.className = `chip ${chipKind[chipKey] || "chip-gray"}`;
  fcaStatusChipSetLabel(fcaSidebarEls.statusChip, displayStatus);

  const primaryCr = fcaVerdictUiPrimaryClaimReview(claimReview);

  if (fcaSidebarEls.relRow) {
    const rel =
      primaryCr?.fcaIndexRelevance || claimReview?.fcaIndexRelevance;
    if (rel?.label) {
      fcaSidebarEls.relRow.textContent = rel.label;
      fcaSidebarEls.relRow.classList.add("is-visible");
    } else {
      fcaSidebarEls.relRow.textContent = "";
      fcaSidebarEls.relRow.classList.remove("is-visible");
    }
  }

  const publisher =
    primaryCr?.publisher?.name || primaryCr?.publisher?.site || "—";
  const site = (primaryCr?.publisher?.site || "")
    .replace(/^www\./, "")
    .trim();
  const pubLine =
    site && publisher !== site && !publisher.includes(site)
      ? `${publisher}（${site}）`
      : publisher;
  const textualRating = fcaVerdictTextualRatingAlignedWithChip(
    claimReview,
    displayStatus,
    primaryCr
  );

  const provLine = fcaResultProvenanceLine(claimReview);
  const cofactsHint =
    fcaIndexSupersedesWeakCofacts(claimReview) && claimReview?.fcaCofactsMatchHintZh
      ? `<div class="sb-match-hint" role="note">${escapeHtmlFc(
          `Cofacts 條目對照：${claimReview.fcaCofactsMatchHintZh}`
        )}</div>`
      : "";
  const matchHintHtml =
    !fcaIndexSupersedesWeakCofacts(claimReview) && claimReview?.fcaCofactsMatchHintZh
      ? `<div class="sb-match-hint" role="note">${escapeHtmlFc(
          claimReview.fcaCofactsMatchHintZh
        )}</div>`
      : "";
  fcaSidebarEls.pubEl.innerHTML = `${
    provLine ? `<div class="sb-prov">${escapeHtmlFc(provLine)}</div>` : ""
  }${cofactsHint}${matchHintHtml}<b>來源</b>：${escapeHtmlFc(pubLine)}`;
  const overrideHint =
    claimReview?.fcaAiOverrodeCofacts && claimReview?.fcaAiReason
      ? `<div style="font-size:11px;line-height:1.45;color:#78350f;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:8px 10px;margin-bottom:8px;">${escapeHtmlFc(
          fcaAiOverrideBannerText(displayStatus)
        )}</div>`
      : "";
  let reasonBody = fcaVerdictReasonSummaryText(
    primaryCr,
    displayStatus,
    queryText,
    { ui: "sidebar" }
  );
  if (
    claimReview?.fcaNewsConsensusUsed &&
    claimReview?.fcaNewsSummaryLine &&
    !String(reasonBody || "").includes(claimReview.fcaNewsSummaryLine)
  ) {
    reasonBody = `${claimReview.fcaNewsSummaryLine}\n\n${reasonBody}`;
  }
  const verdictNewsInline =
    fcaShouldAppendNewsToVerdictBlock(claimReview, reasonBody, chipKey) &&
    fcaBuildVerdictNewsInlineSummaryHtml(queryText, mediaExtra, "sidebar", claimReview);
  const embedNewsInAi = fcaShouldEmbedTrustedNewsInAi(claimReview, chipKey);
  let rateHtml = `${overrideHint}<div class="sb-verdict-block">${fcaSidebarModeTagHtml(claimReview)}<div class="sb-verdict-row"><b>判定</b>：${fcaSidebarVerdictLeadHtml(
    textualRating
  )}</div>${fcaSidebarFormatVerdictReasonHtml(reasonBody)}${
    verdictNewsInline || ""
  }</div>`;
  rateHtml += fcaBuildSupplementaryIndexSectionHtml(
    claimReview,
    queryText,
    "sidebar"
  );
  rateHtml +=
    fcaBuildAiSummarySectionHtml(claimReview, fcaSidebarLastQuery, {
      mediaExtra,
      embedTrustedNews: embedNewsInAi,
      sidebar: true
    }) || "";
  rateHtml += fcaBuildDomainAnalysisSectionHtml(claimReview, mediaExtra) || "";
  rateHtml += fcaBuildRealtimeNewsSectionHtml(mediaExtra, { suppress: embedNewsInAi }) || "";
  fcaSidebarEls.rateEl.innerHTML = rateHtml;
  fcaSidebarApplyRateToneClass(chipKey);
  fcaSidebarAnimateVerdictReasonTyping();

  const sbUrl = fcaSafeHttpUrl(primaryCr?.url || claimReview.url);
  const pageUrlSb = fcaSafeHttpUrl(window.location.href);
  if (sbUrl) {
    fcaSidebarEls.linkEl.href = sbUrl;
    fcaSidebarEls.linkEl.textContent =
      fcaIndexSupersedesWeakCofacts(claimReview) && !sbUrl.includes("cofacts.tw")
        ? "開啟查核出處（索引）"
        : sbUrl.includes("cofacts.tw")
          ? "開啟 Cofacts 原文"
          : "開啟查核出處";
    fcaSidebarEls.linkEl.style.display = "inline-block";
  } else if (pageUrlSb) {
    fcaSidebarEls.linkEl.href = pageUrlSb;
    fcaSidebarEls.linkEl.textContent = "開啟選文所在頁面";
    fcaSidebarEls.linkEl.style.display = "inline-block";
  } else {
    fcaSidebarEls.linkEl.style.display = "none";
  }

  let sideNote =
    claimReview?.fcaGeminiKeyInvalid && !claimReview?.fcaAiReason
      ? "Gemini：金鑰已過期或無效。請至 Google AI Studio 建立新金鑰，並在擴充視窗重新貼上儲存。"
      : fcaIndexSupersedesWeakCofacts(claimReview)
      ? "已優先採用其他查核中心索引命中作為主判定；Cofacts 內容僅供補充比對。"
      : claimReview?.fcaRelatedThemeOnly
      ? "此條為 Cofacts 主題相近參考（未必同一事件），請開原文自行比對，勿當成精確對稿。"
      : claimReview?.fcaNoDirectCofactsMatch
      ? "查無可直接對照的 Cofacts 查核條目；下列為 Gemini 依反白之常識判讀，請交叉查證。"
      : claimReview?.fcaStandaloneAiOnly
      ? "此為 AI 依反白文字之輔助判讀（無即時搜尋），請交叉查證，勿替代正式查核。"
      : claimReview?.cofactsNoConsensus
      ? fcaIndexSupersedesWeakCofacts(claimReview)
        ? "上方判定與摘錄已改採查核索引（Cofacts 條目尚無社群共識摘錄）；請仍核對是否為同一論點。"
        : claimReview?.fcaSupplementaryIndexReview
          ? "Cofacts 尚無可用社群共識摘錄；另見下方「其他查核機構」之索引命中，請核對是否為同一論點。"
          : "目前社群尚無共識，建議自行查證"
      : fcaSidebarTipForStatus(displayStatus);
  if (claimReview?.fcaPhraseHighlights?.length > 1) {
    sideNote += claimReview?.fcaFactOpinionSplit
      ? " 語意拆解：**淺青**＝偏事實敘述；**橘**＝偏觀點／主觀語氣（關鍵字規則粗分，非查核結論）。滑鼠移到色塊可看說明。"
      : " 反白內多段顏色：紅＝錯誤（不實）；橘＝部分錯誤；灰＝目前無法證實；綠＝正確；藍＝事實釐清。滑鼠移到色塊可看提示；完整查核請看右側側欄。";
  }
  fcaSidebarEls.noteEl.textContent = sideNote;
  fcaSidebarCaptureApplyState(displayStatus, claimReview, "", mediaExtra);
  return displayStatus;
}

async function fcaSidebarPersistHistory(queryText, statusKey) {
  const q = String(queryText || "").trim().slice(0, 200);
  if (!q) return;
  try {
    const bag = await fcaStorageLocalGet(FCA_SIDEBAR_STORAGE_KEY);
    const prev = Array.isArray(bag[FCA_SIDEBAR_STORAGE_KEY])
      ? bag[FCA_SIDEBAR_STORAGE_KEY]
      : [];
    const row = {
      q,
      status: FCA_STATUS_LABEL[statusKey] || statusKey,
      t: new Date().toLocaleString("zh-TW")
    };
    const next = [row, ...prev.filter((x) => x.q !== q)].slice(0, 25);
    await fcaStorageLocalSet({ [FCA_SIDEBAR_STORAGE_KEY]: next });
    fcaSidebarRenderHistory();
  } catch (e) {
    fcaLog("sidebar history", e);
  }
}

async function fcaSidebarClearHistory() {
  try {
    await fcaStorageLocalRemove(FCA_SIDEBAR_STORAGE_KEY);
    fcaSidebarRenderHistory();
  } catch (e) {
    fcaLog("sidebar clear history", e);
  }
}

async function fcaSidebarRenderHistory() {
  if (!fcaSidebarEls?.histList) return;
  try {
    const bag = await fcaStorageLocalGet(FCA_SIDEBAR_STORAGE_KEY);
    const list = bag[FCA_SIDEBAR_STORAGE_KEY] || [];
    fcaSidebarEls.histList.innerHTML = "";
    if (!list.length) {
      const em = document.createElement("div");
      em.className = "hist-item";
      em.style.color = "#6b7280";
      em.textContent = "尚無紀錄";
      fcaSidebarEls.histList.appendChild(em);
      return;
    }
    for (const row of list) {
      const div = document.createElement("div");
      div.className = "hist-item";
      div.innerHTML = `${escapeHtmlFc(row.q)}<div class="t">${escapeHtmlFc(row.t)}</div><div class="s">${escapeHtmlFc(row.status)}</div>`;
      fcaSidebarEls.histList.appendChild(div);
    }
  } catch (e) {
    fcaLog("sidebar render history", e);
  }
}

async function fcaPanelAlignedSidebarRefetch() {
  const q = fcaSidebarLastQuery.trim();
  if (!q) return;
  const panelSnap = fcaPanelFetchGeneration;
  const g = ++fcaSidebarAltGen;
  const newsPending = fcaShouldLoadTrustedRealtimeNews(q);
  const newsPromise = newsPending
    ? fcaFetchTrustedRealtimeNews(q, 5).catch(() => [])
    : Promise.resolve([]);
  fcaSidebarSetLoadingUi(true);
  try {
    let { finalStatus, claimReview, error } = await fcaWithTimeout(
      fetchFactCheckToolTopClaim(q, { preferLatest: fcaSidebarPreferLatest }),
      FCA_FACTCHECK_HARD_TIMEOUT_MS,
      "FACTCHECK_TIMEOUT"
    );
    if (String(error || "").includes("FACTCHECK_TIMEOUT")) {
      const fallbackPack = await fcaWithTimeout(
        fetchCofactsAsFallback(
          q,
          fcaSidebarPreferLatest,
          "cofacts quick fallback after timeout",
          { forceSkipGemini: true, fastMode: true }
        ),
        5200,
        "COFACTS_TIMEOUT"
      ).catch(() => null);
      if (fallbackPack?.claimReview) {
        finalStatus = fallbackPack.finalStatus || "Yellow";
        claimReview = fallbackPack.claimReview;
        error = "";
      }
    }
    if (g !== fcaSidebarAltGen || panelSnap !== fcaPanelFetchGeneration) return;
    if (error) {
      await fcaSidebarApplyResult(q, "Yellow", null, error);
      return;
    }
    let mediaExtraRf = null;
    try {
      const r = await fcaSendMessage({
        type: "FC_LOCAL_MEDIA_SCAN",
        text: q,
        host: typeof location !== "undefined" ? location.hostname : ""
      });
      if (r?.ok) {
        mediaExtraRf = { localScan: r.scan };
        if (claimReview) claimReview.fcaLocalScan = r.scan;
      }
    } catch (e) {
      fcaLog("sidebar refetch media scan", e);
    }
    const phase1 = {
      ...(mediaExtraRf || {}),
      ...(newsPending ? { trustedNewsPending: true } : { trustedNews: [] })
    };
    await fcaSidebarApplyResult(q, finalStatus, claimReview, "", phase1);
    if (newsPending) {
      const trustedNews = await newsPromise;
      if (g !== fcaSidebarAltGen || panelSnap !== fcaPanelFetchGeneration) return;
      await fcaSidebarApplyResult(q, finalStatus, claimReview, "", {
        ...(mediaExtraRf || {}),
        trustedNews
      });
    }
  } catch (e) {
    if (g !== fcaSidebarAltGen || panelSnap !== fcaPanelFetchGeneration) return;
    await fcaSidebarApplyResult(q, "Yellow", null, String(e?.message || e));
  }
}

let fcaPanelHost = null;
let fcaPendingRange = null;
let fcaPendingText = "";
let fcaWholePageMode = false;
let fcaPanelRepositionHandler = null;
let fcaPanelRepositionRaf = null;
/** 使用者拖移後固定於視窗座標；下次開新面板時清除。 */
let fcaPanelManualPos = null;
let fcaPanelFabActive = false;
let fcaPanelPeekTimer = null;
let fcaPanelPeekLastX = 0;
let fcaPanelPeekLastY = 0;
let fcaPanelPeekMoveRaf = null;

/** 查核結果浮窗：停留秒數；關閉動畫對齊 iOS 橫幅（約 350ms ease-in-out）。游標在卡內暫停倒數。 */
const FCA_PANEL_AUTO_DISMISS_MS = 7000;
let fcaPanelAutoDismissTimer = null;
/** @type {null | (() => void)} */
let fcaFloatingExpandAfterLoadFn = null;
/** @type {null | (() => void)} */
let fcaFloatingEnterFabModeFn = null;
/** @type {null | (() => void)} */
let fcaPanelScheduleRelayout = null;

/** @type {null | ((e: KeyboardEvent) => void)} */
let fcaPanelEscapeHandler = null;

function fcaPanelShadowActiveElement() {
  try {
    return fcaPanelHost?.shadowRoot?.activeElement ?? null;
  } catch {
    return null;
  }
}

function fcaPanelAttachEscapeHandler() {
  if (fcaPanelEscapeHandler) return;
  fcaPanelEscapeHandler = (e) => {
    if (e.key !== "Escape") return;
    if (!fcaPanelHost?.isConnected) return;
    const shadow = fcaPanelHost.shadowRoot;
    const root = shadow?.getElementById("root");
    if (root?.classList.contains("fca-panel-peek")) {
      fcaHidePeekToFab();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!fcaPanelShadowActiveElement()) return;
    removeFcFloatingPanel();
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("keydown", fcaPanelEscapeHandler, true);
}

function fcaPanelDetachEscapeHandler() {
  if (!fcaPanelEscapeHandler) return;
  document.removeEventListener("keydown", fcaPanelEscapeHandler, true);
  fcaPanelEscapeHandler = null;
}

function fcaPanelClearAutoDismiss() {
  if (fcaPanelAutoDismissTimer != null) {
    clearTimeout(fcaPanelAutoDismissTimer);
    fcaPanelAutoDismissTimer = null;
  }
}

function fcaPanelScheduleAutoDismiss() {
  if (!fcaPanelHost?.isConnected) return;
  const token = fcaPanelFetchGeneration;
  fcaPanelClearAutoDismiss();
  fcaPanelAutoDismissTimer = setTimeout(() => {
    fcaPanelAutoDismissTimer = null;
    if (token !== fcaPanelFetchGeneration) return;
    fcaPanelRunDismissAnimationThenRemove();
  }, FCA_PANEL_AUTO_DISMISS_MS);
}

function fcaPanelRunDismissAnimationThenRemove() {
  fcaPanelClearAutoDismiss();
  if (!fcaPanelHost?.isConnected) return;
  const root = fcaPanelHost.shadowRoot?.getElementById("root");
  if (!root) {
    removeFcFloatingPanel();
    return;
  }
  if (root.classList.contains("fca-panel-ios-dismissing")) return;
  root.classList.add("fca-panel-ios-dismissing");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    removeFcFloatingPanel();
  };
  root.addEventListener(
    "animationend",
    (ev) => {
      if (ev.target !== root) return;
      const name = String(ev.animationName || "");
      if (!name.includes("fca-ios-panel-out")) return;
      cleanup();
    },
    { once: true }
  );
  setTimeout(cleanup, 480);
}

function fcaPanelBindAutoDismissHover(root) {
  if (!root || root.dataset.fcaAutoDismissHover === "1") return;
  root.dataset.fcaAutoDismissHover = "1";
  root.addEventListener("mouseenter", () => {
    fcaPanelClearAutoDismiss();
  });
  root.addEventListener("mouseleave", () => {
    if (!fcaPanelHost?.isConnected) return;
    const r = fcaPanelHost.shadowRoot?.getElementById("root");
    if (!r || r.classList.contains("fca-panel-ios-dismissing")) return;
    fcaPanelScheduleAutoDismiss();
  });
}

function fcaPanelArmAutoDismissAfterResult() {
  if (!fcaPanelHost?.isConnected) return;
  const root = fcaPanelHost.shadowRoot?.getElementById("root");
  if (!root) return;
  fcaPanelBindAutoDismissHover(root);
  fcaPanelScheduleAutoDismiss();
}

function removeFcFloatingPanel() {
  fcaPanelDetachEscapeHandler();
  fcaPanelClearAutoDismiss();
  clearTimeout(fcaPanelPeekTimer);
  fcaPanelPeekTimer = null;
  if (fcaPanelRepositionRaf != null) {
    cancelAnimationFrame(fcaPanelRepositionRaf);
    fcaPanelRepositionRaf = null;
  }
  if (fcaPanelPeekMoveRaf != null) {
    cancelAnimationFrame(fcaPanelPeekMoveRaf);
    fcaPanelPeekMoveRaf = null;
  }
  fcaPanelFabActive = false;
  fcaFloatingExpandAfterLoadFn = null;
  fcaFloatingEnterFabModeFn = null;
  fcaPanelScheduleRelayout = null;
  if (fcaPanelRepositionHandler) {
    window.removeEventListener("scroll", fcaPanelRepositionHandler, true);
    window.removeEventListener("resize", fcaPanelRepositionHandler);
    fcaPanelRepositionHandler = null;
  }
  if (fcaPanelHost?.parentNode) {
    fcaPanelHost.remove();
  }
  fcaPanelHost = null;
  try {
    document.querySelectorAll('[data-fca-panel-host="1"]').forEach((el) => {
      try {
        el.remove();
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
  fcaPendingRange = null;
  fcaPendingText = "";
  fcaPanelAnchorEl = null;
  fcaPanelManualPos = null;
}

function getPanelAnchorRect() {
  try {
    if (fcaPanelAnchorEl && fcaPanelAnchorEl.isConnected) {
      return fcaPanelAnchorEl.getBoundingClientRect();
    }
    if (fcaPendingRange) {
      return fcaPendingRange.getBoundingClientRect();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {DOMRect} selectionRect
 * @param {number} panelWidth
 * @param {number} panelHeight
 */
function computePanelPosition(selectionRect, panelWidth, panelHeight) {
  const gap = 6;
  const rect = selectionRect;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const rr = fcaSidebarGetRightReservedPx();
  const clampX = (pos) =>
    Math.max(10, Math.min(pos, vw - panelWidth - 10 - rr));
  const clampY = (pos) => Math.max(10, Math.min(pos, vh - panelHeight - 10));

  let left;
  let top;

  const fitsRight = rect.right + gap + panelWidth <= vw - 10;
  const fitsLeft = rect.left - panelWidth - gap >= 10;

  if (fitsRight) {
    left = rect.right + gap;
    top = rect.top;
  } else if (fitsLeft) {
    left = rect.left - panelWidth - gap;
    top = rect.top;
  } else {
    left = rect.left + (rect.width - panelWidth) / 2;
    top = rect.bottom + gap;
    if (top + panelHeight > vh - 10) {
      top = rect.top - gap - panelHeight;
    }
  }

  left = clampX(left);
  top = clampY(top);

  if (fcaIsYoutubeWatchPage()) {
    const n = fcaNudgeBoxAwayFromYoutubePlayer(left, top, panelWidth, panelHeight);
    left = n.left;
    top = n.top;
  }

  return { left, top };
}

function positionPanelHost(host, rect, panelEl) {
  if (!host || !panelEl) return;
  const w = panelEl.offsetWidth || 280;
  const h = panelEl.offsetHeight || 120;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rr = fcaSidebarGetRightReservedPx();
  const clampPanel = (left, top) => ({
    left: Math.max(10, Math.min(left, vw - w - 10 - rr)),
    top: Math.max(10, Math.min(top, vh - h - 10))
  });
  if (fcaPanelManualPos) {
    const c = clampPanel(fcaPanelManualPos.left, fcaPanelManualPos.top);
    fcaPanelManualPos.left = c.left;
    fcaPanelManualPos.top = c.top;
    host.style.left = `${Math.round(c.left)}px`;
    host.style.top = `${Math.round(c.top)}px`;
    return;
  }
  if (!rect) return;
  const { left, top } = computePanelPosition(rect, w, h);
  const c = clampPanel(left, top);
  host.style.left = `${Math.round(c.left)}px`;
  host.style.top = `${Math.round(c.top)}px`;
}

function fcaNodeInsideFloatingPanel(node) {
  if (!node || !fcaPanelHost) return false;
  if (node === fcaPanelHost) return true;
  try {
    const sr = fcaPanelHost.shadowRoot;
    if (!sr) return false;
    if (sr.contains(node)) return true;
    if (typeof Node !== "undefined" && node instanceof Node) {
      const root = node.getRootNode();
      if (root && root === sr) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** 側欄全開時不再顯示左下角 FAB；將浮窗移出畫面並不可互動，仍保留 fab 狀態供游標懸停標註時 peek。 */
function fcaPanelSilenceSidebarFabHost(host) {
  if (!host) return;
  host.style.opacity = "0";
  host.style.pointerEvents = "none";
  host.style.left = "-9999px";
  host.style.top = "0";
  host.style.bottom = "auto";
  host.style.right = "auto";
}

function fcaPanelEnterFabMode(host, shadow) {
  const root = shadow.getElementById("root");
  if (!root) return;
  clearTimeout(fcaPanelPeekTimer);
  fcaPanelPeekTimer = null;
  fcaPanelFabActive = true;
  root.classList.add("fca-panel-fab", "wrap-collapsed");
  root.classList.remove("fca-panel-peek");
  const collapseBtn = shadow.getElementById("panelCollapseBtn");
  if (collapseBtn) {
    collapseBtn.style.display = "none";
    collapseBtn.setAttribute("aria-hidden", "true");
  }
  const panelHead = shadow.querySelector(".fca-panel-head");
  if (panelHead) panelHead.style.cursor = "default";
  fcaPanelManualPos = null;
  fcaPanelAnchorEl = null;
  fcaPanelSilenceSidebarFabHost(host);
  fcaInitPanelPeekDelegation();
}

function fcaHidePeekToFab() {
  if (!fcaPanelFabActive || !fcaPanelHost) return;
  const shadow = fcaPanelHost.shadowRoot;
  const root = shadow?.getElementById("root");
  if (!root?.classList.contains("fca-panel-peek")) return;
  root.classList.remove("fca-panel-peek");
  root.classList.add("wrap-collapsed");
  const collapseBtn = shadow.getElementById("panelCollapseBtn");
  if (collapseBtn) {
    collapseBtn.style.display = "none";
    collapseBtn.setAttribute("aria-hidden", "true");
  }
  const panelHead = shadow.querySelector(".fca-panel-head");
  if (panelHead) panelHead.style.cursor = "default";
  fcaPanelAnchorEl = null;
  fcaPanelSilenceSidebarFabHost(fcaPanelHost);
  fcaPanelScheduleRelayout?.();
}

function fcaShowPeekForAnno(anno) {
  if (!fcaPanelHost || !fcaPanelFabActive || !anno?.isConnected) return;
  const shadow = fcaPanelHost.shadowRoot;
  const root = shadow.getElementById("root");
  if (!root) return;
  clearTimeout(fcaPanelPeekTimer);
  fcaPanelPeekTimer = null;
  fcaPanelAnchorEl = anno;
  root.classList.add("fca-panel-peek");
  root.classList.remove("wrap-collapsed");
  const collapseBtn = shadow.getElementById("panelCollapseBtn");
  if (collapseBtn) {
    collapseBtn.style.display = "";
    collapseBtn.removeAttribute("aria-hidden");
    collapseBtn.textContent = "收合";
    collapseBtn.setAttribute("aria-expanded", "true");
    collapseBtn.title = "收合段落摘要";
  }
  const panelHeadTitle = shadow.getElementById("panelHeadTitle");
  if (panelHeadTitle) panelHeadTitle.textContent = "段落查核";
  const panelHead = shadow.querySelector(".fca-panel-head");
  if (panelHead) panelHead.style.cursor = "grab";
  fcaPanelHost.style.bottom = "";
  fcaPanelHost.style.right = "";
  fcaPanelHost.style.left = "";
  fcaPanelHost.style.top = "";
  fcaPanelHost.style.opacity = "";
  fcaPanelHost.style.pointerEvents = "";
  fcaPanelManualPos = null;
  requestAnimationFrame(() => {
    if (!fcaPanelHost || !anno.isConnected) return;
    positionPanelHost(fcaPanelHost, anno.getBoundingClientRect(), root);
  });
}

function fcaPanelPeekOnMouseOver(e) {
  if (!fcaPanelFabActive || !fcaSidebarIsFullExpanded()) return;
  if (fcaNodeInsideFloatingPanel(e.target)) {
    clearTimeout(fcaPanelPeekTimer);
    fcaPanelPeekTimer = null;
    return;
  }
  const anno = e.target?.closest?.("span.fca-anno");
  if (!anno) return;
  clearTimeout(fcaPanelPeekTimer);
  fcaPanelPeekTimer = null;
  fcaShowPeekForAnno(anno);
}

function fcaPanelPeekOnMouseOut(e) {
  if (!fcaPanelFabActive) return;
  const anno = e.target?.closest?.("span.fca-anno");
  if (!anno) return;
  const rel = e.relatedTarget;
  if (rel) {
    if (anno.contains(rel)) return;
    if (fcaNodeInsideFloatingPanel(rel)) return;
  }
  clearTimeout(fcaPanelPeekTimer);
  fcaPanelPeekTimer = setTimeout(() => {
    fcaPanelPeekTimer = null;
    try {
      const topEl = document.elementFromPoint?.(
        fcaPanelPeekLastX,
        fcaPanelPeekLastY
      );
      if (fcaNodeInsideFloatingPanel(topEl)) return;
    } catch {
      /* ignore */
    }
    fcaHidePeekToFab();
  }, 320);
}

function fcaPanelPeekOnMouseMove(e) {
  const x = e.clientX;
  const y = e.clientY;
  if (fcaPanelPeekMoveRaf != null) return;
  fcaPanelPeekMoveRaf = requestAnimationFrame(() => {
    fcaPanelPeekMoveRaf = null;
    fcaPanelPeekLastX = x;
    fcaPanelPeekLastY = y;
  });
}

function fcaInitPanelPeekDelegation() {
  if (fcaInitPanelPeekDelegation.done) return;
  fcaInitPanelPeekDelegation.done = true;
  document.addEventListener("mousemove", fcaPanelPeekOnMouseMove, true);
  document.addEventListener("mouseover", fcaPanelPeekOnMouseOver, true);
  document.addEventListener("mouseout", fcaPanelPeekOnMouseOut, true);
}

/**
 * 不建立浮動面板：只跑查核、更新側欄、頁面標色（與面板內 runCofactsAndApplyHighlight 邏輯對齊，略去 fillResultPanel 等）。
 */
async function fcaRunFactCheckSidebarOnly(gen, fixedUserStatus = null) {
  fcaPanelClearAutoDismiss();
  const rangeSnapshot =
    fcaPendingRange && typeof fcaPendingRange.cloneRange === "function"
      ? fcaPendingRange.cloneRange()
      : null;
  const textSnapshot = fcaPendingText;

  const localScanPromise = fcaSendMessage({
    type: "FC_LOCAL_MEDIA_SCAN",
    text: textSnapshot,
    host: typeof location !== "undefined" ? location.hostname : ""
  }).catch(() => null);
  const newsPending = fcaShouldLoadTrustedRealtimeNews(textSnapshot);
  const trustedNewsPromise = newsPending
    ? fcaFetchTrustedRealtimeNews(textSnapshot, 5).catch(() => [])
    : Promise.resolve([]);

  let claimReview = null;
  let fetchError = "";
  let finalStatus = fixedUserStatus || "Yellow";
  try {
    const pack = await fcaWithTimeout(
      fetchFactCheckToolTopClaim(textSnapshot, {
        preferLatest: fcaSidebarPreferLatest
      }),
      FCA_FACTCHECK_HARD_TIMEOUT_MS,
      "FACTCHECK_TIMEOUT"
    );
    fetchError = pack.error || "";
    if (!fetchError) {
      claimReview = pack.claimReview;
      if (!fixedUserStatus) {
        finalStatus = pack.finalStatus;
        if (claimReview?.fcaCofacts) {
          finalStatus =
            claimReview.fcaResolvedStatus ||
            cofactsReplyTypeToFcaStatus(claimReview.cofactsReplyType);
        }
      }
    }
  } catch (e) {
    fcaLog("factcheck fetch error", e);
    fetchError = String(e?.message || e);
    if (isExtensionContextInvalidated(e)) {
      window.alert("事實查核助手已更新或重載，請重新整理此頁面後再試。");
    }
  }
  if (fetchError.includes("FACTCHECK_TIMEOUT")) {
    const fallbackPack = await fcaWithTimeout(
      fetchCofactsAsFallback(
        textSnapshot,
        fcaSidebarPreferLatest,
        "cofacts quick fallback after timeout",
        { forceSkipGemini: true, fastMode: true }
      ),
      5200,
      "COFACTS_TIMEOUT"
    ).catch(() => null);
    if (fallbackPack?.claimReview) {
      claimReview = fallbackPack.claimReview;
      if (!fixedUserStatus) {
        finalStatus = fallbackPack.finalStatus || "Yellow";
      }
      fetchError = "";
    }
  }

  /* 語意拆解須在 Gemini enrich 之前：否則 enrich 寫入的 fcaAiReason 會被此合成 claim 整段覆蓋。 */
  if (
    !fetchError &&
    !claimReview &&
    String(textSnapshot || "").replace(/\s/g, "").length >= 24
  ) {
    const subOnly = fcaBuildSubjectiveOnlyPhraseHighlights(textSnapshot.trim());
    if (subOnly) {
      claimReview = subOnly;
      if (!fixedUserStatus) finalStatus = "Gray";
    }
  }

  const articleCtxForAi = fcaShouldAttachArticleContextForStandaloneAi(
    claimReview,
    finalStatus
  )
    ? fcaExtractPageArticleContextForAi(4200)
    : "";

  try {
    const enrichedPack = await fcaWithTimeout(
      fcaEnrichWithStandaloneAi(textSnapshot, {
        claimReview,
        finalStatus,
        fetchError,
        fixedUserStatus,
        articleContext: articleCtxForAi
      }),
      FCA_AI_ENRICH_TIMEOUT_MS,
      "AI_ENRICH_TIMEOUT"
    );
    claimReview = enrichedPack.claimReview;
    finalStatus = enrichedPack.finalStatus;
    fetchError = enrichedPack.fetchError;
  } catch {
    /* ignore */
  }

  const locRaw = await localScanPromise;
  const mediaExtra = {
    localScan: locRaw?.ok ? locRaw.scan : null,
    ...(newsPending ? { trustedNewsPending: true } : { trustedNews: [] })
  };

  if (gen !== fcaPanelFetchGeneration) {
    fcaLog("skip stale sidebar-only update");
    return;
  }

  fcaLog("factcheck sidebar-only", { finalStatus, hasReview: Boolean(claimReview) });

  const displayStatus = fcaDisplayStatusForUi(finalStatus, claimReview);
  if (
    !fetchError &&
    claimReview?.fcaIndexCorpus &&
    !claimReview.fcaCofacts &&
    !claimReview.fcaPhraseHighlights &&
    String(textSnapshot || "").replace(/\s/g, "").length >= 16
  ) {
    const ph = fcaBuildIndexMixedPhraseHighlights(
      textSnapshot.trim(),
      displayStatus,
      claimReview,
      claimReview.fcaIndexCorpus
    );
    if (ph.length > 1) {
      claimReview.fcaPhraseHighlights = ph;
      claimReview.fcaHighlightSourceText = textSnapshot.trim();
      claimReview.fcaIndexMixedPhrases = true;
    }
  }

  if (mediaExtra.localScan && claimReview) {
    claimReview.fcaLocalScan = mediaExtra.localScan;
  }

  let highlightSpan = null;
  if (rangeSnapshot) {
    try {
      highlightSpan = wrapRangeWithHighlight(
        rangeSnapshot,
        displayStatus,
        claimReview
      );
    } catch (err) {
      fcaLog("highlight after sidebar-only error", err);
    }
  }

  if (gen !== fcaPanelFetchGeneration) {
    fcaLog("skip stale highlight after wrap (sidebar-only)");
    return;
  }

  const genCapture = gen;

  if (fetchError) {
    await fcaSidebarApplyResult(
      textSnapshot,
      finalStatus,
      claimReview,
      fetchError,
      mediaExtra
    );
  } else {
    const shown = await fcaSidebarApplyResult(
      textSnapshot,
      finalStatus,
      claimReview,
      "",
      mediaExtra
    );
    if (!newsPending) {
      void fcaSidebarPersistHistory(textSnapshot, shown || finalStatus);
    }
  }

  if (newsPending) {
    trustedNewsPromise.then(async (trustedNews) => {
      if (genCapture !== fcaPanelFetchGeneration) return;
      const mediaExtra2 = {
        localScan: mediaExtra.localScan,
        trustedNews: Array.isArray(trustedNews) ? trustedNews : []
      };
      if (fetchError) {
        await fcaSidebarApplyResult(
          textSnapshot,
          finalStatus,
          claimReview,
          fetchError,
          mediaExtra2
        );
      } else {
        const shown2 = await fcaSidebarApplyResult(
          textSnapshot,
          finalStatus,
          claimReview,
          "",
          mediaExtra2
        );
        void fcaSidebarPersistHistory(textSnapshot, shown2 || finalStatus);
      }
      requestAnimationFrame(() => fcaSidebarSyncLayout());
    });
  }

  if (highlightSpan?.isConnected) {
    fcaPanelAnchorEl = highlightSpan;
    fcaPendingRange = null;
  }

  requestAnimationFrame(() => {
    fcaSidebarSyncLayout();
  });
}

/**
 * 僅側欄查核（不建立左側「段落查核」浮窗）。觸發鈕應優先呼叫此函式。
 */
function fcaStartFactCheckFromSelection(rangeClone, rawText) {
  if (!fcaIsUiTopWindow()) return;
  if (!rangeClone || typeof rangeClone.cloneRange !== "function") return;
  removeFcTriggerIcon();
  removeFcFloatingPanel();
  fcaPanelFetchGeneration += 1;
  const panelSessionGen = fcaPanelFetchGeneration;
  fcaWholePageMode = false;
  fcaPendingRange = rangeClone.cloneRange();
  fcaPendingText = String(rawText || "").trim();
  /* YouTube 全寬側欄易與內建版面衝突；預設窄條，仍可手動展開。 */
  fcaSidebarUserCollapsed = fcaIsYoutubeWatchPage();
  ensureFcSidebar();
  fcaSidebarApplyLoading(fcaPendingText);
  void fcaRunFactCheckSidebarOnly(panelSessionGen, null).catch((e) => {
    fcaLog("factcheck sidebar-only fatal", e);
    if (panelSessionGen !== fcaPanelFetchGeneration) return;
    void (async () => {
      await fcaSidebarApplyResult(
        fcaPendingText,
        "Yellow",
        null,
        String(e?.message || e)
      );
    })();
  });
}

async function fcaStartFactCheckWholePage() {
  if (!fcaIsUiTopWindow()) return;
  removeFcTriggerIcon();
  removeFcFloatingPanel();
  const pageEl = fcaPickPageArticleElement();
  const pageRange = document.createRange();
  try {
    pageRange.selectNodeContents(pageEl || document.body);
  } catch {
    pageRange.selectNodeContents(document.body);
  }
  const pageRangeText = String(pageRange.toString() || "").trim();
  const pageText = pageRangeText.slice(0, 4200).trim();
  if (pageText.replace(/\s/g, "").length < 40) {
    window.alert("目前抓不到足夠頁面內容，請換到文章頁後再試。");
    return;
  }
  fcaPanelFetchGeneration += 1;
  const panelSessionGen = fcaPanelFetchGeneration;
  fcaWholePageMode = true;
  fcaPendingRange = pageRange;
  fcaPendingText = pageText;
  fcaSidebarUserCollapsed = fcaIsYoutubeWatchPage();
  ensureFcSidebar();
  fcaSidebarApplyLoading("整頁重點內容");
  void fcaRunFactCheckSidebarOnly(panelSessionGen, null).catch((e) => {
    fcaLog("factcheck whole-page fatal", e);
    if (panelSessionGen !== fcaPanelFetchGeneration) return;
    void (async () => {
      await fcaSidebarApplyResult(
        "整頁重點內容",
        "Yellow",
        null,
        String(e?.message || e)
      );
    })();
  });
}

function fcaPanelRefreshDualUiMode() {
  if (!fcaPanelHost?.isConnected) return;
  const shadow = fcaPanelHost.shadowRoot;
  const phaseResult = shadow?.getElementById("phaseResult");
  if (!phaseResult?.classList.contains("visible")) return;
  if (!fcaFloatingExpandAfterLoadFn || !fcaFloatingEnterFabModeFn) return;
  if (fcaSidebarIsFullExpanded()) {
    fcaFloatingEnterFabModeFn();
  } else {
    fcaFloatingExpandAfterLoadFn();
  }
  fcaPanelScheduleRelayout?.();
}

function showFcFloatingPanel(rangeClone, rawText) {
  if (!fcaIsUiTopWindow()) return;
  if (!rangeClone || typeof rangeClone.cloneRange !== "function") return;
  removeFcTriggerIcon();
  removeFcFloatingPanel();
  fcaPanelFetchGeneration += 1;
  const panelSessionGen = fcaPanelFetchGeneration;

  fcaWholePageMode = false;
  fcaPendingRange = rangeClone.cloneRange();
  fcaPendingText = String(rawText || "").trim();

  fcaSidebarUserCollapsed = fcaIsYoutubeWatchPage();
  ensureFcSidebar();
  fcaSidebarApplyLoading(fcaPendingText);

  if (FCA_FLOAT_PANEL_DISABLED) {
    void fcaRunFactCheckSidebarOnly(panelSessionGen, null).catch((e) => {
      fcaLog("factcheck sidebar-only fatal", e);
      if (panelSessionGen !== fcaPanelFetchGeneration) return;
      void (async () => {
        await fcaSidebarApplyResult(
          fcaPendingText,
          "Yellow",
          null,
          String(e?.message || e)
        );
      })();
    });
    return;
  }

  const host = document.createElement("div");
  host.setAttribute("data-fca-panel-host", "1");
  host.style.cssText = [
    "position:fixed",
    "margin:0",
    "padding:0",
    `z-index:${FCA_Z_FLOAT_PANEL}`,
    "pointer-events:none",
    "left:0",
    "top:0",
    "font-family:system-ui,-apple-system,'SF Pro Text',Segoe UI,sans-serif",
    "transition:left 0.22s ease-out,top 0.22s ease-out"
  ].join(";");

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button:focus-visible,
      a.fca-panel-open:focus-visible {
        outline: 2px solid #2563eb;
        outline-offset: 2px;
      }
      .fca-fab-shield:focus-visible {
        outline: 2px solid #34d399;
        outline-offset: 2px;
      }
      .fca-panel-retry {
        display: block;
        width: 100%;
        margin-top: 12px;
        cursor: pointer;
        font: 12px/1.2 system-ui, -apple-system, sans-serif;
        font-weight: 600;
        color: rgba(40, 40, 45, 0.92);
        background: rgba(255, 255, 255, 0.65);
        border: 1px solid rgba(0, 0, 0, 0.08);
        padding: 8px 14px;
        border-radius: 10px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
      }
      .fca-panel-retry:hover {
        background: rgba(255, 255, 255, 0.88);
      }
      .wrap {
        pointer-events: auto;
        min-width: 260px;
        max-width: min(340px, calc(100vw - 20px));
        color: rgba(20, 20, 22, 0.92);
        border-radius: 28px;
        background: linear-gradient(
          172deg,
          rgba(255, 255, 255, 0.74) 0%,
          rgba(248, 250, 255, 0.58) 40%,
          rgba(242, 244, 252, 0.64) 100%
        );
        backdrop-filter: saturate(245%) blur(56px) brightness(1.05) contrast(1.01);
        -webkit-backdrop-filter: saturate(245%) blur(56px) brightness(1.05) contrast(1.01);
        border: 1px solid rgba(255, 255, 255, 0.82);
        box-shadow:
          0 28px 72px rgba(0, 0, 0, 0.1),
          0 10px 32px rgba(99, 102, 241, 0.11),
          0 3px 16px rgba(56, 189, 248, 0.08),
          inset 0 1px 0 rgba(255, 255, 255, 1),
          inset 0 0 0 0.5px rgba(255, 255, 255, 0.52);
        overflow: hidden;
        font: 13px/1.35 system-ui, -apple-system, "SF Pro Text", sans-serif;
        transition: min-height 0.22s ease, padding 0.22s ease, opacity 0.18s ease, border-radius 0.2s ease;
      }
      /* 與側欄統一：淺色卡片、約 14px 圓角、柔和陰影（段落查核浮窗） */
      .wrap.fca-ui-unified {
        border-radius: 14px;
        background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
        border: 1px solid rgba(0, 0, 0, 0.08);
        box-shadow:
          0 8px 24px rgba(15, 23, 42, 0.1),
          0 2px 6px rgba(15, 23, 42, 0.04);
        backdrop-filter: saturate(190%) blur(18px);
        -webkit-backdrop-filter: saturate(190%) blur(18px);
      }
      /* 接近 iOS 系統橫幅通知被收回：略往上、略縮、淡出；timing ≈ UIView 預設 easeInOut（350ms） */
      @keyframes fca-ios-panel-out {
        from {
          opacity: 1;
          transform: translate3d(0, 0, 0) scale(1);
        }
        to {
          opacity: 0;
          transform: translate3d(0, -32px, 0) scale(0.94);
        }
      }
      @keyframes fca-ios-panel-out-fade {
        from { opacity: 1; }
        to { opacity: 0; }
      }
      .wrap.fca-panel-ios-dismissing {
        transform-origin: 50% 0%;
        animation: fca-ios-panel-out 0.35s cubic-bezier(0.42, 0, 0.58, 1) forwards;
        pointer-events: none;
      }
      @media (prefers-reduced-motion: reduce) {
        .wrap.fca-panel-ios-dismissing {
          animation: fca-ios-panel-out-fade 0.25s cubic-bezier(0.42, 0, 0.58, 1) forwards;
        }
        .fca-panel-load-dots,
        .fca-panel-load-phase {
          animation: none !important;
        }
        .fca-panel-load-phase {
          opacity: 1;
          transform: none;
        }
        .fca-panel-load-hp-fill {
          transition: none !important;
        }
        .fca-panel-load-hp-shine {
          animation: none !important;
          opacity: 0 !important;
        }
      }
      .wrap.wrap-collapsed {
        min-width: 0;
        border-radius: 9999px;
        box-shadow:
          0 10px 36px rgba(0, 0, 0, 0.16),
          0 2px 10px rgba(0, 0, 0, 0.08),
          inset 0 1px 0 rgba(255, 255, 255, 0.7);
      }
      .wrap.wrap-collapsed .fca-panel-body {
        display: none !important;
      }
      .fca-fab-shield {
        display: none;
        align-items: center;
        justify-content: center;
        width: 38px;
        height: 38px;
        margin: 0;
        padding: 0;
        border: none;
        border-radius: 10px;
        cursor: default;
        background: linear-gradient(
          145deg,
          rgba(15, 23, 42, 0.72) 0%,
          rgba(15, 23, 42, 0.52) 100%
        );
        backdrop-filter: saturate(200%) blur(22px);
        -webkit-backdrop-filter: saturate(200%) blur(22px);
        flex-shrink: 0;
        box-shadow:
          0 0 0 0.55px rgba(255, 255, 255, 0.12),
          0 0 0 1px rgba(110, 231, 183, 0.22),
          0 8px 24px rgba(15, 23, 42, 0.28),
          inset 0 1px 0 rgba(255, 255, 255, 0.06);
      }
      .fca-fab-shield .fca-tech-verify-svg {
        width: 20px;
        height: 20px;
        display: block;
      }
      .fca-fab-shield .fca-tv-frame {
        fill: rgba(6, 28, 22, 0.55);
        stroke: rgba(110, 231, 183, 0.88);
        stroke-width: 1;
      }
      .fca-fab-shield .fca-tv-mark {
        stroke: #b9ffe8;
        stroke-width: 1.5;
      }
      .fca-panel-fab.wrap-collapsed .fca-panel-head {
        padding: 0;
        border-bottom: none;
        background: transparent;
        justify-content: center;
      }
      .fca-panel-fab.wrap-collapsed .fca-panel-head-title,
      .fca-panel-fab.wrap-collapsed .fca-panel-collapse {
        display: none !important;
      }
      .fca-panel-fab.wrap-collapsed .fca-fab-shield {
        display: flex !important;
      }
      .fca-panel-peek .fca-fab-shield {
        display: none !important;
      }
      .fca-domain-scan {
        margin-top: 10px;
        padding: 11px 12px;
        border-radius: 15px;
        font-size: 12px;
        line-height: 1.55;
        border: 0.55px solid rgba(14, 165, 233, 0.26);
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.42) 0%,
          rgba(224, 242, 254, 0.32) 50%,
          rgba(255, 255, 255, 0.28) 100%
        );
        backdrop-filter: blur(28px) saturate(205%);
        -webkit-backdrop-filter: blur(28px) saturate(205%);
        color: rgba(12, 74, 110, 0.88);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.75),
          0 8px 26px rgba(0, 0, 0, 0.08);
      }
      .fca-domain-scan__title {
        font-weight: 700;
        margin-bottom: 6px;
        color: rgba(7, 89, 133, 0.94);
        font-size: 12px;
      }
      .fca-domain-scan__hint {
        font-size: 11px;
        margin-bottom: 8px;
        color: rgba(3, 105, 161, 0.76);
        line-height: 1.45;
      }
      .fca-domain-scan__row {
        margin-bottom: 6px;
      }
      .fca-domain-scan__meta {
        margin-bottom: 6px;
        font-size: 11px;
        color: rgba(71, 85, 105, 0.82);
      }
      .fca-domain-scan__code {
        font-size: 11px;
        padding: 2px 7px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.5);
        border: 0.5px solid rgba(14, 165, 233, 0.2);
        color: rgba(12, 74, 110, 0.95);
      }
      .fca-realtime-news {
        margin-top: 10px;
        padding: 11px 12px;
        border-radius: 15px;
        font-size: 12px;
        line-height: 1.55;
        border: 0.55px solid rgba(100, 116, 139, 0.22);
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.4) 0%,
          rgba(248, 250, 252, 0.3) 100%
        );
        backdrop-filter: blur(26px) saturate(200%);
        -webkit-backdrop-filter: blur(26px) saturate(200%);
        color: rgba(30, 41, 59, 0.9);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.72),
          0 8px 24px rgba(0, 0, 0, 0.07);
      }
      .fca-realtime-news__title {
        font-weight: 700;
        margin-bottom: 6px;
        color: rgba(15, 23, 42, 0.92);
        font-size: 12px;
      }
      .fca-realtime-news__hint {
        font-size: 11px;
        margin-bottom: 8px;
        color: rgba(71, 85, 105, 0.8);
        line-height: 1.45;
      }
      .fca-realtime-news__digest {
        font-size: 11px;
        margin-bottom: 8px;
        color: rgba(51, 65, 85, 0.9);
        line-height: 1.45;
      }
      .fca-realtime-news--embedded-in-ai {
        margin-top: 0;
        padding: 9px 10px;
        border-radius: 12px;
      }
      .fca-realtime-news__embed-lead {
        font-size: 11px;
        line-height: 1.45;
        margin-bottom: 7px;
        padding: 5px 8px;
        border-radius: 8px;
        background: rgba(241, 245, 249, 0.95);
        border: 1px solid rgba(0, 0, 0, 0.06);
        color: rgba(51, 65, 85, 0.92);
      }
      .fca-realtime-news__list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .fca-realtime-news__pending,
      .fca-realtime-news__empty {
        font-size: 11px;
        color: rgba(100, 116, 139, 0.88);
      }
      .fca-news-sk {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .fca-realtime-news__link {
        margin-top: 0;
      }
      .fca-ai-summary__news {
        margin-top: 6px;
        padding-top: 8px;
        border-top: 1px solid rgba(0, 0, 0, 0.07);
      }
      .fca-ai-summary__news .fca-realtime-news {
        margin-top: 0;
      }
      .fca-ai-summary {
        margin-top: 10px;
        padding: 11px 12px;
        border-radius: 15px;
        font-size: 12px;
        line-height: 1.55;
        border: 0.55px solid rgba(124, 58, 237, 0.28);
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.36) 0%,
          rgba(237, 233, 254, 0.32) 50%,
          rgba(250, 245, 255, 0.26) 100%
        );
        backdrop-filter: blur(28px) saturate(205%);
        -webkit-backdrop-filter: blur(28px) saturate(205%);
        color: rgba(49, 46, 129, 0.9);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.72),
          0 8px 26px rgba(0, 0, 0, 0.08);
      }
      .fca-ai-summary__title {
        font-weight: 700;
        margin-bottom: 6px;
        color: rgba(76, 29, 149, 0.92);
        font-size: 12px;
      }
      .fca-ai-summary__hint {
        font-size: 11px;
        margin-bottom: 8px;
        color: rgba(76, 29, 149, 0.88);
        line-height: 1.45;
      }
      .fca-ai-summary__rule {
        font-size: 11px;
        line-height: 1.45;
        margin: -2px 0 8px;
        padding: 6px 8px;
        border-radius: 10px;
        background: rgba(124, 58, 237, 0.06);
        border: 1px solid rgba(124, 58, 237, 0.12);
        color: rgba(67, 56, 202, 0.92);
      }
      .fca-ai-summary__body {
        white-space: pre-wrap;
        word-break: break-word;
        color: rgba(30, 27, 75, 0.98);
      }
      .fca-ai-summary__tag {
        font-weight: 600;
        color: rgba(76, 29, 149, 0.95);
      }
      .fca-ai-summary__diag {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 0.55px solid rgba(0, 0, 0, 0.08);
        font-size: 10px;
        line-height: 1.35;
        color: rgba(71, 85, 105, 0.7);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fca-ai-summary--inactive {
        opacity: 0.9;
        filter: saturate(0.92);
      }

      .fca-domain-scan.fca-aux-classic,
      .fca-realtime-news.fca-aux-classic,
      .fca-ai-summary.fca-aux-classic {
        border-radius: 10px;
        padding: 10px 12px;
        margin-top: 10px;
        border: 1px solid rgba(0, 0, 0, 0.08);
        background: rgba(255, 255, 255, 0.62);
        backdrop-filter: blur(14px) saturate(160%);
        -webkit-backdrop-filter: blur(14px) saturate(160%);
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
      }
      .fca-domain-scan.fca-aux-classic .fca-domain-scan__title,
      .fca-realtime-news.fca-aux-classic .fca-realtime-news__title,
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__title {
        color: rgba(15, 23, 42, 0.92);
      }
      .fca-domain-scan.fca-aux-classic .fca-domain-scan__hint,
      .fca-realtime-news.fca-aux-classic .fca-realtime-news__hint,
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__hint {
        color: rgba(71, 85, 105, 0.78);
      }
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__rule {
        background: rgba(241, 245, 249, 0.95);
        border-color: rgba(0, 0, 0, 0.08);
        color: rgba(30, 41, 59, 0.9);
      }
      .fca-domain-scan.fca-aux-classic .fca-domain-scan__row,
      .fca-domain-scan.fca-aux-classic .fca-domain-scan__body {
        color: rgba(30, 41, 59, 0.88);
      }
      .fca-domain-scan.fca-aux-classic .fca-domain-scan__meta {
        color: rgba(100, 116, 139, 0.82);
      }
      .fca-realtime-news.fca-aux-classic .fca-realtime-news__pending,
      .fca-realtime-news.fca-aux-classic .fca-realtime-news__empty {
        color: rgba(100, 116, 139, 0.85);
      }
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__body {
        color: rgba(30, 27, 75, 0.95);
      }
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__tag {
        color: rgba(76, 29, 149, 0.9);
      }
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__diag {
        white-space: normal;
      }
      .fca-ai-summary.fca-aux-classic .fca-ai-summary__fix {
        border-radius: 8px;
        padding: 6px 10px;
      }

      .fca-panel-peek .fca-domain-scan,
      .fca-panel-peek .fca-ai-summary,
      .fca-panel-peek .result-hint {
        display: none !important;
      }
      .fca-panel-peek .verdict-scroll {
        max-height: 6rem;
      }
      .fca-panel-peek {
        border-radius: 14px !important;
      }
      .fca-panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.28);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border-bottom: 0.55px solid rgba(0, 0, 0, 0.06);
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }
      .fca-panel-head.fca-panel-head--dragging {
        cursor: grabbing;
      }
      .wrap.wrap-collapsed .fca-panel-head {
        border-bottom: none;
        background: rgba(255, 255, 255, 0.18);
        padding: 8px 14px 8px 16px;
      }
      .fca-panel-head-title {
        font-weight: 600;
        font-size: 13px;
        color: rgba(28, 28, 30, 0.95);
        line-height: 1.35;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        letter-spacing: -0.01em;
      }
      .fca-panel-collapse {
        flex-shrink: 0;
        margin: 0;
        cursor: pointer;
        font: 12px/1 system-ui, -apple-system, sans-serif;
        font-weight: 600;
        color: rgba(40, 40, 45, 0.88);
        background: rgba(255, 255, 255, 0.38);
        backdrop-filter: saturate(195%) blur(20px);
        -webkit-backdrop-filter: saturate(195%) blur(20px);
        border: 0.55px solid rgba(255, 255, 255, 0.62);
        padding: 6px 12px;
        border-radius: 999px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
      }
      .fca-panel-collapse:hover {
        background: rgba(255, 255, 255, 0.62);
        color: rgba(10, 10, 12, 0.95);
      }
      .fca-panel-body {
        min-width: 260px;
        background: rgba(255, 255, 255, 0.22);
        backdrop-filter: blur(14px) saturate(165%);
        -webkit-backdrop-filter: blur(14px) saturate(165%);
      }
      .fca-phase-loading {
        display: none;
        flex-direction: column;
        align-items: stretch;
        justify-content: center;
        padding: 18px 16px 20px;
        gap: 14px;
        width: 100%;
        box-sizing: border-box;
      }
      .fca-phase-loading.visible { display: flex; }
      .fca-phase-loading-inner {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }
      .fca-panel-mascot-stack {
        position: relative;
        width: 100%;
        max-width: 220px;
        padding-top: 40px;
        margin: 0 auto;
      }
      .fca-panel-turtle-on-bar {
        position: absolute;
        left: 50%;
        bottom: 4px;
        transform: translateX(-50%);
        width: 58px;
        height: 52px;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        z-index: 3;
        pointer-events: none;
        filter: drop-shadow(0 4px 14px rgba(37, 99, 235, 0.26));
      }
      .fca-panel-turtle-on-bar .fca-loading-turtle-img {
        width: 54px;
        height: 54px;
        display: block;
        object-fit: contain;
        pointer-events: none;
        user-select: none;
      }
      .fca-panel-load-hp-track {
        position: relative;
        z-index: 1;
        width: 100%;
        max-width: 220px;
        height: 10px;
        padding: 2px;
        border-radius: 999px;
        margin: 0 auto;
        box-sizing: border-box;
        background: linear-gradient(
          165deg,
          rgba(255, 255, 255, 0.72) 0%,
          rgba(224, 242, 254, 0.52) 100%
        );
        border: 1px solid rgba(0, 0, 0, 0.1);
        box-shadow:
          inset 0 2px 8px rgba(0, 0, 0, 0.12),
          inset 0 -1px 0 rgba(255, 255, 255, 0.85),
          0 0 0 0.5px rgba(59, 130, 246, 0.18),
          0 4px 16px rgba(59, 130, 246, 0.1);
        overflow: hidden;
      }
      .fca-panel-load-hp-fill {
        position: relative;
        height: 100%;
        width: 5%;
        min-width: 4px;
        border-radius: 999px;
        box-sizing: border-box;
        background: linear-gradient(
          128deg,
          #dbeafe 0%,
          #93c5fd 22%,
          #3b82f6 48%,
          #2563eb 72%,
          #1e3a8a 100%
        );
        box-shadow:
          0 0 16px rgba(59, 130, 246, 0.42),
          inset 0 1px 0 rgba(255, 255, 255, 0.56),
          inset 0 -3px 6px rgba(30, 58, 138, 0.35);
        transition: width 0.52s cubic-bezier(0.33, 1, 0.28, 1);
      }
      .fca-panel-load-hp-fill::before {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        height: 48%;
        border-radius: 999px 999px 0 0;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.65), transparent);
        opacity: 0.75;
        pointer-events: none;
      }
      .fca-panel-load-hp-shine {
        position: absolute;
        top: 0;
        bottom: 0;
        left: -55%;
        width: 50%;
        border-radius: inherit;
        background: linear-gradient(
          105deg,
          transparent 0%,
          rgba(255, 255, 255, 0.1) 35%,
          rgba(255, 255, 255, 0.45) 50%,
          rgba(255, 255, 255, 0.08) 65%,
          transparent 100%
        );
        animation: fca-panel-hp-shine-sweep 2.1s ease-in-out infinite;
        pointer-events: none;
      }
      @keyframes fca-panel-hp-shine-sweep {
        0% {
          transform: translateX(0);
          opacity: 0;
        }
        12% {
          opacity: 1;
        }
        100% {
          transform: translateX(280%);
          opacity: 0;
        }
      }
      .fca-panel-load-copy {
        text-align: center;
        width: 100%;
        padding: 0 4px;
      }
      .fca-panel-load-title {
        font-size: 13px;
        font-weight: 600;
        color: rgba(30, 30, 36, 0.92);
        letter-spacing: 0.02em;
      }
      .fca-panel-load-dots {
        display: inline-block;
        margin-left: 2px;
        animation: fca-panel-load-dots 1.1s steps(4, end) infinite;
      }
      @keyframes fca-panel-load-dots {
        0%,
        20% {
          opacity: 0.35;
        }
        50% {
          opacity: 1;
        }
        100% {
          opacity: 0.35;
        }
      }
      .fca-panel-load-phase {
        margin-top: 6px;
        font-size: 11px;
        line-height: 1.45;
        font-weight: 500;
        color: rgba(75, 80, 95, 0.9);
        animation: fca-panel-phase-in 0.42s cubic-bezier(0.25, 0.82, 0.28, 1);
      }
      @keyframes fca-panel-phase-in {
        from {
          opacity: 0.25;
          transform: translateY(4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .fca-phase-result {
        display: none;
        padding: 12px 14px 14px;
      }
      .fca-phase-result.visible { display: block; }
      .result-h { font-weight: 700; font-size: 14px; margin-bottom: 10px; }
      .result-chip {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        margin-bottom: 10px;
      }
      .chip-red { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }
      .chip-orange { background: #fed7aa; color: #9a3412; border: 1px solid #f97316; }
      .chip-yellow { background: #fef9c3; color: #a16207; border: 1px solid #facc15; }
      .chip-green { background: #ecfdf5; color: #166534; border: 1px solid rgba(34, 197, 94, 0.22); }
      .chip-gray { background: #e5e7eb; color: #374151; border: 1px solid #d1d5db; }
      .chip-blue { background: #dbeafe; color: #1d4ed8; border: 1px solid #93c5fd; }
      .result-hint { font-size: 11px; color: #6b7280; margin-top: 8px; line-height: 1.4; }
      .result-nomatch {
        font-size: 12px; color: rgba(45, 45, 50, 0.92); font-weight: 600; margin-bottom: 8px;
        padding: 8px 10px; background: rgba(255, 255, 255, 0.45); border-radius: 8px; line-height: 1.45;
        border: 1px solid rgba(255, 255, 255, 0.4);
      }
      .result-meta { font-size: 12px; color: #444; margin-top: 6px; word-break: break-word; }
      .result-meta b { color: #111; }
      .result-prov {
        font-size: 10px;
        font-weight: 700;
        color: #6b7280;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        margin-bottom: 6px;
      }
      .result-match-hint {
        font-size: 11px;
        line-height: 1.45;
        color: #4b5563;
        margin: 0 0 8px;
        padding: 6px 8px;
        border-radius: 8px;
        background: rgba(249, 250, 251, 0.95);
        border: 1px solid rgba(229, 231, 235, 0.95);
      }
      .result-match-actions {
        margin: 0 0 10px;
      }
      .fca-panel-match-report {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid rgba(99, 102, 241, 0.22);
        background: rgba(238, 242, 255, 0.75);
        color: #4338ca;
        font-size: 11px;
        font-weight: 600;
        line-height: 1.35;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .fca-panel-match-report:hover {
        background: rgba(224, 231, 255, 0.95);
        border-color: rgba(79, 70, 229, 0.35);
      }
      .verdict-scroll {
        max-height: 10rem;
        overflow-y: auto;
        padding: 8px 10px;
        margin-top: 6px;
        background: rgba(255, 255, 255, 0.44);
        backdrop-filter: blur(22px) saturate(195%);
        -webkit-backdrop-filter: blur(22px) saturate(195%);
        border-radius: 12px;
        border: 0.55px solid rgba(255, 255, 255, 0.5);
        line-height: 1.5;
        color: rgba(45, 45, 50, 0.92);
      }
      .panel-verdict-reason {
        font-size: 12px;
        line-height: 1.55;
        color: rgba(45, 45, 50, 0.92);
        margin-top: 8px;
        padding: 8px 10px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.5);
        border: 0.55px solid rgba(255, 255, 255, 0.55);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .panel-verdict-reason--scroll {
        min-height: 10rem;
        max-height: 20rem;
        overflow-y: auto;
        scrollbar-gutter: stable;
        scrollbar-width: auto;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        touch-action: pan-y;
        padding-right: 8px;
      }
      .panel-verdict-reason--scroll::-webkit-scrollbar {
        width: 9px;
      }
      .panel-verdict-reason--scroll::-webkit-scrollbar-thumb {
        background: rgba(148, 163, 184, 0.58);
        border-radius: 999px;
      }
      .panel-verdict-reason--scroll::-webkit-scrollbar-track {
        background: rgba(148, 163, 184, 0.18);
        border-radius: 999px;
      }
      .panel-verdict-preview {
        font-size: 12px;
        line-height: 1.55;
        opacity: 0.95;
      }
      .panel-reason-details {
        margin-top: 6px;
        font-size: 11px;
      }
      .panel-reason-details summary {
        cursor: pointer;
        font-weight: 600;
        color: #2563eb;
      }
      .panel-reason-body {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.55;
        white-space: pre-wrap;
        color: rgba(45, 45, 50, 0.92);
      }
      .panel-verdict-news {
        margin-top: 8px;
        padding: 8px 10px;
        border-radius: 10px;
        font-size: 11px;
        line-height: 1.45;
        color: rgba(45, 45, 50, 0.9);
        background: rgba(255, 255, 255, 0.42);
        border: 0.55px solid rgba(255, 255, 255, 0.5);
      }
      .panel-verdict-news-title {
        font-weight: 700;
        margin-bottom: 4px;
      }
      .panel-verdict-news-line {
        margin-top: 3px;
        word-break: break-word;
      }
      .panel-verdict-news-line .ref {
        color: #1d4ed8;
        font-weight: 600;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .fca-verdict-true {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 17px;
        height: 17px;
        margin-left: 4px;
        vertical-align: middle;
        filter: drop-shadow(0 0 5px rgba(52, 211, 153, 0.2));
      }
      .fca-verdict-true .fca-tech-verify-svg {
        width: 17px;
        height: 17px;
        display: block;
      }
      .fca-verdict-true .fca-tv-frame {
        fill: rgba(4, 18, 14, 0.65);
        stroke: rgba(5, 150, 105, 0.65);
        stroke-width: 1;
      }
      .fca-verdict-true .fca-tv-mark {
        stroke: rgba(4, 120, 87, 0.98);
        stroke-width: 1.45;
      }
      .fca-panel-open {
        margin-left: 6px;
        font-size: 12px;
        font-weight: 600;
        color: #2563eb;
        text-decoration: none;
        border-bottom: 1px solid rgba(37, 99, 235, 0.35);
      }
      .fca-panel-open:hover { color: #1d4ed8; }
      @keyframes fca-sk-pulse-panel {
        0%,
        100% {
          opacity: 0.42;
        }
        50% {
          opacity: 0.92;
        }
      }
      .fca-news-sk-line {
        height: 11px;
        border-radius: 5px;
        background: #cbd5e1;
        animation: fca-sk-pulse-panel 1.12s ease-in-out infinite;
      }
    </style>
    <div class="wrap wrap-collapsed fca-ui-unified" id="root" role="complementary" aria-labelledby="panelHeadTitle">
      <div class="fca-panel-head">
        <button type="button" class="fca-fab-shield" id="panelFabShield" aria-label="查核摘要（完整內容在右側側欄）" title="完整查核在右側側欄；游標移到文中色塊可顯示此段摘要">${fcaTechVerifiedSvg()}</button>
        <span class="fca-panel-head-title" id="panelHeadTitle">查詢中…</span>
        <button type="button" class="fca-panel-collapse" id="panelCollapseBtn" aria-expanded="false" aria-label="展開查核內容" title="展開查核內容">展開</button>
      </div>
      <div class="fca-panel-body" id="panelBody">
        <div class="fca-phase-loading" id="phaseLoading" role="status" aria-live="polite" aria-busy="true">
          <div class="fca-phase-loading-inner">
            <div class="fca-panel-mascot-stack" aria-hidden="true">
              <div
                class="fca-panel-load-hp-track"
                id="panelLoadHpTrack"
                role="progressbar"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow="5"
                aria-label="查詢進度示意"
              >
                <div class="fca-panel-load-hp-fill" id="panelLoadHpFill">
                  <span class="fca-panel-load-hp-shine" aria-hidden="true"></span>
                </div>
              </div>
              <div class="fca-panel-turtle-on-bar">${fcaLoadingTurtleImgHtml()}</div>
            </div>
            <div class="fca-panel-load-copy">
              <div class="fca-panel-load-title">查詢中<span class="fca-panel-load-dots" aria-hidden="true">…</span></div>
              <div class="fca-panel-load-phase" id="panelLoadPhase"></div>
            </div>
          </div>
        </div>
        <div class="fca-phase-result" id="phaseResult" role="status" aria-live="polite" aria-atomic="true">
          <div class="result-h" id="resultTitle">查核結果</div>
          <div class="result-chip" id="resultChip"></div>
          <div class="result-meta" id="resultPub"></div>
          <div class="result-meta" id="resultRate"></div>
        </div>
      </div>
    </div>
  `;

  fcaAppendExtensionUiHost(host);
  fcaPanelHost = host;
  fcaPanelAttachEscapeHandler();

  const root = shadow.getElementById("root");
  const phaseLoading = shadow.getElementById("phaseLoading");
  const phaseResult = shadow.getElementById("phaseResult");
  const resultChip = shadow.getElementById("resultChip");
  const resultPub = shadow.getElementById("resultPub");
  const resultRate = shadow.getElementById("resultRate");
  const resultTitle = shadow.getElementById("resultTitle");
  const panelHeadTitle = shadow.getElementById("panelHeadTitle");
  const panelCollapseBtn = shadow.getElementById("panelCollapseBtn");
  const panelHead = shadow.querySelector(".fca-panel-head");
  const panelLoadPhase = shadow.getElementById("panelLoadPhase");
  const panelLoadHpFill = shadow.getElementById("panelLoadHpFill");
  const panelLoadHpTrack = shadow.getElementById("panelLoadHpTrack");
  let fcaPanelLoadTicker = null;
  let fcaPanelLoadHpTicker = null;

  function stopPanelLoadTicker() {
    if (fcaPanelLoadTicker != null) {
      clearInterval(fcaPanelLoadTicker);
      fcaPanelLoadTicker = null;
    }
    if (fcaPanelLoadHpTicker != null) {
      clearInterval(fcaPanelLoadHpTicker);
      fcaPanelLoadHpTicker = null;
    }
  }

  function startPanelLoadTicker() {
    stopPanelLoadTicker();
    if (!panelLoadPhase) return;
    const phases = FCA_LOAD_SOURCE_PHASES;
    const n = phases.length;
    let idx = 0;
    const startedAt = Date.now();
    const bumpHp = () => {
      if (!panelLoadHpFill?.isConnected) {
        stopPanelLoadTicker();
        return;
      }
      fcaApplyLoadProgressByTime(panelLoadHpFill, panelLoadHpTrack, startedAt);
    };
    bumpHp();
    fcaPanelLoadHpTicker = setInterval(bumpHp, 120);
    const tick = () => {
      if (!panelLoadPhase.isConnected) {
        stopPanelLoadTicker();
        return;
      }
      const step = Math.min(idx, n - 1);
      panelLoadPhase.textContent = phases[step];
      panelLoadPhase.style.animation = "none";
      void panelLoadPhase.offsetHeight;
      panelLoadPhase.style.animation = "";
      if (idx < n - 1) idx += 1;
    };
    tick();
    fcaPanelLoadTicker = setInterval(tick, 1400);
  }

  function setPanelLoadingUi(vis) {
    phaseLoading.classList.toggle("visible", vis);
    phaseLoading.setAttribute("aria-busy", vis ? "true" : "false");
    if (vis) startPanelLoadTicker();
    else {
      if (panelLoadHpFill?.style) {
        panelLoadHpFill.style.width = "100%";
      }
      if (panelLoadHpTrack) {
        panelLoadHpTrack.setAttribute("aria-valuenow", "100");
      }
      stopPanelLoadTicker();
    }
  }

  function syncFloatingPanelHeadTitle() {
    if (!panelHeadTitle) return;
    if (phaseLoading.classList.contains("visible")) {
      panelHeadTitle.textContent = "查詢中…";
      return;
    }
    const chipTxt = (resultChip?.textContent || "").trim();
    if (root.classList.contains("wrap-collapsed") && chipTxt) {
      panelHeadTitle.textContent = `查核：${chipTxt}`;
      return;
    }
    const t = (resultTitle?.textContent || "").trim();
    panelHeadTitle.textContent = t || "查核結果";
  }

  function expandFloatingPanelAfterLoad() {
    clearTimeout(fcaPanelPeekTimer);
    fcaPanelPeekTimer = null;
    fcaPanelFabActive = false;
    root.classList.remove("fca-panel-fab", "fca-panel-peek");
    root.classList.remove("wrap-collapsed");
    host.style.bottom = "";
    host.style.right = "";
    host.style.left = "";
    host.style.top = "";
    host.style.opacity = "";
    host.style.pointerEvents = "";
    if (panelCollapseBtn) {
      panelCollapseBtn.style.display = "";
      panelCollapseBtn.removeAttribute("aria-hidden");
      panelCollapseBtn.textContent = "收合";
      panelCollapseBtn.setAttribute("aria-expanded", "true");
      panelCollapseBtn.setAttribute("aria-label", "收合查核內容");
      panelCollapseBtn.title = "收合查核內容";
    }
    if (panelHead) panelHead.style.cursor = "grab";
    syncFloatingPanelHeadTitle();
  }

  if (panelCollapseBtn) {
    panelCollapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (fcaPanelFabActive && root.classList.contains("fca-panel-peek")) {
        fcaHidePeekToFab();
        syncFloatingPanelHeadTitle();
        requestAnimationFrame(() => {
          requestAnimationFrame(relayout);
        });
        return;
      }
      const collapsed = !root.classList.contains("wrap-collapsed");
      root.classList.toggle("wrap-collapsed", collapsed);
      panelCollapseBtn.textContent = collapsed ? "展開" : "收合";
      panelCollapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      panelCollapseBtn.setAttribute(
        "aria-label",
        collapsed ? "展開查核內容" : "收合查核內容"
      );
      panelCollapseBtn.title = collapsed ? "展開查核內容" : "收合查核內容";
      syncFloatingPanelHeadTitle();
      requestAnimationFrame(() => {
        requestAnimationFrame(relayout);
      });
    });
  }

  if (panelHead) {
    let drag = null;
    const dragTrans = "left 0.22s ease-out,top 0.22s ease-out";
    const dragThreshold = 6;
    const onPtrMove = (e) => {
      if (!drag || e.pointerId !== drag.pid || !fcaPanelHost) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < dragThreshold) return;
      if (!drag.moved) {
        drag.moved = true;
        panelHead.classList.add("fca-panel-head--dragging");
      }
      fcaPanelManualPos = {
        left: drag.sl + dx,
        top: drag.st + dy
      };
      positionPanelHost(fcaPanelHost, null, root);
    };
    const endDrag = (e) => {
      if (!drag) return;
      if (e && e.pointerId !== drag.pid) return;
      const moved = drag.moved;
      panelHead.classList.remove("fca-panel-head--dragging");
      try {
        if (e?.pointerId != null) panelHead.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      drag = null;
      if (fcaPanelHost) fcaPanelHost.style.transition = dragTrans;
      /* 未超過閾值：視為點擊，不覆寫既有 fcaPanelManualPos */
    };
    panelHead.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".fca-panel-collapse")) return;
      if (e.target.closest(".fca-fab-shield")) return;
      if (
        root.classList.contains("fca-panel-fab") &&
        root.classList.contains("wrap-collapsed") &&
        !root.classList.contains("fca-panel-peek")
      )
        return;
      if (!fcaPanelHost) return;
      const r = fcaPanelHost.getBoundingClientRect();
      drag = {
        pid: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        sl: r.left,
        st: r.top,
        moved: false
      };
      fcaPanelHost.style.transition = "none";
      try {
        panelHead.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    });
    panelHead.addEventListener("pointermove", onPtrMove);
    panelHead.addEventListener("pointerup", endDrag);
    panelHead.addEventListener("pointercancel", endDrag);
  }

  const relayout = () => {
    if (!fcaPanelHost || !root) return;
    if (
      fcaPanelFabActive &&
      root.classList.contains("fca-panel-fab") &&
      root.classList.contains("wrap-collapsed") &&
      !root.classList.contains("fca-panel-peek")
    ) {
      fcaPanelSilenceSidebarFabHost(fcaPanelHost);
      return;
    }
    if (fcaPanelManualPos) {
      positionPanelHost(fcaPanelHost, null, root);
      return;
    }
    const r = getPanelAnchorRect();
    if (!r?.width && !r?.height) {
      return;
    }
    positionPanelHost(fcaPanelHost, r, root);
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(relayout);
  });

  fcaPanelRepositionHandler = () => {
    if (fcaPanelRepositionRaf != null) return;
    fcaPanelRepositionRaf = requestAnimationFrame(() => {
      fcaPanelRepositionRaf = null;
      relayout();
    });
  };
  window.addEventListener("scroll", fcaPanelRepositionHandler, { capture: true, passive: true });
  window.addEventListener("resize", fcaPanelRepositionHandler, { passive: true });

  async function fillResultPanel(finalStatus, claimReview, errorText, mediaExtra = null) {
    await fcaGetExtensionLocalOpts();
    await fcaAiDiagPrimeFromStorage();
    phaseResult.classList.add("visible");
    resultChip.className = "result-chip";
    const chipKind = {
      Red: "chip-red",
      Orange: "chip-orange",
      Yellow: "chip-gray",
      Gray: "chip-gray",
      Green: "chip-green",
      Blue: "chip-blue"
    };
    if (errorText && !fcaIsSilentTimeoutError(errorText)) {
      resultTitle.textContent = fcaFloatingPanelTitle(errorText, null);
      resultChip.textContent = fcaFormatErrorForUi(errorText);
      resultChip.classList.add("chip-gray");
      resultPub.innerHTML = "";
      resultRate.innerHTML = `<button type="button" class="fca-panel-retry" id="fcaPanelRetryBtn" aria-label="重新嘗試查核">重新嘗試</button><div class="result-hint" style="margin-top:8px;" role="status">${escapeHtmlFc(
        "若仍失敗，請檢查網路或至右側側欄重試。"
      )}</div>`;
      return;
    }
    if (!claimReview) {
      resultTitle.textContent = fcaFloatingPanelTitle("", null);
      resultChip.classList.add("chip-gray");
      resultChip.textContent = "目前無法證實";
      const pageA = fcaPageContextOpenLinkHtml("開啟目前頁面（選文出處）");
      const suggest = fcaBuildNoResultSuggestionsHtml(fcaPendingText);
      resultPub.innerHTML = `<div class="result-hint">${escapeHtmlFc(
        "未在索引或 Cofacts 找到明確對應條目。下列連結為您選取文字時所開啟的網頁（例如 CNN 文章），並非查核機構結論。可改選較短關鍵句再試。"
      )}</div>${
        pageA
          ? `<div class="result-meta" style="margin-top:8px;">${escapeHtmlFc(
              "選文出處"
            )}：${pageA}</div>`
          : ""
      }${suggest || ""}${fcaPanelMatchReportSnippetHtml()}`;
      const mlOnly = fcaBuildDomainAnalysisSectionHtml(null, mediaExtra);
      const embedNewsInAi = fcaShouldEmbedTrustedNewsInAi(null, "Gray");
      const newsOnly = fcaBuildRealtimeNewsSectionHtml(mediaExtra, { suppress: embedNewsInAi });
      const aiOnly =
        fcaBuildAiSummarySectionHtml(null, fcaPendingText, {
          mediaExtra,
          embedTrustedNews: embedNewsInAi
        }) || "";
      const verdictNewsPanel = fcaBuildVerdictNewsInlineSummaryHtml(
        fcaPendingText,
        mediaExtra,
        "panel",
        null
      );
      resultRate.innerHTML =
        (verdictNewsPanel || "") + (mlOnly || "") + (newsOnly || "") + aiOnly;
      return;
    }
    resultTitle.textContent = fcaFloatingPanelTitle("", claimReview);
    let panelDisplay = fcaDisplayStatusForUi(finalStatus, claimReview);
    if (
      claimReview &&
      !claimReview.fcaCofacts &&
      !claimReview.fcaNoDirectCofactsMatch
    ) {
      const newsConsensus = fcaTrustedNewsConsensusStatus(fcaPendingText, mediaExtra);
      if (
        newsConsensus &&
        (panelDisplay === "Gray" || panelDisplay === "Blue" || panelDisplay === "Yellow")
      ) {
        panelDisplay = newsConsensus.status;
        claimReview.fcaNewsConsensusUsed = true;
        if (newsConsensus.summary) claimReview.fcaNewsSummaryLine = newsConsensus.summary;
      }
    }
    const pk = fcaNormalizeLegacyYellowStatus(panelDisplay);
    resultChip.classList.add(chipKind[pk] || "chip-gray");
    fcaStatusChipSetLabel(resultChip, panelDisplay);
    const primaryCr = fcaVerdictUiPrimaryClaimReview(claimReview);
    const publisher =
      primaryCr?.publisher?.name ||
      primaryCr?.publisher?.site ||
      "—";
    const site = (primaryCr?.publisher?.site || "")
      .replace(/^www\./, "")
      .trim();
    const pubLine =
      site && publisher !== site && !publisher.includes(site)
        ? `${publisher}（${site}）`
        : publisher;
    const textualRating = fcaVerdictTextualRatingAlignedWithChip(
      claimReview,
      panelDisplay,
      primaryCr
    );
    const prov = fcaResultProvenanceLine(claimReview);
    const safeUrl = fcaSafeHttpUrl(primaryCr?.url || claimReview.url);
    const linkHtml = safeUrl
      ? `<a class="fca-panel-open" href="${escapeHtmlFc(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtmlFc(
          fcaIndexSupersedesWeakCofacts(claimReview) && !safeUrl.includes("cofacts.tw")
            ? "開啟查核出處（索引）"
            : "開啟出處"
        )}</a>`
      : "";
    const pageOpenForCtx = !safeUrl ? fcaPageContextOpenLinkHtml("開啟目前頁面") : "";
    const pageCtxHtml = pageOpenForCtx
      ? ` <span class="result-meta">${escapeHtmlFc("選文出處")}：${pageOpenForCtx}</span>`
      : "";
    const noConsensusHint = claimReview?.cofactsNoConsensus
      ? `<div class="result-hint">${escapeHtmlFc(
          fcaIndexSupersedesWeakCofacts(claimReview)
            ? "浮窗判定已改採查核索引；Cofacts 條目尚無社群共識摘錄，請核對是否同一論點。"
            : claimReview?.fcaSupplementaryIndexReview
              ? "Cofacts 尚無共識摘錄；請一併查看下方「其他查核機構」（查核索引）。"
              : "目前社群尚無共識，建議自行查證"
        )}</div>`
      : "";
    const nomatchBanner = claimReview?.fcaNoDirectCofactsMatch
      ? `<div class="result-nomatch">${escapeHtmlFc(
          claimReview.textualRating ||
            fcaNoDirectCofactsHeadline(claimReview.fcaAiCategory)
        )}</div>`
      : "";
    const embedNewsInAi = fcaShouldEmbedTrustedNewsInAi(claimReview, pk);
    const aiCard =
      fcaBuildAiSummarySectionHtml(claimReview, fcaPendingText, {
        mediaExtra,
        embedTrustedNews: embedNewsInAi
      }) || "";
    const keyInvalidHint =
      claimReview?.fcaGeminiKeyInvalid && !claimReview?.fcaAiReason
        ? `<div class="result-hint" style="color:#b91c1c;font-weight:600;">${escapeHtmlFc(
            "Gemini：API 金鑰無效或已過期。請至 Google AI Studio 建立新金鑰，並在本擴充視窗「AI 二次判讀」區塊重新貼上後按儲存。"
          )}</div>`
        : "";
    const verdictOverrideHint =
      !claimReview?.fcaNoDirectCofactsMatch &&
      claimReview?.fcaAiOverrodeCofacts &&
      claimReview?.fcaAiReason
        ? `<div class="result-hint" style="background:#fffbeb;border:1px solid #fcd34d;color:#78350f;border-radius:8px;padding:8px;margin-bottom:6px;">${escapeHtmlFc(
            fcaAiOverrideBannerText(panelDisplay)
          )}</div>`
        : "";
    const thematicRefHint = claimReview?.fcaRelatedThemeOnly
      ? `<div class="result-hint" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:8px;margin-bottom:8px;">${escapeHtmlFc(
          "主題相近參考：此 Cofacts 條目與反白在主題或關鍵詞上部分重合，事件與論點未必相同。請開原文比對，勿當成同一則訊息已查核結論。"
        )}</div>`
      : "";
    const cofactsPanelHint =
      fcaIndexSupersedesWeakCofacts(claimReview) && claimReview?.fcaCofactsMatchHintZh
        ? `<div class="result-match-hint" role="note">${escapeHtmlFc(
            `Cofacts 條目對照：${claimReview.fcaCofactsMatchHintZh}`
          )}</div>`
        : "";
    const panelMatchHint =
      !fcaIndexSupersedesWeakCofacts(claimReview) && claimReview?.fcaCofactsMatchHintZh
        ? `<div class="result-match-hint" role="note">${escapeHtmlFc(
            claimReview.fcaCofactsMatchHintZh
          )}</div>`
        : "";
    resultPub.innerHTML = `${prov ? `<div class="result-prov">${escapeHtmlFc(prov)}</div>` : ""}${cofactsPanelHint}${panelMatchHint}${fcaPanelMatchReportSnippetHtml()}<b>來源</b>：${escapeHtmlFc(pubLine)}${linkHtml ? ` ${linkHtml}` : ""}${pageCtxHtml}`;
    const multiLexHint =
      claimReview?.fcaPhraseHighlights?.length > 1
        ? `<div class="result-hint" style="margin-top:4px;">${escapeHtmlFc(
            claimReview?.fcaSubjectiveOnlyHighlights
              ? "無查核命中時的標色：淺青＝偏事實敘述、橘＝偏觀點（關鍵字規則）。請與官方數字、裁處新聞交叉比對，勿將橘色當成「已查核為假」。"
              : "細部標色（反白可拆成多段時）：紅＝錯誤；橘＝部分錯誤；灰＝目前無法證實；綠＝正確；藍＝事實釐清。游標移到色塊可看說明；完整內容請看右側側欄。"
          )}</div>`
        : "";
    const mlBlock = fcaBuildDomainAnalysisSectionHtml(claimReview, mediaExtra);
    const newsBlock = fcaBuildRealtimeNewsSectionHtml(mediaExtra, { suppress: embedNewsInAi });
    const qPanel = String(fcaPendingText || "").trim();
    let reasonBodyPanel = fcaVerdictReasonSummaryText(
      primaryCr,
      panelDisplay,
      qPanel
    );
    if (
      claimReview?.fcaNewsConsensusUsed &&
      claimReview?.fcaNewsSummaryLine &&
      !String(reasonBodyPanel || "").includes(claimReview.fcaNewsSummaryLine)
    ) {
      reasonBodyPanel = `${claimReview.fcaNewsSummaryLine}\n\n${reasonBodyPanel}`;
    }
    const reasonHtmlPanel = fcaPanelFormatVerdictReasonHtml(reasonBodyPanel);
    const verdictNewsPanel =
      (fcaShouldAppendNewsToVerdictBlock(claimReview, reasonBodyPanel, pk) &&
        fcaBuildVerdictNewsInlineSummaryHtml(qPanel, mediaExtra, "panel", claimReview)) ||
      "";
    const suppPanel = fcaBuildSupplementaryIndexSectionHtml(
      claimReview,
      qPanel,
      "panel"
    );
    resultRate.innerHTML =
      (claimReview?.fcaNoDirectCofactsMatch
        ? `${keyInvalidHint}${nomatchBanner}${noConsensusHint}${reasonHtmlPanel}${verdictNewsPanel}${aiCard}`
        : `${keyInvalidHint}${thematicRefHint}${verdictOverrideHint}<div class="verdict-scroll"><b>判定</b>：${fcaVerdictDisplayHtml(
            textualRating
          )}</div>${reasonHtmlPanel}${verdictNewsPanel}${noConsensusHint}${multiLexHint}<div class="result-hint">${escapeHtmlFc(
            "提示：論據與出處請以右側側欄為主；游標移到文中色塊可看簡短說明。"
          )}</div>${aiCard}`) +
      (suppPanel || "") +
      (mlBlock || "") +
      (newsBlock || "");
  }

  async function runCofactsAndApplyHighlight(fixedUserStatus, gen) {
    fcaPanelClearAutoDismiss();
  const rangeSnapshot =
    fcaPendingRange && typeof fcaPendingRange.cloneRange === "function"
      ? fcaPendingRange.cloneRange()
      : null;
    const textSnapshot = fcaPendingText;

    const localScanPromise = fcaSendMessage({
      type: "FC_LOCAL_MEDIA_SCAN",
      text: textSnapshot,
      host: typeof location !== "undefined" ? location.hostname : ""
    }).catch(() => null);
    const newsPending = fcaShouldLoadTrustedRealtimeNews(textSnapshot);
    const trustedNewsPromise = newsPending
      ? fcaFetchTrustedRealtimeNews(textSnapshot, 5).catch(() => [])
      : Promise.resolve([]);

    let claimReview = null;
    let fetchError = "";
    let finalStatus = fixedUserStatus || "Yellow";
    try {
      const pack = await fcaWithTimeout(
        fetchFactCheckToolTopClaim(textSnapshot, {
          preferLatest: fcaSidebarPreferLatest
        }),
        FCA_FACTCHECK_HARD_TIMEOUT_MS,
        "FACTCHECK_TIMEOUT"
      );
      fetchError = pack.error || "";
      if (!fetchError) {
        claimReview = pack.claimReview;
        if (!fixedUserStatus) {
          finalStatus = pack.finalStatus;
          if (claimReview?.fcaCofacts) {
            finalStatus =
              claimReview.fcaResolvedStatus ||
              cofactsReplyTypeToFcaStatus(claimReview.cofactsReplyType);
          }
        }
      }
    } catch (e) {
      fcaLog("factcheck fetch error", e);
      fetchError = String(e?.message || e);
      if (isExtensionContextInvalidated(e)) {
        window.alert("事實查核助手已更新或重載，請重新整理此頁面後再試。");
      }
    }
    if (fetchError.includes("FACTCHECK_TIMEOUT")) {
      const fallbackPack = await fcaWithTimeout(
        fetchCofactsAsFallback(
          textSnapshot,
          fcaSidebarPreferLatest,
          "cofacts quick fallback after timeout",
          { forceSkipGemini: true, fastMode: true }
        ),
        5200,
        "COFACTS_TIMEOUT"
      ).catch(() => null);
      if (fallbackPack?.claimReview) {
        claimReview = fallbackPack.claimReview;
        if (!fixedUserStatus) {
          finalStatus = fallbackPack.finalStatus || "Yellow";
        }
        fetchError = "";
      }
    }

    /* 語意拆解須在 Gemini enrich 之前：否則 enrich 寫入的 fcaAiReason 會被此合成 claim 整段覆蓋。 */
    if (
      !fetchError &&
      !claimReview &&
      String(textSnapshot || "").replace(/\s/g, "").length >= 24
    ) {
      const subOnly = fcaBuildSubjectiveOnlyPhraseHighlights(textSnapshot.trim());
      if (subOnly) {
        claimReview = subOnly;
        if (!fixedUserStatus) finalStatus = "Gray";
      }
    }

    const articleCtxForAi = fcaShouldAttachArticleContextForStandaloneAi(
      claimReview,
      finalStatus
    )
      ? fcaExtractPageArticleContextForAi(4200)
      : "";

    try {
      const enrichedPack = await fcaWithTimeout(
        fcaEnrichWithStandaloneAi(textSnapshot, {
          claimReview,
          finalStatus,
          fetchError,
          fixedUserStatus,
          articleContext: articleCtxForAi
        }),
        FCA_AI_ENRICH_TIMEOUT_MS,
        "AI_ENRICH_TIMEOUT"
      );
      claimReview = enrichedPack.claimReview;
      finalStatus = enrichedPack.finalStatus;
      fetchError = enrichedPack.fetchError;
    } catch {
      // AI 補強逾時時直接忽略，避免整體卡住
    }

    const locRaw = await localScanPromise;
    const mediaExtra = {
      localScan: locRaw?.ok ? locRaw.scan : null,
      ...(newsPending ? { trustedNewsPending: true } : { trustedNews: [] })
    };

    if (gen !== fcaPanelFetchGeneration) {
      fcaLog("skip stale panel update");
      return;
    }

    fcaLog("factcheck panel", { finalStatus, hasReview: Boolean(claimReview) });

    const displayStatus = fcaDisplayStatusForUi(finalStatus, claimReview);
    if (
      !fetchError &&
      claimReview?.fcaIndexCorpus &&
      !claimReview.fcaCofacts &&
      !claimReview.fcaPhraseHighlights &&
      String(textSnapshot || "").replace(/\s/g, "").length >= 16
    ) {
      const ph = fcaBuildIndexMixedPhraseHighlights(
        textSnapshot.trim(),
        displayStatus,
        claimReview,
        claimReview.fcaIndexCorpus
      );
      if (ph.length > 1) {
        claimReview.fcaPhraseHighlights = ph;
        claimReview.fcaHighlightSourceText = textSnapshot.trim();
        claimReview.fcaIndexMixedPhrases = true;
      }
    }
  if (
    !fetchError &&
    fcaWholePageMode &&
    claimReview &&
    !claimReview.fcaPhraseHighlights &&
    String(textSnapshot || "").replace(/\s/g, "").length >= 60
  ) {
    const wp = fcaBuildSubjectiveOnlyPhraseHighlights(textSnapshot.trim());
    if (wp?.fcaPhraseHighlights?.length > 1) {
      claimReview.fcaPhraseHighlights = wp.fcaPhraseHighlights;
      claimReview.fcaHighlightSourceText = textSnapshot.trim();
    }
  }

    if (mediaExtra.localScan && claimReview) {
      claimReview.fcaLocalScan = mediaExtra.localScan;
    }

    let highlightSpan = null;
    if (rangeSnapshot) {
      try {
        highlightSpan = wrapRangeWithHighlight(
          rangeSnapshot,
          displayStatus,
          claimReview
        );
      } catch (err) {
        fcaLog("highlight after panel error", err);
      }
    }

    if (gen !== fcaPanelFetchGeneration) {
      fcaLog("skip stale highlight after wrap");
      return;
    }

    setPanelLoadingUi(false);

    const genCapture = gen;

    if (fetchError) {
      await fillResultPanel(finalStatus, claimReview, fetchError, mediaExtra);
      await fcaSidebarApplyResult(
        textSnapshot,
        finalStatus,
        claimReview,
        fetchError,
        mediaExtra
      );
    } else {
      await fillResultPanel(finalStatus, claimReview, "", mediaExtra);
      const shown = await fcaSidebarApplyResult(
        textSnapshot,
        finalStatus,
        claimReview,
        "",
        mediaExtra
      );
      if (!newsPending) {
        void fcaSidebarPersistHistory(textSnapshot, shown || finalStatus);
      }
    }

    if (newsPending) {
      trustedNewsPromise.then(async (trustedNews) => {
        if (genCapture !== fcaPanelFetchGeneration) return;
        const mediaExtra2 = {
          localScan: mediaExtra.localScan,
          trustedNews: Array.isArray(trustedNews) ? trustedNews : []
        };
        if (fetchError) {
          await fillResultPanel(finalStatus, claimReview, fetchError, mediaExtra2);
          await fcaSidebarApplyResult(
            textSnapshot,
            finalStatus,
            claimReview,
            fetchError,
            mediaExtra2
          );
        } else {
          await fillResultPanel(finalStatus, claimReview, "", mediaExtra2);
          const shown2 = await fcaSidebarApplyResult(
            textSnapshot,
            finalStatus,
            claimReview,
            "",
            mediaExtra2
          );
          void fcaSidebarPersistHistory(textSnapshot, shown2 || finalStatus);
        }
        requestAnimationFrame(() => requestAnimationFrame(relayout));
      });
    }

    if (highlightSpan?.isConnected) {
      fcaPanelAnchorEl = highlightSpan;
      fcaPendingRange = null;
    }
    if (fcaSidebarIsFullExpanded()) {
      fcaFloatingEnterFabModeFn?.();
    } else {
      expandFloatingPanelAfterLoad();
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        relayout();
        if (!fcaSidebarIsFullExpanded()) {
          fcaPanelArmAutoDismissAfterResult();
        }
      });
    });
  }

  fcaPanelScheduleRelayout = () => {
    requestAnimationFrame(() => requestAnimationFrame(relayout));
  };
  fcaFloatingExpandAfterLoadFn = expandFloatingPanelAfterLoad;
  fcaFloatingEnterFabModeFn = () => fcaPanelEnterFabMode(host, shadow);

  shadow.addEventListener("click", (e) => {
    const suggest = e.target?.closest?.("[data-fca-query-suggest]");
    if (suggest) {
      e.preventDefault();
      e.stopPropagation();
      const q2 = String(suggest.getAttribute("data-fca-query-suggest") || "").trim();
      if (!q2) return;
      fcaPendingText = q2;
      fcaSidebarApplyLoading(q2);
      fcaPanelClearAutoDismiss();
      setPanelLoadingUi(true);
      phaseResult.classList.remove("visible");
      syncFloatingPanelHeadTitle();
      void runCofactsAndApplyHighlight(null, panelSessionGen);
      return;
    }
    if (e.target?.id !== "fcaPanelRetryBtn") return;
    e.stopPropagation();
    fcaPanelClearAutoDismiss();
    setPanelLoadingUi(true);
    phaseResult.classList.remove("visible");
    syncFloatingPanelHeadTitle();
    void runCofactsAndApplyHighlight(null, panelSessionGen);
  });
  shadow.addEventListener("click", (e) => {
    const fix = e.target?.closest?.("[data-fca-ai-fix]");
    if (!fix) return;
    e.stopPropagation();
    const act = String(fix.getAttribute("data-fca-ai-fix") || "");
    const diagCode = String(fix.getAttribute("data-fca-diag-code") || "").trim();
    void (async () => {
      if (act === "enableGemini") {
        await fcaStorageLocalSet({ [FCA_OPT_SKIP_GEMINI]: false });
      } else if (act === "openGeminiSettings") {
        await fcaOpenGeminiSettingsInTab();
      } else if (act === "copyDiag" && diagCode) {
        try {
          await navigator.clipboard.writeText(diagCode);
          window.alert(`已複製診斷碼：${diagCode}`);
        } catch {
          window.alert(`診斷碼：${diagCode}`);
        }
      }
      fcaAiDiagCache.at = 0;
      fcaLocalOptsCache = null;
      try {
        await fillResultPanel(
          fcaSidebarLastApplyState?.finalStatus || "Yellow",
          fcaSidebarLastApplyState?.claimReview || null,
          fcaSidebarLastApplyState?.errorText || "",
          fcaSidebarLastApplyState?.mediaExtra || null
        );
      } catch {
        /* ignore */
      }
    })();
  });
  shadow.addEventListener("click", (e) => {
    const privacy = e.target?.closest?.("[data-fca-ai-privacy]");
    if (!privacy) return;
    e.stopPropagation();
    void (async () => {
      const mode = String(privacy.getAttribute("data-fca-ai-privacy") || "");
      if (mode === "never") {
        await fcaStorageLocalSet({ [FCA_OPT_GEMINI_PRIVACY_DISMISSED]: true });
      } else {
        fcaGeminiPrivacyBannerSessionHidden = true;
      }
      fcaLocalOptsCache = await fcaStorageLocalGet([
        FCA_OPT_SKIP_GEMINI,
        FCA_OPT_SHOW_TRUSTED_NEWS,
        FCA_OPT_GEMINI_PRIVACY_DISMISSED
      ]);
      fcaLocalOptsCacheAt = Date.now();
      try {
        await fillResultPanel(
          fcaSidebarLastApplyState?.finalStatus || "Yellow",
          fcaSidebarLastApplyState?.claimReview || null,
          fcaSidebarLastApplyState?.errorText || "",
          fcaSidebarLastApplyState?.mediaExtra || null
        );
        const st = fcaSidebarLastApplyState;
        if (st) {
          await fcaSidebarApplyResult(
            st.q || fcaSidebarLastQuery,
            st.finalStatus,
            st.claimReview,
            st.errorText || "",
            st.mediaExtra || null
          );
        }
      } catch {
        /* ignore */
      }
    })();
  });
  shadow.addEventListener("click", (e) => {
    const mr = e.target?.closest?.("[data-fca-match-report]");
    if (!mr) return;
    e.stopPropagation();
    void fcaRunMatchMismatchReport();
  });

  setPanelLoadingUi(true);
  phaseResult.classList.remove("visible");
  syncFloatingPanelHeadTitle();
  requestAnimationFrame(() => {
    requestAnimationFrame(relayout);
  });

  void runCofactsAndApplyHighlight(null, panelSessionGen).catch((e) => {
    fcaLog("auto factcheck panel fatal", e);
    if (panelSessionGen !== fcaPanelFetchGeneration) return;
    setPanelLoadingUi(false);
    void (async () => {
      await fillResultPanel("Yellow", null, String(e?.message || e));
      await fcaSidebarApplyResult(
        fcaPendingText,
        "Yellow",
        null,
        String(e?.message || e)
      );
      if (fcaSidebarIsFullExpanded()) {
        fcaFloatingEnterFabModeFn?.();
      } else {
        expandFloatingPanelAfterLoad();
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          relayout();
          if (!fcaSidebarIsFullExpanded()) {
            fcaPanelArmAutoDismissAfterResult();
          }
        });
      });
    })();
  });

  fcaLog("floating panel auto-query");
}

/**
 * Wrap selection with span.fca-anno and apply status styling. Returns the span.
 * @param {Range} range
 * @param {"Red"|"Orange"|"Yellow"|"Green"|"Gray"|"Blue"|"Cyan"} status
 * @param {object|null} [claimReview]
 */
function wrapRangeWithHighlight(range, status, claimReview = null) {
  ensureFcaHighlightStyles();

  /* YouTube 觀看頁：不對頁面插入標註（避免 Polymer／播放器尺寸計算錯亂）；結果僅顯示於側欄。 */
  if (fcaIsYoutubeWatchPage()) {
    try {
      removePreviousFcHighlights();
    } catch {
      /* ignore */
    }
    fcaLog("YouTube watch: skip in-page highlight");
    return null;
  }

  const { publisher, textualRating } = resolveClaimMeta(claimReview);

  let rangePlain = "";
  try {
    rangePlain = range.toString();
  } catch {
    rangePlain = "";
  }
  const phrases = claimReview?.fcaPhraseHighlights;
  const hlSrc = claimReview?.fcaHighlightSourceText;
  const multiOk =
    (claimReview?.fcaCofacts ||
      claimReview?.fcaIndexMixedPhrases ||
      claimReview?.fcaSubjectiveOnlyHighlights) &&
    phrases?.length > 1 &&
    typeof hlSrc === "string" &&
    hlSrc.length > 0;
  if (multiOk) {
    const trimmedRp = rangePlain.trim();
    let lead = 0;
    if (rangePlain === hlSrc) {
      lead = 0;
    } else if (trimmedRp === hlSrc) {
      const m = /^\s*/.exec(rangePlain);
      lead = m ? m[0].length : 0;
    } else {
      const idx = rangePlain.indexOf(hlSrc);
      if (idx < 0) {
        lead = -1;
      } else {
        lead = idx;
      }
    }
    if (lead >= 0) {
      const shifted =
        lead === 0
          ? phrases
          : phrases.map((p) => ({
              ...p,
              start: lead + p.start,
              end: lead + p.end
            }));
      const multiAnchor = wrapRangeWithPhrases(
        range,
        shifted,
        claimReview,
        status
      );
      if (multiAnchor) return multiAnchor;
    }
  }

  const existing = findFcaAnnoWrappingRange(range);

  if (existing) {
    existing.removeAttribute("style");
    existing.className = "";
    applyStatusVisual(existing, status, claimReview);
    const exTip = fcaAnnoTitleForSegment(status, claimReview);
    if (exTip) existing.setAttribute("title", exTip);
    else existing.removeAttribute("title");
    existing.setAttribute("data-fca-publisher", publisher);
    existing.setAttribute("data-fca-rating", textualRating);
    fcaLog("highlight reuse existing fca-anno");
    return existing;
  }

  removePreviousFcHighlights();

  const span = document.createElement("span");
  applyStatusVisual(span, status, claimReview);
  const sgTip = fcaAnnoTitleForSegment(status, claimReview);
  if (sgTip) span.setAttribute("title", sgTip);

  span.setAttribute("data-fca-publisher", publisher);
  span.setAttribute("data-fca-rating", textualRating);

  try {
    range.surroundContents(span);
    fcaLog("highlight surroundContents ok");
  } catch {
    const frag = range.extractContents();
    span.appendChild(frag);
    range.insertNode(span);
    fcaLog("highlight insertNode fallback");
  }

  return span;
}

function shouldIgnoreSelectionUiEvent(ev) {
  if (!ev || typeof ev.composedPath !== "function") return false;
  const path = ev.composedPath();
  if (fcaPanelHost && path.includes(fcaPanelHost)) return true;
  if (fcaSidebarHost && path.includes(fcaSidebarHost)) return true;
  if (fcaTriggerHost && path.includes(fcaTriggerHost)) return true;
  return false;
}

function queueShowPanelFromSelection(ev) {
  if (shouldIgnoreSelectionUiEvent(ev)) return;
  if (ev && Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)) {
    fcaSelectionLastPoint = { x: ev.clientX, y: ev.clientY };
  }
  if (selectionDebounceTimer) {
    clearTimeout(selectionDebounceTimer);
  }
  selectionDebounceTimer = setTimeout(() => {
    selectionDebounceTimer = null;
    handleSelectionDebouncedShowPanel();
  }, 420);
}

function handleSelectionDebouncedShowPanel() {
  let sel;
  try {
    sel = window.getSelection();
  } catch (e) {
    fcaLog("getSelection error", e);
    return;
  }

  const text = sel.toString().trim();
  fcaLog("selection debounced len=", text.length);

  if (text.length > 5) {
    lastSelected = text;
  }

  if (!text.length || !sel.rangeCount) {
    removeFcTriggerIcon();
    return;
  }

  if (selectionAnchoredInEditable(sel)) {
    fcaLog("skip pointer selection inside editable field");
    removeFcTriggerIcon();
    return;
  }

  if (selectionAnchoredInFcaPanel(sel)) {
    fcaLog("skip selection inside FCA panel");
    removeFcTriggerIcon();
    return;
  }

  const range = sel.getRangeAt(0);
  if (range.collapsed) {
    removeFcTriggerIcon();
    return;
  }

  const br = range.getBoundingClientRect();
  if (br && (br.width > 0 || br.height > 0)) {
    const px = Number(fcaSelectionLastPoint?.x);
    const py = Number(fcaSelectionLastPoint?.y);
    const pad = 22;
    const pointStale =
      !Number.isFinite(px) ||
      !Number.isFinite(py) ||
      px < br.left - pad ||
      px > br.right + pad ||
      py < br.top - pad ||
      py > br.bottom + pad;
    if (pointStale) {
      fcaSelectionLastPoint = {
        x: br.left + br.width * 0.72,
        y: br.top + Math.min(br.height * 0.35, 20)
      };
    }
  }

  const cloned = range.cloneRange();
  ensureFcTriggerIcon(cloned, text);
}

document.addEventListener("selectionchange", () => queueShowPanelFromSelection(null));
document.addEventListener("mouseup", queueShowPanelFromSelection, true);
document.addEventListener("pointerup", queueShowPanelFromSelection, true);

document.addEventListener("keydown", async (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === "F") {
    e.preventDefault();

    let sel;
    try {
      sel = window.getSelection();
    } catch {
      return;
    }

    const selected = sel.toString().trim();
    const query = selected.length > 5 ? selected : lastSelected;
    if (!query) return;

    let range = null;
    if (
      sel.rangeCount &&
      !sel.getRangeAt(0).collapsed &&
      !selectionAnchoredInEditable(sel)
    ) {
      range = sel.getRangeAt(0).cloneRange();
    }

    fcaLog("shortcut QUERY_FACTCHECK + highlight path");

    try {
      const result = await fcaQueryFactcheckDeduped(query, false);

      await fcaStorageSessionSet({
        lastQuery: query,
        lastResult: result
      });

      const { history = [] } = await fcaStorageLocalGet("history");
      const updated = [{
        query: query,
        time: new Date().toLocaleString("zh-TW"),
        count: Array.isArray(result) ? result.length : 0
      }, ...history].slice(0, 10);
      await fcaStorageLocalSet({ history: updated });

      const TRUSTED = [
        "factcheck.org", "snopes.com", "apnews.com", "afp.com",
        "fullfact.org", "politifact.com", "usatoday.com", "reuters.com", "bbc.com"
      ];
      const count = (result || []).filter((c) => {
        const pub = c.claimReview?.[0]?.publisher?.site || "";
        return TRUSTED.some((s) => pub.includes(s));
      }).length;

      chrome.runtime.sendMessage({
        type: "SHOW_NOTIFICATION",
        count: count,
        query: query
      });

      if (range) {
        const top = result?.[0];
        let status = top?.fcaStatus || "Yellow";
        const cr = top?.claimReview?.[0] || null;
        let enriched = cr
          ? {
              ...cr,
              articleText: String(top?.text || "").slice(0, 800),
              headline: cr.title || cr.headline || ""
            }
          : null;
        const artShortcut = fcaShouldAttachArticleContextForStandaloneAi(
          enriched,
          status
        )
          ? fcaExtractPageArticleContextForAi(4200)
          : "";
        const aiPack = await fcaEnrichWithStandaloneAi(query, {
          claimReview: enriched,
          finalStatus: status,
          fetchError: "",
          fixedUserStatus: null,
          articleContext: artShortcut
        });
        enriched = aiPack.claimReview;
        status = aiPack.finalStatus;
        const displayStatus = fcaDisplayStatusForUi(status, enriched);
        wrapRangeWithHighlight(range, displayStatus, enriched);
      }
    } catch (err) {
      try {
        fcaLog("shortcut chain error", fcaSafeErrorMessage(err));
      } catch {
        /* ignore */
      }
      let inv = false;
      try {
        inv = isExtensionContextInvalidated(err);
      } catch {
        inv = true;
      }
      if (inv) {
        window.alert("事實查核助手已更新或重載，請重新整理此頁面後再試。");
      } else {
        try {
          window.alert(fcaFormatErrorForUi(fcaSafeErrorMessage(err)));
        } catch {
          window.alert("查核時發生錯誤，請重新整理本頁後再試。");
        }
      }
    }
  }
});

function fcaExtractPagePlainText(maxChars) {
  const cap = Math.min(
    80000,
    Math.max(4000, Number(maxChars) || 16000)
  );
  const candidates = [
    document.querySelector("article"),
    document.querySelector("main"),
    document.querySelector('[role="main"]'),
    document.querySelector("#content"),
    document.querySelector(".article-body"),
    document.querySelector(".article"),
    document.body
  ].filter(Boolean);
  const root = candidates[0] || document.body;
  let t = "";
  try {
    t = root.innerText || root.textContent || "";
  } catch {
    t = "";
  }
  t = String(t).replace(/\s+/g, " ").trim();
  const fullApproxLen = t.length;
  let truncatedNote = "";
  if (t.length > cap) {
    t = t.slice(0, cap);
    truncatedNote = `\n\n> **（正文已截斷）** 原文約 ${fullApproxLen} 字，報告僅保留前 ${cap} 字。可在擴充視窗調高「匯出字數上限」。\n`;
  } else {
    truncatedNote = "";
  }
  return { text: t, fullApproxLen, cap, truncatedNote };
}

function fcaMdLine(s) {
  return String(s ?? "")
    .replace(/\r/g, "")
    .replace(/\n+/g, " ")
    .trim();
}

function fcaSafeReportFilename() {
  const h = (location.hostname || "page")
    .replace(/[^a-z0-9.-]+/gi, "_")
    .replace(/_+/g, "_")
    .slice(0, 48);
  const d = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `fca-media-report_${h}_${d}.md`;
}

function fcaBuildMediaReportMarkdown(pageTitle, pageUrl, plainPack, scan) {
  const when = new Date().toLocaleString("zh-TW", { hour12: false });
  const lines = [];
  lines.push("# 事實查核助手｜網域分析／整頁摘錄");
  lines.push("");
  lines.push(`- **產出時間**：${when}`);
  lines.push(`- **網址**：${fcaMdLine(pageUrl)}`);
  lines.push(
    `- **正文擷取**：本次摘要約 **${plainPack.text.length}** 字（頁面可讀文字粗估 **${plainPack.fullApproxLen}** 字）`
  );
  lines.push("");
  lines.push(
    "> 本檔由擴充功能在本機產生；**網域分型**為規則表輔助，**不代表**網站或文章可信與否。請自行交叉查證。"
  );
  lines.push("");

  if (!scan?.domain) {
    lines.push("## 網域分析");
    lines.push("");
    lines.push("（未能取得網域掃描結果，請重新載入擴充功能或頁面後再試。）");
    lines.push("");
  } else {
    lines.push("## 網域分析");
    lines.push("");
    if (scan.host) {
      lines.push(`- **主機**：\`${fcaMdLine(scan.host)}\``);
    }
    if (scan.domain?.tier) {
      lines.push(`- **內部分類代碼**：\`${fcaMdLine(scan.domain.tier)}\``);
    }
    lines.push(`- **來源分型**：${fcaMdLine(scan.domain.label)}`);
    lines.push(`- **說明**：${fcaMdLine(scan.domain.detail)}`);
    lines.push("");
  }

  lines.push("## 正文摘錄");
  lines.push("");
  if (plainPack.truncatedNote) lines.push(plainPack.truncatedNote);
  lines.push("~~~");
  lines.push(plainPack.text.replace(/~/g, "\\~"));
  lines.push("~~~");
  lines.push("");
  lines.push("—\n*事實查核助手 export*");
  return lines.join("\n");
}

async function fcaExportPageReportMarkdown(maxChars) {
  const title = (document.title || "").trim();
  const url = String(window.location.href || "");
  const plainPack = fcaExtractPagePlainText(maxChars);
  if (!plainPack.text || plainPack.text.length < 20) {
    throw new Error("頁面可用文字過少，無法匯出");
  }
  let scan = null;
  try {
    const r = await fcaSendMessage({
      type: "FC_LOCAL_MEDIA_SCAN",
      text: plainPack.text,
      host: typeof location !== "undefined" ? location.hostname : ""
    });
    if (r?.ok && r.scan) scan = r.scan;
  } catch (e) {
    fcaLog("export scan", e);
  }
  const md = fcaBuildMediaReportMarkdown(title, url, plainPack, scan);
  const blob = new Blob(["\uFEFF" + md], {
    type: "text/markdown;charset=utf-8"
  });
  const a = document.createElement("a");
  const u = URL.createObjectURL(blob);
  a.href = u;
  a.download = fcaSafeReportFilename();
  a.style.display = "none";
  (document.body || document.documentElement).appendChild(a);
  a.click();
  requestAnimationFrame(() => {
    try {
      URL.revokeObjectURL(u);
    } catch {}
    a.remove();
  });
}

try {
  chrome?.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GET_PAGE_TITLE") {
    try {
      const title = (document.title || "").trim();
      const h1 = (document.querySelector("h1")?.textContent || "").trim();
      const chosen = (h1.length > title.length ? h1 : title) || title || h1 || "";
      fcaLog("GET_PAGE_TITLE respond");
      sendResponse({ title: chosen.slice(0, 100) });
    } catch {
      sendResponse({ title: "" });
    }
    return true;
  }
  if (msg?.type === "FC_EXPORT_PAGE_REPORT") {
    const maxChars = Number(msg.maxChars) || 16000;
    void (async () => {
      try {
        await fcaExportPageReportMarkdown(maxChars);
        sendResponse({ ok: true });
      } catch (e) {
        fcaLog("FC_EXPORT_PAGE_REPORT", e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  });
} catch (e) {
  try {
    console.warn("[FCA] runtime.onMessage not available", e);
  } catch {
    /* ignore */
  }
}

document.addEventListener(
  "click",
  (ev) => {
    if (!fcaSidebarHost?.isConnected) return;
    const path = ev.composedPath?.() || [];
    if (path.includes(fcaSidebarHost)) return;
    if (fcaPanelHost && path.includes(fcaPanelHost)) return;
    if (ev.target?.closest?.("span.fca-anno")) return;
    fcaSidebarUserCollapsed = true;
    fcaSidebarSyncLayout();
  },
  false
);

/** 重新載入擴充或舊版注入後，頁面上可能殘留浮窗 DOM；啟動時一律清除。 */
try {
  if (fcaIsUiTopWindow()) removeFcFloatingPanel();
} catch {
  /* ignore */
}

try {
  document.documentElement.style.removeProperty("--fca-yt-inset");
} catch {
  /* ignore */
}

tryAutoFillTfcSearch();

function tryAutoFillTfcSearch() {
  try {
    const host = window.location.hostname || "";
    if (!host.includes("tfc-taiwan.org.tw")) return;

    const url = new URL(window.location.href);
    const q = (url.searchParams.get("ext_q") || url.searchParams.get("s") || "").trim();
    if (!q) return;

    const selectors = [
      'input[type="search"]',
      'input[name="s"]',
      'input[placeholder*="搜尋"]',
      'input[placeholder*="Search"]'
    ];

    const fill = () => {
      for (const sel of selectors) {
        const input = document.querySelector(sel);
        if (!input) continue;
        input.focus();
        input.value = q;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    };

    if (fill()) return;

    let retry = 0;
    const timer = setInterval(() => {
      retry++;
      if (fill() || retry >= 10) clearInterval(timer);
    }, 300);
  } catch {}
}
