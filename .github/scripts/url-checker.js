#!/usr/bin/env node
/**
 * check-urls.js
 *
 * Checks every URL found in one or more JSON files, follows redirects,
 * and rewrites each file in place with the resolved URLs.
 *
 * By default it processes urls.json and embed-urls.json, ONE FILE AT A TIME
 * (fully finishes urls.json — including writing it and its backup — before
 * starting embed-urls.json). Works on any JSON shape: a flat { name: url }
 * map, nested objects, or arrays of objects — it walks the whole tree and
 * only touches string values that look like http(s) URLs, so it doesn't
 * need urls.json and embed-urls.json to have the same structure.
 *
 * Usage:
 *   node check-urls.js                          # default files, one by one
 *   node check-urls.js urls.json                 # only this file
 *   node check-urls.js urls.json embed-urls.json # explicit order
 *   node check-urls.js --dry-run                 # report only, write nothing
 *   node check-urls.js --concurrency=1            # fully sequential per-URL checks
 *   node check-urls.js --timeout=15000 --retries=2 --cache-ttl=3600000
 *
 * Requires: axios (npm install axios)
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

// ======================
// CLI ARGS
// ======================
const rawArgs = process.argv.slice(2);
const flags = {};
const positional = [];

for (const arg of rawArgs) {
  if (arg.startsWith("--")) {
    const [key, value] = arg.slice(2).split("=");
    flags[key] = value === undefined ? true : value;
  } else {
    positional.push(arg);
  }
}

// ======================
// CONFIG
// ======================
const DEFAULT_FILES = ["urls.json", "embed-urls.json"];
const FILES = positional.length ? positional : DEFAULT_FILES;

const TIMEOUT = Number(flags.timeout) || 10000;
const MAX_RETRIES = Number(flags.retries) || 3;
const CONCURRENCY = Number(flags.concurrency) || 5; // set --concurrency=1 for strictly one-URL-at-a-time
const MAX_REDIRECTS = Number(flags["max-redirects"]) || 5;
const CACHE_TTL_MS = Number(flags["cache-ttl"]) || 24 * 60 * 60 * 1000; // 24h
const DRY_RUN = Boolean(flags["dry-run"]);
const CACHE_FILE = flags.cache || ".url-cache.json";

const URL_REGEX = /^https?:\/\//i;

// ======================
// COLORS
// ======================
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

function log(color, message) {
  console.log(`${colors[color] || ""}${message}${colors.reset}`);
}

// ======================
// FILE HELPERS
// ======================
function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("red", `❌ Failed to parse ${file}: ${err.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function createBackup(file) {
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const dir = path.dirname(file);
  const backupName = path.join(dir, `${base}-backup-${Date.now()}${ext}`);
  fs.copyFileSync(file, backupName);
  log("cyan", `🗂  Backup created → ${backupName}`);
  return backupName;
}

// ======================
// URL HELPERS
// ======================
function isUrl(value) {
  return typeof value === "string" && URL_REGEX.test(value);
}

function getDomain(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function preserveSlash(oldUrl, newUrl) {
  return oldUrl.endsWith("/") && !newUrl.endsWith("/") ? `${newUrl}/` : newUrl;
}

function resolveRedirect(base, location) {
  try {
    return new URL(location, base).toString();
  } catch {
    return location;
  }
}

// ======================
// CACHE (shared across all files, keyed by URL, with expiry)
// ======================
let cache = readJson(CACHE_FILE, {});

function getCached(url) {
  const entry = cache[url];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null; // expired, re-check
  return entry;
}

function setCache(url, result) {
  cache[url] = { result, timestamp: Date.now() };
}

function saveCache() {
  writeJson(CACHE_FILE, cache);
  log("cyan", `💾 Cache saved → ${CACHE_FILE}`);
}

// ======================
// AXIOS CLIENT
// ======================
const client = axios.create({
  timeout: TIMEOUT,
  maxRedirects: 0,
  validateStatus: () => true,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  },
});

async function request(url, method = "HEAD") {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client({
        url,
        method,
        headers: { Referer: url, Origin: getDomain(url) },
      });
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES) return { error: err };
      log("yellow", `🔁 Retry ${attempt}/${MAX_RETRIES - 1} → ${url}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return { error: lastErr };
}

// ======================
// FOLLOW THE FULL REDIRECT CHAIN (original only followed one hop)
// ======================
async function followRedirects(startUrl) {
  const chain = [];
  let currentUrl = startUrl;

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    let response = await request(currentUrl, "HEAD");
    if (response.error) response = await request(currentUrl, "GET");

    if (response.error) {
      return { status: "error", error: response.error, chain };
    }

    const status = response.status;

    if (status >= 200 && status < 300) {
      return { status: "ok", chain };
    }

    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      if (!location) return { status: "redirect-no-location", chain };
      const nextUrl = resolveRedirect(currentUrl, location);
      chain.push(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    return { status: "http-error", httpStatus: status, chain };
  }

  return { status: "too-many-redirects", chain };
}

// ======================
// CHECK A SINGLE URL
// ======================
const stats = { ok: 0, updated: 0, dead: 0, errors: 0, cached: 0 };

async function checkUrl(url) {
  const cached = getCached(url);
  if (cached) {
    log("gray", `⚡ Cache hit → ${url}`);
    stats.cached++;
    return cached.result;
  }

  const result = await followRedirects(url);

  if (result.status === "ok") {
    if (result.chain.length === 0) {
      log("green", `✅ OK → ${url}`);
      stats.ok++;
      setCache(url, url);
      return url;
    }

    // Resolved after one or more redirects — keep original behavior of
    // collapsing to the final domain, but now based on the FULL chain.
    const finalHop = result.chain[result.chain.length - 1];
    const newDomain = getDomain(finalHop);
    const finalUrl = preserveSlash(url, newDomain);

    log(
      "blue",
      `🔄 Redirect resolved (${result.chain.length} hop${result.chain.length > 1 ? "s" : ""})`
    );
    log("gray", `   ${url}`);
    result.chain.forEach((hop, i) => log("gray", `   ↳ ${i + 1}. ${hop}`));
    log("cyan", `🌐 Final domain → ${finalUrl}`);

    stats.updated++;
    setCache(url, finalUrl);
    return finalUrl;
  }

  if (result.status === "redirect-no-location") {
    log("yellow", `⚠️  Redirect without location → ${url}`);
    stats.errors++;
    setCache(url, url);
    return url;
  }

  if (result.status === "too-many-redirects") {
    log("red", `❌ Too many redirects (>${MAX_REDIRECTS}) → ${url}`);
    stats.errors++;
    setCache(url, url);
    return url;
  }

  if (result.status === "http-error") {
    log("yellow", `⚠️  HTTP ${result.httpStatus} → ${url}`);
    stats.dead++;
    setCache(url, url);
    return url;
  }

  // result.status === "error"
  const err = result.error;
  if (err.code === "ECONNABORTED") log("yellow", `⌛ Timeout → ${url}`);
  else if (err.code === "ENOTFOUND") log("red", `❌ Domain not found → ${url}`);
  else log("red", `❌ ${url} → ${err.message}`);
  stats.errors++;
  setCache(url, url);
  return url;
}

// ======================
// WALK ANY JSON SHAPE AND COLLECT URL LEAVES
// (works for flat {name: url} maps AND nested objects/arrays, so
// urls.json and embed-urls.json don't need matching structures)
// ======================
function collectUrlEntries(node, parts = []) {
  const entries = [];

  function walk(n, p) {
    if (Array.isArray(n)) {
      n.forEach((value, i) => {
        const np = [...p, `[${i}]`];
        if (isUrl(value)) {
          entries.push({ label: np.join("."), url: value, set: (v) => (n[i] = v) });
        } else if (value && typeof value === "object") {
          walk(value, np);
        }
      });
    } else if (n && typeof n === "object") {
      for (const key of Object.keys(n)) {
        const value = n[key];
        const np = [...p, key];
        if (isUrl(value)) {
          entries.push({ label: np.join("."), url: value, set: (v) => (n[key] = v) });
        } else if (value && typeof value === "object") {
          walk(value, np);
        }
      }
    }
  }

  walk(node, parts);
  return entries;
}

// ======================
// CONCURRENCY LIMITER
// ======================
async function runConcurrent(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) || 1 }, worker));
  return results;
}

// ======================
// PROCESS ONE FILE START TO FINISH
// ======================
async function processFile(file) {
  log("bold", `\n📄 Processing ${file}`);

  if (!fs.existsSync(file)) {
    log("yellow", `⚠️  ${file} not found, skipping`);
    return;
  }

  const data = readJson(file, null);
  if (data === null) {
    log("red", `❌ Skipping ${file} (invalid or unreadable JSON)`);
    return;
  }

  const entries = collectUrlEntries(data);

  if (!entries.length) {
    log("yellow", `ℹ️  No URLs found in ${file}`);
    return;
  }

  log("cyan", `🔍 Found ${entries.length} URL(s) in ${file}`);

  if (!DRY_RUN) createBackup(file);

  let changed = false;

  const tasks = entries.map((entry) => async () => {
    log("cyan", `\n🔎 Checking ${entry.label}`);
    try {
      const newUrl = await checkUrl(entry.url);
      if (newUrl && newUrl !== entry.url) {
        changed = true;
        entry.set(newUrl);
        log("green", `✅ Updated ${entry.label}`);
        log("gray", `   OLD → ${entry.url}`);
        log("gray", `   NEW → ${newUrl}`);
      }
    } catch (err) {
      log("red", `❌ Failed ${entry.label} → ${err.message}`);
    }
  });

  await runConcurrent(tasks, CONCURRENCY);

  if (DRY_RUN) {
    log("yellow", `🧪 Dry run — ${file} not written`);
  } else if (changed) {
    writeJson(file, data);
    log("green", `✅ ${file} updated successfully`);
  } else {
    log("yellow", `ℹ️  No changes needed for ${file}`);
  }
}

// ======================
// SUMMARY
// ======================
function printSummary() {
  log("bold", `\n📊 Summary`);
  log("green", `   OK:        ${stats.ok}`);
  log("blue", `   Updated:   ${stats.updated}`);
  log("yellow", `   Dead/HTTP: ${stats.dead}`);
  log("red", `   Errors:    ${stats.errors}`);
  log("gray", `   Cached:    ${stats.cached}`);
}

// ======================
// MAIN — files are processed one after another, never interleaved
// ======================
async function main() {
  log("bold", `🚀 URL Checker — ${FILES.length} file(s), one by one: ${FILES.join(", ")}`);
  if (DRY_RUN) log("yellow", "🧪 Dry run mode — no files will be written");

  for (const file of FILES) {
    await processFile(file);
  }

  if (!DRY_RUN) saveCache();

  printSummary();

  if (stats.dead > 0 || stats.errors > 0) process.exitCode = 1;
}

process.on("SIGINT", () => {
  log("yellow", "\n⚠️  Interrupted — saving cache before exit...");
  saveCache();
  process.exit(1);
});

main().catch((err) => {
  log("red", `❌ Fatal Error → ${err.message}`);
  saveCache();
  process.exit(1);
});
