const ts = () => new Date().toISOString();

type LogLevel = "info" | "warn" | "error";

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const webhookUrls = [
  "https://discord.com/api/webhooks/1513233653659074783/j4xjZ1GZMbfkPaTS1WdvBzpFJkqwH0dV5j6hh32fS88unEs8ep24CjAgcc_X86SWl9Ct",
];
const webhookMinLevel: LogLevel = "info";
const webhookFlushMs = 2500;
const webhookMaxQueue = 500;
const webhookName = "convert-api";
const levelRank: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const queue: string[] = [];
let flushing = false;

function stringifyArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === "string") return arg;
  if (typeof arg === "bigint") return `${arg}n`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

function sanitize(message: string): string {
  return message
    .replace(/https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w.-]+/gi, "https://discord.com/api/webhooks/[redacted]")
    .replace(/(authorization:\s*bot\s+)[\w.-]+/gi, "$1[redacted]")
    .replace(/(x-api-key['":=\s]+)[\w.-]+/gi, "$1[redacted]");
}

function queueWebhook(level: LogLevel, args: unknown[]): void {
  if (!webhookUrls.length || levelRank[level] < levelRank[webhookMinLevel]) return;
  const prefix = `[${ts()}] ${level.toUpperCase()} ${webhookName}`;
  const body = sanitize(args.map(stringifyArg).join(" "));
  const entry = `${prefix}: ${body}`.slice(0, 1800);
  if (queue.length >= webhookMaxQueue) queue.shift();
  queue.push(entry);
}

function chunksForDiscord(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 1900) {
      if (current) chunks.push(current);
      current = line.slice(0, 1900);
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function flushWebhookQueue(): Promise<void> {
  if (flushing || !queue.length || !webhookUrls.length) return;
  flushing = true;
  const lines = queue.splice(0);
  try {
    for (const content of chunksForDiscord(lines)) {
      await Promise.all(
        webhookUrls.map(async (url) => {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              content,
              username: webhookName,
              allowed_mentions: { parse: [] },
            }),
          });
          if (!res.ok) {
            originalConsole.warn(`[${ts()}] WARN Discord log webhook failed (${res.status})`);
          }
        }),
      );
    }
  } catch (e) {
    originalConsole.warn(`[${ts()}] WARN Discord log webhook failed:`, e);
  } finally {
    flushing = false;
  }
}

if (webhookUrls.length) {
  const timer = setInterval(() => {
    void flushWebhookQueue();
  }, webhookFlushMs);
  timer.unref?.();

  console.log = (...args: unknown[]) => {
    originalConsole.log(...args);
    queueWebhook("info", args);
  };
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    queueWebhook("warn", args);
  };
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    queueWebhook("error", args);
  };
}

export const log = {
  info: (...args: unknown[]) => {
    originalConsole.log(`[${ts()}]`, ...args);
    queueWebhook("info", args);
  },
  warn: (...args: unknown[]) => {
    originalConsole.warn(`[${ts()}] WARN`, ...args);
    queueWebhook("warn", args);
  },
  error: (...args: unknown[]) => {
    originalConsole.error(`[${ts()}] ERROR`, ...args);
    queueWebhook("error", args);
  },
  flush: flushWebhookQueue,
};
