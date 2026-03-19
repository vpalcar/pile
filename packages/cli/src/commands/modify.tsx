import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { createPile, PileInstance } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, ErrorMessage, WarningMessage } from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface ModifyCommandProps {
  all?: boolean;
  update?: boolean;
  message?: string;
  options: OutputOptions;
}

type State =
  | "checking"
  | "prompt_unstaged"
  | "staging"
  | "amending"
  | "success"
  | "not_initialized"
  | "no_changes"
  | "on_trunk"
  | "aborted"
  | "error";

export function ModifyCommand({
  all,
  update,
  message,
  options,
}: ModifyCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [branchName, setBranchName] = useState<string>("");
  const [commitHash, setCommitHash] = useState<string | null>(null);
  const [pileInstance, setPileInstance] = useState<PileInstance | null>(null);

  useEffect(() => {
    async function checkAndModify() {
      try {
        const pile = await createPile();
        setPileInstance(pile);

        if (!pile.state.isInitialized()) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(
                  false,
                  null,
                  "Pile not initialized. Run `pile init` first."
                )
              )
            );
            process.exit(1);
          }
          setState("not_initialized");
          return;
        }

        const currentBranch = await pile.git.getCurrentBranch();
        setBranchName(currentBranch);

        const config = pile.state.getConfig();
        const trunk = config?.trunk ?? "main";

        if (currentBranch === trunk) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, "Cannot modify trunk branch")
              )
            );
            process.exit(1);
          }
          setState("on_trunk");
          return;
        }

        // Check for staged and unstaged changes
        const stagedFiles = await pile.git.getStagedFiles();
        const hasChanges = await pile.git.hasUncommittedChanges();

        // Check for changes
        if (stagedFiles.length === 0 && !message) {
          if (!hasChanges) {
            if (options.json) {
              console.log(
                formatJson(
                  createResult(false, null, "No changes to commit")
                )
              );
              process.exit(1);
            }
            setState("no_changes");
            return;
          }

          // If --all or --update is specified, proceed with staging
          if (!all && !update) {
            setState("prompt_unstaged");
            return;
          }
        }

        // Proceed with modification
        await performModify(pile);
      } catch (err) {
        handleError(err);
      }
    }

    checkAndModify();
  }, [all, update, message, options.json]);

  const handleError = (err: unknown) => {
    const errMessage = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(formatJson(createResult(false, null, errMessage)));
      process.exit(1);
    }
    setError(errMessage);
    setState("error");
  };

  const performModify = async (pile: PileInstance) => {
    try {
      // Stage changes if needed
      if (all) {
        setState("staging");
        await pile.git.stageAll();
      } else if (update) {
        setState("staging");
        await pile.git.stageUpdated();
      }

      // Recheck staged files after staging
      const stagedFiles = await pile.git.getStagedFiles();
      if (stagedFiles.length === 0 && !message) {
        if (options.json) {
          console.log(
            formatJson(createResult(false, null, "No changes to commit"))
          );
          process.exit(1);
        }
        setState("no_changes");
        return;
      }

      setState("amending");

      // Amend the commit
      const hash = await pile.git.amendCommit(message);

      if (options.json) {
        console.log(
          formatJson(
            createResult(
              true,
              {
                branch: branchName,
                commit: hash,
                filesModified: stagedFiles.length,
              },
              undefined,
              `Amended commit on ${branchName}`
            )
          )
        );
        process.exit(0);
      }

      setCommitHash(hash.slice(0, 7));
      setState("success");
      setTimeout(() => exit(), 100);
    } catch (err) {
      handleError(err);
    }
  };

  useInput(
    (input, key) => {
      if (state === "prompt_unstaged") {
        if (input === "a" || input === "A") {
          // Stage all and modify
          if (pileInstance) {
            setState("staging");
            pileInstance.git.stageAll().then(() => {
              performModify(pileInstance);
            });
          }
        } else if (input === "q" || key.escape) {
          setState("aborted");
          setTimeout(() => exit(), 100);
        }
      }
    },
    { isActive: state === "prompt_unstaged" }
  );

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Checking repository state..." />;
    case "prompt_unstaged":
      return (
        <Box flexDirection="column">
          <Text>You have unstaged changes.</Text>
          <Text color="gray">a stage all  q quit</Text>
        </Box>
      );
    case "staging":
      return <Spinner label="Staging changes..." />;
    case "amending":
      return <Spinner label="Amending commit..." />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Amended commit on {branchName}
          </SuccessMessage>
          {commitHash && (
            <Text color="gray">  Commit: {commitHash}</Text>
          )}
          <Text color="gray">  Run `pile submit` to push changes</Text>
        </Box>
      );
    case "no_changes":
      return (
        <WarningMessage>
          No changes to amend. Stage changes with -a or -u, or provide a new message with -m.
        </WarningMessage>
      );
    case "on_trunk":
      return (
        <WarningMessage>
          Cannot modify trunk branch. Create a stacked branch first.
        </WarningMessage>
      );
    case "aborted":
      return <Text color="gray">Aborted</Text>;
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
