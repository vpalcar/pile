import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { createGitHub } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { Link } from "../components/Link.js";
import {
  SuccessMessage,
  ErrorMessage,
  WarningMessage,
  InfoMessage,
} from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";
import { openUrl } from "../utils/browser.js";
import { getPileWisdom } from "../utils/fun.js";

export interface SubmitCommandProps {
  stack?: boolean;
  draft?: boolean;
  title?: string;
  reviewers?: string[];
  open?: boolean;
  options: OutputOptions;
}

interface PRResult {
  branch: string;
  prNumber: number;
  prUrl: string;
  created: boolean;
}

interface StackPR {
  branch: string;
  prNumber: number;
  prUrl: string;
  isNew: boolean;
  isCurrent: boolean;
}

interface QueuedResult {
  branch: string;
  operation: string;
}

type State =
  | "checking"
  | "pushing"
  | "creating_pr"
  | "updating_pr"
  | "submitting_stack"
  | "success"
  | "queued"
  | "no_github"
  | "not_initialized"
  | "on_trunk"
  | "error";

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes("network") ||
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("timeout") ||
    message.includes("socket") ||
    message.includes("unable to resolve")
  );
}

export function SubmitCommand({
  stack,
  draft,
  title,
  reviewers,
  open,
  options,
}: SubmitCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PRResult[]>([]);
  const [queuedResults, setQueuedResults] = useState<QueuedResult[]>([]);
  const [stackPRs, setStackPRs] = useState<StackPR[]>([]);
  const [trunk, setTrunk] = useState<string>("main");

  useEffect(() => {
    async function submit() {
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
        const shouldOpenPR = open || config?.autoOpenPR;
        const current = await pile.git.getCurrentBranch();

        if (current === trunk) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, "Cannot submit from trunk branch")
              )
            );
            process.exit(1);
          }
          setState("on_trunk");
          return;
        }

        const repoRoot = await pile.git.getRepoRoot();

        // Check if there's a remote configured
        const remote = await pile.git.getRemote();

        if (!remote) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(
                  false,
                  null,
                  "No git remote configured. Run `pile init` to set up GitHub."
                )
              )
            );
            process.exit(1);
          }
          setError("No git remote configured. Run `pile init` to set up GitHub.");
          setState("error");
          return;
        }

        const github = await createGitHub(`${repoRoot}/.pile`);

        if (!github) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(
                  false,
                  null,
                  "GitHub not configured. Set GITHUB_TOKEN or run `gh auth login`"
                )
              )
            );
            process.exit(1);
          }
          setState("no_github");
          return;
        }

        // Determine branches to submit
        const branchesToSubmit: string[] = [];
        if (stack) {
          setState("submitting_stack");
          let branch = current;
          const stackBranches = [branch];
          let parent = pile.state.getParent(branch);
          while (parent && parent !== trunk) {
            stackBranches.unshift(parent);
            parent = pile.state.getParent(parent);
          }
          branchesToSubmit.push(...stackBranches);
        } else {
          branchesToSubmit.push(current);
        }

        const prResults: PRResult[] = [];
        const queued: QueuedResult[] = [];

        for (const branch of branchesToSubmit) {
          // Check if this branch's PR is already merged - skip it
          try {
            const existingPr = await github.prs.findByBranchAnyState(branch);
            if (existingPr?.merged) {
              // Branch already merged, clean it up and skip
              pile.state.removeBranchRelationship(branch);
              continue;
            }
          } catch {
            // Ignore errors, proceed with submit
          }

          // Push branch
          setState("pushing");
          try {
            await pile.git.pushSetUpstream(branch);
          } catch {
            try {
              await pile.git.push(branch, true);
            } catch (pushErr) {
              if (isNetworkError(pushErr)) {
                pile.state.queueOperation({
                  type: "push",
                  payload: { branch, force: true },
                });
                queued.push({ branch, operation: "create_pr" });
                continue;
              }
              throw new Error(`Failed to push ${branch}: ${pushErr}`);
            }
          }

          // Create or update PR - use trunk as base if parent was merged
          let parent = pile.state.getParent(branch);

          // Check if parent was merged
          if (parent && parent !== trunk) {
            try {
              const parentPr = await github.prs.findByBranchAnyState(parent);
              if (parentPr?.merged) {
                // Parent was merged, update this branch to use trunk as base
                parent = trunk;
                const rel = pile.state.getBranchRelationship(branch);
                if (rel) {
                  pile.state.setBranchRelationship(branch, { ...rel, parent: trunk });
                }
              }
            } catch {
              // Ignore errors
            }
          }

          const baseBranch = parent ?? trunk;

          try {
            const existingPR = await github.prs.findByBranch(branch);

            if (existingPR) {
              setState("updating_pr");
              if (existingPR.base.ref !== baseBranch) {
                await github.prs.update({
                  number: existingPR.number,
                  base: baseBranch,
                });
              }
              github.cache.cachePR(existingPR);
              pile.stack.setPRInfo(branch, existingPR.number, existingPR.html_url);
              prResults.push({
                branch,
                prNumber: existingPR.number,
                prUrl: existingPR.html_url,
                created: false,
              });
            } else {
              setState("creating_pr");
              // Use stored title from create, or fall back to branch name
              const storedTitle = pile.state.getTitle(branch);
              const prTitle = title ?? storedTitle ?? branch;
              const stackInfo = stack
                ? `Part of a stack based on \`${trunk}\``
                : "";
              const description = stackInfo;

              const pr = await github.prs.create({
                title: prTitle,
                body: description,
                head: branch,
                base: baseBranch,
                draft: draft ?? false,
              });

              if (reviewers && reviewers.length > 0) {
                await github.prs.requestReviewers(pr.number, reviewers);
              }

              github.cache.cachePR(pr);
              pile.stack.setPRInfo(branch, pr.number, pr.html_url);
              prResults.push({
                branch,
                prNumber: pr.number,
                prUrl: pr.html_url,
                created: true,
              });

              // Open newly created PR in browser if requested
              if (shouldOpenPR) {
                openUrl(pr.html_url);
              }
            }
          } catch (prErr) {
            if (isNetworkError(prErr)) {
              const storedTitle = pile.state.getTitle(branch);
              const prTitle = title ?? storedTitle ?? branch;
              const stackInfo = stack
                ? `Part of a stack based on \`${trunk}\``
                : "";
              pile.state.queueOperation({
                type: "create_pr",
                payload: {
                  branch,
                  title: prTitle,
                  body: stackInfo,
                  base: baseBranch,
                  draft: draft ?? false,
                  reviewers,
                },
              });
              queued.push({ branch, operation: "create_pr" });
            } else {
              throw prErr;
            }
          }
        }

        setResults(prResults);
        setQueuedResults(queued);
        setTrunk(trunk);

        // Build full stack PR list for display
        if (stack) {
          const allStackPRs: StackPR[] = [];
          for (const branch of branchesToSubmit) {
            const rel = pile.state.getBranchRelationship(branch);
            if (rel?.prNumber && rel?.prUrl) {
              const wasNew = prResults.some(r => r.branch === branch && r.created);
              allStackPRs.push({
                branch,
                prNumber: rel.prNumber,
                prUrl: rel.prUrl,
                isNew: wasNew,
                isCurrent: branch === current,
              });
            }
          }
          setStackPRs(allStackPRs);
        }

        if (options.json) {
          console.log(
            formatJson(createResult(true, { prs: prResults, queued }))
          );
          process.exit(0);
        }

        if (queued.length > 0 && prResults.length === 0) {
          setState("queued");
        } else {
          setState("success");
        }
      } catch (err) {
        let message = err instanceof Error ? err.message : String(err);

        // Provide helpful error messages for common issues
        if (message.includes("base") && message.includes("invalid")) {
          message = `Base branch "${trunk}" doesn't exist on GitHub. Push it first with: git push -u origin ${trunk}`;
        } else if (message.includes("Repository not found") || message.includes("Not Found")) {
          message = "Repository not found on GitHub. Make sure the remote is configured correctly.";
        }

        if (options.json) {
          console.log(formatJson(createResult(false, null, message)));
          process.exit(1);
        }
        setError(message);
        setState("error");
      }
    }

    submit();
  }, [stack, draft, title, reviewers, open, options.json]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Checking repository state..." />;
    case "pushing":
      return <Spinner label="Pushing branch..." />;
    case "creating_pr":
      return <Spinner label="Creating pull request..." />;
    case "updating_pr":
      return <Spinner label="Updating pull request..." />;
    case "submitting_stack":
      return <Spinner label="Submitting stack..." />;
    case "success":
      return (
        <Box flexDirection="column">
          {/* Show stack summary if submitting stack */}
          {stackPRs.length > 0 ? (
            <Box flexDirection="column">
              <SuccessMessage>Stack submitted</SuccessMessage>
              <Box flexDirection="column" marginTop={1}>
                <Text color="gray">  {trunk}</Text>
                {stackPRs.map((pr, index) => (
                  <Box key={pr.branch} flexDirection="column">
                    <Box>
                      <Text color="gray">  {"│"}</Text>
                    </Box>
                    <Box>
                      <Text color={pr.isCurrent ? "cyan" : "white"}>
                        {"  "}
                        {pr.isCurrent ? "●" : "○"} #{pr.prNumber} {pr.branch}
                        {pr.isNew && <Text color="green"> (new)</Text>}
                      </Text>
                    </Box>
                    <Box>
                      <Text color="gray">    </Text>
                      <Link url={pr.prUrl}>{pr.prUrl}</Link>
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>
          ) : (
            // Single PR result
            results.map((result) => (
              <Box key={result.branch} flexDirection="column">
                <SuccessMessage>
                  {result.created ? "Created" : "Updated"} PR #{result.prNumber} for{" "}
                  {result.branch}
                </SuccessMessage>
                <Box>
                  <Text>  </Text>
                  <Link url={result.prUrl}>{result.prUrl}</Link>
                </Box>
              </Box>
            ))
          )}
          {queuedResults.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <InfoMessage>Queued for later (offline):</InfoMessage>
              {queuedResults.map((q) => (
                <Text key={q.branch} color="yellow">
                  {"  "}
                  {q.branch}
                </Text>
              ))}
              <Text color="gray">
                {"  "}Run `pile sync` when online to process.
              </Text>
            </Box>
          )}
        </Box>
      );
    case "queued":
      return (
        <Box flexDirection="column">
          <InfoMessage>Operations queued (offline mode)</InfoMessage>
          {queuedResults.map((q) => (
            <Text key={q.branch} color="yellow">
              {"  "}
              {q.branch} ({q.operation})
            </Text>
          ))}
          <Text color="gray">
            Run `pile sync` when online to process pending operations.
          </Text>
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
          Cannot submit from trunk branch. Create a branch first.
        </WarningMessage>
      );
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
    default:
      return <></>;
  }
}
