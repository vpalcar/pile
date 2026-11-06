/**
 * Lays out a stack that may diverge (several branches built on the same PR) as rows
 * with lanes, like `git log --graph`: the trunk is the bottom row, every entry sits
 * above what it's built on, the first child continues its parent's lane and other
 * children open lanes to the right. Each row says which lines to draw in it.
 */
export interface TreeNode {
  id: string;
  /** The node this one is built on; null when it's built on the trunk. */
  parent: string | null;
}

export interface RailRow {
  /** null for the trunk row at the bottom. */
  id: string | null;
  lane: number;
  /** A line runs down from this row's dot to what it's built on. */
  down: boolean;
  /** A line comes straight down into this row's dot from a child in the same lane. */
  up: boolean;
  /** Lanes of children that join this row's dot from the right. */
  joins: number[];
  /** Lanes whose lines pass this row without stopping. */
  through: number[];
}

export function layoutTree(nodes: TreeNode[]): { rows: RailRow[]; lanes: number } {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    const parent = node.parent && ids.has(node.parent) ? node.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }

  const placed: Array<{ id: string | null; lane: number; parent: string | null | undefined }> = [];
  let lanes = 1;
  const seen = new Set<string>();
  // A node's subtree is listed above it: later children (in new lanes) on top, then
  // the first child in this lane, then the node itself.
  const place = (id: string | null, lane: number, parent: string | null | undefined) => {
    const kids = (children.get(id) ?? []).filter((k) => !seen.has(k.id));
    kids.forEach((k) => seen.add(k.id));
    const others = kids.slice(1).map((k) => ({ node: k, lane: lanes++ }));
    for (const { node, lane: l } of others.reverse()) place(node.id, l, id);
    if (kids[0]) place(kids[0].id, lane, id);
    placed.push({ id, lane, parent });
  };
  place(null, 0, undefined); // the trunk, at the bottom

  const rows: RailRow[] = placed.map((p) => ({ id: p.id, lane: p.lane, down: false, up: false, joins: [], through: [] }));
  const index = new Map(placed.map((p, i) => [p.id, i]));
  placed.forEach((p, i) => {
    if (p.parent === undefined) return;
    const target = index.get(p.parent)!;
    rows[i].down = true;
    for (let r = i + 1; r < target; r++) rows[r].through.push(p.lane);
    if (p.lane === rows[target].lane) rows[target].up = true;
    else rows[target].joins.push(p.lane);
  });
  return { rows, lanes };
}
