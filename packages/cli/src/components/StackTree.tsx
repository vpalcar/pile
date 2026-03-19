import React from "react";
import { Box, Text } from "ink";
import { StackNode } from "@pile/core";

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

interface FlatBranch {
  name: string;
  depth: number;
  isCurrent: boolean;
  prNumber?: number;
  prStatus?: PRStatusType;
  syncStatus?: string;
  reviews?: number;
}

function flattenTree(
  node: StackNode,
  depth: number,
  prCache?: Record<string, CachedPRInfo>
): FlatBranch[] {
  const result: FlatBranch[] = [];
  const { branch, isCurrentBranch, children } = node;
  const hasMultipleChildren = children.length > 1;

  // Process children first (they appear above in the tree)
  children.forEach((child, index) => {
    const childDepth = hasMultipleChildren && index > 0 ? depth + 1 : depth;
    result.push(...flattenTree(child, childDepth, prCache));
  });

  const cachedPR = prCache?.[branch.name];
  result.push({
    name: branch.name,
    depth,
    isCurrent: isCurrentBranch,
    prNumber: cachedPR?.number ?? branch.prNumber,
    prStatus: cachedPR?.status,
    syncStatus: branch.syncStatus,
    reviews: cachedPR?.reviews,
  });

  return result;
}

export interface StackTreeProps {
  tree: StackNode | null;
  trees?: StackNode[];
  trunk: string;
  prCache?: Record<string, CachedPRInfo>;
}

export function StackTree({
  tree,
  trees,
  trunk,
  prCache,
}: StackTreeProps): React.ReactElement {
  const allTrees = trees ?? (tree ? [tree] : []);

  if (allTrees.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No stack found. Create a branch with `pile create`.</Text>
      </Box>
    );
  }

  const flatBranches: FlatBranch[] = [];
  allTrees.forEach((rootTree, treeIndex) => {
    const treeBranches = flattenTree(rootTree, treeIndex, prCache);
    flatBranches.push(...treeBranches);
  });

  const maxDepth = Math.max(...flatBranches.map((b) => b.depth), 0);

  return (
    <Box flexDirection="column">
      {flatBranches.map((branch) => {
        let prefix = "";
        for (let d = 0; d < branch.depth; d++) {
          prefix += "│ ";
        }

        return (
          <Box key={branch.name}>
            <Text color="gray">{prefix}</Text>
            <Text
              color={branch.isCurrent ? "yellow" : "white"}
              bold={branch.isCurrent}
            >
              {branch.isCurrent ? "◉" : "○"}
            </Text>
            <Text color="gray">{" ".repeat(maxDepth - branch.depth + 1)}</Text>
            <Text
              color={branch.isCurrent ? "yellow" : "white"}
              bold={branch.isCurrent}
            >
              {branch.name}
            </Text>
          </Box>
        );
      })}
      <Box>
        <Text color="gray">○</Text>
        {maxDepth > 0 && <Text color="gray">─┘</Text>}
        <Text color="gray">{maxDepth === 0 ? "  " : " "}</Text>
        <Text color="white">{trunk}</Text>
      </Box>
    </Box>
  );
}
