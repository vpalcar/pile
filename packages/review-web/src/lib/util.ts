import { useEffect, useState, useSyncExternalStore } from "react";
import type { ItemRef } from "../api";

// -----------------------------------------------------------------------------
// Time

const UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.345, "week"],
  [12, "month"],
  [Infinity, "year"],
];

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  let value = (Date.parse(iso) - Date.now()) / 1000;
  if (Math.abs(value) < 45) return "just now";
  for (const [step, unit] of UNITS) {
    if (Math.abs(value) < step) {
      return new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" }).format(Math.round(value), unit);
    }
    value /= step;
  }
  return "";
}

export function shortTime(iso: string | null | undefined): string {
  return timeAgo(iso).replace(/^in /, "").replace(" ago", "").replace(/\s/g, "") || "";
}

export function absoluteTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

/** Re-renders every minute so relative times stay fresh. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// -----------------------------------------------------------------------------
// Routing: #/pr/12, #/branch/feature%2Fx, optionally /file/<path>

export interface Route {
  ref: ItemRef | null;
  file: string | null;
}

export function parseRoute(hash = location.hash): Route {
  const [, kind, id, file] = hash.match(/^#\/(pr|branch)\/([^/]+)(?:\/file\/(.+))?$/) ?? [];
  if (kind === "pr" && /^\d+$/.test(id)) return { ref: { kind: "pr", number: Number(id) }, file: file ? decodeURIComponent(file) : null };
  if (kind === "branch" && id) return { ref: { kind: "branch", name: decodeURIComponent(id) }, file: file ? decodeURIComponent(file) : null };
  return { ref: null, file: null };
}

export function routeHash(ref: ItemRef | null, file?: string | null): string {
  if (!ref) return "#/";
  const base = ref.kind === "pr" ? `#/pr/${ref.number}` : `#/branch/${encodeURIComponent(ref.name)}`;
  return file ? `${base}/file/${encodeURIComponent(file)}` : base;
}

export function navigate(ref: ItemRef | null, file?: string | null, replace = false): void {
  const hash = routeHash(ref, file);
  if (hash === location.hash) return;
  if (replace) history.replaceState(null, "", hash);
  else history.pushState(null, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (listener) => {
      window.addEventListener("hashchange", listener);
      window.addEventListener("popstate", listener);
      return () => {
        window.removeEventListener("hashchange", listener);
        window.removeEventListener("popstate", listener);
      };
    },
    () => location.hash,
  );
  return parseRoute(hash);
}

export const sameRef = (a: ItemRef | null, b: ItemRef | null) =>
  !!a && !!b && (a.kind === "pr" ? b.kind === "pr" && a.number === b.number : b.kind === "branch" && a.name === b.name);

// -----------------------------------------------------------------------------
// Persisted per-viewer state (viewed files, diff preferences)

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisted; the in-memory value still applies.
  }
}

const memory = new Map<string, unknown>();
const storeListeners = new Set<() => void>();

export function usePersisted<T>(key: string, fallback: T): [T, (value: T | ((prev: T) => T)) => void] {
  const value = useSyncExternalStore(
    (listener) => {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
    () => {
      if (!memory.has(key)) memory.set(key, read(key, fallback));
      return memory.get(key) as T;
    },
  );
  const set = (next: T | ((prev: T) => T)) => {
    const resolved = typeof next === "function" ? (next as (prev: T) => T)(memory.has(key) ? (memory.get(key) as T) : read(key, fallback)) : next;
    memory.set(key, resolved);
    write(key, resolved);
    storeListeners.forEach((l) => l());
  };
  return [value, set];
}

/** Viewed files for an item, keyed by path, valued by the diff version that was viewed. */
export function useViewed(itemKey: string) {
  return usePersisted<Record<string, string>>(`pile:viewed:${itemKey}`, {});
}

// -----------------------------------------------------------------------------
// Keyboard

export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/** Global shortcuts, ignored while typing (except those marked `always`). */
export function useShortcuts(
  bindings: Record<string, (event: KeyboardEvent) => void>,
  deps: unknown[],
  options: { always?: string[] } = {},
): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const key = [event.metaKey || event.ctrlKey ? "mod" : "", event.shiftKey && event.key.length > 1 ? "shift" : "", event.altKey ? "alt" : "", event.key.length === 1 ? event.key : event.key]
        .filter(Boolean)
        .join("+");
      const action = bindings[key];
      if (!action) return;
      if (isTyping(event) && !options.always?.includes(key)) return;
      event.preventDefault();
      action(event);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl";

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function copy(text: string): Promise<boolean> {
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}
