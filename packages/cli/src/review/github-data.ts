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

export function enableEtagCache(octokit: Octokit): void {
  const cache = new Map<string, { etag: string; response: unknown }>();
  octokit.hook.wrap("request", async (request, options) => {
    const method = (options.method ?? "GET").toUpperCase();
    if (method !== "GET") return request(options);
    const key = JSON.stringify([options.url, options.mediaType, ...Object.entries(options).filter(([k]) => !["request", "headers", "mediaType", "method", "baseUrl"].includes(k))]);
    const cached = cache.get(key);
    if (cached) {
      options.headers = { ...options.headers, "if-none-match": cached.etag };
    }
    try {
      const response = await request(options);
      const etag = response.headers.etag;
      if (etag) cache.set(key, { etag, response });
      return response;
    } catch (error) {
      if (cached && (error as { status?: number }).status === 304) {
        return cached.response as Awaited<ReturnType<typeof request>>;
      }
      throw error;
    }
  });
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
  const checks: CheckRun[] = runs.map((run) => {
    const started = run.started_at ? Date.parse(run.started_at) : null;
    const done = run.completed_at ? Date.parse(run.completed_at) : null;
    return {
      name: run.name,
      state: checkState(run.status, run.conclusion),
      summary: run.output?.title ?? null,
      url: run.html_url ?? run.details_url ?? null,
      durationSeconds: started && done ? Math.round((done - started) / 1000) : null,
    };
  });
  for (const status of statuses) {
    checks.push({
      name: status.context,
      state: status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure",
      summary: status.description ?? null,
      url: status.target_url ?? null,
      durationSeconds: null,
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
