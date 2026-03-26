import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import {
  SuccessMessage,
  ErrorMessage,
  WarningMessage,
} from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export type Direction = "up" | "down" | "top" | "bottom";

export interface NavigateCommandProps {
  direction: Direction;
  steps?: number;
  options: OutputOptions;
}

type State =
  | "navigating"
  | "success"
  | "no_change"
  | "not_initialized"
  | "error";

export function NavigateCommand({
  direction,
  steps = 1,
  options,
}: NavigateCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("navigating");
  const [targetBranch, setTargetBranch] = useState<string | null>(null);
  const [previousBranch, setPreviousBranch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function navigate() {
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

        const current = await pile.git.getCurrentBranch();
        setPreviousBranch(current);

        let result: string | null = null;
        switch (direction) {
          case "up":
            result = await pile.stack.navigateUp(steps);
            break;
          case "down":
            result = await pile.stack.navigateDown(steps);
            break;
          case "top":
            result = await pile.stack.navigateToTop();
            break;
          case "bottom":
            result = await pile.stack.navigateToBottom();
            break;
        }

        if (result === null) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(
                  true,
                  { branch: current, moved: false },
                  undefined,
                  "Already at boundary"
                )
              )
            );
            process.exit(0);
          }
          setState("no_change");
          return;
        }

        setTargetBranch(result);

        if (options.json) {
          console.log(
            formatJson(
              createResult(
                true,
                { branch: result, previous: current, moved: true },
                undefined,
                `Moved to ${result}`
              )
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

    navigate();
  }, [direction, steps, options.json]);

  if (options.json) {
    return <></>;
  }

  const directionLabels = {
    up: "Moving up",
    down: "Moving down",
    top: "Moving to top",
    bottom: "Moving to bottom",
  };

  switch (state) {
    case "navigating":
      return <Spinner label={`${directionLabels[direction]}...`} />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>Switched to {targetBranch}</SuccessMessage>
          <Text color="gray">  from {previousBranch}</Text>
        </Box>
      );
    case "no_change":
      return (
        <WarningMessage>
          Already at {direction === "up" || direction === "top" ? "top" : "bottom"} of stack
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
