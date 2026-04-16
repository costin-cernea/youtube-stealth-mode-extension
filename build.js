#!/usr/bin/env node
//
// build.js — generates dist/chrome/ and dist/firefox/ with browser-specific manifests.
// Run: node build.js

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");

// Files to copy into each dist folder (everything except build artifacts).
const COPY_FILES = [
  "background.js",
  "browser-polyfill.js",
  "config.js",
  "content.css",
  "content.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "rules.json",
  "rules_curtain.json",
];

const COPY_DIRS = ["icons"];

// Read the base manifest.
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

// ---- Chrome manifest ----
const chrome = JSON.parse(JSON.stringify(base));
chrome.background = {
  service_worker: "background.js",
  type: "module",
};
// Chrome ignores browser_specific_settings but doesn't error on it — keep it
// so the same manifest.json works if someone manually loads the root folder.

// ---- Firefox manifest ----
const firefox = JSON.parse(JSON.stringify(base));
firefox.background = {
  scripts: ["background.js"],
  type: "module",
};
// Ensure gecko settings are present.
firefox.browser_specific_settings = {
  gecko: {
    id: "stealthtube@costincernea.com",
    strict_min_version: "115.0",
  },
};

// ---- helpers ----

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, destDir) {
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
}

function copyDir(name, destDir) {
  const srcDir = path.join(ROOT, name);
  const outDir = path.join(destDir, name);
  mkdirp(outDir);
  for (const file of fs.readdirSync(srcDir)) {
    const full = path.join(srcDir, file);
    if (fs.statSync(full).isFile()) {
      fs.copyFileSync(full, path.join(outDir, file));
    }
  }
}

function buildTarget(name, manifest) {
  const dir = path.join(DIST, name);
  mkdirp(dir);

  // Write manifest.
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Copy source files.
  for (const file of COPY_FILES) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) copyFile(src, dir);
  }

  // Copy directories.
  for (const d of COPY_DIRS) {
    copyDir(d, dir);
  }

  console.log(`  ${name}/ -> ${dir}`);
}

// ---- run ----

console.log("Building StealthTube v" + base.version);
mkdirp(DIST);
buildTarget("chrome", chrome);
buildTarget("firefox", firefox);
console.log("Done. Load dist/chrome or dist/firefox as an unpacked extension.");
