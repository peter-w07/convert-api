/**
 * Lightweight server smoke tests. Spins up the Express app on a free port and
 * exercises each endpoint family. Skips browser-driven cases if Chromium isn't
 * available or the network blocks the test URL.
 *
 * Run with: `bun run test:server` (or `tsx test/server/run.ts`).
 */

import { createServer } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { healthRouter } from "../../server/routes/health.ts";
import { formatsRouter, formatsUpdateRouter } from "../../server/routes/formats.ts";
import { screenshotRouter } from "../../server/routes/screenshot.ts";
import { convertRouter } from "../../server/routes/convert.ts";
import { batchRouter } from "../../server/routes/batch.ts";
import { ytdlpRouter } from "../../server/routes/ytdlp.ts";
import { ocrRouter } from "../../server/routes/ocr.ts";
import { transcribeRouter } from "../../server/routes/transcribe.ts";
import { jobsRouter } from "../../server/routes/jobs.ts";
import { metricsRouter } from "../../server/routes/metrics.ts";
import { docsRouter } from "../../server/openapi.ts";
import { metricsMiddleware } from "../../server/lib/metrics.ts";
import { ApiError } from "../../server/lib/errors.ts";
import { closeBrowser } from "../../server/lib/browser.ts";
import { isYouTubeUrl, youtubeVideoId } from "../../server/lib/youtube.ts";
import { assertSafeUrl, sanitizeFilename } from "../../server/lib/download.ts";
import { convertImage, normalizeSharpFormat } from "../../server/lib/sharpConvert.ts";
import { getJobWithBytes, jobs, spawnJob, waitForJob } from "../../server/lib/jobs.ts";
import { ffmpegAvailable } from "../../server/lib/mediaPdf.ts";

interface TestCase {
  name: string;
  run: () => Promise<void>;
}

const results: Array<{ name: string; status: "pass" | "fail" | "skip"; message?: string }> = [];

function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function makeFixturePng(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .png()
    .toBuffer();
}

async function imageSize(bytes: Uint8Array): Promise<{ width?: number; height?: number }> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(bytes).metadata();
  return { width: meta.width, height: meta.height };
}

async function startApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(metricsMiddleware());
  app.use(healthRouter);
  app.use(formatsRouter);
  app.use(formatsUpdateRouter);
  app.use(screenshotRouter);
  app.use(convertRouter);
  app.use(batchRouter);
  app.use(ytdlpRouter);
  app.use(ocrRouter);
  app.use(transcribeRouter);
  app.use(jobsRouter);
  app.use(metricsRouter);
  app.use(docsRouter);
  app.use("/convert", express.static(resolve(process.cwd(), "dist"), { index: "index.html" }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      typeof err.code === "string" &&
      err.code.startsWith("LIMIT_")
    ) {
      res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error: err instanceof Error ? err.message : "Invalid multipart upload",
      });
      return;
    }
    if (err && typeof err === "object") {
      const status = Number("status" in err ? err.status : "statusCode" in err ? err.statusCode : 0);
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        res.status(status).json({ error: err instanceof Error ? err.message : "Invalid request" });
        return;
      }
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((res) => {
        server.close(() => res());
        server.closeAllConnections();
      }),
  };
}

interface JobDescriptor {
  jobId: string;
  kind: string;
  estimateMs: number;
  statusUrl: string;
  resultUrl: string;
  streamUrl: string;
  pollAfterMs: number;
}

async function expectJob(response: Response, kind?: string): Promise<JobDescriptor> {
  eq(response.status, 202, "job accepted status");
  const job = (await response.json()) as JobDescriptor;
  ok(/^[0-9a-f-]{36}$/i.test(job.jobId), "jobId is a uuid");
  if (kind) eq(job.kind, kind, "job kind");
  ok(job.estimateMs > 0, "estimate positive");
  ok(job.statusUrl.endsWith(job.jobId), "status url");
  ok(job.resultUrl.endsWith("/result"), "result url");
  ok(job.streamUrl.endsWith("/stream"), "stream url");
  ok(job.pollAfterMs >= 200, "pollAfterMs");
  return job;
}

async function inlineOrJob(response: Response, timeoutMs = 180_000): Promise<Response> {
  if (response.status !== 202) return response;
  const job = (await response.json()) as JobDescriptor;
  return fetch(`${job.resultUrl}?wait=true&timeoutMs=${timeoutMs}`);
}

async function probe(url: string): Promise<boolean> {
  // Reachable if the host accepts our connection AND isn't blocked by a sandbox
  // policy (CI environments often deny outbound to most hosts).
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(url, { method: "HEAD", signal: ctl.signal });
      if (r.headers.get("x-deny-reason")) return false;
      // 2xx/3xx → fine. 4xx/5xx usually means the host *is* up; trust it.
      return r.status >= 100 && r.status < 500;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // Cert errors / TLS issues still indicate the host is up; only treat
    // ECONNREFUSED, ENOTFOUND, and timeouts as unreachable.
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    if (msg.includes("certificate") || msg.includes("ssl") || msg.includes("tls")) return true;
    return false;
  }
}

async function run(): Promise<void> {
  const { baseUrl, close } = await startApp();
  const cases: TestCase[] = [
    {
      name: "GET /health returns ok",
      run: async () => {
        const r = await fetch(`${baseUrl}/health`);
        eq(r.status, 200, "status");
        const j = (await r.json()) as {
          ok: boolean;
          capabilities: { browserConverter: boolean; ytdlp: boolean; tesseract: boolean };
          cache: { enabled: boolean };
          browserPool: { active: number };
        };
        ok(j.ok === true, "ok flag");
        ok(typeof j.capabilities?.browserConverter === "boolean", "capabilities.browserConverter type");
        ok(typeof j.capabilities?.ytdlp === "boolean", "capabilities.ytdlp type");
        ok(typeof j.capabilities?.tesseract === "boolean", "capabilities.tesseract type");
        ok(typeof j.cache?.enabled === "boolean", "cache.enabled type");
        ok(typeof j.browserPool?.active === "number", "browserPool.active type");
      },
    },
    {
      name: "GET /api/formats returns native formats",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/formats`);
        eq(r.status, 200, "status");
        const j = (await r.json()) as { count: number; formats: Array<{ format: string }> };
        ok(j.count >= 7, "at least 7 native formats");
        ok(j.formats.some((f) => f.format === "png"), "includes png");
        if (existsSync(resolve(process.cwd(), "dist", "cache.json"))) {
          ok(j.count > 100, "built converter exposes the full format graph");
        }
      },
    },
    {
      name: "GET /api/formats?category=image filters",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/formats?category=image`);
        const j = (await r.json()) as { formats: Array<{ category?: string | string[] }> };
        ok(
          j.formats.every((f) => {
            const cats = Array.isArray(f.category) ? f.category : f.category ? [f.category] : [];
            return cats.includes("image");
          }),
          "all in image category",
        );
      },
    },
    {
      name: "GET /api/formats rejects invalid direction",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/formats?direction=sideways`);
        eq(r.status, 400, "status");
      },
    },
    {
      name: "POST /api/screenshot rejects missing url",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/screenshot`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        eq(r.status, 400, "status");
      },
    },
    {
      name: "Malformed JSON returns 400",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/screenshot`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not-json}",
        });
        eq(r.status, 400, "status");
      },
    },
    {
      name: "POST /api/screenshot rejects unknown format",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/screenshot`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com", format: "tiff" }),
        });
        eq(r.status, 400, "status");
      },
    },
    {
      name: "POST /api/screenshot rejects private IPs (SSRF guard)",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/screenshot`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "http://127.0.0.1/" }),
        });
        eq(r.status, 400, "status");
        const j = (await r.json()) as { error: string };
        ok(/private IP|Refusing/.test(j.error), "error mentions private IP");
      },
    },
    {
      name: "POST /api/screenshot validates numeric options",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/screenshot`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com", width: -1 }),
        });
        eq(r.status, 400, "status");
      },
    },
    {
      name: "POST /api/screenshot validates resolution shorthand",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/screenshot`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com", resolution: "wide" }),
        });
        eq(r.status, 400, "status");
        const j = (await r.json()) as { error: string };
        ok(j.error.includes("resolution"), "error mentions resolution");
      },
    },
    {
      name: "POST /api/convert rejects missing inputs",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/convert?sync=true&nocache=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: "png" }),
        });
        eq(r.status, 400, "status");
      },
    },
    {
      name: "POST /api/convert rejects missing 'to'",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/convert`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com" }),
        });
        eq(r.status, 400, "status");
      },
    },
    {
      name: "POST /api/convert validates quality",
      run: async () => {
        const png = await makeFixturePng();
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "fixture.png");
        form.set("to", "jpeg");
        form.set("quality", "101");
        const r = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
        eq(r.status, 400, "status");
      },
    },
    {
      name: "POST /api/convert rejects an unexpected upload field",
      run: async () => {
        const png = await makeFixturePng();
        const form = new FormData();
        form.set("wrongField", new Blob([new Uint8Array(png)], { type: "image/png" }), "fixture.png");
        form.set("to", "webp");
        const r = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
        eq(r.status, 400, "status");
      },
    },
    {
      name: "POST /api/convert (file PNG → WEBP) via sharp",
      run: async () => {
        const png = await makeFixturePng();
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "fixture.png");
        form.set("to", "webp");
        form.set("quality", "85");
        const r = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "image/webp", "content-type");
        const buf = await r.arrayBuffer();
        // WEBP signature: RIFF .... WEBP
        const u = new Uint8Array(buf);
        const sig = String.fromCharCode(u[0], u[1], u[2], u[3]) + String.fromCharCode(u[8], u[9], u[10], u[11]);
        eq(sig, "RIFFWEBP", "webp magic");
      },
    },
    {
      name: "POST /api/convert (file PNG → JPEG with resize) via sharp",
      run: async () => {
        const png = await makeFixturePng();
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "fixture.png");
        form.set("to", "jpeg");
        form.set("width", "16");
        const r = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "image/jpeg", "content-type");
        const buf = await r.arrayBuffer();
        const u = new Uint8Array(buf);
        // JPEG signature
        ok(u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff, "jpeg magic");
      },
    },
    {
      name: "POST /api/convert accepts resolution shorthand",
      run: async () => {
        const png = await makeFixturePng();
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "fixture.png");
        form.set("to", "png");
        form.set("resolution", "16x16");
        const r = await fetch(`${baseUrl}/api/convert`, { method: "POST", body: form });
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "image/png", "content-type");
        const size = await imageSize(new Uint8Array(await r.arrayBuffer()));
        eq(size.width, 16, "width");
        eq(size.height, 16, "height");
      },
    },
    {
      name: "POST /api/convert (file PNG -> PDF) via native PDF wrapper",
      run: async () => {
        const png = await makeFixturePng();
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "fixture.png");
        form.set("to", "pdf");
        const r = await inlineOrJob(await fetch(`${baseUrl}/api/convert?nocache=true`, { method: "POST", body: form }));
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "application/pdf", "content-type");
        const u = new Uint8Array(await r.arrayBuffer());
        eq(new TextDecoder().decode(u.slice(0, 4)), "%PDF", "pdf magic");
      },
    },
    {
      name: "youtube utils detect YouTube URLs and extract ids",
      run: async () => {
        ok(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "watch");
        ok(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), "youtu.be");
        ok(isYouTubeUrl("https://m.youtube.com/shorts/dQw4w9WgXcQ"), "shorts");
        ok(!isYouTubeUrl("https://example.com"), "non-yt");
        eq(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ", "watch id");
        eq(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?si=foo"), "dQw4w9WgXcQ", "youtu.be id");
        eq(youtubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ", "embed id");
        eq(youtubeVideoId("https://example.com"), null, "non-yt id null");
      },
    },
    {
      name: "assertSafeUrl rejects bad protocols and private hosts",
      run: async () => {
        await assertSafeUrl("https://example.com");
        let threw = false;
        try { await assertSafeUrl("file:///etc/passwd"); } catch { threw = true; }
        ok(threw, "file:// rejected");
        threw = false;
        try { await assertSafeUrl("http://127.0.0.1/"); } catch { threw = true; }
        ok(threw, "loopback rejected");
        threw = false;
        try { await assertSafeUrl("http://169.254.169.254/"); } catch { threw = true; }
        ok(threw, "link-local rejected");
      },
    },
    {
      name: "GET /metrics returns Prometheus format",
      run: async () => {
        const r = await fetch(`${baseUrl}/metrics`);
        eq(r.status, 200, "status");
        const text = await r.text();
        ok(text.includes("# HELP convert_api_jobs_state"), "has job state metric");
        ok(text.includes("# TYPE"), "has type lines");
      },
    },
    {
      name: "GET /openapi.json returns valid spec",
      run: async () => {
        const r = await fetch(`${baseUrl}/openapi.json`);
        eq(r.status, 200, "status");
        const json = (await r.json()) as { openapi: string; paths: Record<string, unknown> };
        ok(json.openapi.startsWith("3."), "openapi version");
        const expected: Record<string, string[]> = {
          "/health": ["get"],
          "/metrics": ["get"],
          "/api/formats": ["get"],
          "/api/formats/changes": ["get"],
          "/api/formats/stream": ["get"],
          "/api/subscriptions/formats": ["get", "post"],
          "/api/subscriptions/formats/{id}": ["delete"],
          "/api/screenshot": ["get", "post"],
          "/api/convert": ["post"],
          "/api/convert/batch": ["post"],
          "/api/ytdlp": ["post"],
          "/api/ytdlp/status": ["get"],
          "/api/ocr": ["post"],
          "/api/ocr/status": ["get"],
          "/api/transcribe": ["post"],
          "/api/transcribe/status": ["get"],
          "/api/jobs": ["get"],
          "/api/jobs/{id}": ["get", "delete"],
          "/api/jobs/{id}/result": ["get"],
          "/api/jobs/{id}/stream": ["get"],
        };
        for (const [path, methods] of Object.entries(expected)) {
          const item = json.paths[path] as Record<string, unknown> | undefined;
          ok(item, `${path} documented`);
          for (const method of methods) ok(method in item, `${method.toUpperCase()} ${path} documented`);
        }
      },
    },
    {
      name: "GET /docs serves Swagger UI",
      run: async () => {
        const r = await fetch(`${baseUrl}/docs`);
        eq(r.status, 200, "status");
        const html = await r.text();
        ok(html.includes("SwaggerUIBundle"), "swagger bundle");
        ok(html.includes("/openapi.json"), "loads spec");
      },
    },
    {
      name: "Async convert job descriptor/result/SSE/list/delete lifecycle",
      run: async () => {
        const png = await makeFixturePng();
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "fixture.png");
        form.set("to", "webp");
        const job = await expectJob(
          await fetch(`${baseUrl}/api/convert?async=true&nocache=true`, { method: "POST", body: form }),
          "sharp",
        );
        const result = await fetch(`${job.resultUrl}?wait=true&timeoutMs=30000`);
        eq(result.status, 200, "result status");
        eq(result.headers.get("content-type"), "image/webp", "result content-type");
        const stream = await fetch(job.streamUrl);
        eq(stream.status, 200, "stream status");
        const streamText = await stream.text();
        ok(streamText.includes("event: snapshot"), "stream snapshot");
        ok(streamText.includes("event: done"), "completed stream closes with done");
        const s = await fetch(job.statusUrl);
        eq(s.status, 200, "snapshot status");
        const snap = (await s.json()) as { id: string; status: string };
        eq(snap.id, job.jobId, "snapshot id");
        eq(snap.status, "complete", "snapshot complete");
        const list = await fetch(`${baseUrl}/api/jobs?status=complete&kind=sharp`);
        const listed = (await list.json()) as { jobs: Array<{ id: string }> };
        ok(listed.jobs.some((item) => item.id === job.jobId), "job list filters include job");
        const del = await fetch(job.statusUrl, { method: "DELETE" });
        eq(del.status, 200, "delete completed job");
        eq((await fetch(job.statusUrl)).status, 404, "deleted job is gone");
      },
    },
    {
      name: "GET /api/jobs/:id returns 404 for unknown",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/jobs/00000000-0000-0000-0000-000000000000`);
        eq(r.status, 404, "status");
      },
    },
    {
      name: "GET /api/jobs rejects an invalid status filter",
      run: async () => {
        eq((await fetch(`${baseUrl}/api/jobs?status=surprise`)).status, 400, "status");
      },
    },
    {
      name: "Jobs preserve ApiError status through the result endpoint",
      run: async () => {
        const job = spawnJob({
          kind: "test-error",
          estimateMs: 1,
          worker: async () => {
            throw new ApiError(415, "unsupported test conversion");
          },
        });
        await waitForJob(job.id, 5_000);
        const result = await fetch(`${baseUrl}/api/jobs/${job.id}/result`);
        eq(result.status, 415, "preserved status");
        const json = (await result.json()) as { error: string };
        eq(json.error, "unsupported test conversion", "preserved message");
        jobs.delete(job.id);
      },
    },
    {
      name: "Cancelled jobs stay cancelled and discard late results",
      run: async () => {
        const job = spawnJob({
          kind: "test-cancel",
          estimateMs: 100,
          worker: async ({ setProgress }) => {
            await wait(75);
            setProgress(0.9);
            return { bytes: new Uint8Array([1]), contentType: "application/octet-stream", fileName: "late.bin" };
          },
        });
        ok(jobs.cancel(job.id), "cancel succeeds");
        await wait(125);
        eq(jobs.get(job.id)?.status, "cancelled", "status remains cancelled");
        eq(jobs.get(job.id)?.progress, 0, "progress remains frozen after cancellation");
        ok(!getJobWithBytes(job.id)?.result, "late result discarded");
        eq((await fetch(`${baseUrl}/api/jobs/${job.id}/result`)).status, 409, "cancelled result status");
        jobs.delete(job.id);
      },
    },
    {
      name: "POST /api/convert/batch (inline) zips multiple sharp conversions",
      run: async () => {
        const png = await makeFixturePng();
        const form = new FormData();
        form.append("files", new Blob([new Uint8Array(png)], { type: "image/png" }), "a.png");
        form.append("files", new Blob([new Uint8Array(png)], { type: "image/png" }), "b.png");
        form.set("items", JSON.stringify([
          { fileIndex: 0, to: "webp", quality: 80 },
          { fileIndex: 1, to: "jpeg", resolution: "16x16" },
        ]));
        form.set("sync", "true");
        const r = await fetch(`${baseUrl}/api/convert/batch`, { method: "POST", body: form });
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "application/zip", "content-type");
        const u = new Uint8Array(await r.arrayBuffer());
        // ZIP signature: PK\x03\x04
        ok(u[0] === 0x50 && u[1] === 0x4b && u[2] === 0x03 && u[3] === 0x04, "zip magic");
      },
    },
    {
      name: "POST /api/convert/batch validates items and URL safety before starting",
      run: async () => {
        const missingTo = await fetch(`${baseUrl}/api/convert/batch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: [{}] }),
        });
        eq(missingTo.status, 400, "missing to status");
        const unsafeUrl = await fetch(`${baseUrl}/api/convert/batch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: [{ url: "http://127.0.0.1/file.png", to: "webp" }] }),
        });
        eq(unsafeUrl.status, 400, "unsafe URL status");
      },
    },
    {
      name: "Format subscription lifecycle (create / list / delete)",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/subscriptions/formats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com/hook", secret: "xyz", events: ["added"] }),
        });
        eq(r.status, 201, "create status");
        const created = (await r.json()) as { id: string; events: string[] };
        ok(created.events.includes("added"), "filter respected");
        const list = await fetch(`${baseUrl}/api/subscriptions/formats`);
        const listed = (await list.json()) as { subscriptions: Array<{ id: string; secret?: string }> };
        const me = listed.subscriptions.find((s) => s.id === created.id);
        ok(me !== undefined, "in listing");
        eq(me!.secret, "***", "secret masked");
        const del = await fetch(`${baseUrl}/api/subscriptions/formats/${created.id}`, { method: "DELETE" });
        eq(del.status, 200, "delete status");
        const del2 = await fetch(`${baseUrl}/api/subscriptions/formats/${created.id}`, { method: "DELETE" });
        eq(del2.status, 404, "second delete 404");
      },
    },
    {
      name: "Format subscription rejects invalid URL",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/subscriptions/formats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "notaurl" }),
        });
        eq(r.status, 400, "status");
      },
    },
    {
      name: "Format subscription rejects private callback URLs and invalid events",
      run: async () => {
        const privateUrl = await fetch(`${baseUrl}/api/subscriptions/formats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "http://127.0.0.1/hook" }),
        });
        eq(privateUrl.status, 400, "private callback status");
        const invalidEvents = await fetch(`${baseUrl}/api/subscriptions/formats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com/hook", events: ["surprise"] }),
        });
        eq(invalidEvents.status, 400, "invalid events status");
      },
    },
    {
      name: "GET /api/formats/changes returns array",
      run: async () => {
        // Touch /api/formats first so the snapshot exists / diff has fired.
        await fetch(`${baseUrl}/api/formats`);
        const r = await fetch(`${baseUrl}/api/formats/changes`);
        eq(r.status, 200, "status");
        const j = (await r.json()) as { changes: Array<{ type: string }> };
        ok(Array.isArray(j.changes), "is array");
      },
    },
    {
      name: "GET /api/formats/stream emits an initial SSE event",
      run: async () => {
        const ctl = new AbortController();
        const r = await fetch(`${baseUrl}/api/formats/stream`, { signal: ctl.signal });
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "text/event-stream", "content-type");
        const reader = r.body?.getReader();
        ok(reader, "stream reader");
        const first = await reader.read();
        const text = new TextDecoder().decode(first.value);
        ok(text.includes("event: hello"), "hello event");
        await reader.cancel();
        ctl.abort();
      },
    },
    {
      name: "Capability status endpoints respond",
      run: async () => {
        for (const path of ["/api/ytdlp/status", "/api/ocr/status", "/api/transcribe/status"]) {
          const r = await fetch(`${baseUrl}${path}`);
          eq(r.status, 200, `${path} status`);
          const j = (await r.json()) as Record<string, unknown>;
          ok(typeof j === "object", `${path} json`);
        }
      },
    },
    {
      name: "yt-dlp endpoint returns 503 when not installed",
      run: async () => {
        const status = (await (await fetch(`${baseUrl}/api/ytdlp/status`)).json()) as { available: boolean };
        if (status.available) return;
        // Force sync so we hit the worker (and the 503) inline.
        const r = await fetch(`${baseUrl}/api/ytdlp?sync=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", format: "mp3" }),
        });
        // Missing backend is reported directly, not buried in a failed job.
        eq(r.status, 503, "status");
      },
    },
    {
      name: "Integration endpoints validate inputs and unavailable backends",
      run: async () => {
        const unsafeYtdlp = await fetch(`${baseUrl}/api/ytdlp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "http://127.0.0.1/video" }),
        });
        eq(unsafeYtdlp.status, 400, "yt-dlp SSRF status");
        eq((await fetch(`${baseUrl}/api/ocr`, { method: "POST" })).status, 400, "ocr missing input");
        eq((await fetch(`${baseUrl}/api/transcribe`, { method: "POST" })).status, 400, "transcribe missing input");

        const ocrStatus = (await (await fetch(`${baseUrl}/api/ocr/status`)).json()) as { available: boolean };
        if (!ocrStatus.available) {
          const png = await makeFixturePng();
          const form = new FormData();
          form.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "fixture.png");
          eq((await fetch(`${baseUrl}/api/ocr`, { method: "POST", body: form })).status, 503, "ocr unavailable");
        }

        const transcribeStatus = (await (await fetch(`${baseUrl}/api/transcribe/status`)).json()) as {
          openai: boolean;
          whisperCli: boolean;
        };
        if (!transcribeStatus.openai && !transcribeStatus.whisperCli) {
          const form = new FormData();
          form.set("file", new Blob([new Uint8Array([0, 1, 2])], { type: "audio/mpeg" }), "fixture.mp3");
          eq(
            (await fetch(`${baseUrl}/api/transcribe`, { method: "POST", body: form })).status,
            503,
            "transcribe unavailable",
          );
        }
      },
    },
    {
      name: "sanitizeFilename blocks CR/LF and traversal",
      run: async () => {
        eq(sanitizeFilename("normal.png"), "normal.png", "passthrough");
        // Path separators replaced with `_` and leading dots stripped — no traversal possible.
        ok(!sanitizeFilename("../../etc/passwd").includes("/"), "no forward slash");
        ok(!sanitizeFilename("../../etc/passwd").includes("\\"), "no backslash");
        ok(!sanitizeFilename("../../etc/passwd").startsWith("."), "no leading dot");
        const crlf = sanitizeFilename("x\r\nSet-Cookie: a=1");
        ok(!/[\r\n]/.test(crlf), "no CR/LF");
        ok(!sanitizeFilename("..\\..\\..\\nt.bat").includes("\\"), "no backslash (win)");
        eq(sanitizeFilename(""), "download.bin", "empty");
        ok(sanitizeFilename("a".repeat(500) + ".png").endsWith(".png"), "preserves ext when capped");
        ok(sanitizeFilename("a".repeat(500) + ".png").length <= 200, "length capped");
      },
    },
    {
      name: "sharp format normalizer",
      run: async () => {
        eq(normalizeSharpFormat("png"), "png", "png");
        eq(normalizeSharpFormat("JPG"), "jpeg", "jpg→jpeg");
        eq(normalizeSharpFormat("jpeg"), "jpeg", "jpeg");
        eq(normalizeSharpFormat("heic"), "heif", "heic→heif");
        eq(normalizeSharpFormat("nope"), null, "unknown");
      },
    },
    {
      name: "sharp direct API converts PNG → JPEG bytes",
      run: async () => {
        const png = await makeFixturePng();
        const res = await convertImage({ bytes: new Uint8Array(png), to: "jpeg", quality: 80 });
        ok(res !== null, "got result");
        eq(res!.contentType, "image/jpeg", "content-type");
        ok(res!.bytes[0] === 0xff && res!.bytes[1] === 0xd8, "jpeg magic");
      },
    },
    {
      name: "POST /api/convert uses the built browser converter fallback",
      run: async () => {
        ok(existsSync(resolve(process.cwd(), "dist", "index.html")), "dist/index.html exists");
        const markdown = await readFile(resolve(process.cwd(), "test", "resources", "markdown.md"));
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(markdown)], { type: "text/markdown" }), "fixture.md");
        form.set("to", "html");
        const r = await fetch(`${baseUrl}/api/convert?sync=true&nocache=true`, {
          method: "POST",
          headers: { "x-forwarded-host": "127.0.0.1:1", "x-forwarded-proto": "http" },
          body: form,
        });
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "text/html", "content-type");
        ok((await r.text()).includes("<"), "html output");
      },
    },
    {
      name: "POST /api/convert/batch supports browser-converter targets",
      run: async () => {
        const markdown = await readFile(resolve(process.cwd(), "test", "resources", "markdown.md"));
        const form = new FormData();
        form.set("files", new Blob([new Uint8Array(markdown)], { type: "text/markdown" }), "fixture.md");
        form.set("items", JSON.stringify([
          { fileIndex: 0, to: "html" },
          { fileIndex: 0, to: "png" },
        ]));
        form.set("sync", "true");
        const r = await fetch(`${baseUrl}/api/convert/batch`, { method: "POST", body: form });
        eq(r.status, 200, "status");
        const JSZip = (await import("jszip")).default;
        const zip = await JSZip.loadAsync(await r.arrayBuffer());
        const names = Object.keys(zip.files);
        ok(names.some((name) => name.endsWith(".html")), "contains converted HTML");
        ok(names.some((name) => name.endsWith(".png")), "contains converted PNG via fallback");
        ok(!names.some((name) => name.startsWith("error_")), "contains no item error");
      },
    },
  ];

  // Browser-driven optional cases: only run if example.com is reachable.
  const exampleReachable = await probe("https://example.com");
  const wikimediaReachable = await probe("https://upload.wikimedia.org/");
  const brokenHttpsFallbackReachable = await probe("http://goole.com");
  if (await ffmpegAvailable()) {
    cases.push({
      name: "POST /api/convert (file MP4 -> PDF) via native poster frame",
      run: async () => {
        const mp4 = await readFile(resolve(process.cwd(), "test", "resources", "doom.mp4"));
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(mp4)], { type: "video/mp4" }), "doom.mp4");
        form.set("to", "pdf");
        const r = await inlineOrJob(await fetch(`${baseUrl}/api/convert?nocache=true`, { method: "POST", body: form }));
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "application/pdf", "content-type");
        const u = new Uint8Array(await r.arrayBuffer());
        eq(new TextDecoder().decode(u.slice(0, 4)), "%PDF", "pdf magic");
      },
    });
  } else {
    results.push({ name: "POST /api/convert (file MP4 -> PDF) via native poster frame", status: "skip", message: "ffmpeg not installed" });
  }
  if (wikimediaReachable) {
    cases.push({
      name: "POST /api/convert (image URL → WEBP) downloads then transcodes via sharp",
      run: async () => {
        const r = await inlineOrJob(await fetch(`${baseUrl}/api/convert?nocache=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png",
            to: "webp",
            quality: 70,
          }),
        }));
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "image/webp", "content-type");
        const u = new Uint8Array(await r.arrayBuffer());
        const sig = String.fromCharCode(u[0], u[1], u[2], u[3]) + String.fromCharCode(u[8], u[9], u[10], u[11]);
        eq(sig, "RIFFWEBP", "webp magic — should be transcoded, not screenshotted");
      },
    });
  }

  if (exampleReachable) {
    cases.push({
      name: "POST /api/screenshot renders example.com to PNG",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/screenshot?sync=true&nocache=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com", format: "png" }),
        });
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "image/png", "content-type");
        const buf = new Uint8Array(await r.arrayBuffer());
        ok(buf[0] === 0x89 && buf[1] === 0x50, "png magic");
      },
    });
    cases.push({
      name: "POST /api/screenshot accepts resolution shorthand",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/screenshot?sync=true&nocache=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com", format: "png", resolution: "640x360" }),
        });
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "image/png", "content-type");
        const size = await imageSize(new Uint8Array(await r.arrayBuffer()));
        eq(size.width, 640, "width");
        eq(size.height, 360, "height");
      },
    });
    cases.push({
      name: "GET /api/screenshot renders example.com to PNG",
      run: async () => {
        const params = new URLSearchParams({
          url: "https://example.com",
          format: "png",
          sync: "true",
          nocache: "true",
        });
        const r = await fetch(`${baseUrl}/api/screenshot?${params}`);
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "image/png", "content-type");
      },
    });
    cases.push({
      name: "POST /api/convert (url → png screenshot)",
      run: async () => {
        const r = await fetch(`${baseUrl}/api/convert?sync=true&nocache=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com", to: "png" }),
        });
        eq(r.status, 200, "status");
        eq(r.headers.get("content-type"), "image/png", "content-type");
      },
    });
    if (brokenHttpsFallbackReachable) {
      cases.push({
        name: "GET /api/screenshot falls back when a target does not speak HTTPS",
        run: async () => {
          const params = new URLSearchParams({
            url: "https://goole.com",
            format: "png",
            sync: "true",
            nocache: "true",
            timeoutMs: "60000",
          });
          const r = await fetch(`${baseUrl}/api/screenshot?${params}`);
          eq(r.status, 200, "status");
          eq(r.headers.get("content-type"), "image/png", "content-type");
          const buf = new Uint8Array(await r.arrayBuffer());
          ok(buf[0] === 0x89 && buf[1] === 0x50, "png magic");
        },
      });
    } else {
      results.push({ name: "broken HTTPS fallback case", status: "skip", message: "goole.com unreachable" });
    }
  } else {
    results.push({ name: "browser-driven cases", status: "skip", message: "example.com unreachable" });
  }

  for (const c of cases) {
    console.log(`  [RUN] ${c.name}`);
    try {
      await c.run();
      results.push({ name: c.name, status: "pass" });
    } catch (e) {
      results.push({ name: c.name, status: "fail", message: e instanceof Error ? e.message : String(e) });
    }
  }
  await close();
  await closeBrowser();
  await wait(50);
}

await run();

let passed = 0;
let failed = 0;
let skipped = 0;
for (const r of results) {
  const tag = r.status === "pass" ? "PASS" : r.status === "skip" ? "SKIP" : "FAIL";
  const line = `  [${tag}] ${r.name}${r.message ? " — " + r.message : ""}`;
  console.log(line);
  if (r.status === "pass") passed++;
  else if (r.status === "skip") skipped++;
  else failed++;
}
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
