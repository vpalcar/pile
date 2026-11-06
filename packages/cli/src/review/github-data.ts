import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Octokit } from "@octokit/rest";
import { mapLimit } from "@pile/core";
import type {
  CheckRun,
  CheckState,
  ChecksSummary,
  DiffFile,
  FileStatus,
  InlineComment,
  Person,
  ReviewState,
  ReviewerState,
  TimelineEntry,
} from "@pile/review-web/api";

/**
 * GitHub reads for the review app, all over REST. Responses are cached with their
 * ETags, so polling only costs a conditional request (304s don't count against the
 * rate limit).
 */

const FULL = { mediaType: { format: "full" } } as const;

/** What the review server has asked GitHub for, and how much of the hourly limit is left. */
export interface ApiUsage {
  /** Requests that counted against the rate limit. */
  counted: number;
  /** Conditional requests GitHub answered with 304 Not Modified: free. */
  notModified: number;
  byRoute: Record<string, number>;
  remaining: number | null;
  limit: number | null;
  /** When the limit resets (ISO time). */
  resetAt: string | null;
  /** GraphQL has a separate budget, in points: what pile spent and what's left. */
  graphql: { points: number; queries: number; remaining: number | null; limit: number | null; resetAt: string | null };
}

const usage = new WeakMap<Octokit, ApiUsage>();
export const apiUsage = (octokit: Octokit): ApiUsage | undefined => usage.get(octokit);

/**
 * Conditional requests: GitHub answers unchanged data with 304, which doesn't count
 * against the rate limit. With `file`, the cache survives restarts, so starting
 * `pile review` again costs almost nothing.
 */
/** Adds a GraphQL query's cost, as reported by its `rateLimit` field. */
export function recordGraphQL(octokit: Octokit, rate: { cost: number; remaining: number; limit: number; resetAt: string } | undefined): void {
  const stats = usage.get(octokit);
  if (!stats) return;
  stats.graphql.queries++;
  if (!rate) return;
  stats.graphql.points += rate.cost;
  stats.graphql.remaining = rate.remaining;
  stats.graphql.limit = rate.limit;
  stats.graphql.resetAt = rate.resetAt;
}

export function enableEtagCache(octokit: Octokit, file?: string): void {
  const cache = new Map<string, { etag: string; response: unknown }>(file ? loadEtags(file) : []);
  let dirty = false;
  const save = () => {
    if (!file || !dirty) return;
    dirty = false;
    saveEtags(file, cache);
  };
  if (file) {
    setInterval(save, 5_000).unref();
    process.once("exit", save);
  }
  const stats: ApiUsage = {
    counted: 0,
    notModified: 0,
    byRoute: {},
    remaining: null,
    limit: null,
    resetAt: null,
    graphql: { points: 0, queries: 0, remaining: null, limit: null, resetAt: null },
  };
  usage.set(octokit, stats);
  const track = (route: string, headers: Record<string, unknown> | undefined, free: boolean) => {
    if (free) stats.notModified++;
    else {
      stats.counted++;
      stats.byRoute[route] = (stats.byRoute[route] ?? 0) + 1;
    }
    const remaining = Number(headers?.["x-ratelimit-remaining"]);
    if (Number.isFinite(remaining) && headers?.["x-ratelimit-resource"] !== "search") {
      stats.remaining = remaining;
      stats.limit = Number(headers?.["x-ratelimit-limit"]) || stats.limit;
      stats.resetAt = new Date(Number(headers?.["x-ratelimit-reset"]) * 1000).toISOString();
    }
  };
  octokit.hook.wrap("request", async (request, options) => {
    const method = (options.method ?? "GET").toUpperCase();
    const route = `${method} ${options.url}`;
    // GraphQL is counted in points from the query's own rateLimit field (see recordGraphQL).
    if (String(options.url).endsWith("/graphql")) return request(options);
    if (method !== "GET") {
      const response = await request(options);
      track(route, response.headers as Record<string, unknown>, false);
      return response;
    }
    const key = JSON.stringify([options.url, options.mediaType, ...Object.entries(options).filter(([k]) => !["request", "headers", "mediaType", "method", "baseUrl"].includes(k))]);
    const cached = cache.get(key);
    if (cached) {
      options.headers = { ...options.headers, "if-none-match": cached.etag };
    }
    try {
      const response = await request(options);
      track(route, response.headers as Record<string, unknown>, false);
      const etag = response.headers.etag;
      if (etag) {
        cache.delete(key); // re-insert: the map's order is least recently used first
        cache.set(key, { etag, response: { status: response.status, url: response.url, headers: response.headers, data: response.data } });
        dirty = true;
      }
      return response;
    } catch (error) {
      const status = (error as { status?: number }).status;
      track(route, (error as { response?: { headers?: Record<string, unknown> } }).response?.headers, status === 304);
      if (cached && status === 304) {
        return cached.response as Awaited<ReturnType<typeof request>>;
      }
      throw error;
    }
  });
}

const ETAG_ENTRIES = 3000;
const ETAG_MAX_BYTES = 512 * 1024;

function loadEtags(file: string): Array<[string, { etag: string; response: unknown }]> {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data.version === 1 && Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

/** Keeps the most recently used responses, skipping very large ones (big diffs). */
function saveEtags(file: string, cache: Map<string, { etag: string; response: unknown }>): void {
  try {
    const entries = [...cache].slice(-ETAG_ENTRIES).filter(([, v]) => JSON.stringify(v).length < ETAG_MAX_BYTES);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, entries }));
    renameSync(temp, file);
  } catch {
    // A cache: losing it only costs requests.
  }
}

export const person = (user: { login: string; avatar_url?: string } | null | undefined): Person | null =>
  user ? { login: user.login, avatarUrl: user.avatar_url ?? null } : null;

export function reviewState(state: string): ReviewState {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
    default:
      return "commented";
  }
}

export interface Repo {
  owner: string;
  repo: string;
}

type RawReview = { user: { login: string; avatar_url?: string } | null; state: string; submitted_at?: string | null };

/** Latest decisive review per reviewer (comments don't override approvals). */
export function latestReviews(reviews: RawReview[]): Map<string, RawReview> {
  const latest = new Map<string, RawReview>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login || review.state === "PENDING") continue;
    const previous = latest.get(login);
    if (review.state === "COMMENTED" && previous && previous.state !== "COMMENTED") continue;
    latest.set(login, review);
  }
  return latest;
}

export function reviewDecision(
  reviews: RawReview[],
  requested: number,
): ReviewState | "review_required" | null {
  const states = [...latestReviews(reviews).values()].map((r) => r.state);
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED") && requested === 0) return "approved";
  // "Needs review" only when someone was actually asked.
  if (requested > 0) return "review_required";
  return states.length > 0 ? "commented" : null;
}

export async function fetchReviews(octokit: Octokit, repo: Repo, number: number) {
  const { data } = await octokit.pulls.listReviews({ ...repo, pull_number: number, per_page: 100, ...FULL });
  return data;
}

function checkState(status: string | null, conclusion: string | null): CheckState {
  if (status && status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "success";
    case "neutral":
    case "skipped":
      return "neutral";
    case null:
      return "pending";
    default:
      return "failure";
  }
}

export async function fetchChecks(octokit: Octokit, repo: Repo, ref: string): Promise<CheckRun[]> {
  const [runs, statuses] = await Promise.all([
    octokit.checks
      .listForRef({ ...repo, ref, per_page: 100 })
      .then(({ data }) => data.check_runs)
      .catch(() => []),
    octokit.repos
      .getCombinedStatusForRef({ ...repo, ref, per_page: 100 })
      .then(({ data }) => data.statuses)
      .catch(() => []),
  ]);
  return mapChecks(runs, statuses);
}

type RawCheckRun = {
  id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  output?: { title?: string | null } | null;
  html_url?: string | null;
  details_url?: string | null;
  app?: { slug?: string } | null;
};
type RawStatus = { context: string; state: string; description?: string | null; target_url?: string | null };

/** Check runs and commit statuses (REST shapes; GraphQL's are converted to them). */
export function mapChecks(runs: RawCheckRun[], statuses: RawStatus[]): CheckRun[] {
  const checks: CheckRun[] = runs.map((run) => {
    const started = run.started_at ? Date.parse(run.started_at) : null;
    const done = run.completed_at ? Date.parse(run.completed_at) : null;
    return {
      name: run.name,
      state: checkState(run.status, run.conclusion),
      summary: run.output?.title ?? null,
      url: run.html_url ?? run.details_url ?? null,
      durationSeconds: started && done ? Math.round((done - started) / 1000) : null,
      // An Actions check run's id is its job's id.
      jobId: run.app?.slug === "github-actions" ? run.id : null,
    };
  });
  for (const status of statuses) {
    checks.push({
      name: status.context,
      state: status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure",
      summary: status.description ?? null,
      url: status.target_url ?? null,
      durationSeconds: null,
      jobId: null,
    });
  }
  return checks.sort((a, b) => order(a.state) - order(b.state) || a.name.localeCompare(b.name));
}

const order = (state: CheckState) => ({ failure: 0, pending: 1, success: 2, neutral: 3, none: 4 })[state];

export function summarizeChecks(checks: CheckRun[]): ChecksSummary {
  const failed = checks.filter((c) => c.state === "failure").length;
  const pending = checks.filter((c) => c.state === "pending").length;
  const passed = checks.filter((c) => c.state === "success" || c.state === "neutral").length;
  return {
    state: checks.length === 0 ? "none" : failed ? "failure" : pending ? "pending" : "success",
    total: checks.length,
    passed,
    failed,
    pending,
  };
}

export async function fetchFiles(octokit: Octokit, repo: Repo, number: number): Promise<DiffFile[]> {
  const files = await octokit.paginate(octokit.pulls.listFiles, { ...repo, pull_number: number, per_page: 100 });
  return files.map((file) => ({
    path: file.filename,
    previousPath: file.previous_filename ?? null,
    status: file.status as FileStatus,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch ?? null,
    sha: `${file.sha}:${file.patch?.length ?? 0}`,
    binary: !file.patch && file.changes === 0 && file.status !== "renamed",
  }));
}

/** Discussion comments and commits; started early, combined with reviews later. */
export function fetchTimelineParts(octokit: Octokit, repo: Repo, number: number) {
  return Promise.all([
    octokit.paginate(octokit.issues.listComments, { ...repo, issue_number: number, per_page: 100, ...FULL }),
    octokit.paginate(octokit.pulls.listCommits, { ...repo, pull_number: number, per_page: 100 }),
  ]);
}

export async function fetchTimeline(
  parts: ReturnType<typeof fetchTimelineParts>,
  reviews: Awaited<ReturnType<typeof fetchReviews>>,
  inline: InlineComment[],
): Promise<TimelineEntry[]> {
  const [comments, commits] = await parts;

  const entries: TimelineEntry[] = [
    ...comments.map((c) => ({
      id: `comment-${c.id}`,
      kind: "comment" as const,
      author: person(c.user),
      createdAt: c.created_at,
      bodyHtml: (c as { body_html?: string }).body_html ?? null,
      url: c.html_url,
    })),
    ...reviews
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({
        id: `review-${r.id}`,
        kind: "review" as const,
        author: person(r.user),
        createdAt: r.submitted_at ?? "",
        bodyHtml: (r as { body_html?: string }).body_html || null,
        reviewState: reviewState(r.state),
        url: r.html_url,
        inlineCount: inline.filter((c) => (c as unknown as { reviewId?: number }).reviewId === r.id).length,
      })),
    ...commits.map((c) => ({
      id: `commit-${c.sha}`,
      kind: "commit" as const,
      author: person(c.author && "login" in c.author ? (c.author as { login: string; avatar_url?: string }) : null) ?? (c.commit.author ? { login: c.commit.author.name ?? "unknown", avatarUrl: null } : null),
      createdAt: c.commit.committer?.date ?? c.commit.author?.date ?? "",
      bodyHtml: null,
      sha: c.sha,
      message: c.commit.message,
      url: c.html_url,
    })),
  ];
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function fetchInlineComments(octokit: Octokit, repo: Repo, number: number): Promise<InlineComment[]> {
  const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
    ...repo,
    pull_number: number,
    per_page: 100,
    ...FULL,
  });
  return comments.map((c) => ({
    id: c.id,
    path: c.path,
    line: c.line ?? c.original_line ?? null,
    side: (c.side as "LEFT" | "RIGHT") ?? "RIGHT",
    author: person(c.user),
    createdAt: c.created_at,
    bodyHtml: (c as { body_html?: string }).body_html ?? "",
    inReplyTo: c.in_reply_to_id ?? null,
    // REST doesn't say; GraphQL does.
    resolved: false,
    url: c.html_url,
    reviewId: c.pull_request_review_id,
  })) as InlineComment[];
}

export function reviewerStates(
  reviews: RawReview[],
  requested: Array<{ login: string; avatar_url?: string }>,
  teams: Array<{ slug: string; name: string }>,
  author: string | undefined,
): ReviewerState[] {
  const result: ReviewerState[] = [];
  const requestedLogins = new Set(requested.map((u) => u.login));
  for (const [login, review] of latestReviews(reviews)) {
    if (login === author) continue;
    result.push({
      person: person(review.user)!,
      state: requestedLogins.has(login) ? "requested" : reviewState(review.state),
    });
  }
  for (const user of requested) {
    if (!result.some((r) => r.person.login === user.login)) {
      result.push({ person: person(user)!, state: "requested" });
    }
  }
  for (const team of teams) {
    result.push({ person: { login: team.name || team.slug, avatarUrl: null }, state: "requested", isTeam: true });
  }
  return result;
}

export async function mapPRs<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  return mapLimit(items, 16, fn);
}
