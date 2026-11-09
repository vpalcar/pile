import type { Inbox } from "../api";

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
