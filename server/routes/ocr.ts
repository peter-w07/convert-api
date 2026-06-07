import { Router, type Request } from "express";
import multer from "multer";
import { ocr, tesseractAvailable } from "../lib/ocr.ts";
import { assertSafeUrl, downloadUrl } from "../lib/download.ts";
import { ApiError, badRequest } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { resultCache } from "../lib/cache.ts";
import { estimateMs } from "../lib/estimate.ts";
import { INLINE_THRESHOLD_MS, spawnJob, waitForJob, getJobWithBytes } from "../lib/jobs.ts";
import { inc } from "../lib/metrics.ts";
import { contentDispositionHeader } from "./_disposition.ts";
import { jobAcceptedPayload, jobFailure } from "../lib/jobHttp.ts";
import { booleanParam } from "../lib/params.ts";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});

export const ocrRouter: Router = Router();

ocrRouter.get("/api/ocr/status", async (_req, res) => {
  res.json({ available: await tesseractAvailable() });
});

ocrRouter.post("/api/ocr", upload.single("file"), async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const query = (req.query || {}) as Record<string, unknown>;
    const src = { ...query, ...body };
    const mode = (typeof src.mode === "string" ? src.mode : "txt") as "txt" | "pdf" | "hocr" | "tsv";
    if (!["txt", "pdf", "hocr", "tsv"].includes(mode)) throw badRequest(`mode must be txt/pdf/hocr/tsv`);
    const lang = typeof src.lang === "string" ? src.lang : "eng";
    const urlIn = typeof src.url === "string" ? src.url : undefined;
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file && !urlIn) throw badRequest("Provide a 'file' upload or a 'url'");
    const forceAsync = booleanParam(src.async, "async") === true;
    const forceSync = booleanParam(src.sync, "sync") === true;
    const nocache = booleanParam(src.nocache, "nocache") === true;
    if (urlIn) await assertSafeUrl(urlIn);

    log.info(`POST /api/ocr mode=${mode} lang=${lang} url=${urlIn ?? ""} file=${file?.originalname ?? ""}`);

    const fileBytes = file ? new Uint8Array(file.buffer) : undefined;
    const uploadedExt = file?.originalname.split(".").pop()?.toLowerCase();
    const estimate = estimateMs({ kind: "ocr", bytes: fileBytes?.byteLength });
    const cacheKey = nocache
      ? ""
      : resultCache.key("ocr", {
          mode,
          lang,
          hash: fileBytes ? hashBytes(fileBytes) : undefined,
          url: urlIn,
        });
    if (cacheKey && !forceAsync) {
      const hit = await resultCache.get(cacheKey);
      if (hit) {
        inc("ocr_cache_hits_total", {});
        res.setHeader("content-type", hit.contentType);
        res.setHeader("content-disposition", contentDispositionHeader(hit.fileName));
        res.send(Buffer.from(hit.bytes));
        return;
      }
    }
    if (!(await tesseractAvailable())) {
      throw new ApiError(
        503,
        "tesseract not installed. Install it or use the Docker image, which includes Tesseract OCR.",
      );
    }
    const shouldAsync = !forceSync && (forceAsync || estimate > INLINE_THRESHOLD_MS);

    const worker = async (_setProgress: (n: number) => void, signal: AbortSignal) => {
      let bytes: Uint8Array | undefined = fileBytes;
      let fileExt = uploadedExt;
      if (!bytes) {
        const dl = await downloadUrl(urlIn!, { signal });
        bytes = dl.bytes;
        fileExt = dl.fileName.split(".").pop()?.toLowerCase();
      }
      const result = await ocr({ bytes, fileExt, mode, lang, signal });
      const payload = { bytes: result.bytes, contentType: result.contentType, fileName: result.fileName };
      if (cacheKey) await resultCache.set(cacheKey, payload);
      return payload;
    };

    if (shouldAsync) {
      const job = spawnJob({
        kind: "ocr",
        estimateMs: estimate,
        input: { mode, lang, fileExt: uploadedExt, url: urlIn },
        worker: async ({ setProgress, signal }) => worker(setProgress, signal),
      });
      inc("ocr_jobs_total", { mode: "async" });
      res.status(202).json(jobAcceptedPayload(req, job));
      return;
    }

    inc("ocr_jobs_total", { mode: "sync" });
    const job = spawnJob({
      kind: "ocr",
      estimateMs: estimate,
      input: { mode, lang, fileExt: uploadedExt, url: urlIn },
      worker: async ({ setProgress, signal }) => worker(setProgress, signal),
    });
    const finished = await waitForJob(job.id, Math.max(20_000, estimate * 5));
    if (finished.status === "failed") throw jobFailure(finished, "OCR failed");
    const internal = getJobWithBytes(job.id);
    if (!internal?.result) throw new ApiError(500, "Result vanished");
    res.setHeader("content-type", internal.result.contentType);
    res.setHeader("content-disposition", contentDispositionHeader(internal.result.fileName));
    res.send(Buffer.from(internal.result.bytes));
  } catch (e) {
    next(e);
  }
});

import { createHash } from "node:crypto";
function hashBytes(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}
