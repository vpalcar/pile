import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { createPile } from "@pile/core";
import { createGitHub } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, ErrorMessage, WarningMessage } from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";
import { execSync } from "node:child_process";

export interface DeleteCommandProps {
  force?: boolean;
  options: OutputOptions;
}

type State =
  | "loading"
  | "deleting"
  | "success"
  | "not_initialized"
  | "on_trunk"
  | "has_children"
  | "error";

export function DeleteCommand({
  force,
  options,
}: DeleteCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("loading");
  const [deletedBranch, setDeletedBranch] = useState<string | null>(null);
  const [closedPR, setClosedPR] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function deleteBranch() {
      try {
        const pile = await createPile();

        if (!pile.state.isInitialized()) {
          if (options.json) {
            console.log(formatJson(createResult(false, null, "Pile not initialized")));
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
            console.log(formatJson(createResult(false, null, "Cannot delete trunk branch")));
            process.exit(1);
          }
          setState("on_trunk");
          return;
        }

        // Check for children
        const children = pile.state.getChildren(currentBranch);
        if (children.length > 0 && !force) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, `Branch has ${children.length} child branch(es). Use --force to reparent them and delete.`)
              )
            );
            process.exit(1);
          }
          setState("has_children");
          return;
        }

        setState("deleting");

        const repoRoot = await pile.git.getRepoRoot();
        const parent = pile.state.getParent(currentBranch) ?? trunk;
        const rel = pile.state.getBranchRelationship(currentBranch);

        // Reparent children to this branch's parent
        if (children.length > 0) {
          for (const child of children) {
            const childRel = pile.state.getBranchRelationship(child);
            if (childRel) {
              pile.state.setBranchRelationship(child, { ...childRel, parent });
            }
          }
        }

        // Close PR if exists
        const github = await createGitHub(`${repoRoot}/.pile`);
        if (github && rel?.prNumber) {
          try {
            const pr = await github.prs.get(rel.prNumber);
            if (pr && pr.state === "open") {
              await github.prs.update({ number: rel.prNumber, state: "closed" });
              setClosedPR(rel.prNumber);
            }
          } catch {
            // PR close failed, continue with branch deletion
          }
        }

        // Switch to parent branch
        await pile.git.checkout(parent);

        // Delete remote branch
        try {
          execSync(`git push origin --delete "${currentBranch}"`, {
            cwd: repoRoot,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // Remote delete failed, that's ok
        }

        // Delete local branch and tracking
        pile.state.removeBranchRelationship(currentBranch);
        try {
          await pile.git.deleteBranch(currentBranch, true);
        } catch {
          // Force delete if needed
          execSync(`git branch -D "${currentBranch}"`, {
            cwd: repoRoot,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
        }

        setDeletedBranch(currentBranch);

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                deleted: currentBranch,
                closedPR: closedPR,
                reparented: children,
                switchedTo: parent,
              })
            )
          );
          process.exit(0);
        }

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

    deleteBranch();
  }, [force, options.json]);

  if (options.json) return <></>;

  switch (state) {
    case "loading":
    case "deleting":
      return <Spinner label="Deleting branch..." />;
    case "success":
      return (
        <SuccessMessage>
          <Text>Deleted {deletedBranch}</Text>
          {closedPR && <Text color="gray"> (closed PR #{closedPR})</Text>}
        </SuccessMessage>
      );
    case "on_trunk":
      return <WarningMessage>Cannot delete trunk branch.</WarningMessage>;
    case "has_children":
      return (
        <ErrorMessage>
          Branch has children. Use --force to reparent them and delete.
        </ErrorMessage>
      );
    case "not_initialized":
      return <ErrorMessage>Pile not initialized. Run `pile init` first.</ErrorMessage>;
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
    default:
      return <></>;
  }
}
