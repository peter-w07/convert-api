FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY .npmrc package.json ./
RUN npm install --no-audit --no-fund

COPY . .

ARG VITE_COMMIT_SHA
ENV VITE_COMMIT_SHA=$VITE_COMMIT_SHA

# Build the original browser converter and its format cache. A failed build
# must fail the image too; otherwise the advertised universal fallback is absent.
RUN npm run build
RUN npm run cache:build

# ─────────────────────────────────────────────────────────────────────
# Runtime image — Node 22 + chromium + yt-dlp + tesseract.
# ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# System tools backing the optional endpoints. yt-dlp and tesseract are
# both relatively small; OCR language packs are language-specific so we
# install english by default — add more under -F LANG_PACKS to expand.
ARG LANG_PACKS="tesseract-ocr-eng"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    tesseract-ocr \
    ${LANG_PACKS} \
    ca-certificates \
    curl \
    python3 \
    python3-pip \
  && pip install --break-system-packages --no-cache-dir -U yt-dlp \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
COPY --from=build /app/test ./test
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    CONVERT_API_STATE_DIR=/var/lib/convert-api/state \
    CONVERT_API_CACHE_DIR=/var/lib/convert-api/cache

VOLUME ["/var/lib/convert-api"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

CMD ["npm", "start"]
