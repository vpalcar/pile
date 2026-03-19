import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { createPile, PileInstance } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, ErrorMessage } from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface CreateCommandProps {
  name?: string;
  message?: string;
  all?: boolean;
  update?: boolean;
  insert?: boolean;
  options: OutputOptions;
}

type State =
  | "checking"
  | "prompt_unstaged"
  | "staging"
  | "creating"
  | "restacking"
  | "success"
  | "not_initialized"
  | "no_changes"
  | "aborted"
  | "error";

function deriveBranchName(message: string): string {
  // Get date prefix in mm-dd format
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const datePrefix = `${month}-${day}`;

  // Convert message to branch-friendly format
  const slug = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
    .replace(/\s+/g, "-") // Replace spaces with dashes
    .replace(/-+/g, "-") // Replace multiple dashes with single
    .replace(/^-|-$/g, "") // Remove leading/trailing dashes
    .slice(0, 40); // Limit length (leaving room for date prefix)

  return `${datePrefix}-${slug}`;
}

export function CreateCommand({
  name,
  message,
  all,
  update,
  insert,
  options,
}: CreateCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [parentBranch, setParentBranch] = useState("");
  const [branchName, setBranchName] = useState<string>("");
  const [commitHash, setCommitHash] = useState<string | null>(null);
  const [pileInstance, setPileInstance] = useState<PileInstance | null>(null);

  useEffect(() => {
    async function checkAndCreate() {
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
        setParentBranch(currentBranch);

        // Check for staged and unstaged changes
        const stagedFiles = await pile.git.getStagedFiles();
        const hasChanges = await pile.git.hasUncommittedChanges();

        // Require message
        if (!message) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, "Message is required. Use -m <message>")
              )
            );
            process.exit(1);
          }
          setError("Message is required. Use -m <message>");
          setState("error");
          return;
        }

        // Check for changes
        if (stagedFiles.length === 0) {
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

        // Proceed with creation
        await performCreate(pile, currentBranch, stagedFiles.length > 0);
      } catch (err) {
        handleError(err);
      }
    }

    checkAndCreate();
  }, [name, message, all, update, insert, options.json]);

  const handleError = (err: unknown) => {
    const errMessage = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(formatJson(createResult(false, null, errMessage)));
      process.exit(1);
    }
    setError(errMessage);
    setState("error");
  };

  const performCreate = async (
    pile: PileInstance,
    currentBranch: string,
    hasStaged: boolean
  ) => {
    try {
      // Stage changes if needed
      if (all) {
        setState("staging");
        await pile.git.stageAll();
      } else if (update) {
        setState("staging");
        await pile.git.stageUpdated();
      }

      // Recheck staged files after staging - always require staged files
      const stagedFiles = await pile.git.getStagedFiles();
      if (stagedFiles.length === 0) {
        if (options.json) {
          console.log(
            formatJson(createResult(false, null, "No changes to commit"))
          );
          process.exit(1);
        }
        setState("no_changes");
        return;
      }

      // Determine branch name
      let finalName = name;
      const commitMessage = message;

      if (!finalName) {
        finalName = deriveBranchName(commitMessage!);
      }

      setBranchName(finalName);
      setState("creating");

      const branch = await pile.stack.createBranch(finalName, commitMessage, {
        insert,
      });

      // If insert mode and there were children, restack them
      if (insert) {
        const children = pile.state.getChildren(finalName);
        if (children.length > 0) {
          setState("restacking");
          for (const child of children) {
            await pile.git.checkout(child);
            await pile.git.rebase(finalName);
          }
          // Go back to the new branch
          await pile.git.checkout(finalName);
        }
      }

      if (options.json) {
        console.log(
          formatJson(
            createResult(
              true,
              {
                branch: branch.name,
                parent: branch.parent,
                commits: branch.commits.length,
                inserted: insert && pile.state.getChildren(finalName).length > 0,
              },
              undefined,
              `Created branch ${finalName}`
            )
          )
        );
        process.exit(0);
      }

      if (branch.commits.length > 0) {
        setCommitHash(branch.commits[0].hash.slice(0, 7));
      }

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
          // Stage all and create
          if (pileInstance) {
            setState("staging");
            pileInstance.git.stageAll().then(() => {
              pileInstance.git.getCurrentBranch().then((currentBranch) => {
                performCreate(pileInstance, currentBranch, true);
              });
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
    case "creating":
      return <Spinner label={`Creating branch ${branchName}...`} />;
    case "restacking":
      return <Spinner label="Restacking child branches..." />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Created branch {branchName} (stacked on {parentBranch})
          </SuccessMessage>
          {commitHash && (
            <Text color="gray">  Committed: {commitHash}</Text>
          )}
        </Box>
      );
    case "no_changes":
      return (
        <Box flexDirection="column">
          <ErrorMessage>No changes to commit</ErrorMessage>
          <Text color="gray">Stage changes or use -a/--all to stage all changes</Text>
        </Box>
      );
    case "aborted":
      return <Text color="gray">Aborted</Text>;
    case "not_initialized":
      return (
        <Box flexDirection="column">
          <ErrorMessage>Pile not initialized</ErrorMessage>
          <Text color="gray">Run `pile init` first</Text>
        </Box>
      );
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
    default:
      return <></>;
  }
}
