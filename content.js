// StealthTube content script.
//
// IronCurtain model:
//   The static "iron_curtain" ruleset is ENABLED BY DEFAULT in the manifest.
//   It blocks the three critical history-writing pings before any JS runs.
//
//   This script's job is to DECIDE whether to release the curtain (safe video)
//   or let the full stealth_ruleset take over (toxic video / manual stealth).
//
// Decision timeline per navigation:
//   0 ms  yt-navigate-start  → REASSERT_CURTAIN  (re-raise if it was lowered)
//   ~50   yt-navigate-finish  → immediate check   (DOM + URL params)
//   500   fast verdict        → if metadata ready, send SAFE_VERDICT or TRIGGER
//   1500  thorough verdict    → re-fetch hidden tags, final SAFE_VERDICT or TRIGGER
//
// A SAFE_VERDICT is the ONLY way the curtain is lowered for a tab.
// AUTO_STEALTH_REVERT from a non-thorough check is held by background while
// the tab is still "pending" in the iron-curtain set.

(function () {
  const api = (typeof browser !== "undefined" ? browser : chrome);
  const cfg = globalThis.StealthTubeConfig;
  const log = (...args) => console.log("[StealthTube]", ...args);
  const curtainLog = (...args) => console.log("[IronCurtain]", ...args);

  let stealthEnabled = false;
  let settings = { enabled: true, userKeywords: [], userChannels: [], enabledPresets: [] };
  let titleObserver = null;
  let docTitleObserver = null;
  let uiObserver = null;
  let lastEvaluatedKey = "";
  let fastVerdictTimer = null;
  let thoroughTimer = null;

  // Cached page-level data from background's MAIN-world extraction.
  let lastYtData = { tags: [], category: "" };

  // Timestamp of the most recent yt-navigate-start.
  let navTimestamp = 0;

  // Current video ID — tracked for Session ID Poisoning.
  let currentVideoId = null;

  // Deduplication for VIDEO_GHOSTED counting.
  let lastGhostedVideoId = null;

  // ---------- visual indicator ----------

  function ensureBadge() {
    if (!stealthEnabled) {
      const existing = document.getElementById(cfg.BADGE_ID);
      if (existing) existing.remove();
      return;
    }
    if (document.getElementById(cfg.BADGE_ID)) return;
    const masthead = document.querySelector(cfg.SELECTORS.masthead);
    if (!masthead) return;
    const badge = document.createElement("div");
    badge.id = cfg.BADGE_ID;
    badge.textContent = "STEALTH ACTIVE";
    badge.setAttribute("role", "status");
    badge.title = "StealthTube is blocking watch-history telemetry";
    masthead.prepend(badge);
  }

  function ensurePlayerBorder() {
    const player = document.querySelector(cfg.SELECTORS.player);
    if (!player) return;
    player.classList.toggle(cfg.PLAYER_CLASS, stealthEnabled);
  }

  function refreshUI() {
    ensureBadge();
    ensurePlayerBorder();
  }

  // ---------- toast ----------

  function showToast(text) {
    const id = "stealthtube-toast";
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.id = id;
    toast.textContent = text;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("visible"));
    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 400);
    }, 3200);
  }

  // ---------- hidden tags (page-level JS objects) ----------

  function fetchYtData() {
    return new Promise((resolve) => {
      api.runtime.sendMessage({ type: "EXTRACT_YT_DATA" }, (response) => {
        if (api.runtime.lastError || !response || !response.ok) {
          resolve(lastYtData);
          return;
        }
        lastYtData = {
          tags: response.tags || [],
          category: response.category || ""
        };
        log("Hidden tags fetched:", lastYtData.tags.length, "tags, category:", lastYtData.category || "(none)");
        resolve(lastYtData);
      });
    });
  }

  // ---------- URL param scanning ----------

  function extractVideoId(url) {
    try {
      const u = url ? new URL(url, location.origin) : new URL(location.href);
      return u.searchParams.get("v") || null;
    } catch (_) { return null; }
  }

  // YouTube sometimes encodes the channel name in ?ab_channel=... and
  // playlist/category info in other params.  This data is available
  // synchronously — no DOM needed.
  function getUrlMeta() {
    try {
      const params = new URLSearchParams(location.search);
      const parts = [];
      const abChannel = params.get("ab_channel");
      if (abChannel) parts.push(abChannel);
      const listName = params.get("list");
      if (listName && !/^[A-Za-z0-9_-]{10,}$/.test(listName)) {
        // Only include human-readable list names, not opaque IDs.
        parts.push(listName);
      }
      // Extract channel handle from URL path (@handle, /c/name, /user/name).
      const handleMatch = location.pathname.match(/^\/@([^/]+)/);
      if (handleMatch) parts.push(handleMatch[1]);
      const slugMatch = location.pathname.match(/^\/(?:c|user)\/([^/]+)/);
      if (slugMatch) parts.push(slugMatch[1]);
      return parts.join(" ");
    } catch (_) {
      return "";
    }
  }

  // ---------- metadata reading ----------

  function readWatchMetadata() {
    if (!location.pathname.startsWith("/watch")) return null;
    const titleEl = document.querySelector(cfg.TITLE_SELECTOR);
    const channelEl = document.querySelector(cfg.CHANNEL_SELECTOR);
    const title = (titleEl && titleEl.textContent || "").trim();
    let channel = (channelEl && channelEl.textContent || "").trim();

    // Fallback: channel from URL param (available before DOM renders).
    if (!channel) {
      try {
        const abChannel = new URLSearchParams(location.search).get("ab_channel");
        if (abChannel) channel = abChannel;
      } catch (_) {}
    }

    if (!title) return null;

    let description = "";
    const descEl = document.querySelector(cfg.DESCRIPTION_SELECTOR);
    if (descEl && descEl.textContent) {
      description = descEl.textContent.trim().slice(0, 500);
    }

    // DOM <meta> tags
    let metaText = "";
    try {
      const metaEls = document.querySelectorAll(cfg.META_SELECTORS);
      const parts = [];
      metaEls.forEach((m) => {
        const c = m.getAttribute("content");
        if (c) parts.push(c);
      });
      metaText = parts.join(" ").slice(0, 1000);
    } catch (_) {}

    // Merge hidden tags from ytInitialPlayerResponse / ytInitialData.
    if (lastYtData.tags.length > 0 || lastYtData.category) {
      const hiddenParts = [];
      if (lastYtData.tags.length > 0) hiddenParts.push(lastYtData.tags.join(" "));
      if (lastYtData.category) hiddenParts.push(lastYtData.category);
      metaText = (metaText + " " + hiddenParts.join(" ")).trim().slice(0, 1500);
    }

    // Merge URL-param metadata.
    const urlMeta = getUrlMeta();
    if (urlMeta) {
      metaText = (metaText + " " + urlMeta).trim().slice(0, 1500);
    }

    return { title, channel, description, metaText };
  }

  // ---------- blacklist matching ----------

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalize(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[.\-_*~`'"!?,:;()\[\]{}<>\/\\|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function collectKeywords() {
    const presets = (cfg && cfg.STEALTH_PRESETS) || {};
    const out = [];
    for (const name of settings.enabledPresets || []) {
      const list = presets[name];
      if (Array.isArray(list)) out.push(...list);
    }
    for (const kw of settings.userKeywords || []) {
      if (kw) out.push(kw);
    }
    return out;
  }

  const WEAK_THRESHOLD = 2;

  function findMatch(meta) {
    if (!settings || !settings.enabled) return null;
    const cleanTitle = normalize(meta.title);
    const cleanChannel = normalize(meta.channel);
    const cleanDesc = normalize(meta.description || "");
    const cleanMeta = normalize(meta.metaText || "");

    for (const entry of settings.userChannels || []) {
      const cleanEntry = normalize(entry);
      if (!cleanEntry) continue;
      if (new RegExp(escapeRegex(cleanEntry), "i").test(cleanChannel)) {
        return { kind: "channel", source: "channel", value: entry };
      }
    }

    const keywords = collectKeywords();
    const weakHits = [];

    for (const kw of keywords) {
      const cleanKw = normalize(kw);
      if (!cleanKw) continue;
      const re = new RegExp(escapeRegex(cleanKw), "i");

      if (re.test(cleanTitle) || re.test(cleanChannel)) {
        return { kind: "keyword", source: "title", value: kw };
      }

      if (re.test(cleanDesc) || re.test(cleanMeta)) {
        if (!weakHits.includes(kw)) weakHits.push(kw);
      }
    }

    if (weakHits.length >= WEAK_THRESHOLD) {
      return {
        kind: "keyword",
        source: "description",
        value: weakHits.slice(0, 3).join(", "),
        weakCount: weakHits.length
      };
    }

    if (weakHits.length > 0) {
      log(`weak hits below threshold (${weakHits.length}/${WEAK_THRESHOLD}): ${weakHits.join(", ")}`);
    }

    return null;
  }

  // ---------- URL-only fast check ----------

  // Runs instantly before any DOM metadata is available.  Checks the URL's
  // ab_channel param against channel blacklist and all keywords.
  function checkUrlOnly() {
    if (!location.pathname.startsWith("/watch")) return null;
    if (!settings || !settings.enabled) return null;

    const urlText = normalize(getUrlMeta());
    if (!urlText) return null;

    for (const entry of settings.userChannels || []) {
      const c = normalize(entry);
      if (c && new RegExp(escapeRegex(c), "i").test(urlText)) {
        return { kind: "channel", source: "url", value: entry };
      }
    }

    const keywords = collectKeywords();
    for (const kw of keywords) {
      const c = normalize(kw);
      if (c && new RegExp(escapeRegex(c), "i").test(urlText)) {
        return { kind: "keyword", source: "url", value: kw };
      }
    }

    return null;
  }

  // ---------- checkBlacklist ----------

  // verdictLevel:
  //   "immediate" — MutationObserver / navigate-finish (can send TRIGGER, not SAFE)
  //   "fast"      — 500 ms pass (can send TRIGGER or SAFE_VERDICT)
  //   "thorough"  — 1.5 s pass with hidden tags (can send TRIGGER or SAFE_VERDICT)
  function checkBlacklist(verdictLevel) {
    const isWatch = location.pathname.startsWith("/watch");
    const isChannelPage = /^\/@|^\/c\/|^\/user\/|^\/channel\//.test(location.pathname);

    if (!isWatch && !isChannelPage) {
      api.runtime.sendMessage({ type: "AUTO_STEALTH_REVERT" }).catch(() => {});
      return;
    }

    // Channel page: match URL handle against channel blacklist.
    if (isChannelPage) {
      if (!settings || !settings.enabled) return;
      const urlText = normalize(getUrlMeta());
      if (!urlText) return;
      for (const entry of settings.userChannels || []) {
        const c = normalize(entry);
        if (c && new RegExp(escapeRegex(c), "i").test(urlText)) {
          log("Channel page blacklist HIT:", entry);
          api.runtime.sendMessage({ type: "AUTO_STEALTH_TRIGGER" }).catch(() => {});
          if (!stealthEnabled) {
            showToast("Auto-Stealth active: channel page match (" + entry + ").");
          }
          return;
        }
      }
      api.runtime.sendMessage({ type: "AUTO_STEALTH_REVERT" }).catch(() => {});
      return;
    }

    const meta = readWatchMetadata();
    if (!meta) return;

    const canVerdict = verdictLevel === "fast" || verdictLevel === "thorough";
    const key = location.search + "|" + meta.title + "|" + meta.channel;
    if (key === lastEvaluatedKey && !canVerdict) return;
    lastEvaluatedKey = key;

    log("checkBlacklist:", {
      verdictLevel,
      title: meta.title.slice(0, 60),
      channel: meta.channel,
      descLen: (meta.description || "").length,
      metaLen: (meta.metaText || "").length
    });

    const match = findMatch(meta);
    if (match) {
      log("Blacklist HIT:", match);
      lastGhostedVideoId = currentVideoId;
      const wasOn = stealthEnabled;
      api.runtime.sendMessage({ type: "AUTO_STEALTH_TRIGGER", videoId: currentVideoId }).catch(() => {});
      if (!wasOn) {
        let label;
        if (match.source === "channel" || match.source === "url") {
          label = `Auto-Stealth active: channel match (${match.value}).`;
        } else if (match.source === "description") {
          label = `Auto-Stealth active: ${match.weakCount} description/tag matches (${match.value}).`;
        } else {
          label = `Auto-Stealth active: keyword match (${match.value}).`;
        }
        showToast(label);
      }
    } else if (canVerdict) {
      // This pass is authoritative enough to declare the video safe.
      curtainLog("Sending SAFE_VERDICT (verdictLevel=" + verdictLevel + ")");
      api.runtime.sendMessage({ type: "SAFE_VERDICT" }).catch(() => {});
      api.runtime.sendMessage({ type: "AUTO_STEALTH_REVERT" }).catch(() => {});
    } else {
      // Non-authoritative: no match found but hidden tags etc. are missing.
      // Send REVERT (held by background while curtain is up).
      log("No match (immediate) — REVERT sent, curtain still protects");
      api.runtime.sendMessage({ type: "AUTO_STEALTH_REVERT" }).catch(() => {});
    }

    // One Video = One Count: manual-stealth counting (auto-stealth counts
    // via AUTO_STEALTH_TRIGGER in background).
    if (!match && stealthEnabled && currentVideoId && currentVideoId !== lastGhostedVideoId) {
      lastGhostedVideoId = currentVideoId;
      api.runtime.sendMessage({ type: "VIDEO_GHOSTED", videoId: currentVideoId }).catch(() => {});
    }
  }

  // ---------- title MutationObserver ----------

  function attachTitleObserver() {
    if (titleObserver) {
      titleObserver.disconnect();
      titleObserver = null;
    }
    const titleEl = document.querySelector(cfg.TITLE_SELECTOR);
    if (!titleEl) {
      const root = document.querySelector(cfg.SELECTORS.app) || document.body;
      if (!root) return;
      const waiter = new MutationObserver(() => {
        if (document.querySelector(cfg.TITLE_SELECTOR)) {
          waiter.disconnect();
          attachTitleObserver();
        }
      });
      waiter.observe(root, { childList: true, subtree: true });
      return;
    }

    log("Title observer attached");
    titleObserver = new MutationObserver(() => checkBlacklist("immediate"));
    titleObserver.observe(titleEl, {
      childList: true,
      subtree: true,
      characterData: true
    });
    checkBlacklist("immediate");
  }

  function attachDocTitleObserver() {
    if (docTitleObserver) return;
    const titleNode = document.querySelector("title");
    if (!titleNode) return;
    docTitleObserver = new MutationObserver(() => checkBlacklist("immediate"));
    docTitleObserver.observe(titleNode, { childList: true, characterData: true, subtree: true });
  }

  // ---------- SPA hooks ----------

  function startUIObserver() {
    if (uiObserver) return;
    const root = document.querySelector(cfg.SELECTORS.app) || document.body;
    if (!root) return;
    uiObserver = new MutationObserver(() => refreshUI());
    uiObserver.observe(root, { childList: true, subtree: true });
  }

  function cancelScheduledChecks() {
    if (fastVerdictTimer) { clearTimeout(fastVerdictTimer); fastVerdictTimer = null; }
    if (thoroughTimer) { clearTimeout(thoroughTimer); thoroughTimer = null; }
  }

  // Earliest SPA signal.  Fires BEFORE yt-navigate-finish, often before the
  // URL has fully settled.  We reassert the iron curtain immediately.
  function onNavigateStart(event) {
    navTimestamp = Date.now();
    lastEvaluatedKey = "";
    lastYtData = { tags: [], category: "" };
    cancelScheduledChecks();

    // Track video ID immediately for Session ID Poisoning.
    currentVideoId = null;
    try {
      const detail = event && event.detail;
      if (detail && detail.endpoint && detail.endpoint.watchEndpoint) {
        currentVideoId = detail.endpoint.watchEndpoint.videoId || null;
      }
      if (!currentVideoId && detail && detail.url) {
        currentVideoId = extractVideoId(detail.url);
      }
    } catch (_) {}
    if (!currentVideoId) currentVideoId = extractVideoId();

    curtainLog("yt-navigate-start — reasserting curtain for:", location.href, "videoId:", currentVideoId);
    api.runtime.sendMessage({
      type: "REASSERT_CURTAIN",
      url: location.href
    }).catch(() => {});

    // Fire-and-forget URL-only check — can catch ab_channel immediately.
    const urlMatch = checkUrlOnly();
    if (urlMatch) {
      log("URL-only fast match:", urlMatch);
      api.runtime.sendMessage({ type: "AUTO_STEALTH_TRIGGER", videoId: currentVideoId }).catch(() => {});
      showToast(`Auto-Stealth active: ${urlMatch.kind} match from URL (${urlMatch.value}).`);
    }
  }

  function onNavigateFinish() {
    log("yt-navigate-finish ->", location.pathname + location.search);
    if (!navTimestamp) navTimestamp = Date.now();
    // Refresh video ID from settled URL.
    currentVideoId = extractVideoId();
    cancelScheduledChecks();
    lastEvaluatedKey = "";
    lastYtData = { tags: [], category: "" };
    refreshUI();
    attachTitleObserver();

    // Fire-and-forget hidden-tag fetch for the thorough pass.
    fetchYtData().catch(() => {});

    // Immediate pass (DOM + URL params, not authoritative for SAFE).
    checkBlacklist("immediate");

    // 500 ms fast verdict — if DOM metadata is ready, this can declare safe.
    fastVerdictTimer = setTimeout(() => {
      fastVerdictTimer = null;
      log("fast verdict pass (500ms)");
      lastEvaluatedKey = "";
      checkBlacklist("fast");
    }, 500);

    // 1.5 s thorough verdict — hidden tags fetched, final authority.
    thoroughTimer = setTimeout(async () => {
      thoroughTimer = null;
      await fetchYtData();
      lastEvaluatedKey = "";
      log("thorough verdict pass (1.5s)");
      checkBlacklist("thorough");
    }, 1500);

    if (!location.pathname.startsWith("/watch")) {
      api.runtime.sendMessage({ type: "AUTO_STEALTH_REVERT" }).catch(() => {});
    }
  }

  document.addEventListener(cfg.EVENTS.navigateStart, onNavigateStart, true);
  document.addEventListener(cfg.EVENTS.navigateFinish, onNavigateFinish, true);
  window.addEventListener(cfg.EVENTS.pageDataUpdated, () => {
    refreshUI();
    checkBlacklist("immediate");
  }, true);

  api.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "STEALTH_STATE") {
      stealthEnabled = Boolean(message.enabled);
      log("State broadcast received: stealthEnabled =", stealthEnabled);
      refreshUI();
    } else if (message.type === "AUTO_STEALTH_SETTINGS") {
      settings = { ...settings, ...(message.settings || {}) };
      log("Settings updated:", settings);
      lastEvaluatedKey = "";
      checkBlacklist("immediate");
    }
  });

  // Initial pulls.
  api.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    if (api.runtime.lastError || !response || !response.ok) return;
    stealthEnabled = Boolean(response.enabled);
    log("Initial state:", { enabled: stealthEnabled, manual: response.manual, current: response.current });
    refreshUI();
    startUIObserver();
    attachTitleObserver();
    attachDocTitleObserver();
  });

  api.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
    if (api.runtime.lastError || !response || !response.ok) return;
    settings = response.settings || settings;
    log("Initial settings:", settings);
    fetchYtData().then(() => checkBlacklist("immediate")).catch(() => {});
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshUI();
  });

  // ---------- initial load protection ----------
  // Content script runs at document_idle — DOMContentLoaded has already fired.
  // Send REASSERT_CURTAIN immediately for /watch pages to lock history.
  if (location.pathname.startsWith("/watch")) {
    currentVideoId = extractVideoId();
    curtainLog("Initial load on /watch — reasserting curtain, videoId:", currentVideoId);
    api.runtime.sendMessage({ type: "REASSERT_CURTAIN", url: location.href }).catch(() => {});
  }

  window.addEventListener("load", () => {
    if (location.pathname.startsWith("/watch")) {
      fetchYtData().then(() => checkBlacklist("fast")).catch(() => {});
    } else {
      checkBlacklist("immediate");
    }
  });
})();
