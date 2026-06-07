import { type Page } from "puppeteer";
import { withPage, withBrowserSlot } from "./browser.ts";
import { assertSafeUrl, downloadUrl } from "./download.ts";
import { isYouTubeUrl, youtubeThumbnailUrl, youtubeVideoId } from "./youtube.ts";
import { ApiError, badRequest } from "./errors.ts";
import { log } from "./log.ts";

export type ScreenshotFormat = "png" | "jpeg" | "webp" | "pdf";

export interface ScreenshotOptions {
  url: string;
  format?: ScreenshotFormat;
  fullPage?: boolean;
  width?: number;
  height?: number;
  /** ms to wait after load before capture. */
  delayMs?: number;
  /** total navigation timeout */
  timeoutMs?: number;
  /** jpeg/webp quality (1-100). */
  quality?: number;
  /** Send a User-Agent override. */
  userAgent?: string;
  /** Force youtube to download thumbnail rather than render the player. */
  youtubeThumbnail?: boolean;
}

export interface ScreenshotResult {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
}

const DEFAULT_VIEWPORT = { width: 1366, height: 900 };

const contentTypeFor = (fmt: ScreenshotFormat) =>
  fmt === "pdf" ? "application/pdf" : fmt === "jpeg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";

const extensionFor = (fmt: ScreenshotFormat) => (fmt === "jpeg" ? "jpg" : fmt);
const HTTPS_FALLBACK_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Capture a URL as an image (PNG/JPEG/WEBP) or PDF.
 * Special-cases YouTube to wait for the video player to render or grab thumbnail.
 */
export async function captureUrl(opts: ScreenshotOptions): Promise<ScreenshotResult> {
  const url = opts.url;
  await assertSafeUrl(url);
  const format = opts.format ?? "png";
  const navTimeout = opts.timeoutMs ?? 45_000;
  const pageDeadline = navTimeout + Math.max(0, opts.delayMs ?? 0) + 5_000;

  // Fast-path: YouTube thumbnail request — direct download, no browser.
  if (opts.youtubeThumbnail && isYouTubeUrl(url)) {
    const id = youtubeVideoId(url);
    if (!id) throw badRequest("Could not extract YouTube video id");
    let lastErr: unknown = null;
    for (const q of ["max", "hq", "mq", "default"] as const) {
      try {
        const thumb = await downloadUrl(youtubeThumbnailUrl(id, q));
        return { bytes: thumb.bytes, contentType: "image/jpeg", extension: "jpg" };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("YouTube thumbnail unavailable");
  }

  return withBrowserSlot(() =>
    withPage(
      async (page) => {
        await installSafeRequestGuard(page);
        await page.setViewport({
          width: opts.width ?? DEFAULT_VIEWPORT.width,
          height: opts.height ?? DEFAULT_VIEWPORT.height,
          deviceScaleFactor: 1,
        });
        if (opts.userAgent) {
          await page.setUserAgent(opts.userAgent);
        }
        page.setDefaultNavigationTimeout(navTimeout);

        await navigateForCapture(page, url, navTimeout);

        if (isYouTubeUrl(url)) {
          await prepareYouTube(page);
        }

        if (opts.delayMs && opts.delayMs > 0) {
          await new Promise((r) => setTimeout(r, opts.delayMs));
        }

        if (format === "pdf") {
          const buffer = await page.pdf({ format: "A4", printBackground: true });
          return {
            bytes: new Uint8Array(buffer),
            contentType: "application/pdf",
            extension: "pdf",
          };
        }

        const shotOpts: Record<string, unknown> = {
          type: format,
          fullPage: opts.fullPage ?? false,
        };
        if (format === "jpeg" || format === "webp") {
          shotOpts.quality = opts.quality ?? 90;
        }
        const buffer = (await page.screenshot(shotOpts as Parameters<Page["screenshot"]>[0])) as Buffer;

        return {
          bytes: new Uint8Array(buffer),
          contentType: contentTypeFor(format),
          extension: extensionFor(format),
        };
      },
      { timeoutMs: pageDeadline },
    ),
  );
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function httpFallbackForBrokenHttps(rawUrl: string, e: unknown): string | null {
  if (!errorMessage(e).includes("net::ERR_SSL_PROTOCOL_ERROR")) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  parsed.protocol = "http:";
  return parsed.href;
}

function navigationFailure(url: string, e: unknown): ApiError {
  const msg = errorMessage(e);
  if (e instanceof ApiError) return e;
  if (msg.includes("net::ERR_SSL_PROTOCOL_ERROR")) {
    return new ApiError(
      502,
      `Target HTTPS failed for ${url}: ${msg}. Try the http:// URL or verify the hostname.`,
    );
  }
  return new ApiError(502, `Target navigation failed for ${url}: ${msg}`);
}

async function navigateForCapture(page: Page, url: string, timeout: number): Promise<void> {
  log.info(`Navigating to ${url}`);
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout });
    return;
  } catch (e) {
    const fallback = httpFallbackForBrokenHttps(url, e);
    if (!fallback) throw navigationFailure(url, e);

    await assertSafeUrl(fallback);
    log.warn(`HTTPS failed for ${url}; retrying screenshot over ${fallback}`);
    try {
      await renderHttpFallbackSnapshot(page, fallback, timeout);
      return;
    } catch (fallbackError) {
      throw navigationFailure(fallback, fallbackError);
    }
  }
}

async function renderHttpFallbackSnapshot(page: Page, fallback: string, timeout: number): Promise<void> {
  const downloaded = await downloadUrl(fallback, {
    maxBytes: HTTPS_FALLBACK_MAX_BYTES,
    timeoutMs: timeout,
  });
  const contentType = downloaded.contentType?.split(";")[0]?.trim().toLowerCase();
  if (contentType && !["text/html", "application/xhtml+xml", "text/plain"].includes(contentType)) {
    throw new ApiError(502, `HTTP fallback for ${fallback} returned unsupported content-type: ${downloaded.contentType}`);
  }

  const body = new TextDecoder("utf-8").decode(downloaded.bytes);
  const html =
    contentType === "text/plain"
      ? `<!doctype html><meta charset="utf-8"><pre>${escapeHtml(body)}</pre>`
      : withBaseHref(body, downloaded.url);

  await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
  await page.setContent(html, { waitUntil: "domcontentloaded", timeout });
  await new Promise((r) => setTimeout(r, 1000));
}

function withBaseHref(html: string, baseUrl: string): string {
  const base = `<base href="${escapeHtmlAttr(baseUrl)}">`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${base}`);
  }
  return `<!doctype html><head>${base}</head>${html}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeHtmlAttr(value: string): string {
  return escapeHtml(value);
}

async function installSafeRequestGuard(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    void (async () => {
      try {
        const requestUrl = request.url();
        const protocol = new URL(requestUrl).protocol;
        if (protocol === "http:" || protocol === "https:") {
          await assertSafeUrl(requestUrl);
        } else if (!["data:", "blob:", "about:"].includes(protocol)) {
          throw badRequest(`Blocked browser request protocol: ${protocol}`);
        }
        await request.continue();
      } catch {
        await request.abort("blockedbyclient").catch(() => {});
      }
    })();
  });
}

async function prepareYouTube(page: Page): Promise<void> {
  // Dismiss the EU consent dialog if present.
  await page
    .evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
      const btn = buttons.find((b) => {
        const t = (b.textContent || "").trim().toLowerCase();
        return t.includes("accept all") || t.includes("reject all") || t === "i agree";
      });
      if (btn) btn.click();
    })
    .catch(() => {});

  // Wait for the player container, with a generous fallback.
  await Promise.race([
    page.waitForSelector("#movie_player, ytd-player, .html5-video-player", { timeout: 15_000 }).catch(() => null),
    new Promise((r) => setTimeout(r, 15_000)),
  ]);

  // Hide the autoplay/cards/consent overlays so the player frame is clean.
  await page
    .evaluate(() => {
      const style = document.createElement("style");
      style.textContent = `
        .ytp-pause-overlay, .ytp-cards-button, .ytp-ce-element, .ytp-popup,
        ytd-consent-bump-v2-lightbox, .ytp-cued-thumbnail-overlay-image,
        ytd-popup-container, tp-yt-paper-dialog, tp-yt-iron-overlay-backdrop {
          display: none !important;
          opacity: 0 !important;
          visibility: hidden !important;
        }
      `;
      document.head.appendChild(style);
    })
    .catch(() => {});

  // Give the player a moment to swap from thumbnail to canvas.
  await new Promise((r) => setTimeout(r, 1500));
}
