import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { createGitHub, PullRequest, getPRStatus } from "@pile/github";
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

type State =
  | "checking"
  | "merging"
  | "cleaning"
  | "updating_children"
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
  const [mergedBranch, setMergedBranch] = useState<string>("");
  const [prNumber, setPrNumber] = useState<number | null>(null);
  const [mergeMethod, setMergeMethod] = useState<string>("squash");
  const [blockingReasons, setBlockingReasons] = useState<BlockingReason[]>([]);
  const [prTitle, setPrTitle] = useState<string>("");

  useEffect(() => {
    async function merge() {
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
        setMergedBranch(currentBranch);

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

        // Find the PR for this branch
        const pr = await github.prs.findByBranch(currentBranch);

        if (!pr) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, "No open PR found for this branch")
              )
            );
            process.exit(1);
          }
          setState("no_pr");
          return;
        }

        setPrNumber(pr.number);

        // Get full PR data with mergeable status
        const fullPr = await github.prs.get(pr.number);
        setPrTitle(fullPr.title);

        // Check for blocking reasons
        const reasons = getBlockingReasons(fullPr);

        if (reasons.length > 0 && !force) {
          setBlockingReasons(reasons);
          if (options.json) {
            console.log(
              formatJson(
                createResult(
                  false,
                  {
                    prNumber: pr.number,
                    blocking: reasons,
                  },
                  "PR cannot be merged"
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

        // Get children before cleaning up
        const children = pile.state.getChildren(currentBranch);
        const parent = pile.state.getParent(currentBranch);
        const newParent = parent ?? trunk;

        // Update children's parent and PR bases
        if (children.length > 0) {
          setState("updating_children");
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
        }

        // Clean up: remove tracking and switch to parent
        setState("cleaning");
        pile.state.removeBranchRelationship(currentBranch);

        // Switch to parent branch
        await pile.git.checkout(newParent);

        // Delete the local branch
        try {
          await pile.git.deleteBranch(currentBranch, true);
        } catch {
          // Branch might still be checked out or other issue
        }

        // Fetch to update trunk
        await pile.git.fetch(true);
        if (newParent === trunk) {
          try {
            await pile.git.pull(trunk);
          } catch {
            // Might fail if not tracking
          }
        }

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                branch: currentBranch,
                prNumber: pr.number,
                mergeMethod: method,
                childrenUpdated: children.length,
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

    merge();
  }, [options.json, force]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Checking PR status..." />;
    case "merging":
      return <Spinner label={`Merging PR #${prNumber} (${mergeMethod})...`} />;
    case "updating_children":
      return <Spinner label="Updating child branches..." />;
    case "cleaning":
      return <Spinner label="Cleaning up..." />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Merged PR #{prNumber} for {mergedBranch}
          </SuccessMessage>
          <Text color="gray">  Method: {mergeMethod}</Text>
          <Text color="gray">  Branch deleted and children reparented</Text>
        </Box>
      );
    case "blocked":
      return (
        <Box flexDirection="column">
          <WarningMessage>
            PR #{prNumber} cannot be merged
          </WarningMessage>
          <Text color="gray">  {prTitle}</Text>
          <Box flexDirection="column" marginTop={1}>
            {blockingReasons.map((reason, i) => {
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
          <WarningMessage>No open PR for this branch</WarningMessage>
          <Text color="gray">Run `pile submit` to create a PR first.</Text>
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
