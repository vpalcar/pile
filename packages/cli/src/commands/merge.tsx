import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile, PileInstance } from "@pile/core";
import { createGitHub, GitHubInstance, PullRequest, getPRStatus } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import {
  SuccessMessage,
  ErrorMessage,
  WarningMessage,
} from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface MergeCommandProps {
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

type State =
  | "checking"
  | "merging"
  | "cleaning"
  | "success"
  | "blocked"
  | "no_pr"
  | "no_github"
  | "not_initialized"
  | "on_trunk"
  | "error";

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

export function MergeCommand({
  force,
  options,
}: MergeCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [currentMerging, setCurrentMerging] = useState<string>("");
  const [mergedPRs, setMergedPRs] = useState<MergedPR[]>([]);
  const [blockedPR, setBlockedPR] = useState<BlockedPR | null>(null);
  const [mergeMethod, setMergeMethod] = useState<string>("squash");

  useEffect(() => {
    async function mergeStack() {
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

        const config = pile.state.getConfig();
        const trunk = config?.trunk ?? "main";
        const method = config?.mergeMethod ?? "squash";
        setMergeMethod(method);

        const currentBranch = await pile.git.getCurrentBranch();

        if (currentBranch === trunk) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, "Cannot merge from trunk branch")
              )
            );
            process.exit(1);
          }
          setState("on_trunk");
          return;
        }

        const repoRoot = await pile.git.getRepoRoot();
        const github = await createGitHub(`${repoRoot}/.pile`);

        if (!github) {
          if (options.json) {
            console.log(
              formatJson(createResult(false, null, "GitHub not configured"))
            );
            process.exit(1);
          }
          setState("no_github");
          return;
        }

        // Build the stack from trunk to current branch (bottom-up order)
        const stackBranches: string[] = [];
        let branch = currentBranch;
        while (branch && branch !== trunk) {
          stackBranches.unshift(branch); // Add to front so bottom is first
          const parent = pile.state.getParent(branch);
          branch = parent ?? "";
        }

        const merged: MergedPR[] = [];

        // Merge each branch in the stack from bottom to top
        for (const branchToMerge of stackBranches) {
          setCurrentMerging(branchToMerge);

          // Check if this branch's PR is already merged
          const existingPr = await github.prs.findByBranchAnyState(branchToMerge);
          if (existingPr?.merged) {
            // Already merged, clean up and continue
            await cleanupMergedBranch(pile, github, branchToMerge, trunk);
            merged.push({
              branch: branchToMerge,
              prNumber: existingPr.number,
              title: existingPr.title,
            });
            continue;
          }

          // Find the open PR for this branch
          const pr = await github.prs.findByBranch(branchToMerge);

          if (!pr) {
            if (options.json) {
              console.log(
                formatJson(
                  createResult(false, null, `No open PR found for branch: ${branchToMerge}`)
                )
              );
              process.exit(1);
            }
            setError(`No open PR found for branch: ${branchToMerge}`);
            setMergedPRs(merged);
            setState("no_pr");
            return;
          }

          // Get full PR data with mergeable status
          const fullPr = await github.prs.get(pr.number);

          // Check for blocking reasons
          const reasons = getBlockingReasons(fullPr);

          if (reasons.length > 0 && !force) {
            setBlockedPR({
              branch: branchToMerge,
              prNumber: pr.number,
              title: fullPr.title,
              reasons,
            });
            setMergedPRs(merged);
            if (options.json) {
              console.log(
                formatJson(
                  createResult(
                    false,
                    {
                      merged,
                      blockedAt: {
                        branch: branchToMerge,
                        prNumber: pr.number,
                        blocking: reasons,
                      },
                    },
                    `PR #${pr.number} cannot be merged`
                  )
                )
              );
              process.exit(1);
            }
            setState("blocked");
            return;
          }

          // Merge the PR
          setState("merging");
          await github.prs.merge(pr.number, method);

          merged.push({
            branch: branchToMerge,
            prNumber: pr.number,
            title: fullPr.title,
          });

          // Clean up the merged branch
          setState("cleaning");
          await cleanupMergedBranch(pile, github, branchToMerge, trunk);
        }

        // Fetch and update trunk
        await pile.git.fetch(true);
        await pile.git.checkout(trunk);
        try {
          await pile.git.pull(trunk);
        } catch {
          // Might fail if not tracking
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

    mergeStack();
  }, [options.json, force]);

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
            <Text color="gray">  Method: {mergeMethod}</Text>
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
          <WarningMessage>{error || "No open PR for branch in stack"}</WarningMessage>
          <Text color="gray">Run `pile submit -s` to create PRs for the stack.</Text>
        </Box>
      );
    case "no_github":
      return (
        <Box flexDirection="column">
          <ErrorMessage>GitHub not configured</ErrorMessage>
          <Text color="gray">
            Set GITHUB_TOKEN environment variable or run `gh auth login`
          </Text>
        </Box>
      );
    case "not_initialized":
      return (
        <ErrorMessage>Pile not initialized. Run `pile init` first.</ErrorMessage>
      );
    case "on_trunk":
      return (
        <WarningMessage>
          Cannot merge from trunk branch. Checkout a feature branch first.
        </WarningMessage>
      );
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
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
          // PR might not exist or other error
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
