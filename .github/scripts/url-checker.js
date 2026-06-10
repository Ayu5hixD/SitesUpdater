const fs = require("fs");
const path = require("path");
const axios = require("axios");

const FILE_PATH = "urls.json";
const CACHE_FILE = ".url-cache.json";

// ======================
// CONFIG
// ======================
const TIMEOUT = 10000;
const MAX_RETRIES = 3;
const CONCURRENCY = 5;

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
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
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

// ======================
// FILE HELPERS
// ======================
function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function createBackup() {
  if (!fs.existsSync(FILE_PATH)) return;

  const backupName = `urls-backup-${Date.now()}.json`;
  fs.copyFileSync(FILE_PATH, backupName);

  log("cyan", `🗂 Backup created → ${backupName}`);
}

// ======================
// URL HELPERS
// ======================
function getDomain(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function preserveSlash(oldUrl, newUrl) {
  return oldUrl.endsWith("/") ? `${newUrl}/` : newUrl;
}

function resolveRedirect(base, location) {
  try {
    return new URL(location, base).toString();
  } catch {
    return location;
  }
}

// ======================
// CACHE
// ======================
const cache = readJson(CACHE_FILE, {});

function getCached(url) {
  return cache[url] || null;
}

function setCache(url, result) {
  cache[url] = {
    result,
    timestamp: Date.now(),
  };
}

// ======================
// REQUEST WITH RETRY
// ======================
async function request(url, method = "HEAD") {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client({
        url,
        method,
        headers: {
          Referer: url,
          Origin: getDomain(url),
        },
      });

      return response;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        return { error: err };
      }

      log("yellow", `🔁 Retry ${attempt}/${MAX_RETRIES - 1} → ${url}`);

      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ======================
// CHECK URL
// ======================
async function checkUrl(url) {
  // CACHE HIT
  const cached = getCached(url);

  if (cached) {
    log("gray", `⚡ Cache hit → ${url}`);
    return cached.result;
  }

  const redirectChain = [];

  let response = await request(url, "HEAD");

  // Fallback to GET
  if (response.error) {
    response = await request(url, "GET");
  }

  // COMPLETE FAILURE
  if (response.error) {
    const err = response.error;

    if (err.code === "ECONNABORTED") {
      log("yellow", `⌛ Timeout → ${url}`);
    } else if (err.code === "ENOTFOUND") {
      log("red", `❌ Domain not found → ${url}`);
    } else {
      log("red", `❌ ${url} → ${err.message}`);
    }

    // Put same URL back
    setCache(url, url);

    return url;
  }

  const status = response.status;

  // SUCCESS
  if (status >= 200 && status < 300) {
    log("green", `✅ OK → ${url}`);

    setCache(url, url);

    return url;
  }

  // REDIRECT
  if (status >= 300 && status < 400) {
    const location = response.headers.location;

    if (!location) {
      log("yellow", `⚠️ Redirect without location → ${url}`);

      setCache(url, url);

      return url;
    }

    const redirectedUrl = resolveRedirect(url, location);

    redirectChain.push(redirectedUrl);

    log("blue", `🔄 Redirect Found`);
    log("gray", `   ${url}`);
    log("gray", `   ↳ ${redirectedUrl}`);

    const newDomain = getDomain(redirectedUrl);

    const finalUrl = preserveSlash(url, newDomain);

    log("cyan", `🌐 Final Domain → ${finalUrl}`);

    // Redirect chain tracking
    if (redirectChain.length) {
      log("gray", `📌 Redirect Chain:`);

      redirectChain.forEach((r, i) => {
        log("gray", `   ${i + 1}. ${r}`);
      });
    }

    setCache(url, finalUrl);

    return finalUrl;
  }

  log("yellow", `⚠️ HTTP ${status} → ${url}`);

  // Keep same URL if dead
  setCache(url, url);

  return url;
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

  const workers = Array.from({ length: limit }, worker);

  await Promise.all(workers);

  return results;
}

// ======================
// MAIN
// ======================
async function main() {
  const providers = readJson(FILE_PATH);

  createBackup();

  let changed = false;

  const tasks = Object.entries(providers).map(([name, url]) => {
    return async () => {
      log("cyan", `\n🔍 Checking ${name}`);

      try {
        const newUrl = await checkUrl(url);

        // Always keep some URL
        providers[name] = newUrl || url;

        if (newUrl && newUrl !== url) {
          changed = true;

          log("green", `✅ Updated ${name}`);
          log("gray", `   OLD → ${url}`);
          log("gray", `   NEW → ${newUrl}`);
        }
      } catch (err) {
        log("red", `❌ Failed ${name} → ${err.message}`);

        // Keep original URL
        providers[name] = url;
      }
    };
  });

  await runConcurrent(tasks, CONCURRENCY);

  // Save updated urls.json
  writeJson(FILE_PATH, providers);

  // Save cache
  writeJson(CACHE_FILE, cache);

  if (changed) {
    log("green", `\n✅ ${FILE_PATH} updated successfully`);
  } else {
    log("yellow", `\nℹ️ No changes needed`);
  }

  log("cyan", `💾 Cache saved → ${CACHE_FILE}`);
}

main().catch((err) => {
  log("red", `❌ Fatal Error → ${err.message}`);
});
