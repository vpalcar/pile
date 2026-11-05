import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { PileInstance } from "@pile/core";
import { GitHubInstance, PullRequest, getPRStatus, parsePRNumber } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, WarningMessage } from "../components/Message.js";
import {
  CommandError,
  OutputOptions,
  exitWithError,
  formatJson,
  createResult,
} from "../utils/output.js";
import {
  FailureMessage,
  openPRContext,
  reportFailure,
  resolveTargetPR,
} from "../utils/pr-target.js";
import { getMergeSuccessMessage, getRiskyTimeWarning } from "../utils/fun.js";

export interface MergeCommandProps {
  /** Branch, PR number, #number or PR URL. Default: current branch. */
  target?: string;
  force?: boolean;
  options: OutputOptions;
}

interface BlockingReason {
  type: "checks" | "reviews" | "conflicts" | "blocked" | "draft";
  message: string;
}

interface MergedPR {
  branch: string;
  prNumber: number;
  title: string;
}

interface BlockedPR {
  branch: string;
  prNumber: number;
  title: string;
  reasons: BlockingReason[];
}

type State = "checking" | "merging" | "cleaning" | "success" | "blocked" | "no_pr" | "error";

function getBlockingReasons(pr: PullRequest): BlockingReason[] {
  const reasons: BlockingReason[] = [];

  // Check if draft
  if (pr.draft) {
    reasons.push({
      type: "draft",
      message: "PR is still a draft",
    });
  }

  // Check CI status
  if (pr.checks.state === "failure") {
    reasons.push({
      type: "checks",
      message: `CI checks failing (${pr.checks.failed}/${pr.checks.total} failed)`,
    });
  } else if (pr.checks.state === "pending") {
    reasons.push({
      type: "checks",
      message: `CI checks in progress (${pr.checks.pending}/${pr.checks.total} pending)`,
    });
  }

  // Check reviews
  const status = getPRStatus(pr);
  if (status === "changes_requested") {
    reasons.push({
      type: "reviews",
      message: "Changes requested by reviewer",
    });
  }

  // Check mergeable state
  if (pr.mergeable === false) {
    if (pr.mergeable_state === "dirty") {
      reasons.push({
        type: "conflicts",
        message: "Has merge conflicts",
      });
    } else if (pr.mergeable_state === "blocked") {
      reasons.push({
        type: "blocked",
        message: "Blocked by branch protection rules",
      });
    } else if (pr.mergeable_state === "behind") {
      reasons.push({
        type: "blocked",
        message: "Branch is behind base branch",
      });
    } else {
      reasons.push({
        type: "blocked",
        message: `Cannot merge: ${pr.mergeable_state}`,
      });
    }
  }

  return reasons;
}

function getReasonIcon(type: BlockingReason["type"]): { icon: string; color: string } {
  switch (type) {
    case "checks":
      return { icon: "○", color: "yellow" };
    case "reviews":
      return { icon: "!", color: "red" };
    case "conflicts":
      return { icon: "✗", color: "red" };
    case "blocked":
      return { icon: "⊘", color: "red" };
    case "draft":
      return { icon: "◐", color: "gray" };
    default:
      return { icon: "?", color: "gray" };
  }
}

/**
 * The PR for a branch with reviews and checks, or null. The PR number pile stored at
 * submit time wins (it survives renames); otherwise the newest PR for the branch.
 */
async function findBranchPR(
  pile: PileInstance,
  github: GitHubInstance,
  branch: string,
): Promise<PullRequest | null> {
  const stored = pile.state.getBranchRelationship(branch)?.prNumber;
  if (stored) {
    try {
      return await github.prs.getEnriched(stored);
    } catch {
      // The stored PR may have been deleted; fall back to a lookup by branch.
    }
  }
  const found = await github.prs.findByBranchAnyState(branch);
  return found ? github.prs.getEnriched(found.number) : null;
}

export function MergeCommand({
  target,
  force,
  options,
}: MergeCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [failure, setFailure] = useState<CommandError | null>(null);
  const [currentMerging, setCurrentMerging] = useState<string>("");
  const [mergedPRs, setMergedPRs] = useState<MergedPR[]>([]);
  const [blockedPR, setBlockedPR] = useState<BlockedPR | null>(null);
  const [mergeMethod, setMergeMethod] = useState<string>("squash");

  useEffect(() => {
    async function mergeStack() {
      try {
        const context = await openPRContext(target);
        const { pile, github, trunk, currentBranch } = context;
        const method = pile.state.getConfig()?.mergeMethod ?? "squash";
        setMergeMethod(method);

        // The branch whose stack is merged: the current branch, a named branch, or the
        // head branch of a PR given by number or URL.
        const targetBranch =
          target && parsePRNumber(target) !== null
            ? (await resolveTargetPR(context, target)).pr.head.ref
            : target ?? currentBranch;

        // Merge the stack from the bottom up to (and including) the target branch.
        const stackBranches = pile.stack.getAncestry(targetBranch);
        const merged: MergedPR[] = [];

        for (const branchToMerge of stackBranches) {
          setCurrentMerging(branchToMerge);

          const pr = await findBranchPR(pile, github, branchToMerge);

          if (pr?.merged) {
            // Already merged, clean up and continue
            await cleanupMergedBranch(pile, github, branchToMerge, trunk);
            merged.push({ branch: branchToMerge, prNumber: pr.number, title: pr.title });
            continue;
          }

          if (!pr || pr.state !== "open") {
            const message = `No open PR found for branch: ${branchToMerge}`;
            const error: CommandError = {
              code: "NO_OPEN_PR",
              message,
              hint: "Run `pile submit -s` to create PRs for the stack.",
              data: { merged },
            };
            if (options.json || !options.interactive) exitWithError(options, error);
            process.exitCode = 1;
            setFailure(error);
            setMergedPRs(merged);
            setState("no_pr");
            return;
          }

          // Checks and reviews come from the enriched PR, so they actually gate the merge.
          const reasons = getBlockingReasons(pr);

          if (reasons.length > 0 && !force) {
            setBlockedPR({
              branch: branchToMerge,
              prNumber: pr.number,
              title: pr.title,
              reasons,
            });
            setMergedPRs(merged);
            if (options.json || !options.interactive) {
              exitWithError(options, {
                code: "MERGE_BLOCKED",
                message: `PR #${pr.number} cannot be merged: ${reasons.map((r) => r.message).join("; ")}`,
                hint: "Run `pile status` for details, or `pile merge --force` to merge anyway.",
                data: {
                  merged,
                  blockedAt: {
                    branch: branchToMerge,
                    prNumber: pr.number,
                    blocking: reasons,
                  },
                },
              });
            }
            process.exitCode = 1;
            setState("blocked");
            return;
          }

          // A forced merge of a draft has to mark it ready first (GraphQL only).
          if (force && pr.draft) {
            await github.prs.markReadyForReview(pr.number);
          }

          // Merge the PR
          setState("merging");
          await github.prs.merge(pr.number, method);

          merged.push({ branch: branchToMerge, prNumber: pr.number, title: pr.title });

          // Clean up the merged branch
          setState("cleaning");
          await cleanupMergedBranch(pile, github, branchToMerge, trunk);
        }

        // Update trunk. Only leave the current branch if it was just merged.
        await pile.git.fetch(true);
        const currentMerged = merged.some((m) => m.branch === currentBranch);
        if (currentMerged) {
          await pile.git.checkout(trunk);
          try {
            await pile.git.pull(trunk);
          } catch {
            // Might fail if not tracking
          }
        } else {
          await pile.git.fastForward(trunk);
        }

        // Delete branches that could not be deleted during cleanup because they
        // were checked out.
        for (const pr of merged) {
          try {
            await pile.git.deleteBranch(pr.branch, true);
          } catch {
            // Branch might already be deleted or other issue
          }
        }

        setMergedPRs(merged);

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                merged: merged.map((m) => ({
                  branch: m.branch,
                  prNumber: m.prNumber,
                })),
                mergeMethod: method,
                target: target ?? null,
              })
            )
          );
          process.exit(0);
        }

        setState("success");
      } catch (err) {
        setFailure(reportFailure(options, err));
        setState("error");
      }
    }

    mergeStack();
  }, [options.json, force, target]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Checking stack..." />;
    case "merging":
      return <Spinner label={`Merging ${currentMerging}...`} />;
    case "cleaning":
      return <Spinner label={`Cleaning up ${currentMerging}...`} />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Merged {mergedPRs.length} PR{mergedPRs.length !== 1 ? "s" : ""} in stack
          </SuccessMessage>
          <Box flexDirection="column" marginTop={1}>
            {mergedPRs.map((pr) => (
              <Box key={pr.branch}>
                <Text color="green">  ✓ </Text>
                <Text>#{pr.prNumber} {pr.branch}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color="gray">  {getMergeSuccessMessage()} </Text>
          </Box>
        </Box>
      );
    case "blocked":
      return (
        <Box flexDirection="column">
          {mergedPRs.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <SuccessMessage>
                Merged {mergedPRs.length} PR{mergedPRs.length !== 1 ? "s" : ""}
              </SuccessMessage>
              {mergedPRs.map((pr) => (
                <Box key={pr.branch}>
                  <Text color="green">  ✓ </Text>
                  <Text>#{pr.prNumber} {pr.branch}</Text>
                </Box>
              ))}
            </Box>
          )}
          <WarningMessage>
            PR #{blockedPR?.prNumber} cannot be merged
          </WarningMessage>
          <Text color="gray">  {blockedPR?.branch}: {blockedPR?.title}</Text>
          <Box flexDirection="column" marginTop={1}>
            {blockedPR?.reasons.map((reason, i) => {
              const { icon, color } = getReasonIcon(reason.type);
              return (
                <Box key={i}>
                  <Text color={color}>  {icon} </Text>
                  <Text>{reason.message}</Text>
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1}>
            <Text color="gray">  Run `pile status` for more details</Text>
          </Box>
          <Box>
            <Text color="gray">  Use `pile merge --force` to merge anyway</Text>
          </Box>
        </Box>
      );
    case "no_pr":
      return (
        <Box flexDirection="column">
          {mergedPRs.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <SuccessMessage>
                Merged {mergedPRs.length} PR{mergedPRs.length !== 1 ? "s" : ""}
              </SuccessMessage>
              {mergedPRs.map((pr) => (
                <Box key={pr.branch}>
                  <Text color="green">  ✓ </Text>
                  <Text>#{pr.prNumber} {pr.branch}</Text>
                </Box>
              ))}
            </Box>
          )}
          <WarningMessage>{failure?.message ?? "No open PR for branch in stack"}</WarningMessage>
          <Text color="gray">Run `pile submit -s` to create PRs for the stack.</Text>
        </Box>
      );
    case "error":
      return failure ? <FailureMessage failure={failure} /> : <></>;
    default:
      return <></>;
  }
}

async function cleanupMergedBranch(
  pile: PileInstance,
  github: GitHubInstance,
  branch: string,
  trunk: string
): Promise<void> {
  // Get children before cleaning up
  const children = pile.state.getChildren(branch);
  const parent = pile.state.getParent(branch);
  const newParent = parent ?? trunk;

  // Update children's parent and PR bases
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
          // If retargeting to parent fails, try retargeting to trunk as fallback
          if (newParent !== trunk) {
            try {
              await github.prs.update({
                number: childRel.prNumber,
                base: trunk,
              });
              pile.state.setBranchRelationship(child, {
                ...childRel,
                parent: trunk,
              });
            } catch {
              // PR update failed entirely, will need manual fix
            }
          }
        }
      }
    }
  }

  // Remove tracking
  pile.state.removeBranchRelationship(branch);

  // Delete the local branch (if not currently on it)
  try {
    const current = await pile.git.getCurrentBranch();
    if (current !== branch) {
      await pile.git.deleteBranch(branch, true);
    }
  } catch {
    // Branch might not exist or other issue
  }
}
