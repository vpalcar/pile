import type { ChecksSummary, Detail, InboxItem, PRState, StackEntry } from "../api";

export type Tone = "green" | "red" | "amber" | "blue" | "purple" | "gray";

export interface Readiness {
  /** Short label shown in badges. */
  label: string;
  /** One sentence for tooltips. */
  detail: string;
  tone: Tone;
  /** Sort weight: lower needs attention sooner. */
  rank: number;
}

interface Signals {
  state: PRState | "local";
  decision: InboxItem["reviewDecision"];
  checks: ChecksSummary | null;
  unpushed?: boolean;
}

/**
 * One answer to "where is this PR?", in priority order: finished states first, then
 * things that block merging, then review progress.
 */
export function readiness({ state, decision, checks, unpushed }: Signals): Readiness {
  if (state === "merged") return { label: "Merged", detail: "Merged into the base branch.", tone: "purple", rank: 8 };
  if (state === "closed") return { label: "Closed", detail: "Closed without merging.", tone: "gray", rank: 9 };
  if (state === "local") {
    return { label: "Local", detail: "Only on this machine. Run `pile submit` to open a pull request.", tone: "amber", rank: 6 };
  }
  if (state === "draft") return { label: "Draft", detail: "Not ready for review yet.", tone: "gray", rank: 5 };
  if (checks?.state === "failure") {
    return { label: "Checks failing", detail: `${checks.failed} of ${checks.total} checks failed.`, tone: "red", rank: 1 };
  }
  if (decision === "changes_requested") return { label: "Changes requested", detail: "A reviewer asked for changes.", tone: "red", rank: 1 };
  if (decision === "approved") {
    if (checks?.state === "pending") return { label: "Approved", detail: "Approved; checks are still running.", tone: "green", rank: 3 };
    if (unpushed) return { label: "Approved", detail: "Approved, but local commits aren't pushed yet.", tone: "green", rank: 3 };
    return {
      label: "Ready to merge",
      detail: !checks || checks.state === "none" ? "Approved. No checks are configured." : "Approved and checks pass.",
      tone: "green",
      rank: 2,
    };
  }
  if (decision === "review_required") return { label: "In review", detail: "Waiting for requested reviewers.", tone: "blue", rank: 4 };
  if (decision === "commented") return { label: "In review", detail: "Reviewers have commented; no approval yet.", tone: "blue", rank: 4 };
  return { label: "Open", detail: "No reviewers requested yet.", tone: "gray", rank: 5 };
}

export const itemReadiness = (item: InboxItem): Readiness =>
  readiness({ state: item.state, decision: item.reviewDecision, checks: item.checks, unpushed: item.local?.unpushed });

export const detailReadiness = (detail: Detail): Readiness =>
  readiness({ state: detail.state, decision: detail.reviewDecision, checks: detail.checksSummary, unpushed: !!detail.local && detail.local.ahead > 0 });

/** Stack entries use what the inbox knows about them, falling back to their state. */
export function entryReadiness(entry: StackEntry, items: InboxItem[]): Readiness {
  const item = items.find((i) =>
    entry.ref.kind === "pr" ? i.ref.kind === "pr" && i.ref.number === entry.ref.number : i.ref.kind === "branch" && i.ref.name === entry.ref.name,
  );
  return item ? itemReadiness(item) : readiness({ state: entry.state, decision: entry.reviewDecision, checks: null });
}
