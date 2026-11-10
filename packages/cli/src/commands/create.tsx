import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { createPile, PileInstance } from "@pile/core";
import { createGitHub } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import {
  SuccessMessage,
  ErrorMessage,
  WarningMessage,
  HookOutput,
} from "../components/Message.js";
import {
  OutputOptions,
  formatJson,
  createResult,
  exitWithError,
  exitNeedsInput,
  toCommandError,
} from "../utils/output.js";
import { useFailureExitCode } from "../utils/exit-code.js";
import { hookFailure, type HookContext } from "../utils/hooks.js";
import { deriveBranchName } from "../utils/branch-name.js";

export interface CreateCommandProps {
  name?: string;
  message: string;
  all?: boolean;
  update?: boolean;
  insert?: boolean;
  /** Run the commit hooks (false with --no-verify). */
  verify?: boolean;
  /** Print the hooks' whole output instead of a summary. */
  verbose?: boolean;
  options: OutputOptions;
}

type State =
  | "checking"
  | "checking_parent"
  | "rebasing_to_trunk"
  | "prompt_unstaged"
  | "staging"
  | "creating"
  | "restacking"
  | "success"
  | "no_staged"
  | "not_initialized"
  | "no_changes"
  | "aborted"
  | "error";

export function CreateCommand({
  name,
  message,
  all,
  update,
  insert,
  verify,
  verbose,
  options,
}: CreateCommandProps): React.ReactElement {
  const [hookOutput, setHookOutput] = useState("");
  const { exit } = useApp();
  const [state, setState] = useState<State>("checking");
  useFailureExitCode(state, ["no_staged", "not_initialized", "no_changes", "aborted", "error"]);
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
            exitWithError(options, {
              code: "NOT_INITIALIZED",
              message: "Pile not initialized. Run `pile init` first.",
            });
          }
          setState("not_initialized");
          return;
        }

        const config = pile.state.getConfig();
        const trunk = config?.trunk ?? "main";
        let currentBranch = await pile.git.getCurrentBranch();
        let effectiveParent = currentBranch;

        // Check if current branch (potential parent) has been merged
        if (currentBranch !== trunk && pile.state.getBranchRelationship(currentBranch)) {
          setState("checking_parent");
          const github = await createGitHub(pile);
          let merged = false;
          try {
            const pr = github ? await github.prs.findByBranchAnyState(currentBranch) : null;
            merged = !!pr?.merged;
          } catch {
            // GitHub unreachable: proceed with the normal flow
          }

          if (merged) {
            // The parent is already in trunk: start the new branch from an up-to-date trunk,
            // carrying any uncommitted work across.
            setState("rebasing_to_trunk");
            const hasChanges = await pile.git.hasUncommittedChanges();
            if (hasChanges) {
              await pile.git.stash();
            }
            try {
              await pile.git.fetch(true);
            } catch {
              // Offline: use the local trunk
            }
            await pile.git.fastForward(trunk);
            await pile.git.checkout(trunk);
            if (hasChanges) {
              try {
                await pile.git.stashPop();
              } catch {
                throw Object.assign(
                  new Error(
                    `Your changes conflict with ${trunk}. They are kept in the stash; resolve with \`git stash pop\`.`,
                  ),
                  { code: "STASH_CONFLICT" },
                );
              }
            }
            pile.state.removeBranchRelationship(currentBranch);
            currentBranch = trunk;
            effectiveParent = trunk;
          }
        }

        setParentBranch(effectiveParent);
        setState("checking");

        // Check for staged and unstaged changes
        const stagedFiles = await pile.git.getStagedFiles();
        const hasChanges = await pile.git.hasUncommittedChanges();

        // Check for changes
        if (stagedFiles.length === 0) {
          if (!hasChanges) {
            if (!options.interactive) {
              exitWithError(options, {
                code: "NO_CHANGES",
                message: "No changes to commit",
                hint: "Make changes first; new branches are created with a commit.",
              });
            }
            setState("no_changes");
            return;
          }

          // If --all or --update is specified, proceed with staging
          if (!all && !update) {
            if (!options.interactive) {
              exitNeedsInput(options, {
                message: "You have unstaged changes and nothing staged.",
                flag: "--all",
                choices: ["--all", "--update"],
              });
            }
            setState("prompt_unstaged");
            return;
          }
        }

        // Proceed with creation
        await performCreate(pile, currentBranch);
      } catch (err) {
        handleError(err);
      }
    }

    checkAndCreate();
  }, [name, message, all, update, insert, options.json, options.interactive]);

  const handleError = (err: unknown, context?: HookContext) => {
    const hook = hookFailure(err, context);
    const errMessage = hook ? `${hook.message}\n${hook.hint}` : err instanceof Error ? err.message : String(err);
    if (!options.interactive) {
      if (hook) exitWithError(options, hook);
      const code = (err as { code?: unknown })?.code;
      exitWithError(
        options,
        typeof code === "string" ? { code, message: errMessage } : toCommandError(err),
      );
    }
    setError(errMessage);
    setState("error");
  };

  const performCreate = async (
    pile: PileInstance,
    currentBranch: string
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
        if (!options.interactive) {
          exitWithError(options, { code: "NO_CHANGES", message: "No changes to commit" });
        }
        setState("no_changes");
        return;
      }

      // Determine branch name
      const finalName = name || deriveBranchName(message);
      setBranchName(finalName);
      setState("creating");

      const branch = await pile.stack.createBranch(finalName, message, {
        insert,
        verify,
      });
      setHookOutput(branch.hookOutput ?? "");

      // If insert mode and there were children, restack them onto the new branch
      if (insert && pile.state.getChildren(finalName).length > 0) {
        setState("restacking");
        const result = await pile.stack.startRestack(finalName);
        if (!result.success) {
          exitWithError(options, {
            code: "RESTACK_CONFLICT",
            message: `Created ${finalName}, but restacking ${result.conflictBranch} onto it hit conflicts.`,
            hint: "Resolve the conflicts, `git add` the files, then run `pile restack --continue` (or `--abort`).",
            data: { branch: finalName, conflictBranch: result.conflictBranch, remaining: result.remaining },
          });
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
                hookOutput: branch.hookOutput ?? "",
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
      const gitDir = await pile.git.getGitDir().catch(() => null);
      handleError(err, { action: "create", branch: currentBranch, verbose, gitDir });
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
                performCreate(pileInstance, currentBranch);
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
    case "checking_parent":
      return <Spinner label="Checking parent branch status..." />;
    case "rebasing_to_trunk":
      return <Spinner label="Parent was merged, rebasing to trunk..." />;
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
          <HookOutput output={hookOutput} />
        </Box>
      );
    case "no_changes":
      return (
        <Box flexDirection="column">
          <WarningMessage>No staged changes</WarningMessage>
          <Text color="gray">Stage changes with -a (all) or -u (tracked), or use git add</Text>
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
