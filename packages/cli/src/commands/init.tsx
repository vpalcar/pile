import React, { useState, useEffect } from "react";
import { Box } from "ink";
import { createPile } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import {
  SuccessMessage,
  ErrorMessage,
  InfoMessage,
} from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface InitCommandProps {
  trunk?: string;
  options: OutputOptions;
}

type State =
  | "checking"
  | "initializing_git"
  | "initializing"
  | "success"
  | "already_initialized"
  | "error";

export function InitCommand({
  trunk,
  options,
}: InitCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [detectedTrunk, setDetectedTrunk] = useState("main");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const pile = await createPile();

        const isGitRepo = await pile.git.isGitRepo();
        if (!isGitRepo) {
          setState("initializing_git");
          await pile.git.initRepo();
        }

        if (pile.state.isInitialized()) {
          const config = pile.state.getConfig();
          if (options.json) {
            console.log(
              formatJson(
                createResult(
                  true,
                  { trunk: config?.trunk },
                  undefined,
                  "Already initialized"
                )
              )
            );
            process.exit(0);
          }
          setDetectedTrunk(config?.trunk ?? "main");
          setState("already_initialized");
          return;
        }

        setState("initializing");

        const branches = await pile.git.getAllBranches();
        let defaultTrunk: string;

        if (branches.length === 0) {
          defaultTrunk = trunk ?? "main";
          await pile.git.createInitialCommit(defaultTrunk);
        } else {
          defaultTrunk =
            trunk ??
            (branches.includes("main")
              ? "main"
              : branches.includes("master")
                ? "master"
                : branches[0]);
        }

        setDetectedTrunk(defaultTrunk);

        pile.state.saveConfig({
          trunk: defaultTrunk,
          remote: "origin",
          initialized: true,
        });

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, { trunk: defaultTrunk }, undefined, "Initialized")
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

    init();
  }, [trunk, options.json]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Checking repository..." />;
    case "initializing_git":
      return <Spinner label="Initializing git repository..." />;
    case "initializing":
      return <Spinner label="Initializing pile..." />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Initialized pile with trunk branch: {detectedTrunk}
          </SuccessMessage>
          <InfoMessage>
            Run `pile create {"<name>"}` to create your first stacked branch
          </InfoMessage>
        </Box>
      );
    case "already_initialized":
      return (
        <InfoMessage>
          Pile already initialized (trunk: {detectedTrunk})
        </InfoMessage>
      );
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
    default:
      return <></>;
  }
}
