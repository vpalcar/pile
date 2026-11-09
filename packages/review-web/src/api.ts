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
  /** 1-based, bottom first. */
  index: number;
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

export interface StackEntry {
  ref: ItemRef;
  title: string;
  branch: string;
  state: PRState | "local";
  reviewDecision: InboxItem["reviewDecision"];
  isCurrent: boolean;
}

export interface CheckRun {
  name: string;
  state: CheckState;
  summary: string | null;
  url: string | null;
  durationSeconds: number | null;
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
  labels: Array<{ name: string; color: string }>;
  assignees: Person[];
  mergeable: boolean | null;
  mergeableState: string | null;
  /** Same meaning as InboxItem.reviewDecision, so both show the same status. */
  reviewDecision: InboxItem["reviewDecision"];
  files: DiffFile[];
  local: LocalState | null;
  /** Things the viewer can do. */
  can: { review: boolean; comment: boolean; merge: boolean };
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
