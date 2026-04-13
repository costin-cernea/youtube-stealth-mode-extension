(function () {
  const api = (typeof browser !== "undefined" ? browser : chrome);

  // ---------- helpers ----------

  function send(message) {
    return new Promise((resolve) => {
      try {
        api.runtime.sendMessage(message, (response) => {
          if (api.runtime.lastError) {
            resolve({ ok: false, error: api.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  function $(id) { return document.getElementById(id); }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function formatMinutes(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
  }

  // ---------- tabs ----------

  function setupTabs() {
    const tabs = document.querySelectorAll(".tab");
    const panels = document.querySelectorAll(".panel");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.tab;
        tabs.forEach((t) => {
          t.classList.toggle("active", t === tab);
          t.setAttribute("aria-selected", t === tab ? "true" : "false");
        });
        panels.forEach((p) => {
          const match = p.dataset.panel === target;
          p.hidden = !match;
          p.classList.toggle("active", match);
        });
        if (target === "stats") refreshStats();
      });
    });
  }

  // ---------- stealth toggle ----------

  function renderState(enabled) {
    const toggle = $("stealth-toggle");
    const statusText = $("status-text");
    toggle.checked = Boolean(enabled);
    statusText.textContent = enabled
      ? "Stealth Mode is ON — history paused"
      : "Stealth Mode is OFF — normal YouTube";
    statusText.style.color = enabled ? "var(--accent)" : "";
  }

  // ---------- stats ----------

  async function refreshStats() {
    const r = await send({ type: "GET_STATS" });
    if (!r.ok) return;
    const s = r.stats;
    $("stat-ghosted").textContent = String(s.ghostedVideos);
    $("stat-pings").textContent = s.blockedPings.toLocaleString();
    $("stat-time").textContent = formatMinutes(s.stealthTimeMs);
    $("footer-count").textContent = String(s.ghostedVideos);

    // Bar fills are visual only — scale against soft caps so the bars feel
    // alive without ever pinning at 100% for power users.
    $("bar-ghosted").style.width = clamp(s.ghostedVideos / 50 * 100, 4, 100) + "%";
    $("bar-pings").style.width = clamp(s.blockedPings / 500 * 100, 4, 100) + "%";
    $("bar-time").style.width = clamp(s.stealthTimeMs / (60 * 60000) * 100, 4, 100) + "%";
  }

  // ---------- settings ----------

  function renderPresetCheckboxes(enabledPresets) {
    const cfg = globalThis.StealthTubeConfig || {};
    const presets = cfg.STEALTH_PRESETS || {};
    const labels = cfg.PRESET_LABELS || {};
    const list = $("preset-list");
    list.innerHTML = "";

    const enabledSet = new Set(enabledPresets || []);
    for (const key of Object.keys(presets)) {
      const id = "preset-" + key.toLowerCase();
      const label = document.createElement("label");
      label.className = "preset-item";
      label.htmlFor = id;
      label.title = (presets[key] || []).join(", ");

      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.dataset.preset = key;
      input.checked = enabledSet.has(key);

      const span = document.createElement("span");
      span.textContent = labels[key] || key;

      label.append(input, span);
      list.append(label);
    }
  }

  function readEnabledPresets() {
    return Array.from(document.querySelectorAll("#preset-list input[type=checkbox]"))
      .filter((el) => el.checked)
      .map((el) => el.dataset.preset);
  }

  async function loadSettings() {
    const r = await send({ type: "GET_SETTINGS" });
    if (!r.ok) return;
    const s = r.settings;
    $("auto-toggle").checked = Boolean(s.enabled);
    $("keywords-input").value = (s.userKeywords || []).join("\n");
    $("channels-input").value = (s.userChannels || []).join("\n");
    renderPresetCheckboxes(s.enabledPresets || []);
  }

  function parseLines(text) {
    return text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function saveSettings() {
    const settings = {
      enabled: $("auto-toggle").checked,
      userKeywords: parseLines($("keywords-input").value),
      userChannels: parseLines($("channels-input").value),
      enabledPresets: readEnabledPresets()
    };
    await send({ type: "SAVE_SETTINGS", settings });
    const btn = $("save-settings");
    const original = btn.textContent;
    btn.textContent = "Saved";
    btn.classList.add("saved");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("saved");
    }, 1200);
  }

  // ---------- panic button ----------

  async function runPanic() {
    const btn = $("panic-btn");
    btn.classList.add("busy");
    const original = $("status-text").textContent;
    $("status-text").textContent = "Wiping last video…";
    const r = await send({ type: "PANIC_WIPE_LAST" });
    btn.classList.remove("busy");
    if (r.ok) {
      $("status-text").textContent = "History cleared ✓";
      $("status-text").style.color = "var(--accent)";
    } else {
      $("status-text").textContent = "Panic failed: " + (r.error || "unknown");
      $("status-text").style.color = "var(--accent)";
    }
    setTimeout(async () => {
      const state = await send({ type: "GET_STATE" });
      renderState(state.ok ? state.enabled : false);
    }, 2400);
  }

  // ---------- init ----------

  async function init() {
    try {
      const manifest = api.runtime.getManifest();
      const vStr = "v" + manifest.version;
      $("version").textContent = vStr;
      if ($("about-version")) $("about-version").textContent = "StealthTube " + vStr;
    } catch (_) {}

    setupTabs();

    const state = await send({ type: "GET_STATE" });
    renderState(state.ok ? state.enabled : false);

    await loadSettings();
    await refreshStats();

    $("stealth-toggle").addEventListener("change", async (e) => {
      const desired = e.target.checked;
      const r = await send({ type: "SET_STATE", enabled: desired });
      renderState(r.ok ? r.enabled : !desired);
      refreshStats();
    });

    $("save-settings").addEventListener("click", saveSettings);

    // Inline confirmation for Reset Statistics.
    $("reset-stats").addEventListener("click", () => {
      $("reset-stats").classList.add("hidden");
      $("reset-confirmation").hidden = false;
    });
    $("reset-cancel").addEventListener("click", () => {
      $("reset-confirmation").hidden = true;
      $("reset-stats").classList.remove("hidden");
    });
    $("reset-yes").addEventListener("click", async () => {
      $("reset-yes").disabled = true;
      await send({ type: "RESET_STATS" });
      await refreshStats();
      $("reset-confirmation").hidden = true;
      $("reset-stats").classList.remove("hidden");
      $("reset-yes").disabled = false;
    });

    $("panic-btn").addEventListener("click", runPanic);
  }

  init();
})();
