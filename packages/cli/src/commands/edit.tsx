import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { createGitHub } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, ErrorMessage } from "../components/Message.js";
import { Link } from "../components/Link.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface EditCommandProps {
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

type State =
  | "loading"
  | "editing"
  | "success"
  | "no_pr"
  | "no_github"
  | "not_initialized"
  | "on_trunk"
  | "no_changes"
  | "error";

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

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("readable", () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
  });
}

export function EditCommand({
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function editPR() {
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
                createResult(false, null, "Cannot edit PR from trunk branch")
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

        // Check if any changes were requested
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
          if (options.json) {
            console.log(
              formatJson(createResult(false, null, "No changes specified"))
            );
            process.exit(1);
          }
          setState("no_changes");
          return;
        }

        setState("editing");

        const changes: string[] = [];

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

        // Handle draft/ready
        if (draft && !pr.draft) {
          await github.prs.convertToDraft(pr.number);
          changes.push("Converted to draft");
        } else if (ready && pr.draft) {
          await github.prs.markReadyForReview(pr.number);
          changes.push("Marked ready for review");
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

        // Handle milestone (not implemented yet - would need separate API)
        if (milestone) {
          // TODO: Implement milestone support
          changes.push(`Milestone: ${milestone} (not yet supported)`);
        }

        const editResult: EditResult = {
          branch: currentBranch,
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
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(formatJson(createResult(false, null, message)));
          process.exit(1);
        }
        setError(message);
        setState("error");
      }
    }

    editPR();
  }, [options.json, title, body, draft, ready, labels, addLabels, assignees, milestone]);

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
    case "no_pr":
      return (
        <Box flexDirection="column">
          <Text color="yellow">No open PR found for this branch.</Text>
          <Text color="gray">Run `pile submit` to create one.</Text>
        </Box>
      );
    case "no_changes":
      return (
        <Box flexDirection="column">
          <Text color="yellow">No changes specified.</Text>
          <Text color="gray">Use -t for title, -b for body, --labels, --assignees, --draft, or --ready.</Text>
        </Box>
      );
    case "on_trunk":
      return (
        <Text color="yellow">
          Cannot edit PR from trunk branch. Checkout a feature branch first.
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
