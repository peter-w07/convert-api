import { Router, type Request, type Response } from "express";
import { captureUrl, type ScreenshotFormat } from "../lib/screenshot.ts";
import { assertSafeUrl } from "../lib/download.ts";
import { ApiError, badRequest } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { resultCache } from "../lib/cache.ts";
import { estimateMs } from "../lib/estimate.ts";
import {
  INLINE_THRESHOLD_MS,
  spawnJob,
  waitForJob,
  getJobWithBytes,
} from "../lib/jobs.ts";
import { inc } from "../lib/metrics.ts";
import { jobAcceptedPayload, jobFailure } from "../lib/jobHttp.ts";
import { booleanParam, numberParam, resolutionParam } from "../lib/params.ts";
import { contentDispositionHeader } from "./_disposition.ts";

const ALLOWED_FORMATS: ScreenshotFormat[] = ["png", "jpeg", "webp", "pdf"];

function parseInputs(body: Record<string, unknown>, query: Record<string, unknown>) {
  const src = { ...query, ...body };
  const url = typeof src.url === "string" ? src.url : "";
  if (!url) throw badRequest("Missing required field 'url'");
  const format = (typeof src.format === "string" ? src.format : "png").toLowerCase() as ScreenshotFormat;
  if (!ALLOWED_FORMATS.includes(format)) {
    throw badRequest(`format must be one of: ${ALLOWED_FORMATS.join(", ")}`);
  }
  const resolution = resolutionParam(src.resolution, "resolution", { min: 1, max: 10_000 });
  return {
    url,
    format,
    fullPage: booleanParam(src.fullPage, "fullPage"),
    width: numberParam(src.width, "width", { min: 1, max: 10_000, integer: true }) ?? resolution?.width,
    height: numberParam(src.height, "height", { min: 1, max: 10_000, integer: true }) ?? resolution?.height,
    delayMs:
      numberParam(src.delayMs, "delayMs", { min: 0, max: 120_000, integer: true }) ??
      numberParam(src.delay, "delay", { min: 0, max: 120_000, integer: true }),
    timeoutMs:
      numberParam(src.timeoutMs, "timeoutMs", { min: 1_000, max: 300_000, integer: true }) ??
      numberParam(src.timeout, "timeout", { min: 1_000, max: 300_000, integer: true }),
    quality: numberParam(src.quality, "quality", { min: 1, max: 100, integer: true }),
    userAgent: typeof src.userAgent === "string" ? src.userAgent : undefined,
    youtubeThumbnail:
      booleanParam(src.youtubeThumbnail, "youtubeThumbnail") ?? booleanParam(src.thumbnail, "thumbnail"),
    sync: booleanParam(src.sync, "sync"),
    async: booleanParam(src.async, "async"),
    nocache: booleanParam(src.nocache, "nocache"),
  };
}

export const screenshotRouter: Router = Router();

function syncWaitMs(estimate: number, opts: { timeoutMs?: number; delayMs?: number }): number {
  const navigationBudget = opts.timeoutMs ?? 45_000;
  const delayBudget = opts.delayMs ?? 0;
  return Math.max(2_000, estimate * 5, navigationBudget + delayBudget + 5_000);
}

const handle = async (req: Request, res: Response, next: import("express").NextFunction) => {
  try {
    const opts = parseInputs((req.body as Record<string, unknown>) || {}, req.query as Record<string, unknown>);
    log.info(`${req.method} /api/screenshot url=${opts.url} format=${opts.format}`);
    // Validate URL eagerly so SSRF / bad-input failures show up as 400 inline,
    // not buried inside a 202'd job's failure state.
    await assertSafeUrl(opts.url);

    const estimate = estimateMs({ kind: "screenshot", url: opts.url, to: opts.format });
    const forceAsync = opts.async === true;
    const forceSync = opts.sync === true;
    const shouldAsync = !forceSync && (forceAsync || estimate > INLINE_THRESHOLD_MS);

    const cacheKey = !opts.nocache
      ? resultCache.key("screenshot", {
          url: opts.url,
          format: opts.format,
          width: opts.width,
          height: opts.height,
          quality: opts.quality,
          fullPage: !!opts.fullPage,
          ytThumb: !!opts.youtubeThumbnail,
          delayMs: opts.delayMs,
          userAgent: opts.userAgent,
        })
      : "";
    if (cacheKey && !forceAsync) {
      const hit = await resultCache.get(cacheKey);
      if (hit) {
        inc("screenshot_cache_hits_total", {});
        res.setHeader("content-type", hit.contentType);
        res.setHeader("content-disposition", contentDispositionHeader(hit.fileName));
        res.send(Buffer.from(hit.bytes));
        return;
      }
    }

    const worker = async () => {
      const result = await captureUrl(opts);
      const payload = {
        bytes: result.bytes,
        contentType: result.contentType,
        fileName: `screenshot.${result.extension}`,
      };
      if (cacheKey) await resultCache.set(cacheKey, payload);
      return payload;
    };

    if (shouldAsync) {
      const job = spawnJob({
        kind: "screenshot",
        estimateMs: estimate,
        input: { url: opts.url, format: opts.format },
        worker,
      });
      inc("screenshot_jobs_total", { mode: "async" });
      res.status(202).json(jobAcceptedPayload(req, job));
      return;
    }

    inc("screenshot_jobs_total", { mode: "sync" });
    const job = spawnJob({ kind: "screenshot", estimateMs: estimate, input: { url: opts.url, format: opts.format }, worker });
    const finished = await waitForJob(job.id, syncWaitMs(estimate, opts));
    if (finished.status === "failed") throw jobFailure(finished, "Screenshot failed");
    const internal = getJobWithBytes(job.id);
    if (!internal?.result) throw new ApiError(500, "Result vanished");
    res.setHeader("content-type", internal.result.contentType);
    res.setHeader("content-disposition", contentDispositionHeader(internal.result.fileName));
    res.send(Buffer.from(internal.result.bytes));
  } catch (e) {
    next(e);
  }
};

screenshotRouter.post("/api/screenshot", handle);
screenshotRouter.get("/api/screenshot", handle);
