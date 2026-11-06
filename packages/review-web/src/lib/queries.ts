import { QueryClient, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Detail, ItemRef, Preferences } from "../api";
import { api, RequestError } from "./client";
import { keepKnownSignals } from "./inbox";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 10 * 60_000,
      // A 4xx won't change by asking again; a hiccup might.
      retry: (count, error) => count < 1 && !(error instanceof RequestError && error.status < 500),
      retryDelay: 400,
    },
  },
});

export const refKey = (ref: ItemRef) => (ref.kind === "pr" ? `pr/${ref.number}` : `branch/${ref.name}`);

export const keys = {
  session: ["session"] as const,
  inbox: ["inbox"] as const,
  detail: (ref: ItemRef) => ["detail", refKey(ref)] as const,
  options: ["options"] as const,
  preferences: ["preferences"] as const,
};

/**
 * The server answers from a short-lived cache. A query that was explicitly
 * invalidated (after a change, or a manual refresh) asks past it, so
 * `invalidateQueries` always means "show me what GitHub has now".
 */
const invalidated = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated ?? false;

// -----------------------------------------------------------------------------
// Session

export const useSession = () => useQuery({ queryKey: keys.session, queryFn: api.session, staleTime: Infinity });

// -----------------------------------------------------------------------------
// Inbox

const fetchInbox = async (fresh: boolean) => keepKnownSignals(await api.inbox(fresh), queryClient.getQueryData(keys.inbox));

export const useInbox = () =>
  useQuery({
    queryKey: keys.inbox,
    queryFn: () => fetchInbox(invalidated(keys.inbox)),
    // The first answer may be the quick list; ask again until the full one is ready.
    refetchInterval: (query) => (query.state.data?.partial ? 1200 : 30_000),
  });

// -----------------------------------------------------------------------------
// PR and branch details

/** Checks running on the PR or anywhere in its stack. */
export const checksRunning = (detail: Detail | undefined) =>
  !!detail && (detail.checks.some((c) => c.state === "pending") || detail.stack.some((e) => e.checks?.state === "pending"));

export const useDetail = (ref: ItemRef | null) =>
  useQuery({
    queryKey: ref ? keys.detail(ref) : ["detail", null],
    enabled: !!ref,
    queryFn: () => {
      const key = keys.detail(ref!);
      // While checks run, poll past the server's cache so progress shows up live.
      return api.detail(ref!, invalidated(key) || checksRunning(queryClient.getQueryData(key)));
    },
    refetchInterval: (query) => (checksRunning(query.state.data) ? 8_000 : 60_000),
  });

/** Warms a detail in the background (hover, neighbors), so opening it is instant. */
export const prefetchDetail = (ref: ItemRef) =>
  queryClient.prefetchQuery({ queryKey: keys.detail(ref), queryFn: () => api.detail(ref), staleTime: 30_000 });

// -----------------------------------------------------------------------------
// Repository options (reviewers, assignees, labels)

export const useOptions = (enabled: boolean) => useQuery({ queryKey: keys.options, queryFn: api.options, enabled, staleTime: 5 * 60_000 });

// -----------------------------------------------------------------------------
// Preferences (theme, diff layout): saved by the server in ~/.config/pile/review.json

type Pref<K extends keyof Preferences> = NonNullable<Preferences[K]>;

/** One preference, its setter applying at once and saving in the background. */
export function usePreference<K extends keyof Preferences>(key: K, fallback: Pref<K>): [Pref<K>, (next: Pref<K> | ((current: Pref<K>) => Pref<K>)) => void] {
  const { data } = useQuery({ queryKey: keys.preferences, queryFn: api.preferences, staleTime: Infinity });
  const value = (data?.[key] ?? fallback) as Pref<K>;
  const set = useCallback(
    (next: Pref<K> | ((current: Pref<K>) => Pref<K>)) => {
      const current = (queryClient.getQueryData<Preferences>(keys.preferences)?.[key] ?? fallback) as Pref<K>;
      const resolved = typeof next === "function" ? (next as (c: Pref<K>) => Pref<K>)(current) : next;
      queryClient.setQueryData<Preferences>(keys.preferences, (p) => ({ ...p, [key]: resolved }));
      api.setPreferences({ [key]: resolved } as Preferences).catch(() => {});
    },
    [key, fallback],
  );
  return [value, set];
}
