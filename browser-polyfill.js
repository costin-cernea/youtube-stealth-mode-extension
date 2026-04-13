// Minimal cross-browser polyfill: exposes a `browser` global that aliases
// `chrome` on Chromium-based browsers. Firefox already provides `browser`
// natively with promise-based APIs, so this is a no-op there.
(function () {
  if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome !== "undefined") {
    globalThis.browser = globalThis.chrome;
  }
})();
