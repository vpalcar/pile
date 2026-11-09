import type { Inbox, InboxItem } from "../api";

/**
 * The quick inbox has no checks, reviews or sizes yet. Items already known keep
 * theirs until a full inbox replaces them, so badges never flash back to "Open".
 */
export function keepKnownSignals(inbox: Inbox, previous: Inbox | undefined): Inbox {
  if (!inbox.partial || !previous) return inbox;
  const known = new Map(previous.groups.flatMap((g) => g.items).map((i) => [i.id, i]));
  return {
    ...inbox,
    groups: inbox.groups.map((g) => ({
      ...g,
      items: g.items.map((item) => {
        const before = known.get(item.id);
        if (!before || before.checks === null) return item;
        const { checks, reviewDecision, additions, deletions, comments, stack } = before;
        return { ...item, checks, reviewDecision, additions, deletions, comments, stack: item.stack ?? stack };
      }),
    })),
  };
}

/**
 * After you review a PR, GitHub no longer lists you as a requested reviewer, so it
 * leaves "Needs your review" at once instead of after the next full inbox.
 */
export function afterReview(inbox: Inbox, number: number, verdict: InboxItem["reviewDecision"]): Inbox {
  const isIt = (i: InboxItem) => i.ref.kind === "pr" && i.ref.number === number;
  const reviewed = inbox.groups.find((g) => g.id === "needs_review")?.items.find(isIt);
  return {
    ...inbox,
    groups: inbox.groups.map((g) => {
      const items = g.items.filter((i) => !(g.id === "needs_review" && isIt(i))).map((i) => (isIt(i) ? { ...i, reviewDecision: verdict } : i));
      return g.id === "others" && reviewed ? { ...g, items: [{ ...reviewed, reviewDecision: verdict }, ...items] } : { ...g, items };
    }),
  };
}
