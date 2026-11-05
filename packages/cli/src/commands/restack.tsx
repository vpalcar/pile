import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile, RestackResult } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import {
  SuccessMessage,
  ErrorMessage,
  WarningMessage,
  InfoMessage,
} from "../components/Message.js";
import {
  OutputOptions,
  formatJson,
  createResult,
  exitWithError,
  toCommandError,
} from "../utils/output.js";

const CONFLICT_HINT =
  "Resolve the conflicts, `git add` the files, then run `pile restack --continue` (or `pile restack --abort`).";

function exitOnConflict(options: OutputOptions, result: RestackResult): never {
  return exitWithError(options, {
    code: "RESTACK_CONFLICT",
    message: `Conflict while restacking ${result.conflictBranch}`,
    hint: CONFLICT_HINT,
    data: result,
  });
}

export interface RestackCommandProps {
  continue?: boolean;
  abort?: boolean;
  options: OutputOptions;
}

type State =
  | "checking"
  | "restacking"
  | "continuing"
  | "aborting"
  | "success"
  | "conflict"
  | "aborted"
  | "no_restack"
  | "not_initialized"
  | "error";

export function RestackCommand({
  continue: continueRestack,
  abort,
  options,
}: RestackCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RestackResult | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string>("");

  useEffect(() => {
    async function run() {
      try {
        const pile = await createPile();

        if (!pile.state.isInitialized()) {
          if (!options.interactive) {
            exitWithError(options, {
              code: "NOT_INITIALIZED",
              message: "Pile not initialized",
              hint: "Run `pile init` first.",
            });
          }
          setState("not_initialized");
          return;
        }

        const hasRestackInProgress = pile.stack.hasRestackInProgress();

        // Handle --abort
        if (abort) {
          if (!hasRestackInProgress) {
            if (!options.interactive) {
              exitWithError(options, {
                code: "NO_RESTACK_IN_PROGRESS",
                message: "No restack in progress",
                hint: "Run `pile restack` to start one.",
              });
            }
            setState("no_restack");
            return;
          }

          setState("aborting");
          await pile.stack.abortRestack();

          if (options.json) {
            console.log(formatJson(createResult(true, { aborted: true })));
            process.exit(0);
          }

          setState("aborted");
          return;
        }

        // Handle --continue
        if (continueRestack) {
          if (!hasRestackInProgress) {
            if (!options.interactive) {
              exitWithError(options, {
                code: "NO_RESTACK_IN_PROGRESS",
                message: "No restack in progress",
                hint: "Run `pile restack` to start one.",
              });
            }
            setState("no_restack");
            return;
          }

          setState("continuing");
          const restackResult = await pile.stack.continueRestack();
          setResult(restackResult);

          if (!restackResult.success && restackResult.conflictBranch) {
            setCurrentBranch(restackResult.conflictBranch);
            if (!options.interactive) {
              exitOnConflict(options, restackResult);
            }
            setState("conflict");
            return;
          }

          if (options.json) {
            console.log(formatJson(createResult(true, restackResult)));
            process.exit(0);
          }

          setState("success");
          return;
        }

        // Start new restack
        if (hasRestackInProgress) {
          const existingState = pile.stack.getRestackState();
          if (!options.interactive) {
            exitWithError(options, {
              code: "RESTACK_IN_PROGRESS",
              message: `Restack already in progress on ${existingState?.conflictBranch}`,
              hint: CONFLICT_HINT,
              data: existingState,
            });
          }
          setCurrentBranch(existingState?.conflictBranch ?? "");
          setState("conflict");
          return;
        }

        setState("restacking");
        const restackResult = await pile.stack.startRestack();
        setResult(restackResult);

        if (!restackResult.success && restackResult.conflictBranch) {
          setCurrentBranch(restackResult.conflictBranch);
          if (!options.interactive) {
            exitOnConflict(options, restackResult);
          }
          setState("conflict");
          return;
        }

        if (options.json) {
          console.log(formatJson(createResult(true, restackResult)));
          process.exit(0);
        }

        setState("success");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!options.interactive) {
          exitWithError(options, toCommandError(err));
        }
        setError(message);
        setState("error");
      }
    }

    run();
  }, [continueRestack, abort, options.json, options.interactive]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Checking repository state..." />;
    case "restacking":
      return <Spinner label="Restacking branches..." />;
    case "continuing":
      return <Spinner label="Continuing restack..." />;
    case "aborting":
      return <Spinner label="Aborting restack..." />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>Restack complete</SuccessMessage>
          {result && result.completed.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Restacked branches:</Text>
              {result.completed.map((branch) => (
                <Text key={branch} color="green">
                  {"  "}✓ {branch}
                </Text>
              ))}
            </Box>
          )}
          {result && result.completed.length === 0 && (
            <Text color="gray">No branches needed restacking.</Text>
          )}
        </Box>
      );
    case "conflict":
      return (
        <Box flexDirection="column">
          <WarningMessage>Rebase conflict in {currentBranch}</WarningMessage>
          <Box flexDirection="column" marginTop={1}>
            <Text>Resolve the conflicts, then run:</Text>
            <Text color="cyan">{"  "}pile add &lt;files&gt;</Text>
            <Text color="cyan">{"  "}pile restack --continue</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">Or abort with: pile restack --abort</Text>
          </Box>
          {result && result.completed.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Successfully restacked before conflict:</Text>
              {result.completed.map((branch) => (
                <Text key={branch} color="green">
                  {"  "}✓ {branch}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      );
    case "aborted":
      return <InfoMessage>Restack aborted</InfoMessage>;
    case "no_restack":
      return (
        <WarningMessage>
          No restack in progress. Run `pile restack` to start.
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
