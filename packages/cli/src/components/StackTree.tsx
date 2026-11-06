import React from "react";
import { Box, Text } from "ink";
import { StackNode } from "@pile/core";
import { layoutTree, type RailRow } from "@pile/review-web/stack-tree";

export type PRStatusType =
  | "draft"
  | "open"
  | "approved"
  | "changes_requested"
  | "merged"
  | "closed";

export interface CachedPRInfo {
  number: number;
  status: PRStatusType;
  reviews: number;
  checksState: string | null;
}

const STATUS_LABELS: Record<PRStatusType, string> = {
  draft: "draft",
  open: "open",
  approved: "approved",
  changes_requested: "changes requested",
  merged: "merged",
  closed: "closed",
};

const STATUS_COLORS: Record<PRStatusType, string> = {
  draft: "gray",
  open: "cyan",
  approved: "green",
  changes_requested: "red",
  merged: "magenta",
  closed: "red",
};

interface FlatBranch {
  name: string;
  parent: string | null;
  isCurrent: boolean;
  prNumber?: number;
  prStatus?: PRStatusType;
  syncStatus?: string;
  reviews?: number;
}

function flattenTree(node: StackNode, parent: string | null, prCache?: Record<string, CachedPRInfo>): FlatBranch[] {
  const { branch, isCurrentBranch, children } = node;
  const cachedPR = prCache?.[branch.name];
  return [
    {
      name: branch.name,
      parent,
      isCurrent: isCurrentBranch,
      prNumber: cachedPR?.number ?? branch.prNumber,
      prStatus: cachedPR?.status,
      syncStatus: branch.syncStatus,
      reviews: cachedPR?.reviews,
    },
    ...children.flatMap((child) => flattenTree(child, branch.name, prCache)),
  ];
}

/**
 * The rail for one row, two characters per lane: the dot in its lane, │ for lanes
 * passing by, and ─┘ (─┴─┘ for several) where branches join this row.
 */
export function railText(row: RailRow, lanes: number, dot: string): string {
  const lastJoin = Math.max(-1, ...row.joins);
  let text = "";
  for (let lane = 0; lane < lanes; lane++) {
    const joining = lane > row.lane && lane <= lastJoin;
    let cell = row.through.includes(lane) ? "│" : " ";
    if (lane === row.lane) cell = dot;
    else if (row.joins.includes(lane)) cell = lane === lastJoin ? "┘" : "┴";
    else if (joining) cell = row.through.includes(lane) ? "┼" : "─";
    text += cell + (lane >= row.lane && lane < lastJoin ? "─" : " ");
  }
  return text;
}

export interface StackTreeProps {
  tree: StackNode | null;
  trees?: StackNode[];
  trunk: string;
  prCache?: Record<string, CachedPRInfo>;
}

/** Stacks as a graph, like `git log --graph`: stacks that branch get a lane per branch. */
export function StackTree({ tree, trees, trunk, prCache }: StackTreeProps): React.ReactElement {
  const allTrees = trees ?? (tree ? [tree] : []);

  if (allTrees.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No stack found. Create a branch with `pile create`.</Text>
      </Box>
    );
  }

  const branches = allTrees.flatMap((root) => flattenTree(root, null, prCache));
  const byName = new Map(branches.map((b) => [b.name, b]));
  const { rows, lanes } = layoutTree(branches.map((b) => ({ id: b.name, parent: b.parent })));

  return (
    <Box flexDirection="column">
      {rows.map((row) => {
        if (row.id === null) {
          return (
            <Box key="trunk">
              <Text color="gray">{railText(row, lanes, "○")}</Text>
              <Text color="white">{trunk}</Text>
            </Box>
          );
        }
        const branch = byName.get(row.id)!;
        const rail = railText(row, lanes, "\0");
        const [before, after] = rail.split("\0");
        return (
          <Box key={branch.name}>
            <Text color="gray">{before}</Text>
            <Text color={branch.isCurrent ? "yellow" : "white"} bold={branch.isCurrent}>
              {branch.isCurrent ? "◉" : "○"}
            </Text>
            <Text color="gray">{after}</Text>
            <Text color={branch.isCurrent ? "yellow" : "white"} bold={branch.isCurrent}>
              {branch.name}
            </Text>
            {branch.prNumber !== undefined && <Text color="gray">{`  #${branch.prNumber}`}</Text>}
            {branch.prStatus && <Text color={STATUS_COLORS[branch.prStatus]}>{` ${STATUS_LABELS[branch.prStatus]}`}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
