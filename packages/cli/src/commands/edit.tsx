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
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface EditCommandProps {
  /** Branch, PR number, #number or PR URL. Default: current branch. */
  target?: string;
  title?: string;
  body?: string | boolean; // string = inline, true = editor, "-" handled before
  draft?: boolean;
  ready?: boolean;
  labels?: string;
  addLabels?: string;
  assignees?: string;
  milestone?: string;
  options: OutputOptions;
}

type State = "loading" | "editing" | "success" | "error";

const EDIT_FLAGS = "--title <title>, --body <body>, --labels, --add-labels, --assignees, --milestone, --draft or --ready";

interface EditResult {
  branch: string;
  prNumber: number;
  prUrl: string;
  changes: string[];
}

function openEditor(initialContent: string): string | null {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const tmpFile = path.join(os.tmpdir(), `pile-edit-${Date.now()}.md`);

  try {
    fs.writeFileSync(tmpFile, initialContent);
    spawnSync(editor, [tmpFile], { stdio: "inherit" });
    const content = fs.readFileSync(tmpFile, "utf-8");
    fs.unlinkSync(tmpFile);
    return content;
  } catch {
    return null;
  }
}

export function EditCommand({
  target,
  title,
  body,
  draft,
  ready,
  labels,
  addLabels,
  assignees,
  milestone,
  options,
}: EditCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("loading");
  const [result, setResult] = useState<EditResult | null>(null);
  const [failure, setFailure] = useState<CommandError | null>(null);

  useEffect(() => {
    async function editPR() {
      try {
        const hasChanges =
          title !== undefined ||
          body !== undefined ||
          draft !== undefined ||
          ready !== undefined ||
          labels !== undefined ||
          addLabels !== undefined ||
          assignees !== undefined ||
          milestone !== undefined;

        if (!hasChanges) {
          if (!options.interactive) {
            exitNeedsInput(options, { message: "No changes specified", flag: EDIT_FLAGS });
          }
          throw new CommandFailure("NEEDS_INPUT", "No changes specified", `Use ${EDIT_FLAGS}.`);
        }
        if (draft && ready) {
          throw new CommandFailure("INVALID_ARGS", "--draft and --ready cannot be combined");
        }
        // `-b` without a value opens an editor, which needs a terminal.
        if (body === true && !options.interactive) {
          exitNeedsInput(options, {
            message: "Editing the body in an editor needs a terminal",
            flag: "--body <text> (or --body - to read stdin)",
          });
        }

        const context = await openPRContext(target);
        const { github } = context;
        const { pr, branch } = await resolveTargetPR(context, target);

        setState("editing");

        const changes: string[] = [];

        // Draft <-> ready needs GraphQL, which can be unavailable; do it first so a
        // failure leaves the PR untouched.
        if (draft && !pr.draft) {
          await github.prs.convertToDraft(pr.number);
          changes.push("Converted to draft");
        } else if (ready && pr.draft) {
          await github.prs.markReadyForReview(pr.number);
          changes.push("Marked ready for review");
        } else if (draft) {
          changes.push("Already a draft");
        } else if (ready) {
          changes.push("Already ready for review");
        }

        // Handle body editing
        let bodyContent: string | undefined;
        if (body === true) {
          // Open editor with current body
          const edited = openEditor(pr.body || "");
          if (edited !== null && edited !== pr.body) {
            bodyContent = edited;
          }
        } else if (typeof body === "string") {
          bodyContent = body;
        }

        // Update title/body via PR update
        if (title || bodyContent !== undefined) {
          await github.prs.update({
            number: pr.number,
            title: title,
            body: bodyContent,
          });
          if (title) changes.push(`Title: "${title}"`);
          if (bodyContent !== undefined) changes.push("Body updated");
        }

        // Handle labels
        if (labels) {
          const labelList = labels.split(",").map((l) => l.trim());
          await github.prs.setLabels(pr.number, labelList);
          changes.push(`Labels: ${labelList.join(", ")}`);
        } else if (addLabels) {
          const labelList = addLabels.split(",").map((l) => l.trim());
          await github.prs.addLabels(pr.number, labelList);
          changes.push(`Added labels: ${labelList.join(", ")}`);
        }

        // Handle assignees
        if (assignees) {
          const assigneeList = assignees.split(",").map((a) => a.trim());
          await github.prs.setAssignees(pr.number, assigneeList);
          changes.push(`Assignees: ${assigneeList.join(", ")}`);
        }

        // Milestones are set on the PR's issue, by number; accept a number or a title.
        if (milestone) {
          const api = github.client.api;
          const repo = { owner: github.client.repoOwner, repo: github.client.repoName };
          let milestoneNumber = /^\d+$/.test(milestone) ? parseInt(milestone, 10) : null;
          if (milestoneNumber === null) {
            const { data } = await api.issues.listMilestones({ ...repo, state: "all", per_page: 100 });
            milestoneNumber = data.find((m) => m.title === milestone)?.number ?? null;
            if (milestoneNumber === null) {
              throw new CommandFailure(
                "MILESTONE_NOT_FOUND",
                `Milestone "${milestone}" not found`,
                "Pass a milestone title or number that exists in the repository.",
              );
            }
          }
          await api.issues.update({ ...repo, issue_number: pr.number, milestone: milestoneNumber });
          changes.push(`Milestone: ${milestone}`);
        }

        const editResult: EditResult = {
          branch,
          prNumber: pr.number,
          prUrl: pr.html_url,
          changes,
        };

        if (options.json) {
          console.log(formatJson(createResult(true, editResult)));
          process.exit(0);
        }

        setResult(editResult);
        setState("success");
      } catch (err) {
        setFailure(reportFailure(options, err));
        setState("error");
      }
    }

    editPR();
  }, [options.json, target, title, body, draft, ready, labels, addLabels, assignees, milestone]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "loading":
      return <Spinner label="Finding PR..." />;
    case "editing":
      return <Spinner label="Updating PR..." />;
    case "success":
      if (!result) return <></>;
      return (
        <Box flexDirection="column">
          <SuccessMessage>Updated PR #{result.prNumber}</SuccessMessage>
          {result.changes.map((change, i) => (
            <Box key={i}>
              <Text color="gray">  {change}</Text>
            </Box>
          ))}
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
