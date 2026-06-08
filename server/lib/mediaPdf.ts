import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, unsupported } from "./errors.ts";
import { commandAvailable } from "./command.ts";

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "avif",
  "tif",
  "tiff",
  "heic",
  "heif",
  "svg",
  "bmp",
]);

const VIDEO_EXTS = new Set([
  "mp4",
  "m4v",
  "webm",
  "mov",
  "mkv",
  "avi",
  "wmv",
  "flv",
  "mpeg",
  "mpg",
  "3gp",
  "3g2",
  "ogv",
  "m2ts",
  "mts",
]);

export type PdfInputKind = "image" | "video";

export interface MediaPdfOptions {
  bytes: Uint8Array;
  fileName: string;
  fileExt?: string;
  inputKind: PdfInputKind;
  signal?: AbortSignal;
}

export interface MediaPdfResult {
  bytes: Uint8Array;
  contentType: "application/pdf";
  fileName: string;
}

export async function ffmpegAvailable(): Promise<boolean> {
  return commandAvailable(FFMPEG_BIN, ["-version"]);
}

export function classifyPdfInput(fileName?: string, mimeType?: string, fromExt?: string): PdfInputKind | null {
  const ext = (fromExt || extOf(fileName)).toLowerCase().replace(/^\./, "");
  const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (mime.startsWith("image/") || IMAGE_EXTS.has(ext)) return "image";
  if (mime.startsWith("video/") || VIDEO_EXTS.has(ext)) return "video";
  return null;
}

export async function convertMediaToPdf(opts: MediaPdfOptions): Promise<MediaPdfResult> {
  const jpeg =
    opts.inputKind === "image"
      ? await imageToJpeg(opts.bytes)
      : await extractVideoPosterJpeg(opts.bytes, opts.fileExt || extOf(opts.fileName), opts.signal);

  return {
    bytes: jpegToPdf(jpeg),
    contentType: "application/pdf",
    fileName: `${baseName(opts.fileName)}.pdf`,
  };
}

async function imageToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  let sharpMod: typeof import("sharp") | null = null;
  try {
    sharpMod = (await import("sharp")).default as unknown as typeof import("sharp");
  } catch {
    throw new ApiError(503, "sharp not installed; image-to-PDF conversion is unavailable.");
  }

  try {
    const sharp = sharpMod as unknown as (input: Uint8Array | Buffer, opts?: Record<string, unknown>) => import("sharp").Sharp;
    const out = await sharp(bytes, { animated: false }).rotate().jpeg({ quality: 90 }).toBuffer();
    return new Uint8Array(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw unsupported(`Input image could not be decoded for PDF output: ${msg}`);
  }
}

async function extractVideoPosterJpeg(bytes: Uint8Array, ext: string | undefined, signal?: AbortSignal): Promise<Uint8Array> {
  if (!(await ffmpegAvailable())) {
    throw new ApiError(
      503,
      "ffmpeg not installed; video-to-PDF conversion is unavailable. Install ffmpeg or use the Docker image.",
    );
  }

  const workdir = await mkdtemp(join(tmpdir(), "media-pdf-"));
  const input = join(workdir, `input.${safeExt(ext)}`);
  const frame = join(workdir, "frame.jpg");
  try {
    await writeFile(input, bytes);

    const attempts = [
      ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", input, "-frames:v", "1", "-an", "-q:v", "3", frame],
      ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-frames:v", "1", "-an", "-q:v", "3", frame],
    ];
    let lastError: unknown = null;
    for (const args of attempts) {
      await rm(frame, { force: true }).catch(() => {});
      try {
        await runFfmpeg(args, signal);
        const out = new Uint8Array(await readFile(frame));
        if (out.byteLength > 0) return out;
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new ApiError(502, "ffmpeg produced no video frame for PDF output.");
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { windowsHide: true });
    let stderr = "";
    let settled = false;
    const abort = () => child.kill("SIGTERM");
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (err) reject(err);
      else resolve();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (e) => finish(e));
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      const tail = stderr.split("\n").slice(-3).join(" ").trim();
      finish(new ApiError(502, `ffmpeg exited with code ${code ?? 1}: ${tail || "no stderr"}`));
    });
  });
}

function jpegToPdf(jpeg: Uint8Array): Uint8Array {
  const { width, height } = jpegSize(jpeg);
  const portrait = 595.28 / 841.89;
  const ratio = width / height;
  const pageWidth = ratio > portrait ? 841.89 : 595.28;
  const pageHeight = ratio > portrait ? 595.28 : 841.89;
  const margin = 36;
  const scale = Math.min((pageWidth - margin * 2) / width, (pageHeight - margin * 2) / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  const x = (pageWidth - drawWidth) / 2;
  const y = (pageHeight - drawHeight) / 2;
  const content = Buffer.from(
    `q\n${num(drawWidth)} 0 0 ${num(drawHeight)} ${num(x)} ${num(y)} cm\n/Im0 Do\nQ\n`,
    "latin1",
  );

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageWidth)} ${num(pageHeight)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`,
        "latin1",
      ),
      Buffer.from(jpeg),
      Buffer.from("\nendstream", "latin1"),
    ]),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.byteLength} >>\nstream\n`, "latin1"),
      content,
      Buffer.from("endstream", "latin1"),
    ]),
  ];

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.concat(chunks).byteLength);
    const body = typeof objects[i] === "string" ? Buffer.from(objects[i] as string, "latin1") : (objects[i] as Buffer);
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1"));
  }
  const xrefOffset = Buffer.concat(chunks).byteLength;
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");
  chunks.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}

function jpegSize(jpeg: Uint8Array): { width: number; height: number } {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Invalid JPEG data");
  let i = 2;
  while (i < jpeg.length) {
    while (jpeg[i] === 0xff) i++;
    const marker = jpeg[i++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const len = (jpeg[i] << 8) | jpeg[i + 1];
    if (!Number.isFinite(len) || len < 2) break;
    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf
    ) {
      return {
        height: (jpeg[i + 3] << 8) | jpeg[i + 4],
        width: (jpeg[i + 5] << 8) | jpeg[i + 6],
      };
    }
    i += len;
  }
  throw new Error("Could not read JPEG dimensions");
}

function extOf(fileName?: string): string {
  const dot = fileName?.lastIndexOf(".") ?? -1;
  return dot >= 0 ? fileName!.slice(dot + 1).toLowerCase() : "";
}

function baseName(fileName: string): string {
  const leaf = fileName.split(/[\\/]/).pop() || "converted";
  const dot = leaf.lastIndexOf(".");
  return (dot > 0 ? leaf.slice(0, dot) : leaf) || "converted";
}

function safeExt(ext: string | undefined): string {
  const clean = (ext || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  return clean.slice(0, 8) || "bin";
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
