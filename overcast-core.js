(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  root.OvercastCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PLUS_RE_GLOBAL = /https?:\/\/overcast\.fm\/\+[A-Za-z0-9_-]+(?:#[^\s"'<>]*)?/gi;
  const PLUS_RE_EXACT = /^https?:\/\/overcast\.fm\/\+[A-Za-z0-9_-]+(?:#[^\s"'<>]*)?$/i;

  async function findAndSaveEpisode({ pageContext, credentials, fetchImpl, logger = null }) {
    if (!credentials?.email || !credentials?.password) {
      throw new Error("Missing Overcast credentials.");
    }

    if (!pageContext) {
      throw new Error("Missing page context.");
    }

    const targetEpisodeTitle = bestEpisodeTitle(pageContext.episodeTitles);
    log(logger, `Attempting match for title: ${targetEpisodeTitle || "(none)"}`);

    await logIntoOvercast(credentials, fetchImpl);
    log(logger, "Logged into Overcast.");

    let detected = pickDirectOvercastLink(pageContext);
    if (!detected) {
      detected = await findEpisodeLinkViaSearch(pageContext, fetchImpl, logger);
    }

    if (!detected?.url) {
      throw new Error("Couldn't match this page to an Overcast episode. Try a page with a clear episode title.");
    }

    const itemID = await getEpisodeItemID(detected.url, fetchImpl);
    await saveEpisodeToAccount(itemID, fetchImpl);

    return {
      url: detected.url,
      itemID,
      source: detected.source,
      targetEpisodeTitle
    };
  }

  function collectPageContextFromHTML(pageURL, html) {
    const normalizedPageURL = String(pageURL || "").trim();
    const rawHtml = String(html || "");

    const overcastLinks = [];
    const episodeTitles = [];
    const podcastTitles = [];
    const audioURLs = [];
    const feedURLs = [];
    const applePodcastIDs = [];

    const push = (url, source, weight) => {
      if (!url) {
        return;
      }
      overcastLinks.push({ url, source, weight });
    };

    if (PLUS_RE_EXACT.test(normalizedPageURL)) {
      push(normalizedPageURL, "current-url", 100);
    }

    for (const anchor of extractTags(rawHtml, "a")) {
      const hrefValue = readAttr(anchor.attrs, "href");
      if (!hrefValue) {
        continue;
      }

      const href = resolveURL(hrefValue, normalizedPageURL);
      if (!href) {
        continue;
      }

      if (PLUS_RE_EXACT.test(href)) {
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

    for (const tagName of ["audio", "source"]) {
      for (const mediaTag of extractTags(rawHtml, tagName)) {
        const srcValue = readAttr(mediaTag.attrs, "src");
        if (!srcValue) {
          continue;
        }
        const src = resolveURL(srcValue, normalizedPageURL);
        if (src) {
          pushUnique(audioURLs, src);
        }
      }
    }

    for (const metaTag of extractTags(rawHtml, "meta")) {
      const content = readAttr(metaTag.attrs, "content") || "";
      if (!content) {
        continue;
      }

      const name = (readAttr(metaTag.attrs, "name") || "").toLowerCase();
      const property = (readAttr(metaTag.attrs, "property") || "").toLowerCase();

      if (name === "twitter:player:stream") {
        const resolved = resolveURL(content, normalizedPageURL);
        pushUnique(audioURLs, resolved || content);
      }

      if (property === "og:title" || name === "twitter:title" || name === "title") {
        pushUnique(episodeTitles, decodeHtml(content));
      }

      if (property === "og:site_name") {
        pushUnique(podcastTitles, decodeHtml(content));
      }

      const plusMatches = content.match(PLUS_RE_GLOBAL) || [];
      for (const match of plusMatches) {
        push(match, "meta", 70);
      }
    }

    const docTitle = extractTitle(rawHtml);
    const h1 = extractFirstTagText(rawHtml, "h1");
    const itempropName = extractTagAttr(rawHtml, "link", "itemprop", "name", "content");
    const itempropAuthor = extractTagAttr(rawHtml, "meta", "itemprop", "author", "content");
    pushUnique(episodeTitles, h1);
    pushUnique(episodeTitles, docTitle);
    pushUnique(podcastTitles, itempropName);
    pushUnique(podcastTitles, itempropAuthor);

    const ownerChannelName = rawHtml.match(/"ownerChannelName":"([^"]+)"/)?.[1];
    pushUnique(podcastTitles, decodeEscapedString(ownerChannelName));

    const embeddedAppleURLs = extractEscapedApplePodcastURLs(rawHtml);
    for (const appleURL of embeddedAppleURLs) {
      const idMatch = appleURL.match(/\bid(\d{5,})\b/i);
      if (idMatch?.[1]) {
        pushUnique(applePodcastIDs, idMatch[1]);
      }
    }

    for (const rawJson of extractJsonLd(rawHtml)) {
      let parsed;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        continue;
      }

      const nodes = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.["@graph"])
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
    }

    const bodyText = stripTags(rawHtml);
    const textMatches = bodyText.match(PLUS_RE_GLOBAL) || [];
    for (const match of textMatches.slice(0, 8)) {
      push(match, "text", 40);
    }

    const ranked = rankLinks(overcastLinks);
    return {
      pageURL: normalizedPageURL,
      episodeTitles,
      podcastTitles,
      audioURLs,
      feedURLs,
      applePodcastIDs,
      overcastLinks: ranked
    };
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

  async function findEpisodeLinkViaSearch(pageContext, fetchImpl, logger = null) {
    const targetEpisodeTitle = bestEpisodeTitle(pageContext.episodeTitles) || "";
    const queries = buildSearchQueries(pageContext);
    log(logger, `Search queries: ${queries.join(" | ") || "(none)"}`);

    const podcastCandidates = new Map();

    if (!queries.length) {
      return null;
    }

    for (const query of queries.slice(0, 4)) {
      const results = await searchPodcasts(query, fetchImpl);
      log(logger, `Overcast search '${query}' returned ${results.length} result(s).`);
      for (const result of results.slice(0, 6)) {
        const key = `p-${result.id}-${result.hash}`;
        const existing = podcastCandidates.get(key);
        if (!existing) {
          podcastCandidates.set(key, {
            directURL: `https://overcast.fm/p${result.id}-${result.hash}`,
            title: result.title || "search",
            query,
            queryResultCount: results.length
          });
        } else if (results.length < Number(existing.queryResultCount || Number.POSITIVE_INFINITY)) {
          existing.queryResultCount = results.length;
          existing.query = query;
        }
      }
    }

    const episodeCandidates = [];

    for (const podcast of podcastCandidates.values()) {
      const podcastURL = podcast.directURL;
      const pageResponse = await fetchImpl(podcastURL, {
        method: "GET",
        redirect: "follow"
      });

      if (!pageResponse.ok) {
        continue;
      }

      const podcastHtml = await pageResponse.text();
      const links = extractEpisodeLinksFromPodcastPage(podcastHtml);
      const isHighConfidenceCandidate = podcast.queryResultCount === 1;
      const candidatesToScore = isHighConfidenceCandidate ? links : links.slice(0, 80);
      log(logger, `Scoring ${candidatesToScore.length} episode link(s) from ${podcastURL}.`);

      for (const link of candidatesToScore) {
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
    log(logger, `Best title match: '${best.title}' (${best.score.toFixed(1)}).`);

    if (best.score < 22) {
      return null;
    }

    return {
      url: best.url,
      source: `search:${best.podcastTitle || "podcast"}`
    };
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

    const episodeTitle = bestEpisodeTitle(pageContext.episodeTitles) || "";
    for (const split of episodeTitle.split(/[|\-–—:]/)) {
      push(split);
    }

    push(episodeTitle);
    return queries;
  }

  async function searchPodcasts(query, fetchImpl) {
    const response = await fetchImpl(`https://overcast.fm/podcasts/search_autocomplete?q=${encodeURIComponent(query)}`, {
      method: "GET",
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

  async function logIntoOvercast({ email, password }, fetchImpl) {
    const body = new URLSearchParams({
      then: "podcasts",
      email,
      password
    });

    const loginResponse = await fetchImpl("https://overcast.fm/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      redirect: "follow"
    });

    if (!loginResponse.ok) {
      throw new Error(`Overcast login failed (HTTP ${loginResponse.status}).`);
    }

    const verifyResponse = await fetchImpl("https://overcast.fm/podcasts", {
      method: "GET",
      redirect: "follow"
    });

    if (!verifyResponse.ok) {
      throw new Error("Overcast login check failed.");
    }

    const verifyHtml = await verifyResponse.text();
    if (verifyHtml.includes("<h2 class=\"centertext marginbottom05\">Email-based accounts</h2>")) {
      throw new Error("Overcast rejected the credentials. Please verify email/password.");
    }
  }

  async function getEpisodeItemID(episodeUrl, fetchImpl) {
    const response = await fetchImpl(episodeUrl, {
      method: "GET",
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

  async function saveEpisodeToAccount(itemID, fetchImpl) {
    const body = new URLSearchParams({
      p: "0",
      speed: "0",
      v: "0"
    });

    const response = await fetchImpl(`https://overcast.fm/podcasts/set_progress/${encodeURIComponent(itemID)}`, {
      method: "POST",
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

  async function verifyEpisodePresence(itemID, fetchImpl, episodeURL = "") {
    if (episodeURL) {
      const episodeResponse = await fetchImpl(episodeURL, {
        method: "GET",
        redirect: "follow"
      });

      if (episodeResponse.ok) {
        const episodeHtml = await episodeResponse.text();
        const hasExistingMarker = episodeHtml.includes("existing_episode_for_user");
        const hasDeleteLink = episodeHtml.includes(`/podcasts/delete_item/${String(itemID)}`);
        if (hasExistingMarker && hasDeleteLink) {
          return {
            verified: true,
            reason: "Episode page shows it is saved in your account."
          };
        }
      }
    }

    const response = await fetchImpl("https://overcast.fm/podcasts", {
      method: "GET",
      redirect: "follow"
    });
    if (!response.ok) {
      return {
        verified: false,
        reason: `Unable to load /podcasts (HTTP ${response.status})`
      };
    }

    const html = await response.text();
    const needle = `data-item-id="${String(itemID)}"`;
    if (html.includes(needle)) {
      return {
        verified: true,
        reason: "Found saved item in /podcasts HTML."
      };
    }

    return {
      verified: false,
      reason: "Item was saved but wasn't found in /podcasts HTML snapshot."
    };
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

  function bestEpisodeTitle(list) {
    if (!Array.isArray(list)) {
      return "";
    }

    const candidates = list
      .map((v) => String(v || "").trim())
      .filter(Boolean)
      .filter((value, index, arr) => arr.indexOf(value) === index);

    candidates.sort((a, b) => scoreEpisodeTitleCandidate(b) - scoreEpisodeTitleCandidate(a));
    return candidates[0] || "";
  }

  function scoreEpisodeTitleCandidate(value) {
    const title = String(value || "").trim();
    if (!title) {
      return 0;
    }

    let score = Math.min(title.length, 180);
    if (/\s-\s*youtube$/i.test(title)) {
      score -= 45;
    }
    if (/\s\|\s*youtube$/i.test(title)) {
      score -= 35;
    }
    if (/apple podcasts?/i.test(title)) {
      score -= 20;
    }
    return score;
  }

  function extractTags(html, tagName) {
    const results = [];
    const re = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
    let match;
    while ((match = re.exec(html)) !== null) {
      results.push({
        attrs: match[1] || ""
      });
    }
    return results;
  }

  function extractFirstTagText(html, tagName) {
    const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\/${tagName}>`, "i");
    const match = html.match(re);
    if (!match?.[1]) {
      return "";
    }
    return decodeHtml(stripTags(match[1])).trim();
  }

  function extractTitle(html) {
    return extractFirstTagText(html, "title");
  }

  function extractTagAttr(html, tagName, filterAttrName, filterAttrValue, targetAttrName) {
    for (const tag of extractTags(html, tagName)) {
      const filterValue = readAttr(tag.attrs, filterAttrName).toLowerCase();
      if (filterValue === String(filterAttrValue || "").toLowerCase()) {
        return readAttr(tag.attrs, targetAttrName);
      }
    }
    return "";
  }

  function extractJsonLd(html) {
    const out = [];
    const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
      if (match[1]?.trim()) {
        out.push(match[1].trim());
      }
    }
    return out;
  }

  function extractEscapedApplePodcastURLs(html) {
    const urls = [];
    const matches = html.match(/https?:\\\/\\\/podcasts\.apple\.com[^"'<>\s]+/gi) || [];
    for (const raw of matches.slice(0, 12)) {
      const decoded = raw.replace(/\\\//g, "/");
      if (!urls.includes(decoded)) {
        urls.push(decoded);
      }
    }
    return urls;
  }

  function decodeEscapedString(value) {
    if (!value) {
      return "";
    }
    return String(value)
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\\//g, "/")
      .replace(/\\"/g, '"');
  }

  function readAttr(attrs, name) {
    const re = new RegExp(`${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
    const quoted = attrs.match(re)?.[2];
    if (quoted) {
      return decodeHtml(quoted).trim();
    }

    const bare = attrs.match(new RegExp(`${name}\\s*=\\s*([^\\s"'>]+)`, "i"))?.[1];
    return bare ? decodeHtml(bare).trim() : "";
  }

  function resolveURL(value, baseURL) {
    try {
      if (!value) {
        return null;
      }
      return new URL(value, baseURL || undefined).toString();
    } catch {
      return null;
    }
  }

  function rankLinks(overcastLinks) {
    const unique = new Map();
    for (const candidate of overcastLinks) {
      const normalized = normalizeOvercastURL(candidate.url);
      if (!normalized) {
        continue;
      }

      const existing = unique.get(normalized);
      if (!existing || candidate.weight > existing.weight) {
        unique.set(normalized, { ...candidate, url: normalized });
      }
    }

    return Array.from(unique.values()).sort((a, b) => b.weight - a.weight);
  }

  function normalizeOvercastURL(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return null;
    }
  }

  function pushUnique(arr, value) {
    if (!value || !String(value).trim()) {
      return;
    }
    const v = String(value).trim();
    if (!arr.includes(v)) {
      arr.push(v);
    }
  }

  function stripTags(value) {
    return String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
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

  function log(logger, message) {
    if (logger && typeof logger === "function") {
      logger(message);
    }
  }

  return {
    collectPageContextFromHTML,
    findAndSaveEpisode,
    verifyEpisodePresence
  };
});
