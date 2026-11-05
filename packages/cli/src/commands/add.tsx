import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, ErrorMessage } from "../components/Message.js";
import {
  OutputOptions,
  formatJson,
  createResult,
  exitWithError,
  exitNeedsInput,
  toCommandError,
} from "../utils/output.js";
import { spawnSync } from "node:child_process";
import { useFailureExitCode } from "../utils/exit-code.js";

export interface AddCommandProps {
  files: string[];
  all?: boolean;
  update?: boolean;
  patch?: boolean;
  options: OutputOptions;
}

type State = "checking" | "staging" | "success" | "no_changes" | "error";

export function AddCommand({
  files,
  all,
  update,
  patch,
  options,
}: AddCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  useFailureExitCode(state, ["no_changes", "error"]);
  const [error, setError] = useState<string | null>(null);
  const [stagedFiles, setStagedFiles] = useState<string[]>([]);

  useEffect(() => {
    async function run() {
      try {
        const pile = await createPile();

        if (patch && !options.interactive) {
          exitNeedsInput(options, {
            message: "--patch selects hunks interactively and needs a terminal.",
            arg: "files",
            flag: "<files...>",
          });
        }

        setState("staging");

        if (patch) {
          // Hand the terminal to git's own hunk selector; quitting early is fine.
          spawnSync("git", ["add", "-p", ...files], { stdio: "inherit" });
        } else if (all) {
          await pile.git.stageAll();
        } else if (update) {
          await pile.git.stageUpdated();
        } else if (files.length > 0) {
          // Paths are relative to the current directory, as with `git add`.
          await pile.git.stageFiles(files);
        } else {
          // No files specified and no flags - stage all by default
          await pile.git.stageAll();
        }

        // Get staged files for display
        const staged = await pile.git.getStagedFiles();
        setStagedFiles(staged);

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                staged: staged,
                count: staged.length,
              })
            )
          );
          process.exit(0);
        }

        if (staged.length === 0) {
          setState("no_changes");
        } else {
          setState("success");
        }
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
  }, [files, all, update, patch, options.json, options.interactive]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
    case "staging":
      return <Spinner label="Staging files..." />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Staged {stagedFiles.length} file{stagedFiles.length !== 1 ? "s" : ""}
          </SuccessMessage>
          {(
            <Box flexDirection="column">
              {stagedFiles.slice(0, 10).map((file) => (
                <Text key={file} color="green">
                  {"  "}+ {file}
                </Text>
              ))}
            </Box>
          )}
          {stagedFiles.length > 10 && (
            <Text color="gray">
              {"  "}(showing first 10 of {stagedFiles.length})
            </Text>
          )}
        </Box>
      );
    case "no_changes":
      return <Text color="gray">No changes to stage</Text>;
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
    default:
      return <></>;
  }
}
