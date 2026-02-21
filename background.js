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

      const settings = await getSettings();
      if (!settings.email || !settings.password) {
        throw new Error("Missing Overcast credentials. Open extension options to set them.");
      }

      const pageContext = await collectPageContext(tab.id);
      if (!pageContext) {
        throw new Error("Unable to read this page. Reload and try again.");
      }

      const result = await OvercastCore.findAndSaveEpisode({
        pageContext,
        credentials: { email: settings.email, password: settings.password },
        anthropicApiKey: settings.anthropicApiKey,
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

async function getSettings() {
  const result = await chrome.storage.local.get(["overcastEmail", "overcastPassword", "anthropicApiKey"]);
  return {
    email: String(result.overcastEmail || "").trim(),
    password: String(result.overcastPassword || ""),
    anthropicApiKey: String(result.anthropicApiKey || "").trim()
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
      const ownerChannelNameRaw = htmlSnapshot.match(/"ownerChannelName":"([^"]+)"/)?.[1] || "";
      const ownerChannelName = ownerChannelNameRaw
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "")
        .replace(/\\\//g, "/")
        .replace(/\\"/g, '"');
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
