import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { createGitHub } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, ErrorMessage } from "../components/Message.js";
import { Link } from "../components/Link.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface ReviewCommandProps {
  approve?: boolean;
  requestChanges?: boolean;
  message?: string;
  options: OutputOptions;
}

type State =
  | "loading"
  | "reviewing"
  | "success"
  | "no_pr"
  | "no_github"
  | "not_initialized"
  | "on_trunk"
  | "no_action"
  | "error";

type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

interface ReviewResult {
  branch: string;
  prNumber: number;
  prUrl: string;
  event: ReviewEvent;
  message?: string;
}

export function ReviewCommand({
  approve,
  requestChanges,
  message,
  options,
}: ReviewCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("loading");
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function submitReview() {
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
                createResult(false, null, "Cannot review PR from trunk branch")
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

        // Determine review event
        let event: ReviewEvent;
        if (approve) {
          event = "APPROVE";
        } else if (requestChanges) {
          if (!message) {
            if (options.json) {
              console.log(
                formatJson(
                  createResult(false, null, "Message required when requesting changes")
                )
              );
              process.exit(1);
            }
            setError("Message required when requesting changes. Use -m 'message'");
            setState("error");
            return;
          }
          event = "REQUEST_CHANGES";
        } else if (message) {
          event = "COMMENT";
        } else {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, "No review action specified")
              )
            );
            process.exit(1);
          }
          setState("no_action");
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

        setState("reviewing");

        // Submit review
        await github.prs.createReview(pr.number, event, message);

        const reviewResult: ReviewResult = {
          branch: currentBranch,
          prNumber: pr.number,
          prUrl: pr.html_url,
          event,
          message,
        };

        if (options.json) {
          console.log(formatJson(createResult(true, reviewResult)));
          process.exit(0);
        }

        setResult(reviewResult);
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

    submitReview();
  }, [options.json, approve, requestChanges, message]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "loading":
      return <Spinner label="Finding PR..." />;
    case "reviewing":
      return <Spinner label="Submitting review..." />;
    case "success":
      if (!result) return <></>;
      const eventLabel =
        result.event === "APPROVE"
          ? "Approved"
          : result.event === "REQUEST_CHANGES"
          ? "Requested changes on"
          : "Commented on";
      const eventColor =
        result.event === "APPROVE"
          ? "green"
          : result.event === "REQUEST_CHANGES"
          ? "red"
          : "blue";
      const eventIcon =
        result.event === "APPROVE"
          ? "✓"
          : result.event === "REQUEST_CHANGES"
          ? "!"
          : "💬";
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            {eventLabel} PR #{result.prNumber}
          </SuccessMessage>
          <Box>
            <Text color={eventColor}>  {eventIcon} </Text>
            <Text color={eventColor}>
              {result.event === "APPROVE"
                ? "Approved"
                : result.event === "REQUEST_CHANGES"
                ? "Changes requested"
                : "Comment added"}
            </Text>
          </Box>
          {result.message && (
            <Box marginTop={1}>
              <Text color="gray">  "{result.message}"</Text>
            </Box>
          )}
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
    case "no_action":
      return (
        <Box flexDirection="column">
          <Text color="yellow">No review action specified.</Text>
          <Text color="gray">Use --approve, --request-changes, or -m 'comment'</Text>
        </Box>
      );
    case "on_trunk":
      return (
        <Text color="yellow">
          Cannot review PR from trunk branch. Checkout a feature branch first.
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
