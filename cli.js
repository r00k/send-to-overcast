#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const OvercastCore = require("./overcast-core.js");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const settings = readSettings(args);
  const credentials = { email: settings.email, password: settings.password };
  if (!credentials.email || !credentials.password) {
    throw new Error(
      "Missing credentials. Set OVERCAST_EMAIL / OVERCAST_PASSWORD, pass --email / --password, or create .send-to-overcast.credentials.json"
    );
  }

  const sessionFetch = createSessionFetch(fetch);
  log(args, `Fetching target page: ${args.url}`);
  const pageResponse = await sessionFetch(args.url, { method: "GET", redirect: "follow" });
  if (!pageResponse.ok) {
    throw new Error(`Unable to load target page (HTTP ${pageResponse.status}).`);
  }

  const pageHtml = await pageResponse.text();
  const pageContext = OvercastCore.collectPageContextFromHTML(args.url, pageHtml);

  if (args.verbose) {
    console.log("Page context summary:");
    console.log(`  Episode titles: ${(pageContext.episodeTitles || []).length}`);
    console.log(`  Podcast titles: ${(pageContext.podcastTitles || []).length}`);
    console.log(`  Feed URLs: ${(pageContext.feedURLs || []).length}`);
    console.log(`  Apple podcast IDs: ${(pageContext.applePodcastIDs || []).join(", ") || "(none)"}`);
    console.log(`  Direct Overcast links: ${(pageContext.overcastLinks || []).length}`);
  }

  const anthropicApiKey = settings.anthropicApiKey;

  const startedAt = Date.now();
  const result = await OvercastCore.findAndSaveEpisode({
    pageContext,
    credentials,
    fetchImpl: sessionFetch,
    anthropicApiKey,
    logger: args.verbose ? (line) => console.log(`[trace] ${line}`) : null
  });
  const durationMs = Date.now() - startedAt;

  let verification = null;
  if (args.verify) {
    verification = await OvercastCore.verifyEpisodePresence(result.itemID, sessionFetch, result.url);
  }

  console.log("\nSaved episode in Overcast:");
  console.log(`  URL: ${result.url}`);
  console.log(`  Item ID: ${result.itemID}`);
  console.log(`  Match source: ${result.source}`);
  console.log(`  Target title: ${result.targetEpisodeTitle || "(none)"}`);
  console.log(`  Duration: ${durationMs}ms`);
  if (verification) {
    console.log(`  Verification: ${verification.verified ? "ok" : "not found"} (${verification.reason})`);
  }
}

function parseArgs(argv) {
  const out = {
    url: "",
    email: "",
    password: "",
    verify: true,
    verbose: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      out.help = true;
      continue;
    }
    if (token === "--verbose" || token === "-v") {
      out.verbose = true;
      continue;
    }
    if (token === "--no-verify") {
      out.verify = false;
      continue;
    }
    if (token === "--email") {
      out.email = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (token === "--password") {
      out.password = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (!token.startsWith("-") && !out.url) {
      out.url = token;
    }
  }

  return out;
}

function readSettings(args) {
  const filePath = path.join(process.cwd(), ".send-to-overcast.credentials.json");
  let fileCreds = {};
  if (fs.existsSync(filePath)) {
    try {
      fileCreds = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      fileCreds = {};
    }
  }

  return {
    email: String(args.email || process.env.OVERCAST_EMAIL || fileCreds.email || "").trim(),
    password: String(args.password || process.env.OVERCAST_PASSWORD || fileCreds.password || ""),
    anthropicApiKey: String(process.env.ANTHROPIC_API_KEY || fileCreds.anthropicApiKey || "").trim()
  };
}

function createSessionFetch(baseFetch) {
  const cookieJar = [];
  const maxRedirects = 10;

  return async function sessionFetch(input, init = {}) {
    let url = new URL(typeof input === "string" ? input : input.url);
    let method = String(init.method || "GET").toUpperCase();
    let body = init.body;
    let redirects = 0;

    while (true) {
      const headers = new Headers(init.headers || {});
      const cookieHeader = getCookieHeader(cookieJar, url);
      if (cookieHeader && !headers.has("cookie")) {
        headers.set("cookie", cookieHeader);
      }

      const response = await baseFetch(url.toString(), {
        ...init,
        method,
        body,
        headers,
        redirect: "manual"
      });

      const setCookies = getSetCookies(response.headers);
      for (const raw of setCookies) {
        upsertCookie(cookieJar, raw, url.hostname);
      }

      const location = response.headers.get("location");
      const isRedirect = response.status >= 300 && response.status < 400 && Boolean(location);
      if (!isRedirect || init.redirect === "manual") {
        return response;
      }

      redirects += 1;
      if (redirects > maxRedirects) {
        throw new Error(`Too many redirects while requesting ${url.toString()}`);
      }

      url = new URL(location, url);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
    }
  };
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function upsertCookie(cookieJar, rawSetCookie, fallbackHost) {
  const parts = String(rawSetCookie || "").split(";").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || !parts[0].includes("=")) {
    return;
  }

  const [namePart, ...valueParts] = parts[0].split("=");
  const name = namePart.trim();
  const value = valueParts.join("=").trim();
  if (!name) {
    return;
  }

  const cookie = {
    name,
    value,
    domain: fallbackHost,
    path: "/",
    secure: false,
    expiresAt: null
  };

  for (const attr of parts.slice(1)) {
    const [rawKey, ...rawValue] = attr.split("=");
    const key = rawKey.trim().toLowerCase();
    const attrValue = rawValue.join("=").trim();

    if (key === "domain" && attrValue) {
      cookie.domain = attrValue.replace(/^\./, "").toLowerCase();
    } else if (key === "path" && attrValue) {
      cookie.path = attrValue;
    } else if (key === "secure") {
      cookie.secure = true;
    } else if (key === "max-age") {
      const seconds = Number(attrValue);
      if (Number.isFinite(seconds)) {
        cookie.expiresAt = Date.now() + seconds * 1000;
      }
    } else if (key === "expires") {
      const ts = Date.parse(attrValue);
      if (!Number.isNaN(ts)) {
        cookie.expiresAt = ts;
      }
    }
  }

  const existingIndex = cookieJar.findIndex((c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path);
  if (existingIndex >= 0) {
    cookieJar[existingIndex] = cookie;
  } else {
    cookieJar.push(cookie);
  }
}

function getCookieHeader(cookieJar, url) {
  const now = Date.now();
  const host = url.hostname.toLowerCase();
  const pathName = url.pathname || "/";

  const cookies = cookieJar
    .filter((cookie) => {
      if (cookie.expiresAt && cookie.expiresAt <= now) {
        return false;
      }
      if (cookie.secure && url.protocol !== "https:") {
        return false;
      }
      if (!(host === cookie.domain || host.endsWith(`.${cookie.domain}`))) {
        return false;
      }
      if (!pathName.startsWith(cookie.path)) {
        return false;
      }
      return true;
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`);

  return cookies.join("; ");
}

function log(args, line) {
  if (args.verbose) {
    console.log(`[info] ${line}`);
  }
}

function printHelp() {
  console.log(`Usage:
  node cli.js <episode-page-url> [--email EMAIL --password PASSWORD] [--verbose] [--no-verify]

Credentials are loaded in this order:
  1) --email / --password
  2) OVERCAST_EMAIL / OVERCAST_PASSWORD environment variables
  3) .send-to-overcast.credentials.json in the current working directory

Example:
  node cli.js "https://elgl.org/podcast-past-future-of-transparency-with-tom-spengler-rock-solid-technologies/" --verbose
`);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
