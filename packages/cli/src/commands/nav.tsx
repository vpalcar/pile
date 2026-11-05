import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { createPile, PileInstance, NavigationDirection } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import { ErrorMessage, SuccessMessage } from "../components/Message.js";
import {
  OutputOptions,
  CommandError,
  formatJson,
  createResult,
  exitWithError,
  exitNeedsInput,
  toCommandError,
} from "../utils/output.js";

export interface BranchPickerProps {
  title: string;
  choices: string[];
  initialIndex?: number;
  /** Shown dimmed after a choice, e.g. "(detected)". */
  annotate?: (choice: string) => string | undefined;
  onSelect: (choice: string) => void;
  onCancel: () => void;
}

/** Minimal arrow-key picker shared by navigation and tracking prompts. */
export function BranchPicker({
  title,
  choices,
  initialIndex = 0,
  annotate,
  onSelect,
  onCancel,
}: BranchPickerProps): React.ReactElement {
  const [index, setIndex] = useState(initialIndex);

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIndex((i) => Math.min(choices.length - 1, i + 1));
    else if (key.return) onSelect(choices[index]);
    else if (input === "q" || key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Box flexDirection="column" marginTop={1}>
        {choices.map((choice, i) => (
          <Text key={choice} color={i === index ? "cyan" : undefined}>
            {i === index ? "› " : "  "}
            {choice}
            {annotate?.(choice) && <Text color="gray"> {annotate(choice)}</Text>}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">↑↓ navigate  enter select  q quit</Text>
      </Box>
    </Box>
  );
}

export interface NavCommandProps {
  direction: NavigationDirection;
  steps: number;
  /** Child to follow when a branch has several children. */
  to?: string;
  options: OutputOptions;
}

type State = "loading" | "choosing" | "moved" | "no_move" | "aborted" | "error";

interface Choice {
  /** Branch reached so far (where the fork is). */
  at: string;
  choices: string[];
  /** Steps still to take after picking a child ("top" keeps walking). */
  remaining: number;
}

const NOWHERE: Record<NavigationDirection, string> = {
  up: "Already at the top of the stack",
  top: "Already at the top of the stack",
  down: "Already on trunk",
  bottom: "Already at the bottom of the stack",
};

export function NavCommand({ direction, steps, to, options }: NavCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<State>("loading");
  const [from, setFrom] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pile, setPile] = useState<PileInstance | null>(null);

  const fail = (err: CommandError) => {
    if (options.json || !options.interactive) {
      exitWithError(options, err);
    }
    process.exitCode = 1;
    setError(err.message);
    setState("error");
  };

  const finish = async (instance: PileInstance, start: string, destination: string | null) => {
    if (!destination || destination === start) {
      if (options.json) {
        console.log(formatJson(createResult(true, { from: start, to: null, moved: false })));
        process.exit(0);
      }
      setState("no_move");
      setTimeout(() => exit(), 50);
      return;
    }
    await instance.git.checkout(destination);
    if (options.json) {
      console.log(formatJson(createResult(true, { from: start, to: destination, moved: true })));
      process.exit(0);
    }
    setTarget(destination);
    setState("moved");
    setTimeout(() => exit(), 50);
  };

  /**
   * Resolves a move from `at`, following `--to` through forks. Returns a Choice when
   * a fork still needs a decision.
   */
  const resolve = (
    instance: PileInstance,
    at: string,
    remaining: number,
    follow?: string,
  ): { destination: string | null } | Choice => {
    let position = at;
    let left = remaining;
    let pick = follow;
    for (;;) {
      const plan = instance.stack.planNavigation(position, direction, direction === "top" ? 1 : left);
      if (!plan.choices) {
        return { destination: plan.target ?? (position === at ? null : position) };
      }
      const fork = plan.target ?? position;
      // Steps taken to reach the fork (planNavigation stops there).
      const taken = fork === position ? 0 : instance.stack.getAncestry(fork).length - instance.stack.getAncestry(position).length;
      left -= taken;
      if (pick && plan.choices.includes(pick)) {
        position = pick;
        pick = undefined;
        left -= 1;
        if (direction === "up" && left <= 0) return { destination: position };
        continue;
      }
      return { at: fork, choices: plan.choices, remaining: left - 1 };
    }
  };

  useEffect(() => {
    async function run() {
      try {
        const instance = await createPile();
        setPile(instance);

        if (!instance.state.isInitialized()) {
          fail({ code: "NOT_INITIALIZED", message: "Pile not initialized", hint: "Run `pile init` first." });
          return;
        }

        const current = await instance.git.getCurrentBranch();
        setFrom(current);

        const result = resolve(instance, current, steps, to);
        if ("choices" in result) {
          if (!options.interactive) {
            exitNeedsInput(options, {
              message: `${result.at} has several children; choose which one to follow`,
              flag: "--to",
              choices: result.choices,
            });
          }
          setChoice(result);
          setState("choosing");
          return;
        }
        await finish(instance, current, result.destination);
      } catch (err) {
        fail(toCommandError(err));
      }
    }

    run();
  }, [direction, steps, to, options.json]);

  const onPick = async (picked: string) => {
    if (!pile || !choice) return;
    try {
      // Continue walking from the picked child if there are steps left (or for "top").
      const more = direction === "top" || choice.remaining > 0;
      const next = more ? resolve(pile, picked, Math.max(choice.remaining, 1)) : { destination: picked };
      if ("choices" in next) {
        setChoice(next);
        return;
      }
      setState("loading");
      await finish(pile, from, next.destination ?? picked);
    } catch (err) {
      fail(toCommandError(err));
    }
  };

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "loading":
      return <Spinner label="Moving..." />;
    case "choosing":
      return choice ? (
        <BranchPicker
          key={choice.at}
          title={`${choice.at} has several children. Go to:`}
          choices={choice.choices}
          onSelect={onPick}
          onCancel={() => {
            setState("aborted");
            setTimeout(() => exit(), 50);
          }}
        />
      ) : (
        <></>
      );
    case "moved":
      return (
        <SuccessMessage>
          {from} → <Text bold>{target}</Text>
        </SuccessMessage>
      );
    case "no_move":
      return <Text color="gray">{NOWHERE[direction]} ({from})</Text>;
    case "aborted":
      return <Text color="gray">Cancelled</Text>;
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
    default:
      return <></>;
  }
}
