const TRUSTED_SOURCES = [
  "factcheck.org", "snopes.com", "politifact.com",
  "apnews.com", "reuters.com", "afp.com",
  "fullfact.org", "usatoday.com", "washingtonpost.com",
  "bbc.com", "mygopen.com", "cofacts.tw",
  "tfc-taiwan.org.tw", "abc.net.au", "aap.com.au",
  "altnews.in", "thip.media", "science.feedback.org",
  "wcnc.com", "factcheck.afp.com"
];


const TIPS = [
  "看到語氣很激動的標題，先深呼吸再分享",
  "確認消息來源是否為可信媒體",
  "搜尋同一則新聞是否有其他媒體報導",
  "注意發文時間，舊新聞常被當新消息流傳",
  "圖片或影片不代表文字內容是真的",
  "看到「不轉不是台灣人」請特別小心",
  "單一來源的爆料，要特別謹慎查證",
  "專家說法要確認是否斷章取義",
  "數據要確認來源和時間是否正確",
  "情緒越激動的訊息，越需要冷靜查核"
];


document.addEventListener("DOMContentLoaded", async () => {


  const { lastQuery, lastResult } = await chrome.storage.session.get([
    "lastQuery", "lastResult"
  ]);


  document.getElementById("query").textContent = `查詢：「${lastQuery || "尚無查詢"}」`;


  const container      = document.getElementById("results");
  const noResult       = document.getElementById("no-result");
  const externalSearch = document.getElementById("external-search");
  const cofactsLink    = document.getElementById("cofacts-link");
  const tfcLink        = document.getElementById("tfc-link");
  const reportBtn      = document.getElementById("report-btn");
  const tooLong        = document.getElementById("too-long");
  const alertBox       = document.getElementById("alert-box");
  const tipsBox        = document.getElementById("tips-box");
  const countBox       = document.getElementById("count-box");
  const sortControls   = document.getElementById("sort-controls");
  const sortRelevance  = document.getElementById("sort-relevance");
  const sortLatest     = document.getElementById("sort-latest");
  const loadingBox     = document.getElementById("loading");
  const loadingText    = document.getElementById("loading-text");
  const scoreBox       = document.getElementById("score-box");
  const historySection = document.getElementById("history-section");
  const historyList    = document.getElementById("history-list");
  const clearBtn       = document.getElementById("clear-history");
  const geminiKeyInput = document.getElementById("gemini-key-input");
  const geminiModelInput = document.getElementById("gemini-model-input");
  const geminiSaveBtn = document.getElementById("gemini-save-btn");
  const geminiClearBtn = document.getElementById("gemini-clear-btn");
  const geminiStatus = document.getElementById("gemini-status");
  const gfcKeyInput = document.getElementById("gfc-key-input");
  const gfcSaveBtn = document.getElementById("gfc-save-btn");
  const gfcClearBtn = document.getElementById("gfc-clear-btn");
  const gfcStatus = document.getElementById("gfc-status");
  const fcaSkipGeminiEl = document.getElementById("fca-skip-gemini");

  function showLoading(isLoading, text = "查詢中…") {
    if (!loadingBox) return;
    loadingText.textContent = text;
    loadingBox.hidden = !isLoading;
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0] || null;
  }

  const FCA_KW_FIELD_MAP = [
    { elId: "fca-kw-china", key: "chinaLexicon" },
    { elId: "fca-kw-us", key: "usSkeptic" },
    { elId: "fca-kw-def", key: "defenseSecurity" },
    { elId: "fca-kw-health", key: "publicHealth" },
    { elId: "fca-kw-econ", key: "economyTrade" }
  ];
  const fcaKwStatusEl = document.getElementById("fca-kw-status");
  const fcaExportMaxEl = document.getElementById("fca-export-max-chars");
  const fcaExportPageBtn = document.getElementById("fca-export-page-btn");
  const fcaKwSaveBtn = document.getElementById("fca-kw-save-btn");
  const fcaKwResetBtn = document.getElementById("fca-kw-reset-btn");

  function fcaSetKwStatus(msg, isError) {
    if (!fcaKwStatusEl) return;
    if (!msg) {
      fcaKwStatusEl.hidden = true;
      fcaKwStatusEl.textContent = "";
      return;
    }
    fcaKwStatusEl.hidden = false;
    fcaKwStatusEl.textContent = msg;
    fcaKwStatusEl.style.color = isError ? "var(--red)" : "var(--green)";
  }

  function fcaParseLinesToKeywords(raw) {
    return [
      ...new Set(
        String(raw || "")
          .replace(/\r/g, "")
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 120)
      )
    ];
  }

  async function fcaRefreshKeywordExtrasUi() {
    const { fcaMediaKeywordExtras, fcaExportMaxChars } = await chrome.storage.local.get([
      "fcaMediaKeywordExtras",
      "fcaExportMaxChars"
    ]);
    const ex =
      fcaMediaKeywordExtras && typeof fcaMediaKeywordExtras === "object"
        ? fcaMediaKeywordExtras
        : {};
    for (const { elId, key } of FCA_KW_FIELD_MAP) {
      const ta = document.getElementById(elId);
      if (!ta) continue;
      const arr = Array.isArray(ex[key]) ? ex[key] : [];
      ta.value = arr.join("\n");
    }
    if (fcaExportMaxEl && typeof fcaExportMaxChars === "number") {
      const n = Math.min(80000, Math.max(4000, fcaExportMaxChars));
      fcaExportMaxEl.value = String(n);
    }
  }

  if (fcaKwSaveBtn) {
    fcaKwSaveBtn.addEventListener("click", async () => {
      const out = {};
      for (const { elId, key } of FCA_KW_FIELD_MAP) {
        const ta = document.getElementById(elId);
        const words = ta ? fcaParseLinesToKeywords(ta.value) : [];
        if (words.length) out[key] = words;
      }
      try {
        if (Object.keys(out).length) {
          await chrome.storage.local.set({ fcaMediaKeywordExtras: out });
        } else {
          await chrome.storage.local.remove("fcaMediaKeywordExtras");
        }
        const maxN = fcaExportMaxEl
          ? Math.min(80000, Math.max(4000, parseInt(fcaExportMaxEl.value || "16000", 10) || 16000))
          : 16000;
        await chrome.storage.local.set({ fcaExportMaxChars: maxN });
        fcaSetKwStatus("已儲存附加關鍵字與匯出字數偏好", false);
      } catch {
        fcaSetKwStatus("儲存失敗", true);
      }
    });
  }

  if (fcaKwResetBtn) {
    fcaKwResetBtn.addEventListener("click", async () => {
      try {
        await chrome.storage.local.remove("fcaMediaKeywordExtras");
        await fcaRefreshKeywordExtrasUi();
        fcaSetKwStatus("已清除附加關鍵字（恢復為僅內建詞庫）", false);
      } catch {
        fcaSetKwStatus("清除失敗", true);
      }
    });
  }

  if (fcaExportPageBtn) {
    fcaExportPageBtn.addEventListener("click", async () => {
      fcaSetKwStatus("", false);
      showLoading(true, "產生報告中…");
      try {
        const tab = await getActiveTab();
        if (!tab?.id) throw new Error("NO_TAB");
        let maxChars = 16000;
        if (fcaExportMaxEl) {
          maxChars = Math.min(
            80000,
            Math.max(4000, parseInt(fcaExportMaxEl.value || "16000", 10) || 16000)
          );
        }
        await chrome.storage.local.set({ fcaExportMaxChars: maxChars });
        const resp = await chrome.tabs.sendMessage(tab.id, {
          type: "FC_EXPORT_PAGE_REPORT",
          maxChars
        });
        if (!resp?.ok) throw new Error(resp?.error || "匯出失敗");
        fcaSetKwStatus("已觸發下載（若未見檔案請檢查瀏覽器下載權限）", false);
      } catch {
        fcaSetKwStatus(
          "無法匯出：請在一般網頁分頁執行、重新整理該頁後再試，並確認非 chrome:// 等受限頁面。",
          true
        );
      } finally {
        showLoading(false);
      }
    });
  }

  function normalizeGeminiApiKeyInput(raw) {
    if (typeof raw !== "string") return "";
    let s = raw.replace(/^\uFEFF/, "").trim();
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      s = s.slice(1, -1).trim();
    }
    // 支援誤貼 "Bearer xxx" 或完整 URL 內含 ?key=xxx
    s = s.replace(/^bearer\s+/i, "").trim();
    const km = s.match(/[?&]key=([^&\s]+)/i);
    if (km && km[1]) {
      try {
        s = decodeURIComponent(km[1]).trim();
      } catch {
        s = km[1].trim();
      }
    }
    // 常見貼上時夾帶空白與換行
    s = s.replace(/\s+/g, "");
    return s;
  }

  async function refreshGeminiUi() {
    const { geminiApiKey, googleFactCheckApiKey, fcaGeminiModel, fcaSkipGemini } =
      await chrome.storage.local.get([
        "geminiApiKey",
        "googleFactCheckApiKey",
        "fcaGeminiModel",
        "fcaSkipGemini"
      ]);
    if (geminiModelInput) geminiModelInput.value = fcaGeminiModel || "";
    if (fcaSkipGeminiEl) fcaSkipGeminiEl.checked = Boolean(fcaSkipGemini);
    if (geminiKeyInput) {
      geminiKeyInput.value = "";
      geminiKeyInput.placeholder = normalizeGeminiApiKeyInput(String(geminiApiKey || ""))
        ? "已儲存金鑰（輸入可覆蓋）"
        : "貼上 Google AI Studio 金鑰…";
    }
    if (gfcKeyInput) {
      gfcKeyInput.value = "";
      gfcKeyInput.placeholder = normalizeGeminiApiKeyInput(String(googleFactCheckApiKey || ""))
        ? "已儲存 GFC Key（輸入可覆蓋）"
        : "貼上 Google Fact Check API Key…";
    }
  }

  function setGeminiStatus(msg, isError) {
    if (!geminiStatus) return;
    if (!msg) {
      geminiStatus.hidden = true;
      geminiStatus.textContent = "";
      return;
    }
    geminiStatus.hidden = false;
    geminiStatus.textContent = msg;
    geminiStatus.style.color = isError ? "var(--red)" : "var(--green)";
  }

  function setGfcStatus(msg, isError) {
    if (!gfcStatus) return;
    if (!msg) {
      gfcStatus.hidden = true;
      gfcStatus.textContent = "";
      return;
    }
    gfcStatus.hidden = false;
    gfcStatus.textContent = msg;
    gfcStatus.style.color = isError ? "var(--red)" : "var(--green)";
  }

  await refreshGeminiUi();

  /* Gemini 冷卻倒數顯示 */
  const geminiCooldownBar = document.getElementById("gemini-cooldown-bar");
  const geminiCooldownMsg = document.getElementById("gemini-cooldown-msg");
  const geminiCooldownClearBtn = document.getElementById("gemini-cooldown-clear-btn");
  let cooldownTimer = null;

  async function refreshCooldownBar() {
    const s = await chrome.storage.session.get(["fcaGeminiCooldownUntil", "fcaGeminiCooldownStatus"]);
    const until = Number(s.fcaGeminiCooldownUntil) || 0;
    if (until > Date.now()) {
      const secLeft = Math.ceil((until - Date.now()) / 1000);
      let timeStr;
      if (secLeft > 3600) {
        const h = Math.floor(secLeft / 3600);
        const m = Math.ceil((secLeft % 3600) / 60);
        /* 每日配額耗盡：顯示重置時間 */
        const resetAt = new Date(until);
        const resetHHMM = resetAt.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
        timeStr = `約 ${h} 小時 ${m} 分（每日配額耗盡，${resetHHMM} 後重置）`;
      } else if (secLeft > 60) {
        timeStr = `約 ${Math.ceil(secLeft / 60)} 分 ${secLeft % 60} 秒（每分鐘速率限制）`;
      } else {
        timeStr = `約 ${secLeft} 秒`;
      }
      if (geminiCooldownMsg) geminiCooldownMsg.textContent = `⏳ Gemini 暫停中：${timeStr}`;
      if (geminiCooldownBar) geminiCooldownBar.style.display = "";
      /* 每日配額時改用紅色提示 */
      if (geminiCooldownBar) {
        geminiCooldownBar.style.background = secLeft > 3600 ? "#f8d7da" : "#fff3cd";
        geminiCooldownBar.style.color = secLeft > 3600 ? "#842029" : "#856404";
      }
    } else {
      if (geminiCooldownBar) geminiCooldownBar.style.display = "none";
      if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
    }
  }

  await refreshCooldownBar();
  /* 若目前在冷卻中，每秒更新倒數 */
  const initCooldown = await chrome.storage.session.get("fcaGeminiCooldownUntil");
  if (Number(initCooldown.fcaGeminiCooldownUntil) > Date.now()) {
    cooldownTimer = setInterval(refreshCooldownBar, 1000);
  }

  if (geminiCooldownClearBtn) {
    geminiCooldownClearBtn.addEventListener("click", async () => {
      await chrome.storage.session.remove(["fcaGeminiCooldownUntil", "fcaGeminiCooldownStatus"]);
      if (geminiCooldownBar) geminiCooldownBar.style.display = "none";
      if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
      setGeminiStatus("冷卻已清除，下次查核將重新嘗試 Gemini", false);
    });
  }

  /* ── 免責聲明 Modal ── */
  const disclaimerBtn     = document.getElementById("fca-disclaimer-btn");
  const disclaimerOverlay = document.getElementById("fca-disclaimer-overlay");
  const disclaimerClose   = document.getElementById("fca-disclaimer-close");

  function openDisclaimer() {
    if (disclaimerOverlay) disclaimerOverlay.classList.add("open");
  }
  function closeDisclaimer() {
    if (disclaimerOverlay) disclaimerOverlay.classList.remove("open");
  }

  if (disclaimerBtn)     disclaimerBtn.addEventListener("click", openDisclaimer);
  if (disclaimerClose)   disclaimerClose.addEventListener("click", closeDisclaimer);
  /* 點 overlay 背景也可關閉 */
  if (disclaimerOverlay) {
    disclaimerOverlay.addEventListener("click", (e) => {
      if (e.target === disclaimerOverlay) closeDisclaimer();
    });
  }
  /* Esc 鍵關閉 */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDisclaimer();
  });

  await fcaRefreshKeywordExtrasUi();

  const fcaDownrankTa = document.getElementById("fca-news-downrank-ta");
  const fcaDownrankSave = document.getElementById("fca-downrank-save");
  const fcaDownrankStatus = document.getElementById("fca-downrank-status");
  const fcaShowNewsToggle = document.getElementById("fca-show-news-toggle");
  const fcaResetGeminiPrivacy = document.getElementById("fca-reset-gemini-privacy");
  const fcaPrivacyStatus = document.getElementById("fca-privacy-status");

  async function refreshDownrankUi() {
    const { fcaNewsDownrankHosts } = await chrome.storage.local.get("fcaNewsDownrankHosts");
    if (fcaDownrankTa) {
      fcaDownrankTa.value =
        typeof fcaNewsDownrankHosts === "string" ? fcaNewsDownrankHosts : "";
    }
    if (fcaDownrankStatus) fcaDownrankStatus.textContent = "";
  }

  await refreshDownrankUi();

  async function refreshPrivacyUi() {
    const { fcaShowTrustedNews = true } = await chrome.storage.local.get(["fcaShowTrustedNews"]);
    if (fcaShowNewsToggle) fcaShowNewsToggle.checked = Boolean(fcaShowTrustedNews !== false);
    if (fcaPrivacyStatus) {
      fcaPrivacyStatus.hidden = true;
      fcaPrivacyStatus.textContent = "";
    }
  }

  function setPrivacyStatus(msg, isError) {
    if (!fcaPrivacyStatus) return;
    if (!msg) {
      fcaPrivacyStatus.hidden = true;
      fcaPrivacyStatus.textContent = "";
      return;
    }
    fcaPrivacyStatus.hidden = false;
    fcaPrivacyStatus.textContent = msg;
    fcaPrivacyStatus.style.color = isError ? "var(--red)" : "var(--green)";
  }

  await refreshPrivacyUi();

  if (fcaShowNewsToggle) {
    fcaShowNewsToggle.addEventListener("change", async () => {
      await chrome.storage.local.set({ fcaShowTrustedNews: fcaShowNewsToggle.checked });
      setPrivacyStatus("已更新新聞區塊顯示設定", false);
    });
  }

  if (fcaResetGeminiPrivacy) {
    fcaResetGeminiPrivacy.addEventListener("click", async () => {
      await chrome.storage.local.remove("fcaGeminiPrivacyDismissed");
      setPrivacyStatus("下次有 Gemini 金鑰時會再次顯示隱私提醒", false);
    });
  }

  const fcaIndexApiTokenEl = document.getElementById("fca-index-api-token");
  const fcaIndexApiSave = document.getElementById("fca-index-api-save");
  const fcaIndexApiClear = document.getElementById("fca-index-api-clear");
  const fcaIndexApiStatus = document.getElementById("fca-index-api-status");

  async function refreshIndexApiUi() {
    const { apiToken } = await chrome.storage.local.get("apiToken");
    const has = Boolean(String(apiToken || "").trim());
    if (fcaIndexApiTokenEl) {
      fcaIndexApiTokenEl.value = "";
      fcaIndexApiTokenEl.placeholder = has
        ? "已儲存權杖（輸入可覆蓋）"
        : "未設定則僅送匿名層級請求";
    }
    if (fcaIndexApiStatus) {
      fcaIndexApiStatus.hidden = true;
      fcaIndexApiStatus.textContent = "";
    }
  }

  await refreshIndexApiUi();

  function setIndexApiStatus(msg, isError) {
    if (!fcaIndexApiStatus) return;
    if (!msg) {
      fcaIndexApiStatus.hidden = true;
      fcaIndexApiStatus.textContent = "";
      return;
    }
    fcaIndexApiStatus.hidden = false;
    fcaIndexApiStatus.textContent = msg;
    fcaIndexApiStatus.style.color = isError ? "var(--red)" : "var(--green)";
  }

  if (fcaIndexApiSave && fcaIndexApiTokenEl) {
    fcaIndexApiSave.addEventListener("click", async () => {
      const raw = String(fcaIndexApiTokenEl.value || "").trim();
      if (raw) {
        await chrome.storage.local.set({ apiToken: raw });
        setIndexApiStatus("已儲存索引 API 權杖", false);
      } else {
        const { apiToken: had } = await chrome.storage.local.get("apiToken");
        if (String(had || "").trim()) {
          setIndexApiStatus("已更新：沿用既有權杖（若要清除請按「清除權杖」）", false);
        } else {
          setIndexApiStatus("請貼上權杖後再儲存，或保持留空使用匿名層級", true);
        }
      }
      await refreshIndexApiUi();
    });
  }

  if (fcaIndexApiClear) {
    fcaIndexApiClear.addEventListener("click", async () => {
      await chrome.storage.local.remove("apiToken");
      setIndexApiStatus("已清除索引 API 權杖", false);
      await refreshIndexApiUi();
    });
  }

  if (fcaDownrankSave && fcaDownrankTa) {
    fcaDownrankSave.addEventListener("click", async () => {
      const raw = fcaDownrankTa.value || "";
      if (!String(raw).trim()) {
        await chrome.storage.local.remove("fcaNewsDownrankHosts");
        if (fcaDownrankStatus) {
          fcaDownrankStatus.textContent = "已清空降權清單。";
          fcaDownrankStatus.style.color = "var(--green)";
        }
        return;
      }
      await chrome.storage.local.set({ fcaNewsDownrankHosts: raw });
      if (fcaDownrankStatus) {
        fcaDownrankStatus.textContent = "已儲存。";
        fcaDownrankStatus.style.color = "var(--green)";
      }
    });
  }

  if (geminiSaveBtn) {
    geminiSaveBtn.addEventListener("click", async () => {
      const key = normalizeGeminiApiKeyInput(geminiKeyInput?.value || "");
      const model = (geminiModelInput?.value || "").trim();

      if (model) await chrome.storage.local.set({ fcaGeminiModel: model });
      else await chrome.storage.local.remove("fcaGeminiModel");

      if (key) {
        // 儲存金鑰時預設啟用 AI，避免「已有 key 但仍被 fcaSkipGemini 關閉」造成誤判為 API 壞掉
        await chrome.storage.local.set({ geminiApiKey: key, fcaSkipGemini: false });
        if (fcaSkipGeminiEl) fcaSkipGeminiEl.checked = false;
        setGeminiStatus("已儲存金鑰並啟用 AI", false);
      } else {
        const { geminiApiKey: hadRaw } = await chrome.storage.local.get("geminiApiKey");
        const had = normalizeGeminiApiKeyInput(String(hadRaw || ""));
        setGeminiStatus(
          had
            ? "已更新設定（金鑰沿用既有）"
            : "尚未設定金鑰：Cofacts 仍可用，但不會呼叫 AI",
          !had
        );
      }
      await refreshGeminiUi();
    });
  }

  if (gfcSaveBtn) {
    gfcSaveBtn.addEventListener("click", async () => {
      const key = normalizeGeminiApiKeyInput(gfcKeyInput?.value || "");
      if (key) {
        await chrome.storage.local.set({ googleFactCheckApiKey: key });
        setGfcStatus("已儲存 GFC Key", false);
      } else {
        const { googleFactCheckApiKey: hadRaw } =
          await chrome.storage.local.get("googleFactCheckApiKey");
        const had = normalizeGeminiApiKeyInput(String(hadRaw || ""));
        setGfcStatus(had ? "已更新設定（GFC Key 沿用既有）" : "尚未設定 GFC Key", !had);
      }
      await refreshGeminiUi();
    });
  }

  if (gfcClearBtn) {
    gfcClearBtn.addEventListener("click", async () => {
      await chrome.storage.local.remove("googleFactCheckApiKey");
      setGfcStatus("已清除 GFC Key", false);
      await refreshGeminiUi();
    });
  }

  if (geminiClearBtn) {
    geminiClearBtn.addEventListener("click", async () => {
      await chrome.storage.local.remove("geminiApiKey");
      setGeminiStatus("已清除金鑰", false);
      await refreshGeminiUi();
    });
  }

  if (fcaSkipGeminiEl) {
    fcaSkipGeminiEl.addEventListener("change", async () => {
      await chrome.storage.local.set({ fcaSkipGemini: fcaSkipGeminiEl.checked });
    });
  }

  function setupExternalSearchLinks(query) {
    const q = String(query || "").trim();
    if (!externalSearch || !cofactsLink || !tfcLink || !q) return;
    cofactsLink.href = `https://cofacts.tw/search?type=messages&q=${encodeURIComponent(q)}`;
    tfcLink.href = `https://tfc-taiwan.org.tw/?s=${encodeURIComponent(q)}&ext_q=${encodeURIComponent(q)}`;
    externalSearch.hidden = false;
  }


  if (lastQuery && lastQuery.length > 30) {
    tooLong.hidden = false;
  }


  const alerts = detectAlerts(lastQuery || "");
  if (alerts.length > 0) {
    alertBox.hidden = false;
    alerts.forEach(alert => {
      const tag = document.createElement("div");
      tag.className = "alert-tag";
      tag.innerHTML = alert;
      alertBox.appendChild(tag);
    });
  }


  if (lastResult && lastResult.length > 0) {


    const seen = new Set();
    const trustedOnly = lastResult.filter(claim => {
      if (seen.has(claim.text)) return false;
      seen.add(claim.text);
      const publisher = claim.claimReview?.[0]?.publisher?.site || "";
      return TRUSTED_SOURCES.some(s => publisher.includes(s));
    });
    const unique = trustedOnly.length > 0 ? trustedOnly : dedupeByClaimText(lastResult);


    if (unique.length > 0) {
      let sortMode = "relevance";

      function sortClaims(mode, claims) {
        const arr = [...claims];
        if (mode === "latest") {
          arr.sort((a, b) => {
            const dateA = new Date(a.claimReview?.[0]?.reviewDate || 0);
            const dateB = new Date(b.claimReview?.[0]?.reviewDate || 0);
            if (dateB - dateA !== 0) return dateB - dateA;
            const scoreA = Number(a.__score) || 0;
            const scoreB = Number(b.__score) || 0;
            return scoreB - scoreA;
          });
          return arr;
        }
        arr.sort((a, b) => {
          const scoreA = Number(a.__score) || 0;
          const scoreB = Number(b.__score) || 0;
          if (scoreA !== scoreB) return scoreB - scoreA;
          const dateA = new Date(a.claimReview?.[0]?.reviewDate || 0);
          const dateB = new Date(b.claimReview?.[0]?.reviewDate || 0);
          return dateB - dateA;
        });
        return arr;
      }

      function updateSortButtons() {
        sortRelevance.classList.toggle("active", sortMode === "relevance");
        sortLatest.classList.toggle("active", sortMode === "latest");
      }

      function renderClaims() {
        const sorted = sortClaims(sortMode, unique);
        const top5 = sorted.slice(0, 5);

        const score = calculateScore(top5);
        scoreBox.hidden = false;
        scoreBox.innerHTML = renderScore(score);

        countBox.hidden = false;
        countBox.textContent = sortMode === "latest"
          ? `找到 ${unique.length} 筆查核結果，顯示最近 ${top5.length} 筆`
          : `找到 ${unique.length} 筆查核結果，顯示最相關 ${top5.length} 筆`;

        container.hidden = false;
        container.innerHTML = "";

        top5.forEach((claim, index) => {
          const review      = claim.claimReview?.[0];
          const rating      = review?.textualRating || "—";
          const ratingClass = getRatingClass(rating);
          const reportTitle = (review?.title || review?.headline || review?.name || "").trim() || "查核報告";
          const reviewDate  = review?.reviewDate
            ? new Date(review.reviewDate).toLocaleDateString("zh-TW")
            : "日期不明";

          const card = document.createElement("div");
          card.className = "claim-card";
          card.style.animationDelay = `${index * 0.08}s`;

          if (index >= 3) {
            card.classList.add("extra-card");
            card.style.display = "none";
          }

          card.innerHTML = `
            <div class="claim-title">${escapeHtml(reportTitle)}</div>
            <div class="claim-claimtext">被查核內容：${escapeHtml(claim.text || "")}</div>
            <div class="claim-footer">
              <span class="rating ${ratingClass}">${translateRating(rating)}</span>
              <div class="source">
                <a href="${review?.url || "#"}" target="_blank">
                  ${review?.publisher?.name || "—"}
                </a>
                <div class="date">${reviewDate}</div>
              </div>
            </div>
            <button class="share-btn" data-claim="${encodeURIComponent(claim.text)}" data-rating="${translateRating(rating)}" data-source="${review?.publisher?.name || ''}" data-url="${review?.url || ''}">
              複製查核結果
            </button>`;

          container.appendChild(card);

          card.querySelector(".share-btn").addEventListener("click", (e) => {
            const btn = e.currentTarget;
            const text = `【事實查核】\n聲稱：${decodeURIComponent(btn.dataset.claim)}\n判定：${btn.dataset.rating}\n來源：${btn.dataset.source}\n${btn.dataset.url}`;
            navigator.clipboard.writeText(text).then(() => {
              btn.textContent = "已複製";
              setTimeout(() => { btn.textContent = "複製查核結果"; }, 2000);
            });
          });
        });

        if (top5.length > 3) {
          const expandBtn = document.createElement("button");
          expandBtn.className = "share-btn";
          expandBtn.style.marginBottom = "10px";
          expandBtn.textContent = `展開更多（還有 ${top5.length - 3} 筆）`;
          expandBtn.addEventListener("click", () => {
            document.querySelectorAll(".extra-card").forEach(c => c.style.display = "block");
            expandBtn.style.display = "none";
          });
          container.appendChild(expandBtn);
        }
      }

      sortControls.hidden = false;
      updateSortButtons();
      renderClaims();
      sortRelevance.addEventListener("click", () => {
        sortMode = "relevance";
        updateSortButtons();
        renderClaims();
      });
      sortLatest.addEventListener("click", () => {
        sortMode = "latest";
        updateSortButtons();
        renderClaims();
      });

    } else {
      noResult.hidden = false;
      showTip(tipsBox);
      setupExternalSearchLinks(lastQuery);
    }


  } else {
    noResult.hidden = false;
    showTip(tipsBox);
    setupExternalSearchLinks(lastQuery);
  }


  reportBtn.hidden = false;
  reportBtn.addEventListener("click", () => {
    const url = `https://cofacts.tw/search?type=messages&q=${encodeURIComponent(lastQuery)}`;
    chrome.tabs.create({ url });
  });


  // 歷史記錄
  const { history = [] } = await chrome.storage.local.get("history");
  if (history.length > 0) {
    historySection.hidden = false;
    renderHistory(history, historyList);
  }


  // 清除歷史記錄
  clearBtn.addEventListener("click", async () => {
    await chrome.storage.local.set({ history: [] });
    historyList.innerHTML = "";
    historySection.hidden = true;
  });


});

function dedupeByClaimText(list) {
  const seen = new Set();
  const out = [];
  for (const claim of list || []) {
    const key = String(claim?.text || claim?.claimReview?.[0]?.url || JSON.stringify(claim));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


// 渲染歷史記錄（可點擊重新查核）
function renderHistory(history, historyList) {
  historyList.innerHTML = "";
  history.forEach(item => {
    const row = document.createElement("div");
    row.className = "history-item";
    row.innerHTML = `
      <span class="history-query">${item.query}</span>
      <span class="history-time">${item.time}</span>`;
    row.addEventListener("click", async () => {
      // 點擊歷史記錄重新查核
      const result = await chrome.runtime.sendMessage({
        type: "QUERY_FACTCHECK",
        text: item.query
      });
      await chrome.storage.session.set({
        lastQuery: item.query,
        lastResult: result
      });
      window.location.reload();
    });
    historyList.appendChild(row);
  });
}


// 可信度進度條
function calculateScore(claims) {
  if (claims.length === 0) return null;
  let falseCount = 0, trueCount = 0;
  claims.forEach(claim => {
    const r = (claim.claimReview?.[0]?.textualRating || "").toLowerCase();
    if (r.includes("false") || r.includes("錯誤")) falseCount++;
    else if (r.includes("true") || r.includes("正確")) trueCount++;
  });
  const total = claims.length;
  if (falseCount > total / 2) return { text: "高風險", desc: "多數查核為錯誤", color: "#f28b82", pct: 10 };
  if (trueCount > total / 2) return { text: "較可信", desc: "多數查核為正確", color: "#81c995", pct: 85 };
  return { text: "需謹慎", desc: "查核結果不一致", color: "#ffb74d", pct: 45 };
}


function renderScore(score) {
  if (!score) return "";
  return `
    <div class="score-label">
      <span style="color:${score.color};font-weight:bold;">${score.text}</span>
      <span style="color:#666;font-size:11px;">${score.desc}</span>
    </div>
    <div class="score-bar-bg">
      <div class="score-bar" style="width:${score.pct}%;background:${score.color};"></div>
    </div>`;
}


function showTip(tipsBox) {
  const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
  tipsBox.hidden = false;
  tipsBox.textContent = tip;
}


function detectAlerts(text) {
  const alerts = [];


  const antiUS = [
    "美國干涉", "美帝", "反美", "美國陰謀", "美軍佔領",
    "美國霸權", "美國操控", "抗美", "美國才是威脅",
    "美國不可信", "美國欺騙", "美國侵略", "美國打壓",
    "反美情緒", "美國制裁", "美國威脅", "美國滲透"
  ];
  if (antiUS.some(k => text.includes(k))) {
    alerts.push("【疑美論】偵測到賦予美國負面形象的用語，請保持批判思考");
  }


  const cnTerms = [
    "內地", "祖國", "大陸同胞", "兩岸一家親",
    "回歸祖國", "統一大業", "寶島", "台灣省",
    "中華民族偉大復興", "九二共識", "一個中國",
    "解放軍", "共軍", "犯台", "武統", "和統",
    "兩岸統一", "反獨促統", "大陸地區"
  ];
  if (cnTerms.some(k => text.includes(k))) {
    alerts.push("偵測到特定政治用語，注意立場傾向");
  }


  const emotionWords = [
    "震驚", "揭露", "曝光", "萬萬沒想到", "不轉不是中國人",
    "瘋傳", "緊急", "立刻", "馬上分享", "速速擴散",
    "不轉不是台灣人", "重磅", "驚爆", "獨家揭密", "快傳",
    "驚天", "內幕", "秘密", "不能說的秘密", "真相大白",
    "終於曝光", "瞞不住了", "快看", "必看"
  ];
  const hasExclamation = (text.match(/!/g) || []).length >= 2;
  const hasEmotion = emotionWords.some(k => text.includes(k));
  if (hasExclamation || hasEmotion) {
    alerts.push("語氣激動，可能涉及情緒操弄，查核後再分享");
  }


  const healthWords = [
    "偏方", "秘方", "神藥", "包治百病", "拒絕疫苗",
    "疫苗有毒", "化療無用", "癌症剋星", "排毒",
    "喝尿治病", "鹽水治病", "大蒜治病"
  ];
  if (healthWords.some(k => text.includes(k))) {
    alerts.push("偵測到可疑醫療資訊，請諮詢專業醫師");
  }


  return alerts;
}


function getRatingClass(rating) {
  const r = rating.toLowerCase();
  if (r.includes("false") || r.includes("錯誤") || r.includes("假")) return "false";
  if (r.includes("true")  || r.includes("正確") || r.includes("真"))  return "true";
  if (r.includes("missing") || r.includes("context") || r.includes("部分")) return "missing";
  return "other";
}


function translateRating(rating) {
  const r = rating.toLowerCase();
  if (r.includes("false"))           return "錯誤";
  if (r.includes("true"))            return "正確";
  if (r.includes("missing context")) return "缺乏脈絡";
  if (r.includes("misleading"))      return "誤導性";
  if (r.includes("partly"))          return "部分正確";
  if (r.includes("unsupported"))     return "缺乏依據";
  if (r.includes("needs context"))   return "需要脈絡";
  return rating;
}
