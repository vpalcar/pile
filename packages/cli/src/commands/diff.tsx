import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import { CommandError, OutputOptions, formatJson, createResult } from "../utils/output.js";
import {
  CommandFailure,
  FailureMessage,
  notInitialized,
  onTrunk,
  reportFailure,
} from "../utils/pr-target.js";

export interface DiffCommandProps {
  /** Local branch to diff against its parent. Default: current branch. */
  target?: string;
  options: OutputOptions;
}

type State = "checking" | "success" | "error";

interface DiffFile {
  path: string;
  status: string;
}

export function DiffCommand({ target, options }: DiffCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [failure, setFailure] = useState<CommandError | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [parent, setParent] = useState<string>("");
  const [current, setCurrent] = useState<string>("");

  useEffect(() => {
    async function run() {
      try {
        const pile = await createPile();
        if (!pile.state.isInitialized()) throw notInitialized();

        const trunk = pile.stack.getTrunk();
        const branch = target ?? (await pile.git.getCurrentBranch());
        setCurrent(branch);

        if (target && !(await pile.git.branchExists(target))) {
          throw new CommandFailure(
            "BRANCH_NOT_FOUND",
            `Branch "${target}" not found`,
            "Pass the name of a local branch.",
          );
        }
        if (branch === trunk) {
          if (!target) throw onTrunk(trunk);
          throw new CommandFailure(
            "ON_TRUNK",
            `${trunk} is the trunk branch, nothing to diff against`,
            "Pass a stacked branch.",
          );
        }

        const parentBranch = pile.state.getParent(branch) ?? trunk;
        setParent(parentBranch);

        const diffFiles = await pile.git.getDiffFiles(parentBranch, branch);
        setFiles(diffFiles);

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                branch,
                parent: parentBranch,
                files: diffFiles,
              })
            )
          );
          process.exit(0);
        }

        setState("success");
      } catch (err) {
        setFailure(reportFailure(options, err));
        setState("error");
      }
    }

    run();
  }, [options.json, target]);

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
    case "error":
      return failure ? <FailureMessage failure={failure} /> : <></>;
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
