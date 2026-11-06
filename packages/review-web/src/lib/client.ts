import type { AgentNote, ApiError, Detail, NewNoteRequest, FileContent, Inbox, ItemRef, MergeRequest, MergeResult, Preferences, PRUpdate, RepoOptions, RerunRequest, ReviewRequest, Session } from "../api";

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

// A new link from `pile review` opened in a tab that already shows the app only
// changes the fragment; reload so the new token is picked up.
window.addEventListener("hashchange", () => {
  if (/token=/.test(location.hash)) location.reload();
});

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
  options: () => request<RepoOptions>("GET", "/options"),
  notes: (branch: string) => request<AgentNote[]>("GET", `/notes?branch=${encodeURIComponent(branch)}`),
  addNote: (note: NewNoteRequest) => request<AgentNote>("POST", "/notes", note),
  updateNote: (id: string, change: { done?: boolean; body?: string }) => request<AgentNote>("PATCH", `/notes/${id}`, change),
  removeNote: (id: string) => request<{ ok: true }>("DELETE", `/notes/${id}`),
  preferences: () => request<Preferences>("GET", "/preferences"),
  setPreferences: (change: Preferences) => request<Preferences>("PATCH", "/preferences", change),
  update: (number: number, change: PRUpdate) => request<Detail>("PATCH", `/pr/${number}`, change),
  merge: (number: number, merge: MergeRequest) => request<MergeResult>("POST", `/pr/${number}/merge`, merge),
  rerun: (number: number, rerun: RerunRequest) => request<Detail>("POST", `/pr/${number}/checks/rerun`, rerun),
};
