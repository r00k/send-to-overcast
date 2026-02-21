importScripts("overcast-core.js");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "send-current-tab-to-overcast") {
    return false;
  }

  (async () => {
    try {
      const tab = await getActiveTab();
      if (!tab?.id) {
        throw new Error("No active tab found.");
      }

      const credentials = await getCredentials();
      if (!credentials.email || !credentials.password) {
        throw new Error("Missing Overcast credentials. Open extension options to set them.");
      }

      const pageContext = await collectPageContext(tab.id);
      if (!pageContext) {
        throw new Error("Unable to read this page. Reload and try again.");
      }

      const result = await OvercastCore.findAndSaveEpisode({
        pageContext,
        credentials,
        fetchImpl: (url, init = {}) => fetch(url, {
          ...init,
          credentials: "include"
        })
      });

      sendResponse({
        ok: true,
        url: result.url,
        itemID: result.itemID,
        source: result.source
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();

  return true;
});

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function getCredentials() {
  const result = await chrome.storage.local.get(["overcastEmail", "overcastPassword"]);
  return {
    email: String(result.overcastEmail || "").trim(),
    password: String(result.overcastPassword || "")
  };
}

async function collectPageContext(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const plusReGlobal = /https?:\/\/overcast\.fm\/\+[A-Za-z0-9_-]+(?:#[^\s"'<>]*)?/gi;
      const plusReExact = /^https?:\/\/overcast\.fm\/\+[A-Za-z0-9_-]+(?:#[^\s"'<>]*)?$/i;

      function normalize(url) {
        try {
          const parsed = new URL(url);
          parsed.hash = "";
          return parsed.toString();
        } catch {
          return null;
        }
      }

      const overcastLinks = [];
      const episodeTitles = [];
      const podcastTitles = [];
      const audioURLs = [];
      const feedURLs = [];
      const applePodcastIDs = [];

      const pushUnique = (arr, value) => {
        if (!value || !String(value).trim()) {
          return;
        }
        const v = String(value).trim();
        if (!arr.includes(v)) {
          arr.push(v);
        }
      };

      const push = (url, source, weight) => {
        if (!url) {
          return;
        }
        overcastLinks.push({ url, source, weight });
      };

      if (plusReExact.test(location.href)) {
        push(location.href, "current-url", 100);
      }

      for (const anchor of document.querySelectorAll("a[href]")) {
        const href = anchor.href;
        if (plusReExact.test(href)) {
          push(href, "anchor", 90);
        }

        const hrefLower = href.toLowerCase();
        if (hrefLower.includes("podcasts.apple.com") || hrefLower.includes("itunes.apple.com")) {
          const idMatch = href.match(/\bid(\d{5,})\b/i);
          if (idMatch?.[1]) {
            pushUnique(applePodcastIDs, idMatch[1]);
          }
        }

        if (hrefLower.includes("/rss") || hrefLower.includes("feed") || hrefLower.endsWith(".xml")) {
          pushUnique(feedURLs, href);
        }
      }

      for (const audio of document.querySelectorAll("audio[src], source[src]")) {
        try {
          const src = audio.src || audio.getAttribute("src");
          if (src) {
            pushUnique(audioURLs, new URL(src, location.href).toString());
          }
        } catch {
          // ignore URL parsing errors
        }
      }

      const twStream = document.querySelector('meta[name="twitter:player:stream"]')?.getAttribute("content");
      if (twStream) {
        pushUnique(audioURLs, twStream);
      }

      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
      const twTitle = document.querySelector('meta[name="twitter:title"]')?.getAttribute("content");
      const metaTitle = document.querySelector('meta[name="title"]')?.getAttribute("content");
      const siteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
      const itempropName = document.querySelector('link[itemprop="name"]')?.getAttribute("content");
      const itempropAuthor = document.querySelector('[itemprop="author"]')?.getAttribute("content");
      const h1 = document.querySelector("h1")?.textContent;
      pushUnique(episodeTitles, ogTitle);
      pushUnique(episodeTitles, twTitle);
      pushUnique(episodeTitles, metaTitle);
      pushUnique(episodeTitles, h1);
      pushUnique(episodeTitles, document.title);
      pushUnique(podcastTitles, siteName);
      pushUnique(podcastTitles, itempropName);
      pushUnique(podcastTitles, itempropAuthor);

      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        const raw = script.textContent || "";
        if (!raw.trim()) {
          continue;
        }

        try {
          const parsed = JSON.parse(raw);
          const nodes = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed["@graph"])
              ? parsed["@graph"]
              : [parsed];

          for (const node of nodes) {
            if (!node || typeof node !== "object") {
              continue;
            }

            const typeRaw = node["@type"];
            const types = Array.isArray(typeRaw) ? typeRaw : [typeRaw];
            const typeJoined = types.filter(Boolean).join(" ").toLowerCase();

            if (typeJoined.includes("episode")) {
              pushUnique(episodeTitles, node.name);
              pushUnique(episodeTitles, node.headline);
              if (node.partOfSeries && typeof node.partOfSeries === "object") {
                pushUnique(podcastTitles, node.partOfSeries.name);
              }
            }

            if (typeJoined.includes("podcastseries") || typeJoined.includes("podcastshow") || typeJoined === "podcastseries") {
              pushUnique(podcastTitles, node.name);
            }
          }
        } catch {
          // ignore malformed JSON-LD
        }
      }

      for (const meta of document.querySelectorAll("meta[content]")) {
        const content = meta.getAttribute("content") || "";
        const matches = content.match(plusReGlobal) || [];
        for (const match of matches) {
          push(match, "meta", 70);
        }
      }

      const bodyText = document.body?.innerText || "";
      const textMatches = bodyText.match(plusReGlobal) || [];
      for (const match of textMatches.slice(0, 8)) {
        push(match, "text", 40);
      }

      // Some pages (especially YouTube) keep useful links and channel names in embedded JSON.
      const htmlSnapshot = document.documentElement?.innerHTML || "";
      const ownerChannelName = htmlSnapshot.match(/"ownerChannelName":"([^"]+)"/)?.[1];
      pushUnique(podcastTitles, ownerChannelName);

      const shortDescriptionRaw = htmlSnapshot.match(/"shortDescription":"([\s\S]*?)"(?:,|})/i)?.[1] || "";
      const shortDescription = shortDescriptionRaw
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "")
        .replace(/\\\//g, "/")
        .replace(/\\"/g, '"');

      if (shortDescription) {
        const firstLine = shortDescription.split(/\n+/).map((line) => line.trim()).filter(Boolean)[0] || "";
        pushUnique(episodeTitles, firstLine);

        const tunedInShow = shortDescription.match(/tune\s+in\s+to\s+([^,\n.!?]{3,120})/i)?.[1];
        pushUnique(podcastTitles, tunedInShow);

        const podcastNamed = shortDescription.match(/(?:podcast|show)\s*[:\-]\s*([^\n]{3,120})/i)?.[1];
        pushUnique(podcastTitles, podcastNamed);
      }

      const appleURLMatches = htmlSnapshot.match(/https?:\\\/\\\/podcasts\.apple\.com[^"'<>\s]+/gi) || [];
      for (const rawMatch of appleURLMatches.slice(0, 10)) {
        const decodedURL = rawMatch.replace(/\\\//g, "/");
        const idMatch = decodedURL.match(/\bid(\d{5,})\b/i);
        if (idMatch?.[1]) {
          pushUnique(applePodcastIDs, idMatch[1]);
        }
      }

      const unique = new Map();
      for (const candidate of overcastLinks) {
        const normalized = normalize(candidate.url);
        if (!normalized) {
          continue;
        }

        const existing = unique.get(normalized);
        if (!existing || candidate.weight > existing.weight) {
          unique.set(normalized, { ...candidate, url: normalized });
        }
      }

      const ranked = Array.from(unique.values()).sort((a, b) => b.weight - a.weight);
      return {
        pageURL: location.href,
        episodeTitles,
        podcastTitles,
        audioURLs,
        feedURLs,
        applePodcastIDs,
        overcastLinks: ranked
      };
    }
  });

  return result?.result || null;
}

function pickDirectOvercastLink(pageContext) {
  if (!pageContext?.overcastLinks?.length) {
    return null;
  }

  return {
    url: pageContext.overcastLinks[0].url,
    source: `direct-${pageContext.overcastLinks[0].source}`
  };
}

async function findEpisodeLinkViaSearch(pageContext) {
  const targetEpisodeTitle = bestValue(pageContext.episodeTitles) || "";
  const queries = buildSearchQueries(pageContext);
  const directPodcastURLs = buildDirectPodcastURLs(pageContext);

  const podcastCandidates = new Map();

  for (const url of directPodcastURLs) {
    podcastCandidates.set(url, { directURL: url, title: "direct" });
  }

  if (!queries.length && !podcastCandidates.size) {
    return null;
  }

  for (const query of queries.slice(0, 4)) {
    const results = await searchPodcasts(query);
    for (const result of results.slice(0, 6)) {
      const key = `p-${result.id}-${result.hash}`;
      if (!podcastCandidates.has(key)) {
        podcastCandidates.set(key, {
          directURL: `https://overcast.fm/p${result.id}-${result.hash}`,
          title: result.title || "search"
        });
      }
    }
  }

  const episodeCandidates = [];

  for (const podcast of podcastCandidates.values()) {
    const podcastURL = podcast.directURL;
    const pageResponse = await fetch(podcastURL, {
      method: "GET",
      credentials: "include",
      redirect: "follow"
    });

    if (!pageResponse.ok) {
      continue;
    }

    const podcastHtml = await pageResponse.text();
    const links = extractEpisodeLinksFromPodcastPage(podcastHtml);

    for (const link of links.slice(0, 25)) {
      const score = scoreEpisodeTitleMatch(targetEpisodeTitle, link.title);
      if (score <= 0) {
        continue;
      }

      episodeCandidates.push({
        ...link,
        score,
        podcastTitle: podcast.title,
        podcastURL
      });
    }
  }

  if (!episodeCandidates.length) {
    return null;
  }

  episodeCandidates.sort((a, b) => b.score - a.score);
  const best = episodeCandidates[0];

  if (best.score < 22) {
    return null;
  }

  return {
    url: best.url,
    source: `search:${best.podcastTitle || "podcast"}`
  };
}

function buildDirectPodcastURLs(pageContext) {
  const out = [];
  const push = (value) => {
    if (!value || out.includes(value)) {
      return;
    }
    out.push(value);
  };

  for (const id of pageContext.applePodcastIDs || []) {
    push(`https://overcast.fm/itunes${id}`);
  }

  return out;
}

function buildSearchQueries(pageContext) {
  const queries = [];
  const push = (value) => {
    if (!value) {
      return;
    }
    const compact = String(value).trim().replace(/\s+/g, " ");
    if (!compact || compact.length < 3) {
      return;
    }
    if (!queries.includes(compact)) {
      queries.push(compact);
    }
  };

  for (const p of pageContext.podcastTitles || []) {
    push(p);
  }

  for (const feedURL of pageContext.feedURLs || []) {
    try {
      const host = new URL(feedURL).hostname.replace(/^www\./, "");
      push(host.split(".")[0]);
    } catch {
      // ignore URL parsing issues
    }
  }

  const episodeTitle = bestValue(pageContext.episodeTitles) || "";
  for (const split of episodeTitle.split(/[|\-–—:]/)) {
    push(split);
  }

  push(episodeTitle);
  return queries;
}

async function searchPodcasts(query) {
  const response = await fetch(`https://overcast.fm/podcasts/search_autocomplete?q=${encodeURIComponent(query)}`, {
    method: "GET",
    credentials: "include",
    redirect: "follow"
  });

  if (!response.ok) {
    return [];
  }

  const text = await response.text();
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch {
    return [];
  }

  return Array.isArray(decoded?.results) ? decoded.results : [];
}

function extractEpisodeLinksFromPodcastPage(html) {
  const matches = [];
  const re = /<a[^>]+href="(\/\+[A-Za-z0-9_-]+(?:#[^"]*)?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = match[1];
    const inner = stripTags(match[2]);
    const title = decodeHtml(inner).trim();
    if (!title) {
      continue;
    }

    matches.push({
      url: `https://overcast.fm${href.split("#")[0]}`,
      title
    });
  }

  const deduped = new Map();
  for (const m of matches) {
    if (!deduped.has(m.url)) {
      deduped.set(m.url, m);
    }
  }

  return Array.from(deduped.values());
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function scoreEpisodeTitleMatch(targetRaw, candidateRaw) {
  const target = normalizeTitle(targetRaw);
  const candidate = normalizeTitle(candidateRaw);
  if (!target || !candidate) {
    return 0;
  }

  if (target === candidate) {
    return 120;
  }

  let score = 0;
  if (target.includes(candidate) || candidate.includes(target)) {
    score += 35;
  }

  const targetTokens = new Set(target.split(" ").filter(Boolean));
  const candidateTokens = new Set(candidate.split(" ").filter(Boolean));
  if (!targetTokens.size || !candidateTokens.size) {
    return score;
  }

  let overlap = 0;
  for (const token of targetTokens) {
    if (candidateTokens.has(token)) {
      overlap += 1;
    }
  }

  const overlapRatio = overlap / Math.max(targetTokens.size, candidateTokens.size);
  score += overlapRatio * 100;
  return score;
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bestValue(list) {
  if (!Array.isArray(list)) {
    return "";
  }

  return list
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || "";
}

async function logIntoOvercast({ email, password }) {
  const body = new URLSearchParams({
    then: "podcasts",
    email,
    password
  });

  const loginResponse = await fetch("https://overcast.fm/login", {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: body.toString(),
    redirect: "follow"
  });

  if (!loginResponse.ok) {
    throw new Error(`Overcast login failed (HTTP ${loginResponse.status}).`);
  }

  const verifyResponse = await fetch("https://overcast.fm/podcasts", {
    method: "GET",
    credentials: "include",
    redirect: "follow"
  });

  if (!verifyResponse.ok) {
    throw new Error("Overcast login check failed.");
  }

  const verifyHtml = await verifyResponse.text();
  if (verifyHtml.includes("<h2 class=\"centertext marginbottom05\">Email-based accounts</h2>")) {
    throw new Error("Overcast rejected the credentials. Please verify email/password in extension options.");
  }
}

async function getEpisodeItemID(episodeUrl) {
  const response = await fetch(episodeUrl, {
    method: "GET",
    credentials: "include",
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Failed to open episode link (HTTP ${response.status}).`);
  }

  const html = await response.text();

  const byDataAttr = html.match(/data-item-id="(\d+)"/i)?.[1];
  if (byDataAttr) {
    return byDataAttr;
  }

  const byAppUrl = html.match(/overcast:\/\/\/(\d+)/i)?.[1];
  if (byAppUrl) {
    return byAppUrl;
  }

  throw new Error("Couldn't extract the Overcast episode ID from the detected link.");
}

async function saveEpisodeToAccount(itemID) {
  const body = new URLSearchParams({
    p: "0",
    speed: "0",
    v: "0"
  });

  const response = await fetch(`https://overcast.fm/podcasts/set_progress/${encodeURIComponent(itemID)}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  if (!response.ok) {
    throw new Error(`Failed to save episode in Overcast (HTTP ${response.status}).`);
  }

  const text = (await response.text()).trim();
  if (text && Number.isNaN(Number(text))) {
    throw new Error(`Unexpected Overcast response while saving: ${text.slice(0, 120)}`);
  }
}
