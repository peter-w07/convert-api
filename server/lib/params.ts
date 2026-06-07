import { badRequest } from "./errors.ts";

export function booleanParam(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  throw badRequest(`${name} must be true or false`);
}

export function numberParam(
  value: unknown,
  name: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${name} must be a number`);
  if (opts.integer && !Number.isInteger(parsed)) throw badRequest(`${name} must be an integer`);
  if (opts.min !== undefined && parsed < opts.min) throw badRequest(`${name} must be at least ${opts.min}`);
  if (opts.max !== undefined && parsed > opts.max) throw badRequest(`${name} must be at most ${opts.max}`);
  return parsed;
}

export interface ResolutionParam {
  width: number;
  height: number;
}

export function resolutionParam(
  value: unknown,
  name: string,
  opts: { min?: number; max?: number } = {},
): ResolutionParam | undefined {
  if (value === undefined || value === "") return undefined;

  let widthValue: unknown;
  let heightValue: unknown;

  if (typeof value === "string") {
    const match = /^\s*(\d+)\s*(?:x|\*|\u00d7)\s*(\d+)\s*$/i.exec(value);
    if (!match) throw badRequest(`${name} must be WIDTHxHEIGHT, for example 1920x1080`);
    widthValue = match[1];
    heightValue = match[2];
  } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    widthValue = obj.width;
    heightValue = obj.height;
    if (widthValue === undefined || heightValue === undefined) {
      throw badRequest(`${name} object must include width and height`);
    }
  } else {
    throw badRequest(`${name} must be WIDTHxHEIGHT, for example 1920x1080`);
  }

  return {
    width: resolutionDimension(widthValue, `${name}.width`, opts),
    height: resolutionDimension(heightValue, `${name}.height`, opts),
  };
}

function resolutionDimension(value: unknown, name: string, opts: { min?: number; max?: number }): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${name} must be a number`);
  if (!Number.isInteger(parsed)) throw badRequest(`${name} must be an integer`);
  if (opts.min !== undefined && parsed < opts.min) throw badRequest(`${name} must be at least ${opts.min}`);
  if (opts.max !== undefined && parsed > opts.max) throw badRequest(`${name} must be at most ${opts.max}`);
  return parsed;
}
