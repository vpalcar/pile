import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { createGitHub } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, ErrorMessage } from "../components/Message.js";
import { Link } from "../components/Link.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";
import { getCloseMessage, getReopenMessage } from "../utils/fun.js";

export interface CloseCommandProps {
  reopen?: boolean;
  options: OutputOptions;
}

type State =
  | "loading"
  | "closing"
  | "success"
  | "no_pr"
  | "no_github"
  | "not_initialized"
  | "on_trunk"
  | "already_closed"
  | "already_open"
  | "error";

interface ResultData {
  branch: string;
  prNumber: number;
  prUrl: string;
  action: "closed" | "reopened";
}

export function CloseCommand({
  reopen,
  options,
}: CloseCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("loading");
  const [result, setResult] = useState<ResultData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function closePR() {
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
        const currentBranch = await pile.git.getCurrentBranch();

        if (currentBranch === trunk) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, "Cannot close PR from trunk branch")
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

        // Find PR - check stored PR number first (survives renames), then API lookup
        const rel = pile.state.getBranchRelationship(currentBranch);
        let pr = null;
        if (rel?.prNumber) {
          try {
            pr = await github.prs.get(rel.prNumber);
          } catch {
            // Stored PR might be invalid
          }
        }
        if (!pr) {
          pr = reopen
            ? await github.prs.findByBranchAnyState(currentBranch)
            : await github.prs.findByBranch(currentBranch);
        }

        if (!pr) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, "No PR found for this branch")
              )
            );
            process.exit(1);
          }
          setState("no_pr");
          return;
        }

        // Check current state
        if (reopen) {
          if (pr.state === "open") {
            if (options.json) {
              console.log(
                formatJson(
                  createResult(false, null, "PR is already open")
                )
              );
              process.exit(1);
            }
            setState("already_open");
            return;
          }
          if (pr.merged) {
            if (options.json) {
              console.log(
                formatJson(
                  createResult(false, null, "Cannot reopen a merged PR")
                )
              );
              process.exit(1);
            }
            setError("Cannot reopen a merged PR");
            setState("error");
            return;
          }
        } else {
          if (pr.state === "closed" || pr.merged) {
            if (options.json) {
              console.log(
                formatJson(
                  createResult(false, null, "PR is already closed")
                )
              );
              process.exit(1);
            }
            setState("already_closed");
            return;
          }
        }

        setState("closing");

        // Update PR state
        const newState = reopen ? "open" : "closed";
        await github.prs.update({
          number: pr.number,
          state: newState,
        });

        const resultData: ResultData = {
          branch: currentBranch,
          prNumber: pr.number,
          prUrl: pr.html_url,
          action: reopen ? "reopened" : "closed",
        };

        if (options.json) {
          console.log(formatJson(createResult(true, resultData)));
          process.exit(0);
        }

        setResult(resultData);
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

    closePR();
  }, [options.json, reopen]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "loading":
      return <Spinner label="Finding PR..." />;
    case "closing":
      return <Spinner label={reopen ? "Reopening PR..." : "Closing PR..."} />;
    case "success":
      if (!result) return <></>;
      const funMessage = result.action === "closed" ? getCloseMessage() : getReopenMessage();
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            {result.action === "closed" ? "Closed" : "Reopened"} PR #{result.prNumber}
          </SuccessMessage>
          <Box>
            <Text color="gray">  {funMessage}</Text>
          </Box>
          <Box marginTop={1}>
            <Text>  </Text>
            <Link url={result.prUrl}>{result.prUrl}</Link>
          </Box>
        </Box>
      );
    case "no_pr":
      return (
        <Box flexDirection="column">
          <Text color="yellow">No PR found for this branch.</Text>
          <Text color="gray">Run `pile submit` to create one.</Text>
        </Box>
      );
    case "already_closed":
      return <Text color="yellow">PR is already closed.</Text>;
    case "already_open":
      return <Text color="yellow">PR is already open.</Text>;
    case "on_trunk":
      return (
        <Text color="yellow">
          Cannot close PR from trunk branch. Checkout a feature branch first.
        </Text>
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
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
    default:
      return <></>;
  }
}
