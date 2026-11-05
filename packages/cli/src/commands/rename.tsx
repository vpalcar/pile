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
import {
  OutputOptions,
  CommandError,
  formatJson,
  createResult,
  exitWithError,
  toCommandError,
} from "../utils/output.js";

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
    async function run() {
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
        setOldName(currentBranch);

        if (currentBranch === trunk) {
          fail({ code: "ON_TRUNK", message: "Cannot rename trunk branch" }, "on_trunk");
          return;
        }

        // Check if new name already exists
        if (await pile.git.branchExists(newName)) {
          fail({ code: "BRANCH_EXISTS", message: `Branch '${newName}' already exists` }, "name_exists");
          return;
        }

        // Get current branch relationship
        const rel = pile.state.getBranchRelationship(currentBranch);
        if (!rel) {
          fail(
            {
              code: "NOT_TRACKED",
              message: "Branch is not tracked by pile",
              hint: "Run `pile track` to track it first.",
            },
            "not_tracked",
          );
          return;
        }
        const children = pile.state.getChildren(currentBranch);
        const remote = pile.git.remoteName;
        const hasRemote = (await pile.git.getRefs()).remote.has(`${remote}/${currentBranch}`);

        // Rename local branch. Git moves the branch.<name>.* config section (and so the
        // pile metadata) to the new name; the cached state is invalidated by the call.
        setState("renaming_local");
        await pile.git.renameBranch(currentBranch, newName);

        // Update pile tracking
        setState("updating_tracking");
        pile.state.setBranchRelationship(newName, { ...rel, name: newName });

        // Update children's parent references
        for (const child of children) {
          const childRel = pile.state.getBranchRelationship(child);
          if (childRel && childRel.parent === currentBranch) {
            pile.state.setBranchRelationship(child, { ...childRel, parent: newName });
          }
        }

        // Rename the remote branch. GitHub's rename endpoint keeps open PRs attached;
        // pushing a new branch and deleting the old one would close them.
        setState("renaming_remote");
        let renamedRemote = false;
        let updatedPr = false;
        const github = hasRemote ? await createGitHub(pile).catch(() => null) : null;
        if (hasRemote && github) {
          try {
            await github.client.api.repos.renameBranch({
              owner: github.client.repoOwner,
              repo: github.client.repoName,
              branch: currentBranch,
              new_name: newName,
            });
            await pile.git.fetch(true);
            await pile.git.run(["branch", "--set-upstream-to", `${remote}/${newName}`, newName]);
            renamedRemote = true;
            updatedPr = !!rel.prNumber;
          } catch {
            // Remote rename failed; the local rename still stands.
          }
        } else if (hasRemote && !rel.prNumber) {
          // No GitHub access and no PR to keep: push the new name, drop the old one.
          try {
            await pile.git.pushSetUpstream(newName);
            await pile.git.deleteRemoteBranch(currentBranch);
            renamedRemote = true;
          } catch {
            // Remote rename failed, that's okay
          }
        }
        setRemoteRenamed(renamedRemote);
        setPrUpdated(updatedPr);

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                oldName: currentBranch,
                newName,
                remoteRenamed: renamedRemote,
                prUpdated: updatedPr,
                childrenUpdated: children,
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
          Branch is not tracked by pile. Run `pile track` to track it first.
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
