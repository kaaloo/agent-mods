import path from "node:path";
import { randomUUID } from "node:crypto";

export function generateId(): string {
  return randomUUID().slice(0, 8);
}

export function generateRunId(): string {
  return `${Date.now()}-${generateId()}`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "unknown";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9-_.]*$/;

export function isSafeIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER.test(value) && !value.includes("..") && value.length > 0 && value.length <= 128;
}

export function isSafePathComponent(value: string): boolean {
  return isSafeIdentifier(value);
}

export function isSafeRunId(value: string): boolean {
  return /^\d{13,}-[a-zA-Z0-9]{8,}$/.test(value);
}

export function isContainedPath(baseDir: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(`${resolvedBase}${path.sep}`);
}
