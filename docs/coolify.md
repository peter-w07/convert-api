# Deploying to Coolify

This repo is Coolify-ready out of the box. The root `docker-compose.yaml` is auto-detected; the build pulls a multi-stage image that includes Chromium, ffmpeg, Tesseract, and yt-dlp.

The release branch for this fork is `master`.

## One-time setup in Coolify

1. **Projects → New Resource → Docker Compose**.
2. **Source**: GitHub → `peter-w07/convert-api` → branch `master`.
3. **Build pack**: leave as **Docker Compose** (Coolify will detect the root `docker-compose.yaml`).
4. **Port**: set the exposed port to **3000** (or leave the default if Coolify reads it from the compose file).
5. **Domain**: bind your domain (Coolify provisions Let's Encrypt automatically).
6. **Environment variables**: paste the contents of `.env.example` and fill in any optional integrations:
   - `OPENAI_API_KEY` — enables `/api/transcribe` via Whisper API.
   - `ANTHROPIC_API_KEY` — enables Claude summaries on transcripts.
   - `CONVERT_API_KEYS` — comma-separated keys to require `x-api-key` on every endpoint (optional; leave empty for open access with per-IP rate limit only).
7. **Persistent storage**: confirm the `convert_api_state` named volume is created. This keeps the result cache, the format snapshot, and webhook subscriptions across restarts.
8. **Deploy**.

The image build is large (~1.5 GB pulled, ~3 min first build) because it bundles Chromium + ffmpeg + Tesseract + yt-dlp. Subsequent builds are cached in seconds.

## Smoke test after deploy

```bash
# Replace with your Coolify-assigned domain
DOMAIN=https://convert-api.yourdomain.tld

curl -s "$DOMAIN/health" | jq
curl -s "$DOMAIN/api/formats" | jq '.count'

# Render a screenshot
curl -X POST "$DOMAIN/api/screenshot?sync=true" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","format":"png"}' \
  -o /tmp/test.png && file /tmp/test.png
```

You should see:
- `/health` → `{"ok": true, "capabilities": { browserConverter, ytdlp, tesseract, openaiWhisper, claudeSummary }}`
- `/api/formats` → `count >= 7`
- The screenshot file should be a real PNG (`PNG image data, 1366 x 900`).

The Swagger UI is at `$DOMAIN/docs`.

## Coolify-specific notes

### Webhook auto-deploy

In Coolify, **Resource → Webhooks** gives you a URL you can paste into the GitHub repository's webhook settings. Pushes to `master` will auto-redeploy.

### Health check

Coolify uses the container's `HEALTHCHECK` from the Dockerfile by default; the compose file also declares one. The endpoint is `GET /health` and it returns 200 with capability flags.

### Logs

Coolify streams stdout/stderr to its dashboard. The server logs every request, every job state transition, and any errors.

### Scaling concurrency

Container size on your VPS dictates how many concurrent browser jobs you can run.

| VPS RAM | Reasonable `CONVERT_API_MAX_CONCURRENCY` |
|---|---|
| 1 GB | 1 |
| 2 GB | 2 (default) |
| 4 GB | 4 |
| 8 GB+ | 6–8 |

Each headless Chromium page can briefly burn ~150 MB RSS during a complex screenshot. Sharp transcodes and yt-dlp jobs aren't counted against this limit — they have their own implicit limits via Node's heap and the `multer` upload cap.

### Updating

Push a new commit to `master` → Coolify rebuilds → restart. To pull and rebuild manually, hit **Redeploy** in the Coolify UI.

### Rolling back

Coolify keeps the previous image. **Settings → Rollback** restores the last successful image.

## Manual SSH deployment (if you skip Coolify)

If you'd rather run it directly on the VPS without Coolify:

```bash
ssh root@your-vps
git clone https://github.com/peter-w07/convert-api.git
cd convert-api
cp .env.example .env   # edit if you want
docker compose up -d --build
curl http://localhost:3000/health
```

Then expose port 3000 behind any reverse proxy (Caddy, nginx, Traefik).
