import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, ErrorMessage } from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface CreateCommandProps {
  name: string;
  message?: string;
  all?: boolean;
  options: OutputOptions;
}

type State =
  | "checking"
  | "staging"
  | "creating"
  | "success"
  | "not_initialized"
  | "error";

export function CreateCommand({
  name,
  message,
  all,
  options,
}: CreateCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [parentBranch, setParentBranch] = useState("");
  const [commitHash, setCommitHash] = useState<string | null>(null);

  useEffect(() => {
    async function create() {
      try {
        const pile = await createPile();

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

        const hasChanges = await pile.git.hasUncommittedChanges();
        if (all && hasChanges) {
          setState("staging");
          await pile.git.stageAll();
        }

        setState("creating");
        const branch = await pile.stack.createBranch(name, message);

        if (options.json) {
          console.log(
            formatJson(
              createResult(
                true,
                {
                  branch: branch.name,
                  parent: branch.parent,
                  commits: branch.commits.length,
                },
                undefined,
                `Created branch ${name}`
              )
            )
          );
          process.exit(0);
        }

        if (branch.commits.length > 0) {
          setCommitHash(branch.commits[0].hash.slice(0, 7));
        }

        setState("success");
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(formatJson(createResult(false, null, errMessage)));
          process.exit(1);
        }
        setError(errMessage);
        setState("error");
      }
    }

    create();
  }, [name, message, all, options.json]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Checking repository state..." />;
    case "staging":
      return <Spinner label="Staging changes..." />;
    case "creating":
      return <Spinner label={`Creating branch ${name}...`} />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Created branch {name} (stacked on {parentBranch})
          </SuccessMessage>
          {commitHash && (
            <Text color="gray">  Committed: {commitHash}</Text>
          )}
        </Box>
      );
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
