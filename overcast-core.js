(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  root.OvercastCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PLUS_RE_GLOBAL = /https?:\/\/overcast\.fm\/\+[A-Za-z0-9_-]+(?:#[^\s"'<>]*)?/gi;
  const PLUS_RE_EXACT = /^https?:\/\/overcast\.fm\/\+[A-Za-z0-9_-]+(?:#[^\s"'<>]*)?$/i;
  const MAX_SEARCH_QUERIES = 3;
  const MAX_RESULTS_PER_QUERY = 4;
  const MAX_PODCAST_PAGE_FETCHES = 3;

  async function findAndSaveEpisode({ pageContext, credentials, fetchImpl, anthropicApiKey = "", logger = null }) {
    if (!credentials?.email || !credentials?.password) {
      throw new Error("Missing Overcast credentials.");
    }

    if (!pageContext) {
      throw new Error("Missing page context.");
    }

    let llmEpisodeTitle = "";
    if (anthropicApiKey) {
      const llmResult = await extractPodcastInfoViaLLM(pageContext, anthropicApiKey, fetchImpl, logger);
      if (llmResult) {
        if (llmResult.episodeTitle) {
          llmEpisodeTitle = llmResult.episodeTitle;
          pageContext.episodeTitles.unshift(llmResult.episodeTitle);
        }
        if (llmResult.podcastName) {
          pageContext.podcastTitles.unshift(llmResult.podcastName);
        }
      }
    }

    const targetEpisodeTitle = llmEpisodeTitle || bestEpisodeTitle(pageContext.episodeTitles);
    log(logger, `Attempting match for title: ${targetEpisodeTitle || "(none)"}`);

    await logIntoOvercast(credentials, fetchImpl);
    log(logger, "Logged into Overcast.");

    let detected = pickDirectOvercastLink(pageContext);
    if (!detected) {
      detected = await findEpisodeLinkViaSearch(pageContext, targetEpisodeTitle, fetchImpl, logger);
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

    const shortDescriptionRaw = extractEmbeddedJSONField(rawHtml, "shortDescription");
    const shortDescription = decodeEscapedString(shortDescriptionRaw);
    if (shortDescription) {
      const firstLine = shortDescription.split(/\n+/).map((line) => line.trim()).filter(Boolean)[0] || "";
      pushUnique(episodeTitles, firstLine);

      const tunedInShow = shortDescription.match(/tune\s+in\s+to\s+([^,\n.!?]{3,120})/i)?.[1];
      pushUnique(podcastTitles, tunedInShow);

      const podcastNamed = shortDescription.match(/(?:podcast|show)\s*[:\-]\s*([^\n]{3,120})/i)?.[1];
      pushUnique(podcastTitles, podcastNamed);
    }

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

  async function findEpisodeLinkViaSearch(pageContext, targetEpisodeTitle, fetchImpl, logger = null) {
    if (!targetEpisodeTitle) {
      targetEpisodeTitle = bestEpisodeTitle(pageContext.episodeTitles) || "";
    }
    const queries = buildSearchQueries(pageContext);
    log(logger, `Search queries: ${queries.join(" | ") || "(none)"}`);

    const podcastCandidates = new Map();

    if (!queries.length) {
      return null;
    }

    for (const query of queries.slice(0, MAX_SEARCH_QUERIES)) {
      const results = await searchPodcasts(query, fetchImpl);
      log(logger, `Overcast search '${query}' returned ${results.length} result(s).`);
      for (const result of results.slice(0, MAX_RESULTS_PER_QUERY)) {
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
    const orderedPodcastCandidates = Array.from(podcastCandidates.values())
      .sort((a, b) => {
        const aCount = Number(a.queryResultCount || Number.POSITIVE_INFINITY);
        const bCount = Number(b.queryResultCount || Number.POSITIVE_INFINITY);
        if (aCount !== bCount) {
          return aCount - bCount;
        }
        return String(a.title || "").localeCompare(String(b.title || ""));
      })
      .slice(0, MAX_PODCAST_PAGE_FETCHES);

    for (const podcast of orderedPodcastCandidates) {
      const podcastURL = podcast.directURL;
      const pageResponse = await fetchImpl(podcastURL, {
        method: "GET",
        redirect: "follow"
      });

      if (pageResponse.status === 429) {
        throw new Error("Overcast is rate-limiting requests right now. Please wait a minute and try again.");
      }

      if (!pageResponse.ok) {
        continue;
      }

      const podcastHtml = await pageResponse.text();
      const links = extractEpisodeLinksFromPodcastPage(podcastHtml);
      const isHighConfidenceCandidate = podcast.queryResultCount === 1;
      const candidatesToScore = isHighConfidenceCandidate ? links.slice(0, 180) : links.slice(0, 50);
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

        if (score >= 105) {
          log(logger, `Accepting high-confidence exact match: '${link.title}'.`);
          return {
            url: link.url,
            source: `search:${podcast.title || "podcast"}`
          };
        }
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
    const queryScores = new Map();
    const push = (value, boost = 0) => {
      if (!value) {
        return;
      }
      const compact = String(value).trim().replace(/\s+/g, " ");
      if (!compact || compact.length < 3) {
        return;
      }
      const key = compact.toLowerCase();
      const baseScore = scoreSearchQuery(compact);
      if (baseScore <= 0) {
        return;
      }
      const score = baseScore + boost;
      const existing = queryScores.get(key);
      if (!existing || score > existing.score) {
        queryScores.set(key, { value: compact, score });
      }
    };

    for (const p of pageContext.podcastTitles || []) {
      push(p, 100);
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

    return Array.from(queryScores.values())
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.value);
  }

  function scoreSearchQuery(value) {
    const text = String(value || "").trim();
    if (!text) {
      return 0;
    }

    const lower = text.toLowerCase();
    const genericTerms = new Set(["youtube", "podcast", "episode", "apple podcasts", "spotify"]);
    if (genericTerms.has(lower)) {
      return 0;
    }

    let score = Math.min(text.length, 80);
    if (/\b(youtube|apple podcasts?|spotify)\b/i.test(text)) {
      score -= 25;
    }
    if (/[:|\-]/.test(text)) {
      score += 10;
    }
    if (/\b(with|feat\.?|featuring|vision|interview)\b/i.test(text)) {
      score += 8;
    }

    return score;
  }

  async function searchPodcasts(query, fetchImpl) {
    const response = await fetchImpl(`https://overcast.fm/podcasts/search_autocomplete?q=${encodeURIComponent(query)}`, {
      method: "GET",
      redirect: "follow"
    });

    if (response.status === 429) {
      throw new Error("Overcast is rate-limiting requests right now. Please wait a minute and try again.");
    }

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

  function extractEmbeddedJSONField(html, fieldName) {
    const escapedField = String(fieldName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`"${escapedField}":"([\\s\\S]*?)"(?:,|})`, "i");
    return html.match(re)?.[1] || "";
  }

  function decodeEscapedString(value) {
    if (!value) {
      return "";
    }
    return String(value)
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
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

  async function extractPodcastInfoViaLLM(pageContext, apiKey, fetchImpl, logger = null) {
    const prompt = [
      "Given the following metadata from a web page, identify the podcast name and episode title.",
      "If this page is not about a podcast episode, return your best guess based on the content.",
      "",
      "IMPORTANT: On YouTube, the channel name is often different from the podcast name. The podcast",
      "name is usually mentioned in the video description (e.g. as a playlist or show name). Look there first.",
      "",
      `Page URL: ${pageContext.pageURL || "(unknown)"}`,
      "",
      "Episode title candidates:",
      ...(pageContext.episodeTitles || []).map((t) => `  - ${t}`),
      "",
      "Podcast/channel title candidates:",
      ...(pageContext.podcastTitles || []).map((t) => `  - ${t}`),
      "",
      'Respond with ONLY a JSON object: {"podcastName": "...", "episodeTitle": "..."}',
      "Use empty strings if you cannot determine a value."
    ].join("\n");

    try {
      const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 150,
          messages: [{ role: "user", content: prompt }]
        })
      });

      if (!response.ok) {
        log(logger, `LLM request failed (HTTP ${response.status}).`);
        return null;
      }

      const data = await response.json();
      const text = data?.content?.[0]?.text || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log(logger, "LLM response did not contain JSON.");
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      log(logger, `LLM extracted podcast: '${parsed.podcastName || ""}', episode: '${parsed.episodeTitle || ""}'.`);
      return {
        podcastName: String(parsed.podcastName || "").trim(),
        episodeTitle: String(parsed.episodeTitle || "").trim()
      };
    } catch (error) {
      log(logger, `LLM extraction failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  function log(logger, message) {
    if (logger && typeof logger === "function") {
      logger(message);
    }
  }

  return {
    collectPageContextFromHTML,
    findAndSaveEpisode,
    verifyEpisodePresence,
    __test: {
      buildSearchQueries,
      bestEpisodeTitle,
      scoreEpisodeTitleMatch,
      scoreSearchQuery
    }
  };
});
