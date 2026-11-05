import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage } from "../components/Message.js";
import { Link } from "../components/Link.js";
import { CommandError, OutputOptions, formatJson, createResult } from "../utils/output.js";
import {
  CommandFailure,
  FailureMessage,
  openPRContext,
  reportFailure,
  resolveTargetPR,
} from "../utils/pr-target.js";
import { getCloseMessage, getReopenMessage } from "../utils/fun.js";

export interface CloseCommandProps {
  /** Branch, PR number, #number or PR URL. Default: current branch. */
  target?: string;
  reopen?: boolean;
  options: OutputOptions;
}

type State = "loading" | "closing" | "success" | "error";

interface ResultData {
  branch: string;
  prNumber: number;
  prUrl: string;
  action: "closed" | "reopened";
}

export function CloseCommand({
  target,
  reopen,
  options,
}: CloseCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("loading");
  const [result, setResult] = useState<ResultData | null>(null);
  const [failure, setFailure] = useState<CommandError | null>(null);

  useEffect(() => {
    async function closePR() {
      try {
        const context = await openPRContext(target);
        const { pr, branch } = await resolveTargetPR(context, target);

        if (reopen) {
          if (pr.merged) {
            throw new CommandFailure("PR_MERGED", `PR #${pr.number} is merged and cannot be reopened`);
          }
          if (pr.state === "open") {
            throw new CommandFailure("ALREADY_OPEN", `PR #${pr.number} is already open`);
          }
        } else if (pr.state === "closed" || pr.merged) {
          throw new CommandFailure(
            "ALREADY_CLOSED",
            `PR #${pr.number} is already ${pr.merged ? "merged" : "closed"}`,
            pr.merged ? undefined : "Use `pile close --reopen` to reopen it.",
          );
        }

        setState("closing");
        await context.github.prs.update({
          number: pr.number,
          state: reopen ? "open" : "closed",
        });

        const resultData: ResultData = {
          branch,
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
        setFailure(reportFailure(options, err));
        setState("error");
      }
    }

    closePR();
  }, [options.json, reopen, target]);

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
    case "error":
      return failure ? <FailureMessage failure={failure} /> : <></>;
    default:
      return <></>;
  }
}
