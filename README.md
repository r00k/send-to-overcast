# Send to Overcast

One-click Chrome extension (plus CLI harness) for saving podcast episodes to Overcast from arbitrary episode pages.

## What it does

- Extracts episode context from any podcast page (title, metadata, JSON-LD, feed hints, Apple podcast links).
- Logs into Overcast using your stored credentials.
- Finds the best Overcast episode match.
- Saves that matched episode to your Overcast account.

## Project files

- `background.js`: MV3 service worker entrypoint.
- `popup.*`: extension popup UI.
- `options.*`: credential settings UI.
- `overcast-core.js`: shared matching + save logic (used by both extension and CLI).
- `cli.js`: command-line runner for end-to-end testing.

## Chrome setup

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Open extension **Options** and enter Overcast email/password.

If you already loaded the extension before code changes, click **Reload** on the extension card.

## Using the extension

1. Open a podcast episode page.
2. Click the extension icon.
3. Click **Save Episode**.

The popup will display success/failure text, including match source and item ID when successful.

## CLI usage

Run the same core logic from terminal:

```bash
node cli.js "https://example.com/podcast-episode-page" --verbose
```

Credentials are loaded in this order:

1. `--email` + `--password`
2. `OVERCAST_EMAIL` + `OVERCAST_PASSWORD`
3. `.send-to-overcast.credentials.json` in the working directory

Credential file format:

```json
{
  "email": "you@example.com",
  "password": "your-overcast-password"
}
```

Useful options:

- `--verbose`: print matching/search trace output.
- `--no-verify`: skip post-save verification checks.
- `--help`: print usage.

## Verification behavior

CLI verification checks:

1. The matched episode page shows user-saved markers.
2. Fallback check against `/podcasts` HTML.

This was added because `/podcasts` alone is not always a reliable indicator for all saved items.

## Notes and caveats

- Credentials are intentionally stored locally (`chrome.storage.local` in extension, or env/file for CLI).
- Matching quality is best when the source page has clean metadata (`og:title`, JSON-LD, feed links, descriptive `<title>`).
- Overcast web behavior may associate a saved episode with podcast subscription state depending on account/server behavior.

## Troubleshooting

- "Missing Overcast credentials": set creds in extension options or provide CLI creds.
- "Couldn't match this page": try a page with clearer episode title metadata.
- Extension appears stale: reload extension in `chrome://extensions`.
