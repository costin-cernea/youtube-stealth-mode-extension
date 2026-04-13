// Centralized config: keep YouTube DOM selectors here so they're easy to
// update when YouTube ships layout changes. Prefer stable custom-element tags
// and ARIA labels over generated CSS classes.
(function () {
  const StealthTubeConfig = {
    STORAGE_KEY: "stealthMode", // legacy — kept for migration only
    RULESET_ID: "stealth_ruleset",
    BADGE_ID: "stealthtube-badge",
    PLAYER_CLASS: "stealthtube-player-active",

    // Robust selectors for Auto-Stealth metadata detection.
    TITLE_SELECTOR: "h1.ytd-watch-metadata, #container h1.ytd-video-primary-info-renderer",
    CHANNEL_SELECTOR: "#owner-sub-count, ytd-channel-name #text",
    DESCRIPTION_SELECTOR: "#description-inner, #description-inline-expander, ytd-text-inline-expander#description-inline-expander, #description ytd-text-inline-expander",
    META_SELECTORS: "head meta[name=\"keywords\"], head meta[name=\"description\"], head meta[property=\"og:description\"], head meta[property=\"og:title\"]",

    // Robust ARIA-based selector for the Panic Button history menu.
    PANIC_MENU: "button[aria-label=\"Action menu\"]",

    SELECTORS: {
      masthead: "ytd-masthead #end, ytd-masthead #container #end",
      player: "ytd-watch-flexy #player, #movie_player",
      app: "ytd-app",
      // Aliases (kept so existing code paths keep working).
      videoTitle: "h1.ytd-watch-metadata, #container h1.ytd-video-primary-info-renderer",
      channelName: "#owner-sub-count, ytd-channel-name #text, ytd-channel-name a",
      historyVideoRow: "ytd-section-list-renderer ytd-item-section-renderer ytd-video-renderer, ytd-video-renderer",
      historyMenuButton: "button[aria-label=\"Action menu\"]",
      historyMenuItems: "tp-yt-paper-item, ytd-menu-service-item-renderer, yt-list-item-view-model"
    },

    IRON_CURTAIN_ID: "iron_curtain",

    EVENTS: {
      navigateStart: "yt-navigate-start",
      navigateFinish: "yt-navigate-finish",
      pageDataUpdated: "yt-page-data-updated"
    },

    // Built-in Auto-Stealth keyword presets. Each entry is a list of plain
    // keywords; matching is case-insensitive and runs through the same
    // normalizer as the user's manual list (so "D.r.a.m.a" still hits).
    STEALTH_PRESETS: {
      GAMING: ["gameplay", "walkthrough", "gaming", "playthrough", "twitch", "stream", "nintendo", "playstation", "xbox"],
      VLOGS: ["vlog", "daily vlog", "storytime", "lifestyle", "routine", "challenge", "prank"],
      ASMR: ["asmr", "whispering", "tapping", "tingles", "relaxation"],
      DRAMA: ["drama", "gossip", "exposed", "truth about", "scandal", "tea", "commentary"]
    },

    PRESET_LABELS: {
      GAMING: "Gaming",
      VLOGS: "Vlogs",
      ASMR: "ASMR",
      DRAMA: "Drama"
    }
  };

  if (typeof globalThis !== "undefined") {
    globalThis.StealthTubeConfig = StealthTubeConfig;
  }
})();
