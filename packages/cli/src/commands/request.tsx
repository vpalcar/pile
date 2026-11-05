import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage } from "../components/Message.js";
import { Link } from "../components/Link.js";
import {
  CommandError,
  OutputOptions,
  exitNeedsInput,
  formatJson,
  createResult,
} from "../utils/output.js";
import {
  CommandFailure,
  FailureMessage,
  openPRContext,
  reportFailure,
  resolveTargetPR,
} from "../utils/pr-target.js";

export interface RequestCommandProps {
  /** Branch, PR number, #number or PR URL. Default: current branch. */
  target?: string;
  reviewers: string[];
  teams?: string[];
  options: OutputOptions;
}

type State = "loading" | "requesting" | "success" | "error";

interface RequestResult {
  branch: string;
  prNumber: number;
  prUrl: string;
  reviewers: string[];
  teams: string[];
}

export function RequestCommand({
  target,
  reviewers,
  teams,
  options,
}: RequestCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("loading");
  const [result, setResult] = useState<RequestResult | null>(null);
  const [failure, setFailure] = useState<CommandError | null>(null);

  useEffect(() => {
    async function requestReviewers() {
      try {
        const hasReviewers = reviewers.length > 0 || (teams?.length ?? 0) > 0;
        if (!hasReviewers) {
          if (!options.interactive) {
            exitNeedsInput(options, {
              message: "No reviewers specified",
              arg: "reviewers...",
              flag: "--team <teams...>",
            });
          }
          throw new CommandFailure(
            "NEEDS_INPUT",
            "No reviewers specified",
            "Usage: pile request user1 user2, or pile request -t team-name",
          );
        }

        const context = await openPRContext(target);
        const { pr, branch } = await resolveTargetPR(context, target);
        if (pr.state !== "open" || pr.merged) {
          throw new CommandFailure(
            "PR_NOT_OPEN",
            `PR #${pr.number} is ${pr.merged ? "merged" : "closed"}`,
            "Reviews can only be requested on open PRs.",
          );
        }

        setState("requesting");
        await context.github.prs.requestReviewers(pr.number, reviewers, teams);

        const requestResult: RequestResult = {
          branch,
          prNumber: pr.number,
          prUrl: pr.html_url,
          reviewers,
          teams: teams || [],
        };

        if (options.json) {
          console.log(formatJson(createResult(true, requestResult)));
          process.exit(0);
        }

        setResult(requestResult);
        setState("success");
      } catch (err) {
        setFailure(reportFailure(options, err));
        setState("error");
      }
    }

    requestReviewers();
  }, [options.json, reviewers, teams, target]);

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
    case "error":
      return failure ? <FailureMessage failure={failure} /> : <></>;
    default:
      return <></>;
  }
}
