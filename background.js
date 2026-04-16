// StealthTube background service worker.
//
// IronCurtain architecture (block-by-default / whitelist model):
//
//   The static ruleset "iron_curtain" is ENABLED in the manifest.  It blocks
//   the three pings that write to watch history (playback, watchtime,
//   ptracking).  Because it is a static default-on ruleset, it is active
//   before the very first navigation — there is zero race window.
//
//   The background tracks a `pendingTabs` set.  A tab is "pending" from the
//   moment a /watch navigation starts until content.js sends a verdict:
//     SAFE_VERDICT   → remove from set; if set empty, disable iron_curtain
//     STEALTH_TRIGGER → remove from set; stealth_ruleset takes over
//     Tab closed / non-watch nav → remove from set
//
//   The full "stealth_ruleset" is orthogonal: toggled by manual switch or
//   auto-stealth engage/revert, same as before.
//
// Dual-state model (unchanged):
//   manualState  — the user's popup toggle
//   currentState — what is actually active (may differ during auto-stealth)

const api = (typeof browser !== "undefined" ? browser : chrome);

const LEGACY_KEY = "stealthMode";
const MANUAL_KEY = "manualState";
const CURRENT_KEY = "currentState";
const STATS_KEY = "ghostStats";
const SETTINGS_KEY = "autoStealth";
const STEALTH_RULESET_ID = "stealth_ruleset";
const IRON_CURTAIN_ID = "iron_curtain";

const PINGS_PER_TOXIC_VIDEO = 25;

// "One Video = One Count" deduplication.
let lastCountedVideoId = null;

// ---------- Session ID Poisoning ----------
// Dynamic DNR rules that permanently block tracking pings for specific toxic
// video IDs.  Rules persist across iron-curtain enable/disable cycles and are
// only cleared on a fresh browser session (onInstalled / onStartup).
const DYNAMIC_RULE_ID_BASE = 10000;
const RULES_PER_VIDEO = 3;
const blacklistedVideoIds = new Set();
let nextDynamicRuleId = DYNAMIC_RULE_ID_BASE;

// Recover blacklist state when service worker wakes mid-session.
(async function recoverPoisonState() {
  try {
    const rules = await api.declarativeNetRequest.getDynamicRules();
    for (const rule of rules) {
      if (rule.id < DYNAMIC_RULE_ID_BASE) continue;
      nextDynamicRuleId = Math.max(nextDynamicRuleId, rule.id + 1);
      const f = (rule.condition && rule.condition.urlFilter) || "";
      const idx = f.lastIndexOf("*");
      if (idx >= 0) {
        const vid = f.substring(idx + 1);
        if (vid) blacklistedVideoIds.add(vid);
      }
    }
    if (blacklistedVideoIds.size > 0) {
      curtainLog("Recovered " + blacklistedVideoIds.size + " poisoned video(s) from dynamic rules");
    }
  } catch (_) {}
})();

const DEFAULT_STATS = {
  ghostedVideos: 0,
  stealthTimeMs: 0,
  stealthOnSince: 0
};

const DEFAULT_SETTINGS = {
  enabled: true,
  userKeywords: [],
  userChannels: [],
  enabledPresets: []
};

const log = (...args) => console.log("[StealthTube]", ...args);
const curtainLog = (...args) => console.log("[IronCurtain]", ...args);

// ---------- state accessors ----------

async function getManual() {
  const r = await api.storage.local.get(MANUAL_KEY);
  return Boolean(r[MANUAL_KEY]);
}

async function getCurrent() {
  const r = await api.storage.local.get(CURRENT_KEY);
  return Boolean(r[CURRENT_KEY]);
}

async function setManual(v) {
  await api.storage.local.set({ [MANUAL_KEY]: Boolean(v) });
}

async function setCurrent(v) {
  await api.storage.local.set({ [CURRENT_KEY]: Boolean(v) });
}

async function getStats() {
  const r = await api.storage.local.get(STATS_KEY);
  return { ...DEFAULT_STATS, ...(r[STATS_KEY] || {}) };
}

async function saveStats(stats) {
  await api.storage.local.set({ [STATS_KEY]: stats });
}

async function getSettings() {
  const r = await api.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(r[SETTINGS_KEY] || {}) };
}

async function saveSettings(s) {
  await api.storage.local.set({ [SETTINGS_KEY]: s });
}

async function computeLiveStats() {
  const stats = await getStats();
  let totalMs = stats.stealthTimeMs;
  if (stats.stealthOnSince > 0) totalMs += Date.now() - stats.stealthOnSince;
  return {
    ghostedVideos: stats.ghostedVideos,
    stealthTimeMs: totalMs,
    stealthMinutes: Math.round(totalMs / 60000),
    blockedPings: stats.ghostedVideos * PINGS_PER_TOXIC_VIDEO
  };
}

// ---------- ruleset helpers ----------

async function setStealthRuleset(enabled) {
  try {
    await api.declarativeNetRequest.updateEnabledRulesets(
      enabled
        ? { enableRulesetIds: [STEALTH_RULESET_ID] }
        : { disableRulesetIds: [STEALTH_RULESET_ID] }
    );
  } catch (err) {
    console.error("[StealthTube] setStealthRuleset failed:", err);
  }
}

async function setIronCurtain(enabled) {
  try {
    await api.declarativeNetRequest.updateEnabledRulesets(
      enabled
        ? { enableRulesetIds: [IRON_CURTAIN_ID] }
        : { disableRulesetIds: [IRON_CURTAIN_ID] }
    );
  } catch (err) {
    console.error("[IronCurtain] setIronCurtain failed:", err);
  }
}

// ---------- badge / broadcast ----------

async function updateBadge(enabled) {
  try {
    await api.action.setBadgeText({ text: enabled ? "ON" : "" });
    await api.action.setBadgeBackgroundColor({ color: enabled ? "#cc0000" : "#00000000" });
    await api.action.setTitle({
      title: enabled ? "StealthTube: ON (history paused)" : "StealthTube: OFF"
    });
  } catch (err) {
    console.error("[StealthTube] updateBadge failed:", err);
  }
}

async function broadcast(enabled) {
  try {
    const tabs = await api.tabs.query({ url: "*://*.youtube.com/*" });
    for (const tab of tabs) {
      api.tabs.sendMessage(tab.id, { type: "STEALTH_STATE", enabled }).catch(() => {});
    }
  } catch (err) {
    console.error("[StealthTube] broadcast failed:", err);
  }
}

// Apply a new currentState (stealth_ruleset, badge, broadcast, time tracking).
// Iron curtain is NOT touched here — it lives on its own lifecycle.
async function applyCurrentState(enabled, sourceLabel) {
  const prev = await getCurrent();
  if (prev === enabled) {
    log(`currentState already ${enabled ? "ON" : "OFF"} (${sourceLabel}); no-op`);
    return;
  }
  const stats = await getStats();
  const now = Date.now();
  if (enabled && !prev) {
    stats.stealthOnSince = now;
  } else if (!enabled && prev && stats.stealthOnSince > 0) {
    stats.stealthTimeMs += now - stats.stealthOnSince;
    stats.stealthOnSince = 0;
  }
  await api.storage.local.set({ [CURRENT_KEY]: enabled, [STATS_KEY]: stats });

  await setStealthRuleset(enabled);
  await updateBadge(enabled);
  await broadcast(enabled);
  log(`currentState -> ${enabled ? "ON" : "OFF"} (${sourceLabel})`);
}

// ---------- public state operations ----------

async function setUserManualState(enabled) {
  await setManual(enabled);
  await applyCurrentState(enabled, "manual toggle");
}

async function autoStealthEngage() {
  log("Auto-Stealth ENGAGED (blacklist match)");
  await applyCurrentState(true, "auto engage");
}

async function autoStealthRevert() {
  const manual = await getManual();
  const current = await getCurrent();
  if (current === manual) return;
  log("Stealth Reverted to Manual State:", manual ? "ON" : "OFF");
  await applyCurrentState(manual, "auto revert");
}

// ---------- IronCurtain lifecycle ----------

const pendingTabs = new Set();

function isWatchUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("youtube.com") && u.pathname === "/watch";
  } catch { return false; }
}

async function syncIronCurtain() {
  const needed = pendingTabs.size > 0;
  await setIronCurtain(needed);
  if (!needed) curtainLog("All tabs resolved — curtain", needed ? "ON" : "OFF");
}

// Called on webNavigation.onBeforeNavigate and on REASSERT_CURTAIN from
// content's yt-navigate-start.  Adds the tab to the pending set and ensures
// the iron curtain is active.
async function engageIronCurtain(tabId, url) {
  pendingTabs.add(tabId);
  await setIronCurtain(true);
  curtainLog("Block active by default for navigation to:", url || `tab=${tabId}`);
}

// Called when content sends SAFE_VERDICT.  Removes the tab from the pending
// set and, if no other tabs are pending, lowers the curtain.
async function releaseIronCurtain(tabId) {
  pendingTabs.delete(tabId);
  curtainLog("Unblocking history: Video confirmed SAFE. tab=" + tabId);
  await syncIronCurtain();
}

// Called when content sends AUTO_STEALTH_TRIGGER.  The tab is no longer
// pending (the stealth_ruleset takes over blocking).
async function resolveIronCurtainToxic(tabId) {
  pendingTabs.delete(tabId);
  curtainLog("Verdict TOXIC — stealth_ruleset takes over. tab=" + tabId);
  await syncIronCurtain();
}

// ---------- Session ID Poisoning: dynamic per-video rules ----------

async function blacklistVideoId(videoId) {
  if (!videoId || blacklistedVideoIds.has(videoId)) return;
  blacklistedVideoIds.add(videoId);

  const baseId = nextDynamicRuleId;
  nextDynamicRuleId += RULES_PER_VIDEO;

  const addRules = [
    {
      id: baseId,
      priority: 2000,
      action: { type: "block" },
      condition: {
        urlFilter: "||youtube.com/api/stats*" + videoId,
        resourceTypes: ["xmlhttprequest", "ping", "image", "other"]
      }
    },
    {
      id: baseId + 1,
      priority: 2000,
      action: { type: "block" },
      condition: {
        urlFilter: "||youtube.com/ptracking*" + videoId,
        resourceTypes: ["xmlhttprequest", "ping", "image", "other"]
      }
    },
    {
      id: baseId + 2,
      priority: 2000,
      action: { type: "block" },
      condition: {
        urlFilter: "||youtube.com/player_204*" + videoId,
        resourceTypes: ["xmlhttprequest", "ping", "image", "other"]
      }
    }
  ];

  try {
    await api.declarativeNetRequest.updateDynamicRules({ addRules });
    curtainLog("Poisoned video " + videoId + " — dynamic rules " + baseId + "-" + (baseId + RULES_PER_VIDEO - 1));
  } catch (err) {
    console.error("[IronCurtain] blacklistVideoId failed:", err);
    blacklistedVideoIds.delete(videoId);
  }
}

// ---------- Panic Button ----------

function panicCleanScript() {
  const PANIC_MENU = 'button[aria-label="Action menu"]';
  const ROW_SEL = "ytd-section-list-renderer ytd-item-section-renderer ytd-video-renderer, ytd-video-renderer";

  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitForElement(selector, root = document, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = root.querySelector(selector);
      if (el && el.getBoundingClientRect().width > 0) return el;
      await wait(100);
    }
    return null;
  }

  function simulateHover(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"].forEach((type) => {
      try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (_) {}
    });
  }

  return (async () => {
    console.log("[StealthTube panic] starting");
    const firstRow = await waitForElement(ROW_SEL);
    if (!firstRow) return { ok: false, error: "No history rows visible." };
    simulateHover(firstRow);
    await wait(120);
    let menuBtn = firstRow.querySelector(PANIC_MENU);
    if (!menuBtn) menuBtn = await waitForElement(PANIC_MENU, firstRow, 2000);
    if (!menuBtn) return { ok: false, error: "Action menu button not found." };
    simulateHover(menuBtn);
    await wait(80);
    menuBtn.click();
    const removeItem = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const items = document.querySelectorAll(
          "tp-yt-paper-item, ytd-menu-service-item-renderer, yt-list-item-view-model"
        );
        for (const it of items) {
          const rect = it.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const text = (it.textContent || "").toLowerCase();
          if (text.includes("remove from watch history")) return it;
        }
        await wait(100);
      }
      return null;
    })();
    if (!removeItem) return { ok: false, error: "Remove option not in menu." };
    simulateHover(removeItem);
    await wait(60);
    removeItem.click();
    await wait(400);
    console.log("[StealthTube panic] removed first history entry");
    return { ok: true };
  })();
}

async function runPanicButton() {
  let tab;
  try {
    tab = await api.tabs.create({
      url: "https://www.youtube.com/feed/history",
      active: false,
      pinned: true
    });
  } catch (err) {
    return { ok: false, error: "Could not open history tab: " + err.message };
  }
  await new Promise((resolve) => {
    function listener(tabId, info) {
      if (tabId === tab.id && info.status === "complete") {
        api.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    api.tabs.onUpdated.addListener(listener);
    setTimeout(() => { api.tabs.onUpdated.removeListener(listener); resolve(); }, 12000);
  });
  let result;
  try {
    const [injection] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: panicCleanScript
    });
    result = injection && injection.result
      ? await injection.result
      : { ok: false, error: "Injection returned no result." };
  } catch (err) {
    result = { ok: false, error: "Inject failed: " + err.message };
  } finally {
    try { await api.tabs.remove(tab.id); } catch (_) {}
  }
  log("Panic Button result:", result);
  return result;
}

// ---------- init / migration ----------

async function init() {
  // Clear session-poisoning dynamic rules from previous session.
  try {
    const dynRules = await api.declarativeNetRequest.getDynamicRules();
    const staleIds = dynRules.filter(r => r.id >= DYNAMIC_RULE_ID_BASE).map(r => r.id);
    if (staleIds.length > 0) {
      await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: staleIds });
      curtainLog("Cleared " + staleIds.length + " stale dynamic rules from previous session");
    }
  } catch (_) {}
  blacklistedVideoIds.clear();
  nextDynamicRuleId = DYNAMIC_RULE_ID_BASE;

  const all = await api.storage.local.get([LEGACY_KEY, MANUAL_KEY, CURRENT_KEY]);
  if (all[LEGACY_KEY] !== undefined && all[MANUAL_KEY] === undefined) {
    log("Migrating legacy stealthMode key to dual-state");
    await setManual(Boolean(all[LEGACY_KEY]));
    await setCurrent(Boolean(all[LEGACY_KEY]));
    await api.storage.local.remove(LEGACY_KEY);
  } else if (all[MANUAL_KEY] === undefined) {
    await api.storage.local.set({ [MANUAL_KEY]: false, [CURRENT_KEY]: false });
  }

  const current = await getCurrent();
  const stats = await getStats();
  if (current && stats.stealthOnSince === 0) {
    stats.stealthOnSince = Date.now();
    await saveStats(stats);
  } else if (!current && stats.stealthOnSince > 0) {
    stats.stealthTimeMs += Date.now() - stats.stealthOnSince;
    stats.stealthOnSince = 0;
    await saveStats(stats);
  }

  await setStealthRuleset(current);
  await updateBadge(current);
  // Iron curtain starts enabled from manifest.  Content scripts in existing
  // YouTube tabs will send their verdicts as they re-initialize.

  try { await api.alarms.create("stealthtube-flush", { periodInMinutes: 1 }); } catch (_) {}
  log("init complete. manual=", await getManual(), "current=", current);
  log("[StealthTube v4.1] Stats Synced & Buffer Active");
}

api.runtime.onInstalled.addListener(init);
api.runtime.onStartup.addListener(init);

api.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "stealthtube-flush") return;
  const current = await getCurrent();
  if (!current) return;
  const stats = await getStats();
  if (stats.stealthOnSince > 0) {
    const now = Date.now();
    stats.stealthTimeMs += now - stats.stealthOnSince;
    stats.stealthOnSince = now;
    await saveStats(stats);
  }
});

// ---------- webNavigation: IronCurtain ----------

if (api.webNavigation && api.webNavigation.onBeforeNavigate) {
  api.webNavigation.onBeforeNavigate.addListener(
    async (details) => {
      if (details.frameId !== 0) return;
      if (isWatchUrl(details.url)) {
        await engageIronCurtain(details.tabId, details.url);
      } else if (pendingTabs.has(details.tabId)) {
        // Navigating away from /watch — resolve as safe.
        pendingTabs.delete(details.tabId);
        curtainLog("Non-watch nav — released tab", details.tabId);
        await syncIronCurtain();
      }
    },
    { url: [{ hostSuffix: "youtube.com" }] }
  );
}

// Clean up when a tab is closed.
api.tabs.onRemoved.addListener((tabId) => {
  if (pendingTabs.has(tabId)) {
    pendingTabs.delete(tabId);
    syncIronCurtain();
  }
});

// ---------- Global Reset: revert auto-stealth on non-watch YouTube pages ----------

api.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;
  try {
    const u = new URL(tab.url);
    if (!u.hostname.endsWith("youtube.com")) return;
    if (u.pathname === "/watch") return;
    const manual = await getManual();
    if (!manual) {
      if (pendingTabs.has(tabId)) {
        pendingTabs.delete(tabId);
        await syncIronCurtain();
      }
      await autoStealthRevert();
      log("Global Reset: non-watch page, reverted auto-stealth. tab=" + tabId);
    }
  } catch (_) {}
});

// ---------- ytInitialData extractor ----------

function ytDataExtractor() {
  try {
    var tags = [];
    var category = "";
    if (typeof ytInitialPlayerResponse !== "undefined" && ytInitialPlayerResponse) {
      var vd = ytInitialPlayerResponse.videoDetails;
      if (vd && Array.isArray(vd.keywords)) tags = vd.keywords;
      var mf = ytInitialPlayerResponse.microformat;
      if (mf && mf.playerMicroformatRenderer) {
        category = mf.playerMicroformatRenderer.category || "";
      }
    }
    if (tags.length === 0 && typeof ytInitialData !== "undefined" && ytInitialData) {
      try {
        var rows = ytInitialData.contents.twoColumnWatchNextResults
          .results.results.contents;
        for (var i = 0; i < rows.length; i++) {
          var s = rows[i].videoSecondaryInfoRenderer;
          if (s && s.metadataRowContainer) {
            var mr = s.metadataRowContainer.metadataRowContainerRenderer.rows;
            for (var j = 0; j < mr.length; j++) {
              var row = mr[j].metadataRowRenderer;
              if (row && row.title && row.title.simpleText === "Category" && !category) {
                category = row.contents[0].runs[0].text;
              }
            }
          }
        }
      } catch (_) {}
    }
    return { tags: tags, category: category };
  } catch (_) {
    return { tags: [], category: "" };
  }
}

// ---------- message router ----------

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== "string") {
      sendResponse({ ok: false, error: "invalid message" });
      return;
    }

    switch (message.type) {
      case "GET_STATE": {
        const manual = await getManual();
        const current = await getCurrent();
        sendResponse({ ok: true, enabled: current, manual, current });
        return;
      }
      case "SET_STATE": {
        // Manual toggle — user is taking explicit control.
        const tabId = sender.tab && sender.tab.id;
        if (tabId !== undefined && pendingTabs.has(tabId)) {
          pendingTabs.delete(tabId);
          await syncIronCurtain();
        }
        await setUserManualState(Boolean(message.enabled));
        sendResponse({ ok: true, enabled: Boolean(message.enabled) });
        return;
      }
      case "TOGGLE_STATE": {
        const next = !(await getManual());
        const tabId = sender.tab && sender.tab.id;
        if (tabId !== undefined && pendingTabs.has(tabId)) {
          pendingTabs.delete(tabId);
          await syncIronCurtain();
        }
        await setUserManualState(next);
        sendResponse({ ok: true, enabled: next });
        return;
      }
      // ---- IronCurtain messages ----
      case "REASSERT_CURTAIN": {
        // SPA navigation started (yt-navigate-start). Re-raise the curtain.
        const tabId = sender.tab && sender.tab.id;
        if (tabId !== undefined) {
          const url = message.url || `tab=${tabId}`;
          await engageIronCurtain(tabId, url);
        }
        sendResponse({ ok: true });
        return;
      }
      case "SAFE_VERDICT": {
        // Content completed its check and found no blacklist match.
        const tabId = sender.tab && sender.tab.id;
        if (tabId !== undefined) {
          await releaseIronCurtain(tabId);
        }
        await autoStealthRevert();
        sendResponse({ ok: true, enabled: await getCurrent() });
        return;
      }
      // ---- Auto-Stealth messages ----
      case "AUTO_STEALTH_TRIGGER": {
        const tabId = sender.tab && sender.tab.id;
        if (tabId !== undefined) {
          await resolveIronCurtainToxic(tabId);
        }
        // Session ID Poisoning: permanently block pings for this video.
        if (message.videoId) {
          await blacklistVideoId(message.videoId);
        }
        // One Video = One Count: deduplicate stats.
        if (message.videoId && message.videoId !== lastCountedVideoId) {
          lastCountedVideoId = message.videoId;
          const stats = await getStats();
          stats.ghostedVideos += 1;
          await saveStats(stats);
        }
        await autoStealthEngage();
        sendResponse({ ok: true, enabled: true });
        return;
      }
      case "AUTO_STEALTH_REVERT": {
        // Non-thorough "no match".  If the tab is still pending (curtain up),
        // hold the revert — the curtain keeps protecting until a definitive
        // SAFE_VERDICT or TRIGGER arrives.
        const tabId = sender.tab && sender.tab.id;
        if (tabId !== undefined && pendingTabs.has(tabId)) {
          curtainLog("REVERT held — tab", tabId, "still pending");
          sendResponse({ ok: true, enabled: true, curtained: true });
          return;
        }
        await autoStealthRevert();
        sendResponse({ ok: true, enabled: await getCurrent() });
        return;
      }
      // ---- Stats / Settings / Utilities ----
      case "VIDEO_GHOSTED": {
        if (message.videoId && message.videoId !== lastCountedVideoId) {
          lastCountedVideoId = message.videoId;
          const stats = await getStats();
          stats.ghostedVideos += 1;
          await saveStats(stats);
        }
        sendResponse({ ok: true });
        return;
      }
      case "GET_STATS": {
        sendResponse({ ok: true, stats: await computeLiveStats() });
        return;
      }
      case "RESET_STATS": {
        const current = await getCurrent();
        await saveStats({ ...DEFAULT_STATS, stealthOnSince: current ? Date.now() : 0 });
        lastCountedVideoId = null;
        sendResponse({ ok: true, stats: await computeLiveStats() });
        return;
      }
      case "GET_SETTINGS": {
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }
      case "SAVE_SETTINGS": {
        const merged = { ...(await getSettings()), ...(message.settings || {}) };
        await saveSettings(merged);
        try {
          const tabs = await api.tabs.query({ url: "*://*.youtube.com/*" });
          for (const tab of tabs) {
            api.tabs.sendMessage(tab.id, { type: "AUTO_STEALTH_SETTINGS", settings: merged }).catch(() => {});
          }
        } catch (_) {}
        sendResponse({ ok: true, settings: merged });
        return;
      }
      case "EXTRACT_YT_DATA": {
        try {
          const tabId = sender.tab && sender.tab.id;
          if (tabId === undefined) {
            sendResponse({ ok: false, tags: [], category: "" });
            return;
          }
          const results = await api.scripting.executeScript({
            target: { tabId },
            func: ytDataExtractor,
            world: "MAIN"
          });
          const data = results && results[0] && results[0].result;
          sendResponse({
            ok: true,
            tags: (data && data.tags) || [],
            category: (data && data.category) || ""
          });
        } catch (err) {
          log("EXTRACT_YT_DATA failed:", err);
          sendResponse({ ok: false, tags: [], category: "" });
        }
        return;
      }
      case "PANIC_WIPE_LAST": {
        sendResponse(await runPanicButton());
        return;
      }
      default:
        sendResponse({ ok: false, error: "unknown type" });
    }
  })();
  return true;
});
