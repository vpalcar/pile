import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile, StackNode } from "@pile/core";
import { createPRCacheManager } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { StackTree, CachedPRInfo } from "../components/StackTree.js";
import { SyncStatus } from "../components/SyncStatus.js";
import { ErrorMessage } from "../components/Message.js";
import { OutputOptions, formatJson, stackToJson } from "../utils/output.js";
import { getPileCountMessage } from "../utils/fun.js";

export interface LogCommandProps {
  options: OutputOptions;
}

type State = "loading" | "ready" | "not_initialized" | "error";

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
            console.log(formatJson(stackToJson(null, "", 0)));
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
        const repoRoot = await pile.git.getRepoRoot();
        const cacheManager = createPRCacheManager(`${repoRoot}/.pile`);
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
        const stackData = await pile.stack.getStack();

        if (options.json) {
          console.log(formatJson(stackToJson(stackData, current, pending)));
          process.exit(0);
        }

        setStackTrees(trees);
        setState("ready");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(formatJson({ error: message }));
          process.exit(1);
        }
        setError(message);
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
