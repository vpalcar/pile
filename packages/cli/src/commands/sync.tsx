import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile, RestackResult } from "@pile/core";
import { createGitHub, createQueueProcessor } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import {
  SuccessMessage,
  ErrorMessage,
  WarningMessage,
} from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface SyncCommandProps {
  options: OutputOptions;
}

interface QueueResult {
  processed: number;
  failed: number;
}

interface CleanedBranch {
  branch: string;
  reason: "merged" | "closed";
  prNumber?: number;
}

type State =
  | "checking"
  | "processing_queue"
  | "fetching"
  | "updating_trunk"
  | "restacking"
  | "refreshing_prs"
  | "cleaning_branches"
  | "success"
  | "conflict"
  | "restack_in_progress"
  | "not_initialized"
  | "error";

export function SyncCommand({ options }: SyncCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [restackResult, setRestackResult] = useState<RestackResult | null>(null);
  const [conflictBranch, setConflictBranch] = useState<string | null>(null);
  const [queueResult, setQueueResult] = useState<QueueResult | null>(null);
  const [cleanedBranches, setCleanedBranches] = useState<CleanedBranch[]>([]);

  useEffect(() => {
    async function sync() {
      try {
        const pile = await createPile();

        if (!pile.state.isInitialized()) {
          if (options.json) {
            console.log(
              formatJson(createResult(false, null, "Pile not initialized"))
            );
            process.exit(1);
          }
          setState("not_initialized");
          return;
        }

        // Check if there's a restack in progress
        if (pile.stack.hasRestackInProgress()) {
          const existingState = pile.stack.getRestackState();
          if (options.json) {
            console.log(
              formatJson(
                createResult(
                  false,
                  existingState,
                  `Restack in progress on ${existingState?.conflictBranch}. Run 'pile restack --continue' or 'pile restack --abort'.`
                )
              )
            );
            process.exit(1);
          }
          setConflictBranch(existingState?.conflictBranch ?? null);
          setState("restack_in_progress");
          return;
        }

        const repoRoot = await pile.git.getRepoRoot();
        const github = await createGitHub(`${repoRoot}/.pile`);
        const trunk = pile.stack.getTrunk();

        // Process pending operations if GitHub is available
        if (github && pile.state.hasPendingOperations()) {
          setState("processing_queue");
          const pendingOps = pile.state.getPendingOps();
          const processor = createQueueProcessor({
            prs: github.prs,
            cache: github.cache,
            maxRetries: 3,
          });

          const queueProcessResult = await processor.process(
            pendingOps,
            (id, success) => {
              if (success) {
                pile.state.removeOperation(id);
              }
            },
            (id) => {
              pile.state.incrementOperationRetry(id);
            }
          );

          setQueueResult({
            processed: queueProcessResult.processed,
            failed: queueProcessResult.failed,
          });
        }

        // Fetch and update trunk
        setState("fetching");
        await pile.git.fetch(true);

        setState("updating_trunk");
        try {
          await pile.git.checkout(trunk);
          await pile.git.pull(trunk);
        } catch {
          // Trunk might not have a remote
        }

        // Restack using the new state-managed flow
        setState("restacking");
        const result = await pile.stack.startRestack();
        setRestackResult(result);

        // Check for conflicts
        if (!result.success && result.conflictBranch) {
          setConflictBranch(result.conflictBranch);
          if (options.json) {
            console.log(
              formatJson(
                createResult(
                  false,
                  { restacked: result, queue: queueResult },
                  `Conflict in ${result.conflictBranch}`
                )
              )
            );
            process.exit(1);
          }
          setState("conflict");
          return;
        }

        // Refresh PR cache and check for merged/closed branches
        setState("refreshing_prs");
        const cleaned: CleanedBranch[] = [];

        if (github) {
          const trackedBranches = pile.stack.getAllTrackedBranches();
          const branchesToClean: Array<{ branch: string; reason: "merged" | "closed"; prNumber?: number; parent: string | null }> = [];

          for (const branch of trackedBranches) {
            try {
              // Check for open PRs first
              let pr = await github.prs.findByBranch(branch);

              if (pr) {
                // PR exists and is open
                github.cache.cachePR(pr);
              } else {
                // Check if PR was merged or closed
                pr = await github.prs.findByBranchAnyState(branch);

                if (pr) {
                  if (pr.merged) {
                    const parent = pile.state.getParent(branch);
                    branchesToClean.push({
                      branch,
                      reason: "merged",
                      prNumber: pr.number,
                      parent
                    });
                  } else if (pr.state === "closed") {
                    const parent = pile.state.getParent(branch);
                    branchesToClean.push({
                      branch,
                      reason: "closed",
                      prNumber: pr.number,
                      parent
                    });
                  }
                }
              }
            } catch {
              // Ignore errors when refreshing individual PRs
            }
          }

          // Clean up merged/closed branches
          if (branchesToClean.length > 0) {
            setState("cleaning_branches");

            for (const { branch, reason, prNumber, parent } of branchesToClean) {
              try {
                // Get children of this branch before deleting
                const children = pile.state.getChildren(branch);

                // Reparent children to this branch's parent
                const newParent = parent ?? trunk;
                for (const child of children) {
                  const childRel = pile.state.getBranchRelationship(child);
                  if (childRel) {
                    pile.state.setBranchRelationship(child, {
                      ...childRel,
                      parent: newParent,
                    });

                    // Update the child's PR base on GitHub
                    if (childRel.prNumber) {
                      try {
                        await github.prs.update({
                          number: childRel.prNumber,
                          base: newParent,
                        });
                      } catch {
                        // PR might not exist or other error
                      }
                    }
                  }
                }

                // If we're on this branch, switch to trunk first
                const nowCurrentBranch = await pile.git.getCurrentBranch();
                if (nowCurrentBranch === branch) {
                  await pile.git.checkout(trunk);
                }

                // Remove from pile tracking
                pile.state.removeBranchRelationship(branch);

                // Delete the local branch
                try {
                  await pile.git.deleteBranch(branch, true);
                } catch {
                  // Branch might not exist locally (only remote)
                }

                cleaned.push({ branch, reason, prNumber });
              } catch {
                // Ignore errors when cleaning individual branches
              }
            }
          }
        }

        setCleanedBranches(cleaned);

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                restacked: result,
                queue: queueResult,
                cleaned,
              })
            )
          );
          process.exit(0);
        }

        setState("success");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(formatJson(createResult(false, null, message)));
          process.exit(1);
        }
        setError(message);
        setState("error");
      }
    }

    sync();
  }, [options.json]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Checking repository state..." />;
    case "processing_queue":
      return <Spinner label="Processing pending operations..." />;
    case "fetching":
      return <Spinner label="Fetching from remote..." />;
    case "updating_trunk":
      return <Spinner label="Updating trunk branch..." />;
    case "restacking":
      return <Spinner label="Restacking branches..." />;
    case "refreshing_prs":
      return <Spinner label="Refreshing PR statuses..." />;
    case "cleaning_branches":
      return <Spinner label="Cleaning up merged/closed branches..." />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>Sync complete</SuccessMessage>
          {queueResult &&
            (queueResult.processed > 0 || queueResult.failed > 0) && (
              <Box flexDirection="column" marginTop={1}>
                <Text color="gray">Pending operations:</Text>
                <Text color="green">
                  {"  "}✓ {queueResult.processed} processed
                </Text>
                {queueResult.failed > 0 && (
                  <Text color="red">
                    {"  "}✗ {queueResult.failed} failed
                  </Text>
                )}
              </Box>
            )}
          {cleanedBranches.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Cleaned up branches:</Text>
              {cleanedBranches.map((item) => (
                <Text key={item.branch} color="magenta">
                  {"  "}✓ {item.branch}{" "}
                  <Text color="gray">
                    ({item.reason}{item.prNumber ? ` PR #${item.prNumber}` : ""})
                  </Text>
                </Text>
              ))}
            </Box>
          )}
          {restackResult && restackResult.completed.filter((b) => !cleanedBranches.some((c) => c.branch === b)).length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Restacked branches:</Text>
              {restackResult.completed
                .filter((b) => !cleanedBranches.some((c) => c.branch === b))
                .map((branch) => (
                  <Text key={branch} color="green">
                    {"  "}✓ {branch}
                  </Text>
                ))}
            </Box>
          )}
          {(!restackResult || restackResult.completed.filter((b) => !cleanedBranches.some((c) => c.branch === b)).length === 0) && cleanedBranches.length === 0 && (
            <Text color="gray">No branches to restack or clean.</Text>
          )}
        </Box>
      );
    case "conflict":
      return (
        <Box flexDirection="column">
          <WarningMessage>Rebase conflict in {conflictBranch}</WarningMessage>
          <Box flexDirection="column" marginTop={1}>
            <Text>Resolve the conflicts, then run:</Text>
            <Text color="cyan">{"  "}git add &lt;files&gt;</Text>
            <Text color="cyan">{"  "}pile restack --continue</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">Or abort with: pile restack --abort</Text>
          </Box>
          {restackResult && restackResult.completed.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Successfully restacked before conflict:</Text>
              {restackResult.completed.map((branch) => (
                <Text key={branch} color="green">
                  {"  "}✓ {branch}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      );
    case "restack_in_progress":
      return (
        <Box flexDirection="column">
          <WarningMessage>Restack already in progress</WarningMessage>
          <Text>Conflict in {conflictBranch}</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text>Resolve the conflicts, then run:</Text>
            <Text color="cyan">{"  "}git add &lt;files&gt;</Text>
            <Text color="cyan">{"  "}pile restack --continue</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">Or abort with: pile restack --abort</Text>
          </Box>
        </Box>
      );
    case "not_initialized":
      return (
        <ErrorMessage>Pile not initialized. Run `pile init` first.</ErrorMessage>
      );
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
    default:
      return <></>;
  }
}
