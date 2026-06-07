import type { Request } from "express";
import { ApiError } from "./errors.ts";
import type { Job } from "./jobs.ts";

export function jobAcceptedPayload(
  req: Request,
  job: Pick<Job, "id" | "kind" | "estimateMs">,
  extra: Record<string, unknown> = {},
) {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const base = `${proto}://${host}`;
  return {
    jobId: job.id,
    kind: job.kind,
    status: "queued",
    estimateMs: job.estimateMs,
    estimatedSeconds: Math.round(job.estimateMs / 100) / 10,
    statusUrl: `${base}/api/jobs/${job.id}`,
    resultUrl: `${base}/api/jobs/${job.id}/result`,
    streamUrl: `${base}/api/jobs/${job.id}/stream`,
    pollAfterMs: Math.max(200, Math.min(job.estimateMs / 2, 3_000)),
    ...extra,
  };
}

export function jobFailure(job: Job, fallback: string): ApiError {
  return new ApiError(job.errorStatus ?? 500, job.error || fallback);
}
