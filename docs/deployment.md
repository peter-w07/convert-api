# Deployment

## Docker (recommended)

```bash
docker compose -f docker/docker-compose.yml \
                -f docker/docker-compose.override.yml \
                up -d --build
```

Exposes port `3000`. The image includes Chromium and (optionally) yt-dlp + tesseract — see `docker/Dockerfile`.

## Manual (Bun or Node 18+)

```bash
# Required deps
bun install         # or: npm install

# Optional: pre-build the WASM converter so /api/convert can fall back to it
git submodule update --init --recursive
bun run build
bun run cache:build:dev

# Start the API
bun run server      # or: npm run server
```

Default port: `3000`. Override with `PORT=…`.

## External tools (optional)

These power specific endpoints; the server starts without them and reports their absence in `/health.capabilities`.

| Tool | Endpoint | Install |
|---|---|---|
| `yt-dlp` | `/api/ytdlp`, `/api/transcribe` (YouTube) | `pip install -U yt-dlp` or [release binary](https://github.com/yt-dlp/yt-dlp/releases) |
| `tesseract` | `/api/ocr` | `apt-get install -y tesseract-ocr` (plus language packs `tesseract-ocr-eng` etc.) |
| `whisper` CLI | `/api/transcribe` (fallback) | `pip install -U openai-whisper` (large model download on first run) |
| Chromium | `/api/screenshot`, `/api/convert` | Bundled via Puppeteer (`npx puppeteer browsers install chrome`). Or set `PUPPETEER_EXECUTABLE_PATH`. |

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | bind address |
| `PUPPETEER_EXECUTABLE_PATH` | — | use a pre-installed Chromium |
| `CONVERT_API_MAX_CONCURRENCY` | `2` | concurrent browser-driven jobs |
| `CONVERT_API_MAX_UPLOAD_BYTES` | `209715200` | multer upload limit |
| `CONVERT_API_INLINE_THRESHOLD_MS` | `100` | inline vs async threshold |
| `CONVERT_API_JOB_TTL_MS` | `3600000` | job retention after completion |
| `CONVERT_API_MAX_JOBS` | `5000` | LRU bound on the job store |
| `CONVERT_API_CACHE_DIR` | `/tmp/convert-api-cache` | disk cache location |
| `CONVERT_API_CACHE_MAX_BYTES` | `536870912` | total cache budget |
| `CONVERT_API_CACHE_MAX_AGE_MS` | `86400000` | cache TTL |
| `CONVERT_API_CACHE_DISABLED` | — | set `1` to bypass cache entirely |
| `CONVERT_API_STATE_DIR` | `/tmp/convert-api-state` | format snapshot + webhooks storage |
| `CONVERT_API_BATCH_MAX_ITEMS` | `32` | max items per batch request |
| `CONVERT_API_WARM_BROWSER` | `1` | pre-launch Chromium on startup |
| `CONVERT_API_IGNORE_CERT_ERRORS` | `0` | pass `--ignore-certificate-errors` (dev) |
| `CONVERT_API_RATE_RPM` | `60` | per-key rate-limit (requests/minute) |
| `CONVERT_API_BURST` | `20` | rate-limit burst size |
| `YTDLP_BIN` | `yt-dlp` | path to yt-dlp binary |
| `TESSERACT_BIN` | `tesseract` | path to tesseract binary |
| `WHISPER_BIN` | `whisper` | path to whisper CLI |
| `OPENAI_API_KEY` | — | enables OpenAI Whisper transcription path |
| `OPENAI_WHISPER_MODEL` | `whisper-1` | OpenAI Whisper model id |
| `ANTHROPIC_API_KEY` | — | enables Claude summarization of transcripts |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Claude model id |

## Scaling notes

- **Browser concurrency** is the main bottleneck. Each Chromium page burns ~150MB RSS during a screenshot; `CONVERT_API_MAX_CONCURRENCY=4` on a 2 GB container is a reasonable starting point.
- **Cache** drastically helps idempotent workloads (same URL → same params). Mount a persistent volume at `CONVERT_API_CACHE_DIR` so cache survives restarts.
- **Job store** is in-memory and per-process. For multi-instance deployments add a sticky-routing layer at the LB or move to Redis-backed storage (TODO; see [contributing.md](./contributing.md)).
- **Rate limiting** is per-process — a token bucket per API key (or remote IP when unauthenticated). For cluster mode, front-load with a CDN rate limiter.

## Reverse proxy snippet (nginx)

```nginx
upstream convert_api { server localhost:3000; }

server {
  listen 443 ssl;
  server_name api.example.com;

  client_max_body_size 250m;
  proxy_read_timeout 300s;
  proxy_send_timeout 300s;

  location / {
    proxy_pass http://convert_api;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

    # SSE endpoints need streaming
    proxy_buffering off;
    proxy_cache off;
  }
}
```

## Optional Discord bot integration

Set `DISCORD_BOT_TOKEN` to enable the built-in Discord gateway client. On startup it registers simple slash commands that keep conversion separate by workflow:

- `/convert` prompts for a file upload, then shows a target-format dropdown, a complete-format-list button, and a custom-format modal. If a user uploads the file after the slash command instead of attaching it to the command, the bot deletes that raw upload message after it captures the attachment so the channel stays clean.
- `/formats` lists every input/output format reported by `/api/formats` (with optional direction/category filters) so users can discover conversion targets beyond Discord's 25-option dropdown limit.
- `/screenshot` captures a URL as PNG/JPEG/WEBP/PDF.
- `/download` fetches media through the yt-dlp endpoint.
- `/ocr` extracts text from an uploaded image/PDF.
- `/transcribe` transcribes an uploaded file or URL.

Useful Discord environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | unset | Bot token. If unset, all Discord features stay disabled. |
| `DISCORD_APPLICATION_ID` | bot user id | Optional app id for command registration/followups. |
| `DISCORD_LOG_CHANNEL_ID` | unset | Comma-separated channel ids that receive batched Discord audit events. These logs are sent to Discord only, not Google Sheets. |
| `DISCORD_LOG_WEBHOOK_URL` | unset | Optional comma-separated Discord webhook URLs that receive the same batched audit logs. Keep webhook URLs in environment variables/secrets; do not commit them. |
| `DISCORD_AUDIT_FLUSH_MS` | `30000` | How often queued audit events are posted. |
| `DISCORD_PROGRESS_UPDATE_MS` | `5000` | Minimum spacing between Discord progress-card edits while async API jobs run. |
| `DISCORD_RAW_UPLOAD_DELETE_DELAY_MS` | `1500` | Delay before deleting a raw attachment message that was uploaded after `/convert` instead of through the slash-command attachment field. |
| `DISCORD_CONVERT_API_BASE_URL` | `http://127.0.0.1:$PORT` | Base URL the bot uses to call this API. |
| `DISCORD_WEB_HISTORY_LIMIT` | `100` | Messages retained per channel for the web console cache. |

The bot needs the Guilds, Guild Members, Guild Messages, and Message Content gateway intents enabled in the Discord developer portal. To delete raw follow-up upload messages, grant the bot `Manage Messages` in the target channels; if that permission is missing the conversion still continues and only the cleanup attempt is skipped. Conversion, screenshot, download, OCR, and transcription commands call the async API path and edit the original Discord response with a progress bar, job status, and estimated duration until the result is uploaded back to the channel. The `/discord` page provides a lightweight console for the channels the bot can see, including message viewing and sending as the bot; it is protected by the existing `CONVERT_API_KEYS` middleware when API keys are configured. If keys are enabled, open it as `/discord?apiKey=...` so the browser console can make authenticated API calls.
