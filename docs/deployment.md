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
| `CONVERT_API_BROWSER_TIMEOUT_MS` | `180000` | default Puppeteer page/protocol deadline |
| `CONVERT_API_BROWSER_CONVERT_TIMEOUT_MS` | browser timeout | browser-converter deadline override |
| `CONVERT_API_BROWSER_WIDTH` / `CONVERT_API_BROWSER_HEIGHT` | `1366` / `900` | headless Chromium viewport/window size |
| `CONVERT_API_IGNORE_CERT_ERRORS` | `0` | pass `--ignore-certificate-errors` (dev) |
| `CONVERT_API_RATE_RPM` | `60` | per-key rate-limit (requests/minute) |
| `CONVERT_API_BURST` | `20` | rate-limit burst size |
| `FFMPEG_BIN` | `ffmpeg` | path to ffmpeg binary for video poster-frame PDF output |
| `YTDLP_BIN` | `yt-dlp` | path to yt-dlp binary |
| `TESSERACT_BIN` | `tesseract` | path to tesseract binary |
| `WHISPER_BIN` | `whisper` | path to whisper CLI |
| `OPENAI_API_KEY` | — | enables OpenAI Whisper transcription path |
| `OPENAI_WHISPER_MODEL` | `whisper-1` | OpenAI Whisper model id |
| `ANTHROPIC_API_KEY` | — | enables Claude summarization of transcripts |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Claude model id |

| `DISCORD_BOT_TOKEN` | â€” | enables the optional Discord bot integration |
| `DISCORD_APPLICATION_ID` | auto-detected | Discord application id, if auto-detect is unavailable |
| `DISCORD_GUILD_ID` | â€” | register slash commands in one guild instead of globally |
| `DISCORD_CONVERT_API_BASE_URL` | `http://127.0.0.1:$PORT` | API base URL the bot calls |
| `DISCORD_CONVERT_API_KEY` | first `CONVERT_API_KEYS` value | API key the bot uses for internal API calls |
| `DISCORD_AUDIT_CHANNEL_ID(S)` | â€” | comma-separated Discord channel ids for audit log batches |
| `DISCORD_AUDIT_WEBHOOK_URL(S)` | â€” | comma-separated Discord webhook URLs for audit log batches |
| `DISCORD_WEB_HISTORY_LIMIT` | `100` | cached messages per channel for `/discord` |
| `DISCORD_AUDIT_FLUSH_MS` | `30000` | audit batch flush interval |
| `DISCORD_PROGRESS_UPDATE_MS` | `5000` | Discord progress edit interval for async jobs |
| `DISCORD_RAW_UPLOAD_DELETE_DELAY_MS` | `1500` | delay before deleting raw post-`/convert` uploads |

## Optional Discord bot integration

Set `DISCORD_BOT_TOKEN` to enable the built-in Discord gateway client. Without that variable the server starts normally and the Discord status endpoint reports the bot as disabled.

The bot registers these slash commands:

| Command | Purpose |
|---|---|
| `/convert` | attach a file, choose an output format, and receive the converted result in Discord |
| `/formats` | list input/output formats reported by `/api/formats` |
| `/screenshot` | capture a website as `png`, `jpeg`, `webp`, or `pdf` |
| `/download` | download media using the `/api/ytdlp` workflow |
| `/ocr` | run OCR on an attachment or URL |
| `/transcribe` | transcribe an attachment or media URL |

`/convert` also supports a two-step flow: run the command without an attachment, upload or paste a file in the same channel within 10 minutes, then use the format picker. If the bot has permission to manage messages, it deletes that raw uploaded message after it captures the attachment.

The bot uses the Convert API's async job endpoints, edits the original Discord response with a progress bar, then uploads the finished file back into the channel. If API keys are enabled, set `DISCORD_CONVERT_API_KEY` or let the bot use the first value in `CONVERT_API_KEYS`.

Audit logging can be sent to one or more Discord channels or webhooks with `DISCORD_AUDIT_CHANNEL_IDS` and `DISCORD_AUDIT_WEBHOOK_URLS`. The bot queues and batches gateway activity such as message edits/deletes, bulk deletes, member joins/leaves, role changes, server/channel/thread changes, bans, invites, webhooks, emojis/stickers, reactions, integrations, scheduled events, AutoMod events, slash-command use, conversion lifecycle events, and raw-upload cleanup attempts.

Required Discord setup:

- Enable the Message Content intent if you want the bot to capture post-`/convert` uploads and cache readable message text.
- Enable Server Members intent for join/leave and role/member audit coverage.
- Invite the bot with permissions to send messages, attach files, use slash commands, read message history, and optionally manage messages for raw-upload cleanup.
- For quick command updates during development, set `DISCORD_GUILD_ID`; global commands can take longer to propagate.

The operator console is available at `/discord`. When API keys are enabled, open it as `/discord?apiKey=YOUR_KEY`; the console carries that key into its same-origin API requests. It exposes:

- `GET /api/discord/status`
- `GET /api/discord/guilds`
- `GET /api/discord/channels`
- `GET /api/discord/channels/:channelId/messages`
- `POST /api/discord/channels/:channelId/messages`

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
