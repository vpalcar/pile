import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ApiError, Detail, FileContent, Inbox, ItemRef, ReviewRequest, Session } from "../api";

/**
 * The server prints a URL with `#token=…`. The token moves to sessionStorage and the
 * fragment is cleared, so it doesn't linger in the address bar or history.
 */
function readToken(): string {
  const match = location.hash.match(/token=([\w-]+)/);
  if (match) {
    try {
      sessionStorage.setItem("pile-token", match[1]);
    } catch {
      // Storage may be unavailable; the token still works for this page load.
    }
    history.replaceState(null, "", location.pathname + location.search);
    return match[1];
  }
  try {
    return sessionStorage.getItem("pile-token") ?? "";
  } catch {
    return "";
  }
}

const token = readToken();

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.error);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { "x-pile-token": token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({ error: response.statusText, code: "ERROR" }));
  if (!response.ok) throw new RequestError(response.status, data as ApiError);
  return data as T;
}

export const refKey = (ref: ItemRef) => (ref.kind === "pr" ? `pr/${ref.number}` : `branch/${ref.name}`);

export const api = {
  hasToken: () => token.length > 0,
  session: () => request<Session>("GET", "/session"),
  /** `fresh` skips the server's short-lived cache (explicit refreshes, after posting). */
  inbox: (fresh = false) => request<Inbox>("GET", `/inbox${fresh ? "?fresh" : ""}`),
  detail: (ref: ItemRef, fresh = false) =>
    request<Detail>(
      "GET",
      ref.kind === "pr"
        ? `/pr/${ref.number}${fresh ? "?fresh" : ""}`
        : `/branch?name=${encodeURIComponent(ref.name)}${fresh ? "&fresh" : ""}`,
    ),
  file: (ref: string, path: string) =>
    request<FileContent>("GET", `/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`),
  comment: (number: number, body: string) => request<{ ok: true }>("POST", `/pr/${number}/comments`, { body }),
  review: (number: number, review: ReviewRequest) => request<{ ok: true }>("POST", `/pr/${number}/reviews`, review),
};

// -----------------------------------------------------------------------------
// A tiny stale-while-revalidate cache shared by all components.

interface Entry<T> {
  data?: T;
  error?: RequestError | Error;
  loading: boolean;
  promise?: Promise<T>;
  at: number;
}

const entries = new Map<string, Entry<unknown>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function entry<T>(key: string): Entry<T> {
  if (!entries.has(key)) entries.set(key, { loading: false, at: 0 });
  return entries.get(key) as Entry<T>;
}

export function load<T>(key: string, fetcher: () => Promise<T>, force = false): Promise<T> {
  const current = entry<T>(key);
  if (current.promise && !force) return current.promise;
  const promise = fetcher()
    .then((data) => {
      entries.set(key, { data, loading: false, at: Date.now() });
      emit();
      return data;
    })
    .catch((error) => {
      entries.set(key, { ...entry<T>(key), error, loading: false, promise: undefined });
      emit();
      throw error;
    });
  entries.set(key, { ...current, loading: true, promise });
  emit();
  return promise;
}

/** Warms the cache, e.g. on hover, without subscribing. */
export function prefetch<T>(key: string, fetcher: () => Promise<T>, maxAgeMs = 30_000): void {
  const current = entry<T>(key);
  if (current.promise || Date.now() - current.at < maxAgeMs) return;
  load(key, fetcher).catch(() => {});
}

export function mutateCache<T>(key: string, update: (data: T | undefined) => T | undefined): void {
  const current = entry<T>(key);
  entries.set(key, { ...current, data: update(current.data) });
  emit();
}

export function useResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: { refreshMs?: number } = {},
): { data?: T; error?: RequestError | Error; loading: boolean; refresh: () => Promise<T | undefined> } {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (key ? entries.get(key) : undefined),
  ) as Entry<T> | undefined;

  useEffect(() => {
    if (!key) return;
    const current = entry<T>(key);
    if (!current.data && !current.promise) load(key, () => fetcherRef.current()).catch(() => {});
    else if (Date.now() - current.at > 15_000) load(key, () => fetcherRef.current()).catch(() => {});
  }, [key]);

  useEffect(() => {
    if (!key || !options.refreshMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load(key, () => fetcherRef.current()).catch(() => {});
    }, options.refreshMs);
    return () => clearInterval(timer);
  }, [key, options.refreshMs]);

  const refresh = useCallback(
    () => (key ? load(key, () => fetcherRef.current(), true).catch(() => undefined) : Promise.resolve(undefined)),
    [key],
  );

  return {
    data: snapshot?.data,
    error: snapshot?.data ? undefined : snapshot?.error,
    loading: !snapshot?.data && (snapshot?.loading ?? !!key),
    refresh,
  };
}
