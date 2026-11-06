import { describe, expect, it } from "vitest";
import type { Inbox, InboxItem, StackEntry } from "../src/api";
import { keepKnownSignals } from "../src/lib/inbox";
import { entryReadiness } from "../src/lib/status";

const item = (number: number, extra: Partial<InboxItem> = {}): InboxItem => ({
  ref: { kind: "pr", number },
  id: `pr-${number}`,
  title: `PR ${number}`,
  branch: `b${number}`,
  base: "main",
  author: null,
  state: "open",
  updatedAt: null,
  additions: 10,
  deletions: 2,
  reviewDecision: "review_required",
  checks: { state: "failure", total: 2, passed: 1, failed: 1, pending: 0 },
  stack: null,
  local: null,
  url: null,
  comments: 3,
  ...extra,
});
const quick = (number: number) => item(number, { checks: null, reviewDecision: null, additions: null, deletions: null, comments: 0 });
const inbox = (items: InboxItem[], partial = false): Inbox => ({ groups: [{ id: "mine", title: "Mine", items }], fetchedAt: "", partial });

describe("keepKnownSignals", () => {
  it("keeps checks and reviews from the full inbox when a quick one arrives", () => {
    const merged = keepKnownSignals(inbox([quick(1)], true), inbox([item(1)]));
    const [one] = merged.groups[0].items;
    expect(one.checks?.state).toBe("failure");
    expect(one.reviewDecision).toBe("review_required");
    expect(one.additions).toBe(10);
  });

  it("takes titles and new items from the quick inbox", () => {
    const merged = keepKnownSignals(inbox([{ ...quick(1), title: "Renamed" }, quick(2)], true), inbox([item(1)]));
    expect(merged.groups[0].items.map((i) => i.title)).toEqual(["Renamed", "PR 2"]);
    expect(merged.groups[0].items[1].checks).toBeNull();
  });

  it("replaces everything once a full inbox arrives", () => {
    const full = inbox([item(1, { checks: { state: "success", total: 2, passed: 2, failed: 0, pending: 0 } })]);
    expect(keepKnownSignals(full, inbox([item(1)]))).toBe(full);
  });
});

describe("entryReadiness", () => {
  const entry = (extra: Partial<StackEntry> = {}): StackEntry => ({
    ref: { kind: "pr", number: 1 },
    title: "PR 1",
    branch: "b1",
    state: "open",
    reviewDecision: "review_required",
    isCurrent: false,
    ...extra,
  });

  it("uses the entry's own checks over the inbox's", () => {
    const passing = entry({ checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 } });
    expect(entryReadiness(passing, [item(1)]).label).toBe("In review");
  });

  it("falls back to the inbox when the entry has no checks of its own", () => {
    expect(entryReadiness(entry(), [item(1)]).label).toBe("Checks failing");
  });
});
