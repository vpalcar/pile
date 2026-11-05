import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { createPile, mapLimit, RestackResult, PileInstance } from "@pile/core";
import { createGitHub, createQueueProcessor, GitHubInstance } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import {
  SuccessMessage,
  ErrorMessage,
  WarningMessage,
} from "../components/Message.js";
import {
  OutputOptions,
  formatJson,
  createResult,
  exitWithError,
  toCommandError,
} from "../utils/output.js";
import { useFailureExitCode } from "../utils/exit-code.js";

const CLEANUP_HINT = "Rerun with --yes to delete merged and closed branches without a prompt.";
const CONFLICT_HINT =
  "Resolve the conflicts, `git add` the files, then run `pile restack --continue` (or `pile restack --abort`).";

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

interface SkippedBranch {
  branch: string;
  reason: "merged" | "closed";
  prNumber?: number;
}

interface BranchToClean {
  branch: string;
  reason: "merged" | "closed";
  prNumber?: number;
  parent: string | null;
}

type State =
  | "checking"
  | "processing_queue"
  | "fetching"
  | "updating_trunk"
  | "restacking"
  | "refreshing_prs"
  | "confirming_delete"
  | "cleaning_branches"
  | "success"
  | "conflict"
  | "restack_in_progress"
  | "not_initialized"
  | "error";

export function SyncCommand({ options }: SyncCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<State>("checking");
  useFailureExitCode(state, ["conflict", "restack_in_progress", "not_initialized", "error"]);
  const [error, setError] = useState<string | null>(null);
  const [restackResult, setRestackResult] = useState<RestackResult | null>(null);
  const [conflictBranch, setConflictBranch] = useState<string | null>(null);
  const [queueResult, setQueueResult] = useState<QueueResult | null>(null);
  const [cleanedBranches, setCleanedBranches] = useState<CleanedBranch[]>([]);
  const [skippedBranches, setSkippedBranches] = useState<SkippedBranch[]>([]);
  const [branchesToConfirm, setBranchesToConfirm] = useState<BranchToClean[]>([]);
  const [pileInstance, setPileInstance] = useState<PileInstance | null>(null);
  const [githubInstance, setGithubInstance] = useState<GitHubInstance | null>(null);
  const [trunk, setTrunk] = useState<string>("main");

  useEffect(() => {
    async function sync() {
      try {
        const pile = await createPile();

        if (!pile.state.isInitialized()) {
          if (!options.interactive) {
            exitWithError(options, {
              code: "NOT_INITIALIZED",
              message: "Pile not initialized",
              hint: "Run `pile init` first.",
            });
          }
          setState("not_initialized");
          return;
        }

        // Check if there's a restack in progress
        if (pile.stack.hasRestackInProgress()) {
          const existingState = pile.stack.getRestackState();
          if (!options.interactive) {
            exitWithError(options, {
              code: "RESTACK_IN_PROGRESS",
              message: `Restack in progress on ${existingState?.conflictBranch}`,
              hint: CONFLICT_HINT,
              data: existingState,
            });
          }
          setConflictBranch(existingState?.conflictBranch ?? null);
          setState("restack_in_progress");
          return;
        }

        const github = await createGitHub(pile);
        const trunk = pile.stack.getTrunk();
        const originalBranch = await pile.git.getCurrentBranch();

        // Process pending operations if GitHub is available
        let queue: QueueResult | null = null;
        if (github && pile.state.hasPendingOperations()) {
          setState("processing_queue");
          const processor = createQueueProcessor({
            prs: github.prs,
            cache: github.cache,
            maxRetries: 3,
          });

          const queueProcessResult = await processor.process(
            pile.state.getPendingOps(),
            (id, success) => {
              if (success) {
                pile.state.removeOperation(id);
              }
            },
            (id) => {
              pile.state.incrementOperationRetry(id);
            }
          );

          queue = {
            processed: queueProcessResult.processed,
            failed: queueProcessResult.failed,
          };
          setQueueResult(queue);
        }

        // Fetch and fast-forward trunk (without checking it out)
        setState("fetching");
        await pile.git.fetch(true);

        setState("updating_trunk");
        const trunkUpdated = await pile.git.fastForward(trunk);

        // Find branches whose PRs were merged or closed, before restacking, so children
        // of merged branches restack straight onto trunk.
        setState("refreshing_prs");
        const candidates = github ? await findBranchesToClean(pile, github, trunk) : [];

        // Merged work is in trunk: move children to the merged branch's parent and stop
        // tracking it. This is safe without consent; only deleting the local branch needs it.
        const merged = candidates.filter((c) => c.reason === "merged");
        await reparentChildren(pile, github, merged, trunk);
        for (const { branch } of merged) {
          pile.state.removeBranchRelationship(branch);
        }

        // Restack the current branch's stack (or every stack when on trunk)
        setState("restacking");
        const restackFrom = pile.state.getBranchRelationship(originalBranch) ? originalBranch : undefined;
        const result = await pile.stack.startRestack(restackFrom);
        setRestackResult(result);

        // Check for conflicts
        if (!result.success && result.conflictBranch) {
          setConflictBranch(result.conflictBranch);
          if (!options.interactive) {
            exitWithError(options, {
              code: "RESTACK_CONFLICT",
              message: `Conflict while restacking ${result.conflictBranch}`,
              hint: CONFLICT_HINT,
              data: { restacked: result, queue },
            });
          }
          setState("conflict");
          return;
        }

        if (candidates.length > 0 && options.interactive && !options.yes) {
          // Ask before deleting local branches
          setPileInstance(pile);
          setGithubInstance(github);
          setTrunk(trunk);
          setBranchesToConfirm(candidates);
          setState("confirming_delete");
          return;
        }

        // --yes deletes; otherwise (non-interactive) nothing is deleted and the
        // candidates are reported so the caller can decide.
        const cleaned = options.yes ? await cleanupBranches(pile, github, candidates, trunk, true) : [];
        const skipped = options.yes
          ? []
          : candidates.map(({ branch, reason, prNumber }) => ({ branch, reason, prNumber }));

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                restacked: result,
                queue,
                trunk: { name: trunk, updated: trunkUpdated },
                cleaned,
                cleanup: {
                  deleted: cleaned.map((c) => c.branch),
                  skipped,
                  ...(skipped.length > 0 ? { hint: CLEANUP_HINT } : {}),
                },
              })
            )
          );
          process.exit(0);
        }

        setCleanedBranches(cleaned);
        setSkippedBranches(skipped);
        setState("success");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!options.interactive) {
          exitWithError(options, toCommandError(err));
        }
        setError(message);
        setState("error");
      }
    }

    sync();
  }, [options.json, options.interactive, options.yes]);

  // Handle branch cleanup after user confirmation
  const handleCleanupBranches = async (deleteBranches: boolean) => {
    if (!pileInstance) return;
    setState("cleaning_branches");
    const cleaned = await cleanupBranches(
      pileInstance,
      githubInstance,
      branchesToConfirm,
      trunk,
      deleteBranches
    );
    setCleanedBranches(cleaned);
    setBranchesToConfirm([]);
    setState("success");
  };

  // Handle user input for delete confirmation
  useInput(
    (input, key) => {
      if (state === "confirming_delete") {
        if (input === "y" || input === "Y" || key.return) {
          handleCleanupBranches(true);
        } else if (input === "n" || input === "N" || key.escape) {
          handleCleanupBranches(false);
        }
      }
    },
    { isActive: state === "confirming_delete" }
  );

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
    case "confirming_delete":
      return (
        <Box flexDirection="column">
          <Text bold>The following branches have been merged or closed:</Text>
          <Box flexDirection="column" marginTop={1}>
            {branchesToConfirm.map((item) => (
              <Text key={item.branch} color="magenta">
                {"  "}• {item.branch}{" "}
                <Text color="gray">
                  ({item.reason}{item.prNumber ? ` PR #${item.prNumber}` : ""})
                </Text>
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text>Delete these local branches? </Text>
            <Text color="gray">y yes  n no (untrack only)</Text>
          </Box>
        </Box>
      );
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
          {skippedBranches.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Merged or closed (kept):</Text>
              {skippedBranches.map((item) => (
                <Text key={item.branch} color="magenta">
                  {"  "}• {item.branch}{" "}
                  <Text color="gray">
                    ({item.reason}{item.prNumber ? ` PR #${item.prNumber}` : ""})
                  </Text>
                </Text>
              ))}
              <Text color="gray">{"  "}{CLEANUP_HINT}</Text>
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
            <Text color="cyan">{"  "}pile add &lt;files&gt;</Text>
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
            <Text color="cyan">{"  "}pile add &lt;files&gt;</Text>
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

/** Local branches (other than trunk) whose PR was merged or closed, looked up in parallel. */
async function findBranchesToClean(
  pile: PileInstance,
  github: GitHubInstance,
  trunk: string
): Promise<BranchToClean[]> {
  const branches = (await pile.git.getAllBranches()).filter((branch) => branch !== trunk);
  const results = await mapLimit(branches, 8, async (branch): Promise<BranchToClean | null> => {
    try {
      // Most recent PR in any state; open PRs refresh the cache.
      const pr = await github.prs.findByBranchAnyState(branch);
      if (!pr) return null;
      if (pr.state === "open" && !pr.merged) {
        github.cache.cachePR(pr);
        return null;
      }
      const reason = pr.merged ? "merged" : pr.state === "closed" ? "closed" : null;
      if (!reason) return null;
      return { branch, reason, prNumber: pr.number, parent: pile.state.getParent(branch) };
    } catch {
      // Ignore errors when refreshing individual PRs
      return null;
    }
  });
  return results.filter((r): r is BranchToClean => r !== null);
}

/** Moves children of each branch onto that branch's parent, locally and on GitHub. */
async function reparentChildren(
  pile: PileInstance,
  github: GitHubInstance | null,
  branches: BranchToClean[],
  trunk: string
): Promise<void> {
  const prUpdates: Array<Promise<unknown>> = [];
  for (const { branch, parent } of branches) {
    const newParent = parent ?? trunk;
    for (const child of pile.state.getChildren(branch)) {
      const childRel = pile.state.getBranchRelationship(child);
      if (!childRel) continue;
      pile.state.setBranchRelationship(child, { ...childRel, parent: newParent });
      if (github && childRel.prNumber) {
        prUpdates.push(
          github.prs.update({ number: childRel.prNumber, base: newParent }).catch(() => undefined)
        );
      }
    }
  }
  await Promise.all(prUpdates);
}

/**
 * Untracks merged/closed branches (reparenting their children) and, when
 * `deleteLocal` is set, deletes the local branches.
 */
async function cleanupBranches(
  pile: PileInstance,
  github: GitHubInstance | null,
  branches: BranchToClean[],
  trunk: string,
  deleteLocal: boolean
): Promise<CleanedBranch[]> {
  await reparentChildren(pile, github, branches, trunk);
  const cleaned: CleanedBranch[] = [];
  for (const { branch, reason, prNumber } of branches) {
    try {
      if ((await pile.git.getCurrentBranch()) === branch) {
        await pile.git.checkout(trunk);
      }
      pile.state.removeBranchRelationship(branch);
      if (deleteLocal) {
        try {
          await pile.git.deleteBranch(branch, true);
        } catch {
          // Branch might not exist locally (only remote)
        }
      }
      cleaned.push({ branch, reason, prNumber });
    } catch {
      // Ignore errors when cleaning individual branches
    }
  }
  return cleaned;
}
