import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import { SuccessMessage, ErrorMessage } from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";
import { execSync } from "node:child_process";

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
  const [error, setError] = useState<string | null>(null);
  const [stagedFiles, setStagedFiles] = useState<string[]>([]);

  useEffect(() => {
    async function run() {
      try {
        const pile = await createPile();
        const repoRoot = await pile.git.getRepoRoot();

        setState("staging");

        // Build git add command
        if (patch) {
          // Interactive patch mode - run directly
          try {
            execSync("git add -p", {
              cwd: repoRoot,
              stdio: "inherit",
            });
          } catch {
            // User might have quit
          }
        } else if (all) {
          await pile.git.stageAll();
        } else if (update) {
          await pile.git.stageUpdated();
        } else if (files.length > 0) {
          // Stage specific files
          for (const file of files) {
            execSync(`git add "${file}"`, {
              cwd: repoRoot,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });
          }
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
        if (options.json) {
          console.log(formatJson(createResult(false, null, message)));
          process.exit(1);
        }
        setError(message);
        setState("error");
      }
    }

    run();
  }, [files, all, update, patch, options.json]);

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
          {stagedFiles.length <= 10 && (
            <Box flexDirection="column">
              {stagedFiles.map((file) => (
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
