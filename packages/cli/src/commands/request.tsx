import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { createGitHub } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, ErrorMessage } from "../components/Message.js";
import { Link } from "../components/Link.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface RequestCommandProps {
  reviewers: string[];
  teams?: string[];
  options: OutputOptions;
}

type State =
  | "loading"
  | "requesting"
  | "success"
  | "no_pr"
  | "no_github"
  | "not_initialized"
  | "on_trunk"
  | "no_reviewers"
  | "error";

interface RequestResult {
  branch: string;
  prNumber: number;
  prUrl: string;
  reviewers: string[];
  teams: string[];
}

export function RequestCommand({
  reviewers,
  teams,
  options,
}: RequestCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("loading");
  const [result, setResult] = useState<RequestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function requestReviewers() {
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
                createResult(false, null, "Cannot request reviewers from trunk branch")
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

        // Check if any reviewers specified
        const hasReviewers = (reviewers && reviewers.length > 0) || (teams && teams.length > 0);
        if (!hasReviewers) {
          if (options.json) {
            console.log(
              formatJson(createResult(false, null, "No reviewers specified"))
            );
            process.exit(1);
          }
          setState("no_reviewers");
          return;
        }

        // Find PR for current branch
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

        setState("requesting");

        // Request reviewers
        await github.prs.requestReviewers(
          pr.number,
          reviewers || [],
          teams
        );

        const requestResult: RequestResult = {
          branch: currentBranch,
          prNumber: pr.number,
          prUrl: pr.html_url,
          reviewers: reviewers || [],
          teams: teams || [],
        };

        if (options.json) {
          console.log(formatJson(createResult(true, requestResult)));
          process.exit(0);
        }

        setResult(requestResult);
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

    requestReviewers();
  }, [options.json, reviewers, teams]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "loading":
      return <Spinner label="Finding PR..." />;
    case "requesting":
      return <Spinner label="Requesting reviewers..." />;
    case "success":
      if (!result) return <></>;
      const allReviewers = [
        ...result.reviewers,
        ...result.teams.map((t) => `@${t}`),
      ];
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Requested review on PR #{result.prNumber}
          </SuccessMessage>
          <Box>
            <Text color="gray">  Reviewers: </Text>
            <Text>{allReviewers.join(", ")}</Text>
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
          <Text color="yellow">No open PR found for this branch.</Text>
          <Text color="gray">Run `pile submit` to create one.</Text>
        </Box>
      );
    case "no_reviewers":
      return (
        <Box flexDirection="column">
          <Text color="yellow">No reviewers specified.</Text>
          <Text color="gray">Usage: pile request user1 user2 or pile request -t team-name</Text>
        </Box>
      );
    case "on_trunk":
      return (
        <Text color="yellow">
          Cannot request reviewers from trunk branch. Checkout a feature branch first.
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
