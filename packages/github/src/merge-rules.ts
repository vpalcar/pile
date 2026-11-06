import { getPRStatus, type PullRequest } from "./types.js";

/** Why a PR can't be merged right now. */
export interface BlockingReason {
  type: "checks" | "reviews" | "conflicts" | "blocked" | "draft";
  message: string;
}

/** What the merge rules look at; filled from a full PR or from lighter data. */
export interface MergeSignals {
  draft: boolean;
  checks: { state: string | null; total: number; failed: number; pending: number };
  changesRequested: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  /** GitHub's review decision says an approving review is still required. */
  reviewRequired?: boolean;
}

/**
 * The reasons pile won't merge a PR: a draft, checks failing or still running,
 * changes requested, or GitHub saying it can't be merged. Shared by `pile merge` and
 * the review app, so both refuse the same things.
 */
export function blockingReasons(pr: MergeSignals): BlockingReason[] {
  const reasons: BlockingReason[] = [];
  if (pr.draft) reasons.push({ type: "draft", message: "PR is still a draft" });

  if (pr.checks.state === "failure") {
    reasons.push({ type: "checks", message: `CI checks failing (${pr.checks.failed}/${pr.checks.total} failed)` });
  } else if (pr.checks.state === "pending") {
    reasons.push({ type: "checks", message: `CI checks in progress (${pr.checks.pending}/${pr.checks.total} pending)` });
  }

  if (pr.changesRequested) reasons.push({ type: "reviews", message: "Changes requested by reviewer" });
  else if (pr.reviewRequired) reasons.push({ type: "reviews", message: "Needs an approving review" });

  const state = pr.mergeableState;
  if (state === "blocked") {
    // GitHub says "blocked" for PRs without conflicts too (a required review or check
    // missing): say so unless a reason above already explains it.
    if (reasons.length === 0) reasons.push({ type: "blocked", message: "Blocked by branch protection rules" });
  } else if (pr.mergeable === false) {
    if (state === "dirty") reasons.push({ type: "conflicts", message: "Has merge conflicts" });
    else if (state === "behind") reasons.push({ type: "blocked", message: "Branch is behind base branch" });
    else reasons.push({ type: "blocked", message: `Cannot merge: ${state}` });
  }
  return reasons;
}

/** The merge rules for a PR fetched with its checks and reviews. */
export const getBlockingReasons = (pr: PullRequest): BlockingReason[] =>
  blockingReasons({
    draft: pr.draft,
    checks: pr.checks,
    changesRequested: getPRStatus(pr) === "changes_requested",
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
    reviewRequired: pr.reviewDecision === "REVIEW_REQUIRED",
  });
