/**
 * The JSON contract between `pile review`'s local server and the review web app.
 * Types only: the server imports them as `@pile/review-web/api`.
 */

export interface Person {
  login: string;
  avatarUrl: string | null;
}

export interface Session {
  repo: { owner: string; name: string; url: string } | null;
  viewer: Person | null;
  trunk: string;
  currentBranch: string;
  /** False when there's no GitHub token or remote; only local branches are shown then. */
  github: boolean;
  /** The PR or branch `pile review <target>` was opened on. */
  initial: ItemRef | null;
}

/**
 * A review note for the agent working on a branch, kept locally in .pile/notes.json
 * and read with `pile notes` (same shape as @pile/core's Note).
 */
export interface AgentNote {
  id: string;
  branch: string;
  pr: number | null;
  path: string | null;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  commit: string | null;
  code: string[];
  codeStart: number | null;
  body: string;
  createdAt: string;
  done: boolean;
  /** The agent's answers (`pile notes done/reply -m`) and the reviewer's follow-ups. */
  replies?: Array<{ author: "agent" | "reviewer"; body: string; createdAt: string }>;
}

/** Where a new note goes; the server fills in the branch, commit and code. */
export interface NewNoteRequest {
  ref: ItemRef;
  path?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  body: string;
}

/** Personal settings, kept in ~/.config/pile/review.json so they survive restarts. */
export interface Preferences {
  theme?: "system" | "light" | "dark";
  diffMode?: "split" | "unified";
  diffWrap?: boolean;
  treeOpen?: boolean;
}

/** Identifies something reviewable: a pull request, or a local branch without one. */
export type ItemRef = { kind: "pr"; number: number } | { kind: "branch"; name: string };

export type PRState = "open" | "draft" | "merged" | "closed";
export type ReviewState = "approved" | "changes_requested" | "commented" | "pending" | "dismissed";
export type CheckState = "success" | "failure" | "pending" | "neutral" | "none";

export interface ChecksSummary {
  state: CheckState;
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface StackPosition {
  /** 1-based depth from the bottom; siblings in a diverging stack share it. */
  index: number;
  /** Every PR in the stack, all branches of it included. */
  size: number;
  /** Native GitHub stack number, if any. */
  nativeStack: number | null;
}

/** Local git state of a branch, when it exists in this clone. */
export interface LocalState {
  ahead: number;
  behind: number;
  /** Commits on the local branch that the remote branch doesn't have. */
  unpushed: boolean;
  isCurrent: boolean;
}

export interface InboxItem {
  ref: ItemRef;
  id: string;
  title: string;
  branch: string;
  base: string;
  author: Person | null;
  state: PRState | "local";
  updatedAt: string | null;
  additions: number | null;
  deletions: number | null;
  /** The viewer's position: what they need to do with this item. */
  reviewDecision: ReviewState | "review_required" | null;
  checks: ChecksSummary | null;
  stack: StackPosition | null;
  local: LocalState | null;
  url: string | null;
  comments: number;
}

export interface InboxGroup {
  id: "needs_review" | "mine" | "local" | "others";
  title: string;
  items: InboxItem[];
}

export interface Inbox {
  groups: InboxGroup[];
  fetchedAt: string;
  /** Checks, reviews and sizes are still loading; ask again shortly. */
  partial?: boolean;
}

/**
 * One PR (or local branch) in a stack. Stacks can diverge: several entries may share
 * a `base`, so together they form a tree rooted on the trunk.
 */
export interface StackEntry {
  ref: ItemRef;
  title: string;
  branch: string;
  /** The branch this one is based on: another entry's branch, or the trunk. */
  base: string;
  state: PRState | "local";
  reviewDecision: InboxItem["reviewDecision"];
  /** The entry's own checks, so the stack shows real statuses without the inbox. */
  checks?: ChecksSummary | null;
  /** Why pile wouldn't merge this entry now (empty when nothing blocks it). */
  blockers?: string[];
  isCurrent: boolean;
}

export interface CheckRun {
  name: string;
  state: CheckState;
  summary: string | null;
  url: string | null;
  durationSeconds: number | null;
  /** GitHub Actions job behind this check, when it can be re-run from here. */
  jobId: number | null;
}

export interface ReviewerState {
  person: Person;
  state: ReviewState | "requested";
  isTeam?: boolean;
}

export interface TimelineEntry {
  id: string;
  kind: "comment" | "review" | "commit";
  author: Person | null;
  createdAt: string;
  /** Sanitized server-side? No: GitHub-rendered HTML, sanitized again in the browser. */
  bodyHtml: string | null;
  reviewState?: ReviewState;
  /** For commits. */
  sha?: string;
  message?: string;
  url: string | null;
  /** Inline review comments attached to a review. */
  inlineCount?: number;
}

export interface InlineComment {
  id: number;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  author: Person | null;
  createdAt: string;
  bodyHtml: string;
  inReplyTo: number | null;
  url: string;
}

export type FileStatus = "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";

export interface DiffFile {
  path: string;
  previousPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Unified diff hunks; null when GitHub omits it (binary or too large). */
  patch: string | null;
  /** Identifies this version of the file's diff, for "viewed" state. */
  sha: string;
  binary: boolean;
}

export interface Detail {
  ref: ItemRef;
  title: string;
  number: number | null;
  url: string | null;
  state: PRState | "local";
  author: Person | null;
  branch: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdAt: string | null;
  updatedAt: string | null;
  bodyHtml: string | null;
  additions: number;
  deletions: number;
  stack: StackEntry[];
  timeline: TimelineEntry[];
  inlineComments: InlineComment[];
  checks: CheckRun[];
  checksSummary: ChecksSummary | null;
  reviewers: ReviewerState[];
  labels: Label[];
  assignees: Person[];
  mergeable: boolean | null;
  mergeableState: string | null;
  /** Same meaning as InboxItem.reviewDecision, so both show the same status. */
  reviewDecision: InboxItem["reviewDecision"];
  files: DiffFile[];
  local: LocalState | null;
  /** Things the viewer can do. */
  can: { review: boolean; comment: boolean; merge: boolean; draft: boolean };
  /** What merging from here would do; null for local branches and finished PRs. */
  merge: MergeInfo | null;
}

export interface MergeInfo {
  method: "merge" | "squash" | "rebase";
  /** Merging only this PR: possible when it's based on the trunk. */
  single: { possible: boolean; blockers: string[] };
  /** Merging every open PR from the bottom of the stack up to this one. */
  stack: { count: number; blockers: string[] } | null;
}

export interface MergeRequest {
  /** Merge the whole stack up to this PR instead of only this PR. */
  stack?: boolean;
}

export interface MergeResult {
  merged: number[];
  /** GitHub accepted the merge but finishes it later (native stacks). */
  queued: boolean;
}

export interface Label {
  name: string;
  color: string;
  description?: string | null;
}

/** What a PR's reviewers, assignees and labels can be picked from. */
export interface RepoOptions {
  people: Person[];
  labels: Label[];
}

/** Changes to a PR's metadata; every field is optional. */
export interface PRUpdate {
  reviewers?: { add?: string[]; remove?: string[] };
  assignees?: { add?: string[]; remove?: string[] };
  /** The full set of labels the PR should have. */
  labels?: string[];
  draft?: boolean;
}

/** Re-runs one check (by its Actions job) or, without `jobId`, every failed one. */
export interface RerunRequest {
  jobId?: number;
}

export interface ApiError {
  error: string;
  code: string;
  hint?: string;
}

export interface CommentRequest {
  body: string;
}

export interface ReviewRequest {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body?: string;
  comments?: Array<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }>;
}

export interface FileContent {
  path: string;
  ref: string;
  lines: string[];
}
