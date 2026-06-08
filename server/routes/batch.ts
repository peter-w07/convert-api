import { Router, type Request } from "express";
import multer from "multer";
import JSZip from "jszip";
import mime from "mime";
import { assertSafeUrl, downloadUrl } from "../lib/download.ts";
import { captureUrl, type ScreenshotFormat } from "../lib/screenshot.ts";
import { convertImage, normalizeSharpFormat } from "../lib/sharpConvert.ts";
import { convertViaBrowser, isBrowserConverterAvailable } from "../lib/browserConvert.ts";
import { classifyPdfInput, convertMediaToPdf } from "../lib/mediaPdf.ts";
import { isYouTubeUrl } from "../lib/youtube.ts";
import { badRequest, ApiError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { sanitizeFilename } from "../lib/download.ts";
import { estimateMs } from "../lib/estimate.ts";
import { INLINE_THRESHOLD_MS, spawnJob, waitForJob, getJobWithBytes } from "../lib/jobs.ts";
import { contentDispositionHeader } from "./_disposition.ts";
import { inc } from "../lib/metrics.ts";
import { jobAcceptedPayload, jobFailure } from "../lib/jobHttp.ts";
import { booleanParam, numberParam, resolutionParam } from "../lib/params.ts";
import { internalBaseUrl } from "../lib/internalBaseUrl.ts";

const MAX_BATCH = Number(process.env.CONVERT_API_BATCH_MAX_ITEMS) || 32;
const MAX_UPLOAD_BYTES = Number(process.env.CONVERT_API_MAX_UPLOAD_BYTES) || 200 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_BATCH },
});

const SCREENSHOT_FORMATS: ScreenshotFormat[] = ["png", "jpeg", "webp", "pdf"];

interface BatchItem {
  url?: string;
  to: string;
  from?: string;
  width?: number;
  height?: number;
  quality?: number;
  /** Index into the uploaded files array (for multipart). */
  fileIndex?: number;
}

export const batchRouter: Router = Router();

batchRouter.post("/api/convert/batch", upload.array("files", MAX_BATCH), async (req, res, next) => {
  try {
    const body = (req.body || {}) as { items?: unknown; async?: unknown; sync?: unknown };
    let items: BatchItem[];
    try {
      const raw = typeof body.items === "string" ? JSON.parse(body.items) : body.items;
      items = Array.isArray(raw) ? (raw as BatchItem[]) : [];
    } catch {
      throw badRequest("'items' must be a JSON array");
    }
    if (items.length === 0) throw badRequest("At least one item required");
    if (items.length > MAX_BATCH) throw badRequest(`Too many items (max ${MAX_BATCH})`);
    const wantAsync = booleanParam(body.async, "async") === true;
    const wantSync = booleanParam(body.sync, "sync") === true;

    const files = ((req as Request & { files?: Express.Multer.File[] }).files || []) as Express.Multer.File[];
    items = items.map((item, index) => normalizeBatchItem(item, index, files));
    await Promise.all(items.filter((item) => item.url).map((item) => assertSafeUrl(item.url!)));
    const browserBaseUrl = internalBaseUrl(req);
    const childEstimates = items.map((it) =>
      it.url
        ? estimateMs({
            kind: SCREENSHOT_FORMATS.includes(it.to as ScreenshotFormat) && (!isLikelyFileUrl(it.url) || isYouTubeUrl(it.url))
              ? "screenshot"
              : normalizeSharpFormat(it.to)
                ? "sharp"
                : "browserConvert",
            url: it.url,
            to: it.to,
          })
        : estimateMs({
            kind: normalizeSharpFormat(it.to) ? "sharp" : "browserConvert",
            bytes: files[it.fileIndex ?? 0]?.size ?? 1024 * 1024,
          }),
    );
    const totalEstimate = estimateMs({ kind: "batch", childrenMs: childEstimates.reduce((a, b) => a + b, 0) });
    const shouldAsync = !wantSync && (wantAsync || totalEstimate > INLINE_THRESHOLD_MS);

    const worker = async (setProgress: (n: number) => void, signal: AbortSignal) => {
      const zip = new JSZip();
      let done = 0;
      for (let i = 0; i < items.length; i++) {
        if (signal.aborted) throw new ApiError(409, "Batch cancelled");
        const it = items[i];
        try {
          const result = await runOne(it, files, browserBaseUrl, signal);
          zip.file(safeZipName(result.fileName, i), Buffer.from(result.bytes));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          zip.file(`error_${i}.txt`, `Item ${i} failed: ${msg}\n${JSON.stringify(it)}`);
        }
        done++;
        setProgress(done / items.length);
      }
      const zipBytes = await zip.generateAsync({ type: "uint8array" });
      return {
        bytes: zipBytes,
        contentType: "application/zip",
        fileName: `batch_${Date.now()}.zip`,
      };
    };

    if (shouldAsync) {
      const job = spawnJob({
        kind: "batch",
        estimateMs: totalEstimate,
        input: { itemCount: items.length },
        worker: async ({ setProgress, signal }) => worker(setProgress, signal),
      });
      inc("batch_jobs_total", { mode: "async" });
      res.status(202).json(jobAcceptedPayload(req, job, { itemCount: items.length }));
      return;
    }

    inc("batch_jobs_total", { mode: "sync" });
    const job = spawnJob({
      kind: "batch",
      estimateMs: totalEstimate,
      input: { itemCount: items.length },
      worker: async ({ setProgress, signal }) => worker(setProgress, signal),
    });
    const finished = await waitForJob(job.id, Math.max(5_000, totalEstimate * 5));
    if (finished.status === "failed") throw jobFailure(finished, "Batch failed");
    const internal = getJobWithBytes(job.id);
    if (!internal?.result) throw new ApiError(500, "Batch produced no result");
    res.setHeader("content-type", internal.result.contentType);
    res.setHeader("content-disposition", contentDispositionHeader(internal.result.fileName));
    res.send(Buffer.from(internal.result.bytes));
  } catch (e) {
    next(e);
  }
});

async function runOne(it: BatchItem, files: Express.Multer.File[], baseUrl: string, signal: AbortSignal) {
  if (!it.to) throw badRequest("Each batch item needs 'to'");
  // URL + screenshot target → screenshot.
  if (it.url && SCREENSHOT_FORMATS.includes(it.to as ScreenshotFormat) && (!isLikelyFileUrl(it.url) || isYouTubeUrl(it.url))) {
    const r = await captureUrl({
      url: it.url,
      format: it.to as ScreenshotFormat,
      width: it.width,
      height: it.height,
      quality: it.quality,
    });
    return { bytes: r.bytes, contentType: r.contentType, fileName: `screenshot.${r.extension}` };
  }
  // Otherwise download/use the file then sharp.
  let bytes: Uint8Array;
  let name: string;
  let contentType: string | undefined;
  if (it.url) {
    const dl = await downloadUrl(it.url, { signal });
    bytes = dl.bytes;
    name = dl.fileName;
    contentType = dl.contentType ?? undefined;
  } else {
    const file = files[it.fileIndex ?? 0];
    if (!file) throw badRequest(`Batch item references missing file index ${it.fileIndex}`);
    bytes = new Uint8Array(file.buffer);
    name = file.originalname;
    contentType = file.mimetype || undefined;
  }
  const fromExt = it.from || extOf(name, contentType);
  if (!hasTransformOptions(it) && fromExt && sameFormat(fromExt, it.to)) {
    return {
      bytes,
      contentType: contentType || mimeTypeFor(it.to),
      fileName: name,
    };
  }
  const sharpTo = normalizeSharpFormat(it.to);
  if (sharpTo) {
    try {
      const r = await convertImage({ bytes, to: sharpTo, width: it.width, height: it.height, quality: it.quality });
      if (r) {
        const base = name.replace(/\.[^.]+$/, "");
        return { bytes: r.bytes, contentType: r.contentType, fileName: `${base}.${r.extension}` };
      }
    } catch {
      // The input is not Sharp-compatible; let the full converter graph try it.
    }
  }
  if (it.to === "pdf") {
    const pdfInputKind = classifyPdfInput(name, contentType, fromExt);
    if (pdfInputKind) {
      return convertMediaToPdf({
        bytes,
        fileName: name,
        fileExt: fromExt,
        inputKind: pdfInputKind,
        signal,
      });
    }
  }
  if (!isBrowserConverterAvailable()) {
    throw new ApiError(415, `No native fast-path for '${it.to}' and the browser converter is not built`);
  }
  const result = await convertViaBrowser({ bytes, fileName: name, to: it.to, from: fromExt, baseUrl });
  return { bytes: result.bytes, contentType: result.contentType, fileName: result.fileName };
}

function safeZipName(name: string, idx: number): string {
  const safe = sanitizeFilename(name);
  return `${String(idx).padStart(3, "0")}_${safe}`;
}

function normalizeBatchItem(item: BatchItem, index: number, files: Express.Multer.File[]): BatchItem {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw badRequest(`Batch item ${index} must be an object`);
  }
  const raw = item as unknown as Record<string, unknown>;
  const to = typeof raw.to === "string" ? raw.to.trim().toLowerCase().replace(/^\./, "") : "";
  if (!to) throw badRequest(`Batch item ${index} needs 'to'`);
  const url = typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : undefined;
  if (raw.url !== undefined && !url) throw badRequest(`Batch item ${index} has an invalid url`);
  const resolution = resolutionParam(raw.resolution, `items[${index}].resolution`, { min: 1, max: 10_000 });
  let fileIndex: number | undefined;
  if (!url) {
    fileIndex =
      raw.fileIndex === undefined
        ? 0
        : numberParam(raw.fileIndex, `items[${index}].fileIndex`, { min: 0, integer: true });
    if (fileIndex === undefined || !files[fileIndex]) {
      throw badRequest(`Batch item ${index} references missing file index ${fileIndex ?? 0}`);
    }
  }
  return {
    url,
    to,
    from: typeof raw.from === "string" ? raw.from.toLowerCase().replace(/^\./, "") : undefined,
    fileIndex,
    width:
      numberParam(raw.width, `items[${index}].width`, { min: 1, max: 10_000, integer: true }) ??
      resolution?.width,
    height:
      numberParam(raw.height, `items[${index}].height`, { min: 1, max: 10_000, integer: true }) ??
      resolution?.height,
    quality: numberParam(raw.quality, `items[${index}].quality`, { min: 1, max: 100, integer: true }),
  };
}

function isLikelyFileUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const last = u.pathname.split("/").filter(Boolean).pop() || "";
    const m = /\.([a-z0-9]{1,6})$/i.exec(last);
    if (!m) return false;
    const ext = m[1].toLowerCase();
    if (["html", "htm", "php", "aspx", "asp", "jsp", "cgi"].includes(ext)) return false;
    return true;
  } catch {
    return false;
  }
}

function extOf(name?: string, mimeType?: string): string | undefined {
  if (name) {
    const dot = name.lastIndexOf(".");
    const e = dot >= 0 ? name.slice(dot + 1) : "";
    if (e && e.length <= 8) return e.toLowerCase();
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

function hasTransformOptions(item: Pick<BatchItem, "width" | "height" | "quality">): boolean {
  return item.width !== undefined || item.height !== undefined || item.quality !== undefined;
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

function mimeTypeFor(extOrMime: string): string {
  const value = extOrMime.toLowerCase().split(";")[0].trim();
  if (value.includes("/")) return value;
  const detected = mime.getType(value);
  if (detected) return detected;
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    wav: "audio/wav",
    txt: "text/plain",
    html: "text/html",
    json: "application/json",
  };
  return map[value] || "application/octet-stream";
}

log.info(`Batch endpoint loaded (max items: ${MAX_BATCH})`);
