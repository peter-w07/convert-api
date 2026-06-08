import { Router, type Request, type Response } from "express";
import multer from "multer";
import mime from "mime";
import { downloadUrl, assertSafeUrl } from "../lib/download.ts";
import { captureUrl, type ScreenshotFormat } from "../lib/screenshot.ts";
import { convertImage, normalizeSharpFormat } from "../lib/sharpConvert.ts";
import { convertViaBrowser, isBrowserConverterAvailable } from "../lib/browserConvert.ts";
import { classifyPdfInput, convertMediaToPdf } from "../lib/mediaPdf.ts";
import { isYouTubeUrl } from "../lib/youtube.ts";
import { badRequest, unsupported, ApiError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { resultCache } from "../lib/cache.ts";
import { estimateMs } from "../lib/estimate.ts";
import { INLINE_THRESHOLD_MS, spawnJob, waitForJob, getJobWithBytes, type JobResult } from "../lib/jobs.ts";
import { inc } from "../lib/metrics.ts";
import { jobAcceptedPayload, jobFailure } from "../lib/jobHttp.ts";
import { booleanParam, numberParam, resolutionParam } from "../lib/params.ts";
import { internalBaseUrl } from "../lib/internalBaseUrl.ts";
import { contentDispositionHeader } from "./_disposition.ts";

const MAX_UPLOAD_BYTES = Number(process.env.CONVERT_API_MAX_UPLOAD_BYTES) || 200 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

const SCREENSHOT_FORMATS: ScreenshotFormat[] = ["png", "jpeg", "webp", "pdf"];

interface ConvertInputs {
  to: string;
  from?: string;
  width?: number;
  height?: number;
  quality?: number;
  url?: string;
  fullPage?: boolean;
  delayMs?: number;
  youtubeThumbnail?: boolean;
  fileBytes?: Uint8Array;
  fileName?: string;
  fileMime?: string;
  sync?: boolean | undefined;
  async?: boolean | undefined;
  nocache?: boolean | undefined;
}

function parseInputs(req: Request): ConvertInputs {
  const body = (req.body || {}) as Record<string, unknown>;
  const query = (req.query || {}) as Record<string, unknown>;
  const src = { ...query, ...body };
  const to = typeof src.to === "string" ? src.to.toLowerCase().replace(/^\./, "") : "";
  if (!to) throw badRequest("Missing required field 'to' (target format extension, e.g. 'png')");
  const resolution = resolutionParam(src.resolution, "resolution", { min: 1, max: 10_000 });
  const inputs: ConvertInputs = {
    to,
    from: typeof src.from === "string" ? src.from.toLowerCase().replace(/^\./, "") : undefined,
    width: numberParam(src.width, "width", { min: 1, max: 10_000, integer: true }) ?? resolution?.width,
    height: numberParam(src.height, "height", { min: 1, max: 10_000, integer: true }) ?? resolution?.height,
    quality: numberParam(src.quality, "quality", { min: 1, max: 100, integer: true }),
    fullPage: booleanParam(src.fullPage, "fullPage"),
    delayMs:
      numberParam(src.delayMs, "delayMs", { min: 0, max: 120_000, integer: true }) ??
      numberParam(src.delay, "delay", { min: 0, max: 120_000, integer: true }),
    youtubeThumbnail:
      booleanParam(src.youtubeThumbnail, "youtubeThumbnail") ?? booleanParam(src.thumbnail, "thumbnail"),
    sync: booleanParam(src.sync, "sync"),
    async: booleanParam(src.async, "async"),
    nocache: booleanParam(src.nocache, "nocache"),
  };
  if (typeof src.url === "string" && src.url) inputs.url = src.url;
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (file) {
    inputs.fileBytes = new Uint8Array(file.buffer);
    inputs.fileName = file.originalname || "upload.bin";
    inputs.fileMime = file.mimetype || undefined;
  }
  if (!inputs.fileBytes && !inputs.url) {
    throw badRequest("Provide either a 'file' multipart upload or a 'url' in the body/query");
  }
  return inputs;
}

export const convertRouter: Router = Router();

convertRouter.post("/api/convert", upload.single("file"), async (req, res, next) => {
  try {
    const inputs = parseInputs(req);
    log.info(`POST /api/convert to=${inputs.to} url=${inputs.url ?? ""} file=${inputs.fileName ?? ""}`);
    if (inputs.url) await assertSafeUrl(inputs.url);

    // Decide path + estimate cost.
    const plan = await planConversion(inputs, internalBaseUrl(req));
    const estimate = estimateMs(plan.estimateInputs);

    const forceAsync = inputs.async === true;
    const forceSync = inputs.sync === true;
    const shouldAsync = !forceSync && (forceAsync || estimate > INLINE_THRESHOLD_MS);

    // Cache lookup — skipped when the caller explicitly asked for async, so
    // they always get a 202 + jobId back as documented.
    const cacheKey = !inputs.nocache ? resultCache.key(plan.kind, plan.cacheParams) : "";
    if (cacheKey && !forceAsync) {
      const hit = await resultCache.get(cacheKey);
      if (hit) {
        inc("convert_cache_hits_total", { kind: plan.kind });
        sendBinary(res, hit.bytes, hit.contentType, hit.fileName);
        return;
      }
    }

    if (shouldAsync) {
      const job = spawnJob({
        kind: plan.kind,
        estimateMs: estimate,
        input: plan.publicInput,
        worker: async ({ setProgress, signal }) => {
          if (signal.aborted) throw new Error("Cancelled");
          setProgress(0.05);
          const result = await plan.run(setProgress, signal);
          setProgress(0.95);
          if (cacheKey) {
            await resultCache.set(cacheKey, result);
          }
          return result;
        },
      });
      inc("convert_jobs_total", { kind: plan.kind, mode: "async" });
      res.status(202).json(jobAcceptedPayload(req, job));
      return;
    }

    inc("convert_jobs_total", { kind: plan.kind, mode: "sync" });
    // Inline path — we still go through the job system so the status pages
    // reflect even quick jobs (e.g. sharp transcodes).
    const job = spawnJob({
      kind: plan.kind,
      estimateMs: estimate,
      input: plan.publicInput,
      worker: async ({ setProgress, signal }) => {
        const result = await plan.run(setProgress, signal);
        if (cacheKey) await resultCache.set(cacheKey, result);
        return result;
      },
    });
    const finished = await waitForJob(job.id, Math.max(2_000, estimate * 5));
    if (finished.status === "failed") {
      throw jobFailure(finished, "Conversion failed");
    }
    const internal = getJobWithBytes(job.id);
    if (!internal?.result) throw new ApiError(500, "Result vanished");
    sendBinary(res, internal.result.bytes, internal.result.contentType, internal.result.fileName);
  } catch (e) {
    next(e);
  }
});

interface ConvertPlan {
  kind: string;
  estimateInputs: Parameters<typeof estimateMs>[0];
  cacheParams: Record<string, unknown>;
  publicInput: Record<string, unknown>;
  run: (setProgress: (n: number) => void, signal: AbortSignal) => Promise<JobResult>;
}

async function planConversion(inputs: ConvertInputs, baseUrl: string): Promise<ConvertPlan> {
  // Case 1: URL → screenshot-friendly target → headless capture.
  if (inputs.url && !inputs.fileBytes && SCREENSHOT_FORMATS.includes(inputs.to as ScreenshotFormat)) {
    const looksLikeFile = isLikelyFileUrl(inputs.url);
    if (!looksLikeFile || isYouTubeUrl(inputs.url)) {
      const ytThumb = inputs.youtubeThumbnail === true && isYouTubeUrl(inputs.url);
      const url = inputs.url;
      const format = inputs.to as ScreenshotFormat;
      return {
        kind: "screenshot",
        estimateInputs: { kind: "screenshot", url, to: format },
        cacheParams: {
          url,
          format,
          width: inputs.width,
          height: inputs.height,
          quality: inputs.quality,
          fullPage: !!inputs.fullPage,
          ytThumb,
        },
        publicInput: { url, format, ytThumb },
        run: async (setProgress) => {
          setProgress(0.2);
          const result = await captureUrl({
            url,
            format,
            width: inputs.width,
            height: inputs.height,
            delayMs: inputs.delayMs,
            fullPage: inputs.fullPage,
            quality: inputs.quality,
            youtubeThumbnail: ytThumb,
          });
          return {
            bytes: result.bytes,
            contentType: result.contentType,
            fileName: `screenshot.${result.extension}`,
          };
        },
      };
    }
  }

  // Resolve URL → bytes if URL was given for a file conversion.
  let bytes = inputs.fileBytes;
  let fileName = inputs.fileName;
  let detectedMime = inputs.fileMime;
  if (!bytes && inputs.url) {
    const url = inputs.url;
    return {
      kind: "downloadConvert",
      estimateInputs: { kind: "sharp", bytes: 5 * 1024 * 1024 },
      cacheParams: { url, to: inputs.to, width: inputs.width, height: inputs.height, quality: inputs.quality },
      publicInput: { url, to: inputs.to },
      run: async (setProgress, signal) => {
        setProgress(0.1);
        const dl = await downloadUrl(url, { signal });
        setProgress(0.4);
        const fromExt = inputs.from || extOf(dl.fileName, dl.contentType ?? undefined);
        const result = await runActualConvert(
          dl.bytes,
          dl.fileName,
          fromExt,
          inputs,
          baseUrl,
          setProgress,
          signal,
        );
        return result;
      },
    };
  }
  if (!bytes) throw badRequest("No input bytes available");

  const captured = bytes;
  const capturedName = fileName ?? "input.bin";
  const fromExt = inputs.from || extOf(capturedName, detectedMime);
  const sharpFrom = fromExt ? normalizeSharpFormat(fromExt) : null;
  const sharpTo = normalizeSharpFormat(inputs.to);

  if (!hasTransformOptions(inputs) && fromExt && sameFormat(fromExt, inputs.to)) {
    return {
      kind: "passthrough",
      estimateInputs: { kind: "sharp", bytes: captured.byteLength },
      cacheParams: {
        hash: hashBytes(captured),
        to: inputs.to,
        from: fromExt,
        fileName: capturedName,
      },
      publicInput: { fileName: capturedName, to: inputs.to, from: fromExt, bytes: captured.byteLength },
      run: async (setProgress) => {
        setProgress(0.9);
        return {
          bytes: captured,
          contentType: detectedMime || mime.getType(inputs.to) || "application/octet-stream",
          fileName: capturedName,
        };
      },
    };
  }

  if (sharpFrom && sharpTo) {
    return {
      kind: "sharp",
      estimateInputs: { kind: "sharp", bytes: captured.byteLength },
      cacheParams: {
        hash: hashBytes(captured),
        to: sharpTo,
        width: inputs.width,
        height: inputs.height,
        quality: inputs.quality,
      },
      publicInput: { fileName: capturedName, to: inputs.to, bytes: captured.byteLength },
      run: async (setProgress) => {
        setProgress(0.3);
        const result = await convertImage({
          bytes: captured,
          to: sharpTo,
          width: inputs.width,
          height: inputs.height,
          quality: inputs.quality,
        });
        setProgress(0.9);
        if (!result) throw new ApiError(500, "sharp not installed");
        return {
          bytes: result.bytes,
          contentType: result.contentType,
          fileName: `converted.${result.extension}`,
        };
      },
    };
  }

  if (inputs.to === "pdf") {
    const pdfInputKind = classifyPdfInput(capturedName, detectedMime, fromExt);
    if (pdfInputKind) {
      return {
        kind: pdfInputKind === "video" ? "videoPdf" : "imagePdf",
        estimateInputs: { kind: "mediaPdf", bytes: captured.byteLength },
        cacheParams: {
          hash: hashBytes(captured),
          to: "pdf",
          from: fromExt,
          fileName: capturedName,
        },
        publicInput: { fileName: capturedName, to: "pdf", from: fromExt, bytes: captured.byteLength },
        run: async (setProgress, signal) => {
          setProgress(0.25);
          const result = await convertMediaToPdf({
            bytes: captured,
            fileName: capturedName,
            fileExt: fromExt,
            inputKind: pdfInputKind,
            signal,
          });
          setProgress(0.9);
          return result;
        },
      };
    }
  }

  // Browser-driven fallback.
  if (!isBrowserConverterAvailable()) {
    throw unsupported(
      `No native fast-path for ${fromExt} → ${inputs.to}. The full browser converter is not built — run \`npm run build\` (or \`bun run build\`) to produce dist/, then retry.`,
    );
  }
  return {
    kind: "browserConvert",
    estimateInputs: { kind: "browserConvert" },
    cacheParams: {
      hash: hashBytes(captured),
      to: inputs.to,
      from: fromExt,
      fileName: capturedName,
    },
    publicInput: { fileName: capturedName, to: inputs.to, from: fromExt, bytes: captured.byteLength },
    run: async (setProgress) => {
      setProgress(0.2);
      const result = await convertViaBrowser({
        bytes: captured,
        fileName: capturedName,
        to: inputs.to,
        from: inputs.from,
        baseUrl,
      });
      return { bytes: result.bytes, contentType: result.contentType, fileName: result.fileName };
    },
  };
}

async function runActualConvert(
  bytes: Uint8Array,
  fileName: string,
  fromExt: string | undefined,
  inputs: ConvertInputs,
  baseUrl: string,
  setProgress: (n: number) => void,
  _signal: AbortSignal,
): Promise<JobResult> {
  const sharpFrom = fromExt ? normalizeSharpFormat(fromExt) : null;
  const sharpTo = normalizeSharpFormat(inputs.to);
  if (!hasTransformOptions(inputs) && fromExt && sameFormat(fromExt, inputs.to)) {
    setProgress(0.9);
    return {
      bytes,
      contentType: mime.getType(inputs.to) || "application/octet-stream",
      fileName,
    };
  }
  if (sharpFrom && sharpTo) {
    setProgress(0.6);
    const result = await convertImage({
      bytes,
      to: sharpTo,
      width: inputs.width,
      height: inputs.height,
      quality: inputs.quality,
    });
    if (result) {
      return {
        bytes: result.bytes,
        contentType: result.contentType,
        fileName: `converted.${result.extension}`,
      };
    }
  }
  if (inputs.to === "pdf") {
    const pdfInputKind = classifyPdfInput(fileName, undefined, fromExt);
    if (pdfInputKind) {
      setProgress(0.65);
      return convertMediaToPdf({
        bytes,
        fileName,
        fileExt: fromExt,
        inputKind: pdfInputKind,
        signal: _signal,
      });
    }
  }
  if (!isBrowserConverterAvailable()) {
    throw unsupported(
      `No native fast-path for ${fromExt} → ${inputs.to}. Build dist/ to unlock the WASM handler fallback.`,
    );
  }
  setProgress(0.6);
  const result = await convertViaBrowser({
    bytes,
    fileName,
    to: inputs.to,
    from: inputs.from,
    baseUrl,
  });
  return { bytes: result.bytes, contentType: result.contentType, fileName: result.fileName };
}

function sendBinary(res: Response, bytes: Uint8Array, contentType: string, fileName: string) {
  res.setHeader("content-type", contentType);
  res.setHeader("content-disposition", contentDispositionHeader(fileName));
  res.send(Buffer.from(bytes));
}

function isLikelyFileUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const last = u.pathname.split("/").filter(Boolean).pop() || "";
    const m = /\.([a-z0-9]{1,6})$/i.exec(last);
    if (!m) return false;
    const ext = m[1].toLowerCase();
    if (["html", "htm", "php", "aspx", "asp", "jsp", "cgi"].includes(ext)) return false;
    return !!mime.getType(ext);
  } catch {
    return false;
  }
}

function extOf(name?: string, mimeType?: string): string | undefined {
  if (name) {
    const dot = name.lastIndexOf(".");
    const e = dot >= 0 ? name.slice(dot + 1) : "";
    if (e && e.length <= 6) return e.toLowerCase();
  }
  if (mimeType) {
    const e = mime.getExtension(mimeType.split(";")[0].trim());
    if (e) return e.toLowerCase();
  }
  return undefined;
}

function sameFormat(from: string, to: string): boolean {
  return canonicalExt(from) === canonicalExt(to);
}

function hasTransformOptions(inputs: Pick<ConvertInputs, "width" | "height" | "quality">): boolean {
  return inputs.width !== undefined || inputs.height !== undefined || inputs.quality !== undefined;
}

function canonicalExt(ext: string): string {
  const lower = ext.toLowerCase().replace(/^\./, "");
  const aliases: Record<string, string> = {
    jpg: "jpeg",
    jpeg: "jpeg",
    tif: "tiff",
    tiff: "tiff",
    htm: "html",
    html: "html",
    m4v: "mp4",
  };
  return aliases[lower] || lower;
}

import { createHash } from "node:crypto";
function hashBytes(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}
