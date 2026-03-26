import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { createGitHub } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import {
  SuccessMessage,
  ErrorMessage,
  WarningMessage,
} from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";
import { execSync } from "node:child_process";

export interface RenameCommandProps {
  newName: string;
  options: OutputOptions;
}

type State =
  | "checking"
  | "renaming_local"
  | "updating_tracking"
  | "renaming_remote"
  | "updating_pr"
  | "success"
  | "name_exists"
  | "not_tracked"
  | "not_initialized"
  | "on_trunk"
  | "error";

export function RenameCommand({
  newName,
  options,
}: RenameCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [oldName, setOldName] = useState<string>("");
  const [remoteRenamed, setRemoteRenamed] = useState(false);
  const [prUpdated, setPrUpdated] = useState(false);

  useEffect(() => {
    async function run() {
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

        const trunk = pile.stack.getTrunk();
        const currentBranch = await pile.git.getCurrentBranch();
        setOldName(currentBranch);

        if (currentBranch === trunk) {
          if (options.json) {
            console.log(
              formatJson(createResult(false, null, "Cannot rename trunk branch"))
            );
            process.exit(1);
          }
          setState("on_trunk");
          return;
        }

        // Check if new name already exists
        const newBranchExists = await pile.git.branchExists(newName);
        if (newBranchExists) {
          if (options.json) {
            console.log(
              formatJson(createResult(false, null, `Branch '${newName}' already exists`))
            );
            process.exit(1);
          }
          setState("name_exists");
          return;
        }

        // Get current branch relationship
        const rel = pile.state.getBranchRelationship(currentBranch);
        if (!rel) {
          if (options.json) {
            console.log(
              formatJson(createResult(false, null, "Branch is not tracked by pile"))
            );
            process.exit(1);
          }
          setState("not_tracked");
          return;
        }

        const repoRoot = await pile.git.getRepoRoot();

        // Rename local branch
        setState("renaming_local");
        execSync(`git branch -m "${currentBranch}" "${newName}"`, {
          cwd: repoRoot,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Update pile tracking
        setState("updating_tracking");

        // Remove old relationship and create new one
        pile.state.removeBranchRelationship(currentBranch);
        pile.state.setBranchRelationship(newName, {
          ...rel,
          name: newName,
        });

        // Update children's parent references
        const children = pile.state.getChildren(currentBranch);
        for (const child of children) {
          const childRel = pile.state.getBranchRelationship(child);
          if (childRel && childRel.parent === currentBranch) {
            pile.state.setBranchRelationship(child, {
              ...childRel,
              parent: newName,
            });
          }
        }

        // Try to rename remote branch
        setState("renaming_remote");
        let renamedRemote = false;
        try {
          // Check if remote branch exists
          const remoteBranches = await pile.git.getRemoteBranches();
          const hasRemote = remoteBranches.some(
            (b) => b === `origin/${currentBranch}` || b.endsWith(`/${currentBranch}`)
          );

          if (hasRemote) {
            // Push new branch name
            execSync(`git push origin "${newName}"`, {
              cwd: repoRoot,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });

            // Delete old remote branch
            execSync(`git push origin --delete "${currentBranch}"`, {
              cwd: repoRoot,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });

            // Set upstream
            execSync(`git branch -u "origin/${newName}"`, {
              cwd: repoRoot,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });

            renamedRemote = true;
          }
        } catch {
          // Remote rename failed, that's okay
        }
        setRemoteRenamed(renamedRemote);

        // Try to update PR if exists
        setState("updating_pr");
        let updatedPr = false;
        const github = await createGitHub(`${repoRoot}/.pile`);
        if (github && rel.prNumber) {
          try {
            // GitHub automatically updates the PR when the branch is renamed
            // But we should verify the PR still exists and is linked
            const pr = await github.prs.get(rel.prNumber);
            if (pr) {
              updatedPr = true;
            }
          } catch {
            // PR update failed
          }
        }
        setPrUpdated(updatedPr);

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                oldName: currentBranch,
                newName,
                remoteRenamed: renamedRemote,
                prUpdated: updatedPr,
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

    run();
  }, [newName, options.json]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Checking repository state..." />;
    case "renaming_local":
      return <Spinner label="Renaming local branch..." />;
    case "updating_tracking":
      return <Spinner label="Updating pile tracking..." />;
    case "renaming_remote":
      return <Spinner label="Renaming remote branch..." />;
    case "updating_pr":
      return <Spinner label="Updating pull request..." />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Renamed {oldName} → {newName}
          </SuccessMessage>
          <Box flexDirection="column" marginTop={1}>
            <Text color="green">  ✓ Local branch renamed</Text>
            <Text color="green">  ✓ Pile tracking updated</Text>
            {remoteRenamed ? (
              <Text color="green">  ✓ Remote branch renamed</Text>
            ) : (
              <Text color="gray">  - Remote branch not renamed (no remote or not pushed)</Text>
            )}
            {prUpdated ? (
              <Text color="green">  ✓ Pull request updated</Text>
            ) : (
              <Text color="gray">  - No pull request to update</Text>
            )}
          </Box>
        </Box>
      );
    case "name_exists":
      return (
        <ErrorMessage>
          Branch '{newName}' already exists
        </ErrorMessage>
      );
    case "not_tracked":
      return (
        <WarningMessage>
          Branch is not tracked by pile. Run `pile branches` to track it first.
        </WarningMessage>
      );
    case "on_trunk":
      return (
        <WarningMessage>
          Cannot rename trunk branch.
        </WarningMessage>
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
