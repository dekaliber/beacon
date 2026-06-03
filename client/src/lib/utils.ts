import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Register custom font-size tokens so tailwind-merge doesn't confuse them
// with text-color utilities when both appear in the same cn() call.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": ["text-10", "text-11", "text-13", "text-15", "text-17", "text-19", "text-32", "text-42"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function parseAmount(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

export function formatCurrency(amount: number | string): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(num);
}

export function formatDate(date: string | Date): string {
  // Parse as local time to avoid timezone offset issues.
  // ISO strings like "2026-03-02T00:00:00.000Z" can shift a day when
  // interpreted in local time via new Date(). Replacing hyphens forces
  // the parser to treat it as local.
  const str = typeof date === "string" ? date : date.toISOString();
  const d = new Date(str.replace(/-/g, "/").replace("T", " ").split(".")[0]);
  return d.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

// Local YYYY-MM-DD for today (avoids UTC shift in evening hours)
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Extract YYYY-MM-DD for <input type="date"> without timezone shift
export function toDateInputValue(date?: string | null): string {
  if (!date) return localToday();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return date.split("T")[0];
}
