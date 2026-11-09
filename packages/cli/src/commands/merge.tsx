import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { PileInstance } from "@pile/core";
import { GitHubInstance, PullRequest, getBlockingReasons, parsePRNumber, type BlockingReason } from "@pile/github";
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
import { cleanupMergedBranch } from "../utils/merge-cleanup.js";

export interface MergeCommandProps {
  /** Branch, PR number, #number or PR URL. Default: current branch. */
  target?: string;
  force?: boolean;
  options: OutputOptions;
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

type State = "checking" | "merging" | "cleaning" | "success" | "queued" | "blocked" | "no_pr" | "error";

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
  const [nativeStack, setNativeStack] = useState<number | null>(null);

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
        let nativeStackNumber: number | null = null;

        const block = (branch: string, pr: PullRequest, reasons: BlockingReason[]) => {
          setBlockedPR({ branch, prNumber: pr.number, title: pr.title, reasons });
          setMergedPRs(merged);
          if (options.json || !options.interactive) {
            exitWithError(options, {
              code: "MERGE_BLOCKED",
              message: `PR #${pr.number} cannot be merged: ${reasons.map((r) => r.message).join("; ")}`,
              hint: "Run `pile status` for details, or `pile merge --force` to merge anyway.",
              data: {
                merged,
                blockedAt: { branch, prNumber: pr.number, blocking: reasons },
              },
            });
          }
          process.exitCode = 1;
          setState("blocked");
        };

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

          // A PR in a native GitHub stack can only be merged through GitHub's async
          // endpoint, which merges it and every open PR below it atomically.
          if (pr.stack) {
            const remaining = stackBranches.slice(stackBranches.indexOf(branchToMerge));
            const found = await Promise.all(
              remaining.map((b) => (b === branchToMerge ? pr : findBranchPR(pile, github, b))),
            );
            const entries = remaining.map((branch, i) => ({ branch, pr: found[i] }));

            const outside = entries.find(
              (e) => !e.pr || e.pr.state !== "open" || e.pr.stack?.number !== pr.stack!.number,
            );
            if (outside) {
              const error: CommandError = {
                code: "NOT_IN_STACK",
                message: `${outside.branch} has no open PR in GitHub stack #${pr.stack.number}, so the stack can't be merged up to ${targetBranch} in one step.`,
                hint: "Merge up to the branch below it, or add its PR to the stack on GitHub.",
                data: { merged, stack: pr.stack.number, branch: outside.branch },
              };
              if (options.json || !options.interactive) exitWithError(options, error);
              process.exitCode = 1;
              setFailure(error);
              setMergedPRs(merged);
              setState("error");
              return;
            }

            // Check every PR first: the merge is all-or-nothing.
            for (const entry of entries) {
              const reasons = getBlockingReasons(entry.pr!);
              if (reasons.length > 0 && !force) return block(entry.branch, entry.pr!, reasons);
            }
            if (force) {
              for (const entry of entries.filter((e) => e.pr!.draft)) {
                await github.prs.markReadyForReview(entry.pr!.number);
              }
            }

            const top = entries[entries.length - 1];
            nativeStackNumber = pr.stack.number;
            setNativeStack(pr.stack.number);
            setCurrentMerging(`${entries.length} PR${entries.length === 1 ? "" : "s"} up to ${top.branch}`);
            setState("merging");
            const result = await github.prs.mergeAsyncAndWait(top.pr!.number, method, { sha: top.pr!.head.sha });

            if (result.status === "enqueued") {
              const queued = entries.map((e) => ({ branch: e.branch, prNumber: e.pr!.number, title: e.pr!.title }));
              setMergedPRs(queued);
              if (options.json) {
                console.log(formatJson(createResult(true, {
                  merged: [],
                  queued: queued.map((q) => ({ branch: q.branch, prNumber: q.prNumber })),
                  mergeMethod: method,
                  target: target ?? null,
                  stack: pr.stack.number,
                })));
                process.exit(0);
              }
              setState("queued");
              return;
            }

            const mergedNumbers = new Set((await github.prs.getMergedInStack(pr.stack.number)).map((m) => m.number));
            setState("cleaning");
            for (const entry of entries) {
              if (!mergedNumbers.has(entry.pr!.number)) continue;
              merged.push({ branch: entry.branch, prNumber: entry.pr!.number, title: entry.pr!.title });
              // GitHub retargets and rebases the PRs above; only local state needs updating.
              await cleanupMergedBranch(pile, github, entry.branch, trunk, false);
            }
            break;
          }

          // A stack merge lands every PR on the trunk. One still based on the branch below
          // (just merged) would land there instead, so move it onto the trunk first, and
          // stop rather than merge it anywhere else.
          if (pr.base.ref !== trunk) {
            try {
              await github.prs.update({ number: pr.number, base: trunk });
            } catch (retargetErr) {
              const error: CommandError = {
                code: "NOT_ON_TRUNK",
                message: `#${pr.number} is based on ${pr.base.ref}, and GitHub refused to move it onto ${trunk}: ${retargetErr instanceof Error ? retargetErr.message : String(retargetErr)}`,
                hint: `Nothing more was merged. Change the PR's base to ${trunk} on GitHub, then run \`pile merge\` again.`,
                data: { merged },
              };
              if (options.json || !options.interactive) exitWithError(options, error);
              process.exitCode = 1;
              setFailure(error);
              setMergedPRs(merged);
              setState("error");
              return;
            }
          }

          // Checks and reviews come from the enriched PR, so they actually gate the merge.
          const reasons = getBlockingReasons(pr);

          if (reasons.length > 0 && !force) {
            return block(branchToMerge, pr, reasons);
          }

          // A forced merge of a draft has to mark it ready first (GraphQL only).
          if (force && pr.draft) {
            await github.prs.markReadyForReview(pr.number);
          }

          // Merge the PR. Right after a retarget GitHub may still be recomputing it, and
          // says the base was modified: wait a moment and try again.
          setState("merging");
          for (let attempt = 1; ; attempt++) {
            try {
              await github.prs.merge(pr.number, method);
              break;
            } catch (mergeErr) {
              if (attempt >= 5 || !/base branch was modified|not mergeable/i.test(mergeErr instanceof Error ? mergeErr.message : "")) throw mergeErr;
              await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
            }
          }

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
                stack: nativeStackNumber,
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
      return (
        <Spinner
          label={nativeStack ? `Merging ${currentMerging} (GitHub stack #${nativeStack})...` : `Merging ${currentMerging}...`}
        />
      );
    case "queued":
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Added {mergedPRs.length} PR{mergedPRs.length !== 1 ? "s" : ""} to the merge queue
          </SuccessMessage>
          <Text color="gray">  Run `pile sync` once GitHub has merged them.</Text>
        </Box>
      );
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
