import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import {
  ErrorMessage,
  WarningMessage,
} from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface DiffCommandProps {
  options: OutputOptions;
}

type State =
  | "checking"
  | "success"
  | "not_initialized"
  | "on_trunk"
  | "error";

interface DiffFile {
  path: string;
  status: string;
}

export function DiffCommand({ options }: DiffCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [parent, setParent] = useState<string>("");
  const [current, setCurrent] = useState<string>("");

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
        setCurrent(currentBranch);

        if (currentBranch === trunk) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, "On trunk branch, nothing to diff")
              )
            );
            process.exit(1);
          }
          setState("on_trunk");
          return;
        }

        const parentBranch = pile.state.getParent(currentBranch) ?? trunk;
        setParent(parentBranch);

        const diffFiles = await pile.git.getDiffFiles(parentBranch, currentBranch);
        setFiles(diffFiles);

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                branch: currentBranch,
                parent: parentBranch,
                files: diffFiles,
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
  }, [options.json]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Getting diff..." />;
    case "success":
      return (
        <Box flexDirection="column">
          <Text>
            <Text color="cyan">{current}</Text>
            <Text color="gray"> vs </Text>
            <Text color="yellow">{parent}</Text>
          </Text>
          {files.length === 0 ? (
            <Text color="gray">No changes.</Text>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {files.map((f) => (
                <Text key={f.path}>
                  <Text color={getStatusColor(f.status)}>
                    {"  "}{f.status.padEnd(2)}
                  </Text>
                  <Text> {f.path}</Text>
                </Text>
              ))}
              <Text color="gray">
                {"\n  "}{files.length} file{files.length !== 1 ? "s" : ""} changed
              </Text>
            </Box>
          )}
        </Box>
      );
    case "on_trunk":
      return (
        <WarningMessage>On trunk branch, nothing to diff.</WarningMessage>
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

function getStatusColor(status: string): string {
  switch (status) {
    case "A":
      return "green";
    case "D":
      return "red";
    case "M":
      return "yellow";
    case "R":
      return "magenta";
    default:
      return "white";
  }
}
