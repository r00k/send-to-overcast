const test = require("node:test");
const assert = require("node:assert/strict");
const OvercastCore = require("../overcast-core.js");

test("bestEpisodeTitle prefers non-YouTube-suffixed title", () => {
  const chosen = OvercastCore.__test.bestEpisodeTitle([
    "Turning Air, Water, and Sunlight into Natural Gas: Casey Handmer's Vision for Sustainable Energy - YouTube",
    "Turning Air, Water, and Sunlight into Natural Gas: Casey Handmer's Vision for Sustainable Energy"
  ]);

  assert.equal(
    chosen,
    "Turning Air, Water, and Sunlight into Natural Gas: Casey Handmer's Vision for Sustainable Energy"
  );
});

test("buildSearchQueries prioritizes strong show/episode phrases and drops generic terms", () => {
  const queries = OvercastCore.__test.buildSearchQueries({
    podcastTitles: ["YouTube", "Hardware to Save a Planet", "Synapse"],
    feedURLs: [],
    episodeTitles: [
      "Turning Air, Water, and Sunlight into Natural Gas: Casey Handmer's Vision for Sustainable Energy"
    ]
  });

  assert.ok(queries.includes("Hardware to Save a Planet"));
  assert.ok(queries.includes("Turning Air, Water, and Sunlight into Natural Gas"));
  assert.ok(queries.includes("Casey Handmer's Vision for Sustainable Energy"));
  assert.ok(!queries.includes("YouTube"));
});

test("collectPageContextFromHTML pulls YouTube owner and show hint from shortDescription", () => {
  const html = `
    <html>
      <head>
        <meta name="title" content="Turning Air, Water, and Sunlight into Natural Gas: Casey Handmer's Vision for Sustainable Energy" />
        <script>
          var data = {"ownerChannelName":"Synapse","shortDescription":"Tune in to Hardware to Save a Planet, where Dylan Garrett sits down with Casey Handmer."};
        </script>
      </head>
      <body></body>
    </html>
  `;

  const context = OvercastCore.collectPageContextFromHTML("https://www.youtube.com/watch?v=abc123", html);

  assert.ok(context.podcastTitles.includes("Synapse"));
  assert.ok(context.podcastTitles.includes("Hardware to Save a Planet"));
  assert.ok(context.episodeTitles.some((title) => title.includes("Turning Air, Water")));
});
