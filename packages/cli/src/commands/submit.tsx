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
import {
  OutputOptions,
  formatJson,
  createResult,
  exitWithError,
  toCommandError,
} from "../utils/output.js";
import { openUrl } from "../utils/browser.js";
import { getPileWisdom } from "../utils/fun.js";
import { useFailureExitCode } from "../utils/exit-code.js";

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
  useFailureExitCode(state, ["no_github", "not_initialized", "on_trunk", "error"]);
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

        const config = pile.state.getConfig();
        const trunk = config?.trunk ?? "main";
        const shouldOpenPR = open || config?.autoOpenPR;
        const current = await pile.git.getCurrentBranch();

        if (current === trunk) {
          if (!options.interactive) {
            exitWithError(options, {
              code: "ON_TRUNK",
              message: "Cannot submit from trunk branch",
              hint: "Check out a stacked branch first (`pile checkout <branch>`).",
            });
          }
          setState("on_trunk");
          return;
        }

        // Check if there's a remote configured
        const remote = await pile.git.getRemote();

        if (!remote) {
          if (!options.interactive) {
            exitWithError(options, {
              code: "NO_REMOTE",
              message: `No git remote "${pile.git.remoteName}" configured.`,
              hint: "Run `pile init` to set up GitHub.",
            });
          }
          setError("No git remote configured. Run `pile init` to set up GitHub.");
          setState("error");
          return;
        }

        const github = await createGitHub(pile);

        if (!github) {
          if (!options.interactive) {
            exitWithError(options, {
              code: "NO_GITHUB",
              message: "GitHub not configured",
              hint: "Set GITHUB_TOKEN or run `gh auth login`, and make sure the remote points at github.com.",
            });
          }
          setState("no_github");
          return;
        }

        // Determine branches to submit
        const branchesToSubmit: string[] = [];
        if (stack) {
          setState("submitting_stack");
          branchesToSubmit.push(...pile.stack.getAncestry(current));
        } else {
          branchesToSubmit.push(current);
        }

        const prResults: PRResult[] = [];
        const queued: QueuedResult[] = [];

        // Push all branches in a single git command. Trunk is only pushed when the
        // remote doesn't have it yet (PR bases must exist), and never with force.
        setState("pushing");
        try {
          const refs = await pile.git.getRefs();
          if (!refs.remote.has(`${pile.git.remoteName}/${trunk}`)) {
            await pile.git.push(trunk);
          }
          await pile.git.pushMultiple(branchesToSubmit, true);
        } catch (pushErr) {
          if (isNetworkError(pushErr)) {
            for (const branch of branchesToSubmit) {
              pile.state.queueOperation({
                type: "push",
                payload: { branch, force: true },
              });
              queued.push({ branch, operation: "create_pr" });
            }
            setResults(prResults);
            setQueuedResults(queued);
            setTrunk(trunk);
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
            return;
          }
          throw Object.assign(
            new Error(
              `Push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`
            ),
            {
              code: "PUSH_FAILED",
              hint: "The remote may have commits you don't have. Run `pile sync`, then submit again.",
            }
          );
        }

        // Look up existing PRs for all branches in parallel
        setState("creating_pr");
        const existingPRs = await Promise.all(
          branchesToSubmit.map(async (branch) => {
            const storedRel = pile.state.getBranchRelationship(branch);
            if (storedRel?.prNumber) {
              try {
                const stored = await github.prs.get(storedRel.prNumber);
                if (stored && stored.state === "open") {
                  return { branch, pr: stored };
                }
              } catch {
                // Fall through to branch lookup
              }
            }
            const pr = await github.prs.findByBranch(branch);
            return { branch, pr };
          })
        );

        // Resolve each branch's base first (cheap, local), then create or update all PRs
        // in parallel: every head and base branch is already on the remote.
        const plans = existingPRs.map(({ branch, pr: existingPR }) => {
          let parent = pile.state.getParent(branch);

          // If the parent's PR was merged, retarget onto trunk
          if (parent && parent !== trunk) {
            const parentResult = existingPRs.find((r) => r.branch === parent);
            if (parentResult?.pr?.merged) {
              parent = trunk;
              const rel = pile.state.getBranchRelationship(branch);
              if (rel) {
                pile.state.setBranchRelationship(branch, { ...rel, parent: trunk });
              }
            }
          }
          return { branch, existingPR, baseBranch: parent ?? trunk };
        });

        const stackInfo = stack ? `Part of a stack based on \`${trunk}\`` : "";
        const outcomes = await Promise.all(
          plans.map(async ({ branch, existingPR, baseBranch }): Promise<PRResult | QueuedResult | null> => {
            const prTitle = title ?? pile.state.getTitle(branch) ?? branch;
            try {
              if (existingPR && !existingPR.merged) {
                if (existingPR.base.ref !== baseBranch) {
                  await github.prs.update({ number: existingPR.number, base: baseBranch });
                }
                github.cache.cachePR(existingPR);
                return {
                  branch,
                  prNumber: existingPR.number,
                  prUrl: existingPR.html_url,
                  created: false,
                };
              }
              if (existingPR?.merged) {
                // Branch already merged, clean it up and skip
                return null;
              }

              const pr = await github.prs.create({
                title: prTitle,
                body: stackInfo,
                head: branch,
                base: baseBranch,
                draft: draft ?? false,
              });
              if (reviewers && reviewers.length > 0) {
                await github.prs.requestReviewers(pr.number, reviewers);
              }
              github.cache.cachePR(pr);
              if (shouldOpenPR) {
                openUrl(pr.html_url);
              }
              return { branch, prNumber: pr.number, prUrl: pr.html_url, created: true };
            } catch (prErr) {
              if (!isNetworkError(prErr)) throw prErr;
              pile.state.queueOperation({
                type: existingPR ? "update_pr" : "create_pr",
                payload: existingPR
                  ? { prNumber: existingPR.number, base: baseBranch }
                  : {
                      branch,
                      title: prTitle,
                      body: stackInfo,
                      base: baseBranch,
                      draft: draft ?? false,
                      reviewers,
                    },
              });
              return { branch, operation: existingPR ? "update_pr" : "create_pr" };
            }
          })
        );

        // Record results in stack order (state writes are synchronous git config calls)
        plans.forEach(({ branch, existingPR }, i) => {
          const outcome = outcomes[i];
          if (outcome === null) {
            if (existingPR?.merged) pile.state.removeBranchRelationship(branch);
          } else if ("operation" in outcome) {
            queued.push(outcome);
          } else {
            pile.stack.setPRInfo(branch, outcome.prNumber, outcome.prUrl);
            prResults.push(outcome);
          }
        });

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
        const coded = err as { code?: unknown; hint?: string };

        // Provide helpful error messages for common issues
        if (message.includes("base") && message.includes("invalid")) {
          message = `Base branch "${trunk}" doesn't exist on GitHub. Push it first with: git push -u origin ${trunk}`;
        } else if (message.includes("Repository not found") || message.includes("Not Found")) {
          message = "Repository not found on GitHub. Make sure the remote is configured correctly.";
        }

        if (!options.interactive) {
          exitWithError(
            options,
            typeof coded?.code === "string"
              ? { code: coded.code, message, hint: coded.hint }
              : { ...toCommandError(err), message }
          );
        }
        setError(message);
        setState("error");
      }
    }

    submit();
  }, [stack, draft, title, reviewers, open, options.json, options.interactive]);

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
