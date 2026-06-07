import type { Request } from "express";

/**
 * Origin used by server-side browser work to call this same API process.
 * External Host/X-Forwarded-Host values may point at a reverse proxy or a
 * host-mapped Docker port that is unreachable from inside the container.
 */
export function internalBaseUrl(req: Request): string {
  const configured = process.env.CONVERT_API_INTERNAL_BASE_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("CONVERT_API_INTERNAL_BASE_URL must use http or https");
    }
    return new URL("/", url).toString();
  }
  const port = req.socket.localPort || Number(process.env.PORT) || 3000;
  return `http://127.0.0.1:${port}/`;
}
