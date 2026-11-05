import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { createPile } from "@pile/core";
import { createGitHub } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, ErrorMessage, WarningMessage } from "../components/Message.js";
import {
  OutputOptions,
  CommandError,
  formatJson,
  createResult,
  exitWithError,
  toCommandError,
} from "../utils/output.js";

export interface DeleteCommandProps {
  /** Branch to delete (default: current branch). */
  branch?: string;
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
  branch,
  force,
  options,
}: DeleteCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("loading");
  const [deletedBranch, setDeletedBranch] = useState<string | null>(null);
  const [closedPR, setClosedPR] = useState<number | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Non-interactive runs exit with a structured error; interactive runs render it.
  const fail = (err: CommandError, view: State = "error") => {
    if (options.json || !options.interactive) {
      exitWithError(options, err);
    }
    process.exitCode = 1;
    setError(err.message);
    setState(view);
  };

  useEffect(() => {
    async function deleteBranch() {
      try {
        const pile = await createPile();

        if (!pile.state.isInitialized()) {
          fail(
            { code: "NOT_INITIALIZED", message: "Pile not initialized", hint: "Run `pile init` first." },
            "not_initialized",
          );
          return;
        }

        const trunk = pile.stack.getTrunk();
        const currentBranch = await pile.git.getCurrentBranch();
        const target = branch ?? currentBranch;

        if (target === trunk) {
          fail({ code: "ON_TRUNK", message: "Cannot delete trunk branch" }, "on_trunk");
          return;
        }

        const refs = await pile.git.getRefs();
        if (!refs.local.has(target)) {
          fail({
            code: "BRANCH_NOT_FOUND",
            message: `Branch "${target}" does not exist`,
            hint: "Run `pile log` to see tracked branches.",
          });
          return;
        }

        // Check for children
        const children = pile.state.getChildren(target);
        if (children.length > 0 && !force) {
          fail(
            {
              code: "HAS_CHILDREN",
              message: `Branch has ${children.length} child branch(es): ${children.join(", ")}`,
              hint: "Use --force to reparent them onto its parent and delete.",
              data: { children },
            },
            "has_children",
          );
          return;
        }

        setState("deleting");

        const parent = pile.state.getParent(target) ?? trunk;
        const rel = pile.state.getBranchRelationship(target);

        // Reparent children to this branch's parent. Their base commit stays, so the
        // next restack replays only their own commits onto the new parent.
        for (const child of children) {
          const childRel = pile.state.getBranchRelationship(child);
          if (childRel) {
            pile.state.setBranchRelationship(child, { ...childRel, parent });
          }
        }

        // Close the PR if there is one; GitHub problems never block the delete.
        let prClosed: number | null = null;
        if (rel?.prNumber) {
          const github = await createGitHub(pile).catch(() => null);
          if (!github) {
            setWarning(`Could not reach GitHub; PR #${rel.prNumber} was left open.`);
          } else {
            try {
              const pr = await github.prs.get(rel.prNumber);
              if (pr.state === "open") {
                await github.prs.update({ number: rel.prNumber, state: "closed" });
                prClosed = rel.prNumber;
                setClosedPR(rel.prNumber);
              }
            } catch (err) {
              setWarning(`Could not close PR #${rel.prNumber}: ${toCommandError(err).message}`);
            }
          }
        }

        // Leave the branch before deleting it.
        const switchedTo = target === currentBranch ? parent : null;
        if (switchedTo) {
          await pile.git.checkout(switchedTo);
        }

        // Delete remote branch
        if (refs.remote.has(`${pile.git.remoteName}/${target}`)) {
          try {
            await pile.git.deleteRemoteBranch(target);
          } catch {
            // Remote delete failed, that's ok
          }
        }

        // Delete local branch and tracking
        pile.state.removeBranchRelationship(target);
        await pile.git.deleteBranch(target, true);

        setDeletedBranch(target);

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                deleted: target,
                closedPR: prClosed,
                prClosed: prClosed !== null,
                reparented: children,
                switchedTo,
              })
            )
          );
          process.exit(0);
        }

        setState("success");
      } catch (err) {
        fail(toCommandError(err));
      }
    }

    deleteBranch();
  }, [branch, force, options.json]);

  if (options.json) return <></>;

  switch (state) {
    case "loading":
    case "deleting":
      return <Spinner label="Deleting branch..." />;
    case "success":
      return (
        <>
          <SuccessMessage>
            <Text>Deleted {deletedBranch}</Text>
            {closedPR && <Text color="gray"> (closed PR #{closedPR})</Text>}
          </SuccessMessage>
          {warning && <WarningMessage>{warning}</WarningMessage>}
        </>
      );
    case "on_trunk":
      return <WarningMessage>Cannot delete trunk branch.</WarningMessage>;
    case "has_children":
      return (
        <ErrorMessage>
          {error} Use --force to reparent them and delete.
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
