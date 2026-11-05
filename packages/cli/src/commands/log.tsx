import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile, StackNode } from "@pile/core";
import { createPRCacheManager } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { StackTree, CachedPRInfo } from "../components/StackTree.js";
import { SyncStatus } from "../components/SyncStatus.js";
import { ErrorMessage } from "../components/Message.js";
import {
  OutputOptions,
  formatJson,
  stackToJson,
  exitWithError,
  toCommandError,
} from "../utils/output.js";
import { getPileCountMessage } from "../utils/fun.js";

export interface LogCommandProps {
  options: OutputOptions;
}

type State = "loading" | "ready" | "not_initialized" | "error";

interface StackJson {
  name: string;
  parent: string | null;
  prNumber: number | null;
  prUrl: string | null;
  commits: number;
  syncStatus: string;
  isCurrent: boolean;
  children: StackJson[];
}

function treeToJson(node: StackNode): StackJson {
  return {
    name: node.branch.name,
    parent: node.branch.parent,
    prNumber: node.branch.prNumber ?? null,
    prUrl: node.branch.prUrl ?? null,
    commits: node.branch.commits.length,
    syncStatus: node.branch.syncStatus,
    isCurrent: node.isCurrentBranch,
    children: node.children.map(treeToJson),
  };
}

/** The current branch's stack (bottom first), taken from already-loaded trees. */
function currentPath(trees: StackNode[]): StackNode[] {
  for (const tree of trees) {
    if (tree.isCurrentBranch) return [tree];
    const rest = currentPath(tree.children);
    if (rest.length > 0) return [tree, ...rest];
  }
  return [];
}

export function LogCommand({ options }: LogCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("loading");
  const [stackTrees, setStackTrees] = useState<StackNode[]>([]);
  const [trunk, setTrunk] = useState("main");
  const [pendingOps, setPendingOps] = useState(0);
  const [prCache, setPrCache] = useState<Record<string, CachedPRInfo>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const pile = await createPile();

        if (!pile.state.isInitialized()) {
          if (options.json) {
            console.log(formatJson({ ...stackToJson(null, "", 0), stacks: [] }));
            process.exit(0);
          }
          setState("not_initialized");
          return;
        }

        const config = pile.state.getConfig();
        const trunkBranch = config?.trunk ?? "main";
        setTrunk(trunkBranch);

        const current = await pile.git.getCurrentBranch();
        const pending = pile.state.getPendingOperationCount();
        setPendingOps(pending);

        // Load PR cache
        const cacheManager = createPRCacheManager(pile.state.getPileDir());
        const cachedPRs = cacheManager.getAllCachedPRs();

        const prCacheMap: Record<string, CachedPRInfo> = {};
        for (const pr of cachedPRs) {
          prCacheMap[pr.branch] = {
            number: pr.number,
            status: pr.status,
            reviews: pr.reviews,
            checksState: pr.checksState,
          };
        }
        setPrCache(prCacheMap);

        const trees = await pile.stack.getAllStackTrees();

        if (options.json) {
          const stackData = {
            id: current,
            branches: currentPath(trees).map((node) => node.branch),
            trunk: trunkBranch,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          console.log(
            formatJson({
              ...stackToJson(stackData, current, pending),
              stacks: trees.map(treeToJson),
            }),
          );
          process.exit(0);
        }

        setStackTrees(trees);
        setState("ready");
      } catch (err) {
        if (options.json || !options.interactive) {
          exitWithError(options, toCommandError(err));
        }
        process.exitCode = 1;
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    }

    load();
  }, [options.json]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "loading":
      return <Spinner label="Loading stack..." />;
    case "ready":
      // Count total branches in all trees
      const countBranches = (nodes: StackNode[]): number => {
        return nodes.reduce((acc, node) => acc + 1 + countBranches(node.children), 0);
      };
      const totalBranches = countBranches(stackTrees);

      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <SyncStatus isOnline={true} pendingOps={pendingOps} />
          </Box>
          <StackTree trees={stackTrees} tree={null} trunk={trunk} prCache={prCache} />
          {totalBranches > 0 && (
            <Box marginTop={1}>
              <Text color="gray" dimColor>  {getPileCountMessage(totalBranches)}</Text>
            </Box>
          )}
        </Box>
      );
    case "not_initialized":
      return <ErrorMessage>Pile not initialized. Run `pile init` first.</ErrorMessage>;
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
    default:
      return <></>;
  }
}
