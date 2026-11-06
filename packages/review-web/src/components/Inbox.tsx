import type { Inbox, InboxItem } from "../api";
import { layoutTree, type RailRow } from "../lib/stack-tree";

/** A stack of related items, top first (possibly diverging), or a single item. */
export interface Cluster {
  key: string;
  /** In display order: the top of the stack first. */
  items: InboxItem[];
  /** Rail layout per item id, for stacks; the trunk isn't shown in the inbox. */
  rails: Map<string, RailRow> | null;
  lanes: number;
}

/**
 * Groups a list into stacks: items connected by base -> branch links belong together,
 * in the order their stacks first appear. Each stack is laid out as a tree.
 */
export function clusters(items: InboxItem[]): Cluster[] {
  const byBranch = new Map(items.map((i) => [i.branch, i]));
  const rootOf = (item: InboxItem) => {
    const seen = new Set<string>();
    let current = item;
    while (byBranch.has(current.base) && !seen.has(current.base)) {
      seen.add(current.base);
      current = byBranch.get(current.base)!;
    }
    return current.id;
  };
  const groups = new Map<string, InboxItem[]>();
  for (const item of items) groups.set(rootOf(item), [...(groups.get(rootOf(item)) ?? []), item]);

  return [...groups].map(([key, group]) => {
    if (group.length === 1) return { key, items: group, rails: null, lanes: 1 };
    // Siblings in PR order, the same as on the PR page, so a stack looks the same in both.
    const ordered = [...group].sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true }));
    const { rows, lanes } = layoutTree(ordered.map((i) => ({ id: i.id, parent: byBranch.get(i.base)?.id ?? null })));
    const rails = new Map<string, RailRow>();
    for (const row of rows) {
      // The trunk row isn't drawn here, so the bottom PR's line stops at its dot.
      if (row.id !== null) rails.set(row.id, { ...row, down: row.down && !!byBranch.get(group.find((i) => i.id === row.id)!.base) });
    }
    const order = new Map(rows.map((r, i) => [r.id, i]));
    return { key, items: [...group].sort((a, b) => order.get(a.id)! - order.get(b.id)!), rails, lanes };
  });
}

/** Every inbox item in display order, for stepping with j / k and [ / ]. */
const sortKey = (item: InboxItem) => (item.ref.kind === "pr" ? String(item.ref.number).padStart(9, "0") : `~${item.branch}`);

export function flatItems(inbox: Inbox | undefined): InboxItem[] {
  return inbox?.groups.flatMap((g) => clusters(g.items).flatMap((c) => c.items)) ?? [];
}
