import { Router, type Request } from "express";
import multer from "multer";
import { transcribe, whisperCliAvailable } from "../lib/transcribe.ts";
import { assertSafeUrl, downloadUrl } from "../lib/download.ts";
import { ytdlpAvailable, ytdlpFetch } from "../lib/ytdlp.ts";
import { isYouTubeUrl } from "../lib/youtube.ts";
import { ApiError, badRequest } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { resultCache } from "../lib/cache.ts";
import { estimateMs } from "../lib/estimate.ts";
import { INLINE_THRESHOLD_MS, spawnJob, waitForJob, getJobWithBytes } from "../lib/jobs.ts";
import { inc } from "../lib/metrics.ts";
import { jobAcceptedPayload, jobFailure } from "../lib/jobHttp.ts";
import { booleanParam } from "../lib/params.ts";
import { contentDispositionHeader } from "./_disposition.ts";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
});

export const transcribeRouter: Router = Router();

transcribeRouter.get("/api/transcribe/status", async (_req, res) => {
  res.json({
    openai: !!process.env.OPENAI_API_KEY,
    whisperCli: await whisperCliAvailable(),
    summarize: !!process.env.ANTHROPIC_API_KEY,
    ytdlp: await ytdlpAvailable(),
  });
});

transcribeRouter.post("/api/transcribe", upload.single("file"), async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const query = (req.query || {}) as Record<string, unknown>;
    const src = { ...query, ...body };
    const lang = typeof src.language === "string" ? src.language : undefined;
    const summarize = booleanParam(src.summarize, "summarize") === true;
    const urlIn = typeof src.url === "string" ? src.url : undefined;
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file && !urlIn) throw badRequest("Provide a 'file' upload or a 'url'");
    const forceAsync = booleanParam(src.async, "async") === true;
    const forceSync = booleanParam(src.sync, "sync") === true;
    if (urlIn) await assertSafeUrl(urlIn);
    if (!process.env.OPENAI_API_KEY && !(await whisperCliAvailable())) {
      throw new ApiError(
        503,
        "No speech-to-text backend available. Set OPENAI_API_KEY or install whisper.",
      );
    }
    if (summarize && !process.env.ANTHROPIC_API_KEY) {
      throw new ApiError(503, "summarize=true requires ANTHROPIC_API_KEY");
    }
    if (urlIn && isYouTubeUrl(urlIn) && !(await ytdlpAvailable())) {
      throw new ApiError(503, "Transcribing a YouTube URL requires yt-dlp");
    }

    log.info(`POST /api/transcribe lang=${lang ?? "auto"} summarize=${summarize} url=${urlIn ?? ""}`);

    const estimate = estimateMs({ kind: "transcribe" });
    const shouldAsync = !forceSync && (forceAsync || estimate > INLINE_THRESHOLD_MS);

    const fetchInput = async (signal: AbortSignal): Promise<{ bytes: Uint8Array; ext: string }> => {
      if (file) {
        return {
          bytes: new Uint8Array(file.buffer),
          ext: (file.originalname.split(".").pop() || "mp3").toLowerCase(),
        };
      }
      if (urlIn && isYouTubeUrl(urlIn) && (await ytdlpAvailable())) {
        const yt = await ytdlpFetch({ url: urlIn, format: "mp3", signal });
        return { bytes: yt.bytes, ext: "mp3" };
      }
      const dl = await downloadUrl(urlIn!, { signal });
      const ext = (dl.fileName.split(".").pop() || "mp3").toLowerCase();
      return { bytes: dl.bytes, ext };
    };

    const worker = async (setProgress: (n: number) => void, signal: AbortSignal) => {
      setProgress(0.1);
      const input = await fetchInput(signal);
      setProgress(0.4);
      const result = await transcribe({
        bytes: input.bytes,
        fileExt: input.ext,
        language: lang,
        summarize,
        signal,
      });
      const json = JSON.stringify(result, null, 2);
      return {
        bytes: new Uint8Array(Buffer.from(json, "utf8")),
        contentType: "application/json",
        fileName: "transcript.json",
        metadata: { backend: result.backend, language: result.language, hasSummary: !!result.summary },
      };
    };

    if (shouldAsync) {
      const job = spawnJob({
        kind: "transcribe",
        estimateMs: estimate,
        input: { url: urlIn, lang, summarize },
        worker: async ({ setProgress, signal }) => worker(setProgress, signal),
      });
      inc("transcribe_jobs_total", { mode: "async" });
      res.status(202).json(jobAcceptedPayload(req, job));
      return;
    }

    inc("transcribe_jobs_total", { mode: "sync" });
    const job = spawnJob({
      kind: "transcribe",
      estimateMs: estimate,
      input: { url: urlIn, lang, summarize },
      worker: async ({ setProgress, signal }) => worker(setProgress, signal),
    });
    const finished = await waitForJob(job.id, Math.max(60_000, estimate * 5));
    if (finished.status === "failed") throw jobFailure(finished, "Transcription failed");
    const internal = getJobWithBytes(job.id);
    if (!internal?.result) throw new ApiError(500, "Result vanished");
    res.setHeader("content-type", internal.result.contentType);
    res.setHeader("content-disposition", contentDispositionHeader(internal.result.fileName));
    res.send(Buffer.from(internal.result.bytes));
  } catch (e) {
    next(e);
  }
});

void resultCache; // reserved for future per-bytes-hash caching
