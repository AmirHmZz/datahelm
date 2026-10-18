import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function formatNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value)
    : "—";
}
export function formatBytes(value: unknown) {
  if (typeof value !== "number") return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i =
    value > 0 ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${formatNumber(value / 1024 ** i)} ${units[i]}`;
}
export function dateTimestamp(value: unknown): number {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if ("$date" in v) return dateTimestamp(v.$date);
    if ("$numberLong" in v) return Number(v.$numberLong);
  }
  return typeof value === "string" || typeof value === "number"
    ? new Date(value).getTime()
    : NaN;
}
export function dateValue(value: unknown): string {
  const timestamp = dateTimestamp(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : "—";
}
