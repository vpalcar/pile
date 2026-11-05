import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { createPile, PileInstance } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import {
  SuccessMessage,
  ErrorMessage,
  WarningMessage,
} from "../components/Message.js";
import {
  OutputOptions,
  CommandError,
  formatJson,
  createResult,
  exitWithError,
  exitNeedsInput,
  toCommandError,
} from "../utils/output.js";

export interface MoveCommandProps {
  onto?: string;
  options: OutputOptions;
}

type State =
  | "checking"
  | "selecting"
  | "moving"
  | "restacking"
  | "success"
  | "conflict"
  | "no_change"
  | "invalid_target"
  | "not_tracked"
  | "not_initialized"
  | "on_trunk"
  | "error";

interface BranchOption {
  name: string;
  isCurrent: boolean;
  isCurrentParent: boolean;
}

export function MoveCommand({
  onto,
  options,
}: MoveCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string>("");
  const [oldParent, setOldParent] = useState<string>("");
  const [newParent, setNewParent] = useState<string>("");
  const [rebasedChildren, setRebasedChildren] = useState<string[]>([]);
  const [availableBranches, setAvailableBranches] = useState<BranchOption[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pile, setPile] = useState<PileInstance | null>(null);

  // Non-interactive runs exit with a structured error; interactive runs render it.
  const fail = (err: CommandError, view: State = "error") => {
    if (options.json || !options.interactive) {
      exitWithError(options, err);
    }
    process.exitCode = 1;
    setError(err.message);
    setState(view);
  };

  useEffect(() => {
    async function run() {
      try {
        const pileInstance = await createPile();
        setPile(pileInstance);

        if (!pileInstance.state.isInitialized()) {
          fail(
            { code: "NOT_INITIALIZED", message: "Pile not initialized", hint: "Run `pile init` first." },
            "not_initialized",
          );
          return;
        }

        const trunk = pileInstance.stack.getTrunk();
        const current = await pileInstance.git.getCurrentBranch();
        setCurrentBranch(current);

        if (current === trunk) {
          fail({ code: "ON_TRUNK", message: "Cannot move trunk branch" }, "on_trunk");
          return;
        }

        const currentParent = pileInstance.state.getParent(current);
        if (!currentParent) {
          fail(
            {
              code: "NOT_TRACKED",
              message: "Branch is not tracked by pile",
              hint: "Run `pile track` to track it.",
            },
            "not_tracked",
          );
          return;
        }
        setOldParent(currentParent);

        // If --onto is specified, move directly
        if (onto) {
          // Validate target
          const targetExists = await pileInstance.git.branchExists(onto);
          if (!targetExists) {
            fail({ code: "INVALID_TARGET", message: `Branch '${onto}' does not exist` }, "invalid_target");
            return;
          }

          // Check if target would create a cycle
          if (onto === current || isDescendant(pileInstance, onto, current)) {
            fail(
              { code: "INVALID_TARGET", message: "Cannot move branch onto itself or its descendant" },
              "invalid_target",
            );
            return;
          }

          if (onto === currentParent) {
            if (options.json) {
              console.log(
                formatJson(createResult(true, { noChange: true }, "Branch already has this parent"))
              );
              process.exit(0);
            }
            setState("no_change");
            return;
          }

          setNewParent(onto);
          await performMove(pileInstance, current, currentParent, onto, trunk);
          return;
        }

        // Interactive mode - show branch selector
        const allBranches = await pileInstance.git.getAllBranches();
        const trackedBranches = pileInstance.stack.getAllTrackedBranches();

        // Build list of valid targets (trunk + tracked branches, excluding current and descendants)
        const validTargets: BranchOption[] = [];

        // Add trunk
        if (trunk !== current) {
          validTargets.push({
            name: trunk,
            isCurrent: false,
            isCurrentParent: trunk === currentParent,
          });
        }

        // Add tracked branches (excluding current and its descendants)
        for (const branch of trackedBranches) {
          if (branch !== current && !isDescendant(pileInstance, branch, current)) {
            validTargets.push({
              name: branch,
              isCurrent: false,
              isCurrentParent: branch === currentParent,
            });
          }
        }

        // Add untracked branches that exist
        for (const branch of allBranches) {
          if (
            branch !== current &&
            branch !== trunk &&
            !trackedBranches.includes(branch) &&
            !isDescendant(pileInstance, branch, current)
          ) {
            validTargets.push({
              name: branch,
              isCurrent: false,
              isCurrentParent: false,
            });
          }
        }

        if (!options.interactive) {
          exitNeedsInput(options, {
            message: `No target given for moving ${current}`,
            flag: "--onto",
            choices: validTargets.filter((b) => !b.isCurrentParent).map((b) => b.name),
          });
        }

        setAvailableBranches(validTargets);

        // Find current parent in list and select it
        const parentIndex = validTargets.findIndex((b) => b.isCurrentParent);
        if (parentIndex >= 0) {
          setSelectedIndex(parentIndex);
        }

        setState("selecting");
      } catch (err) {
        fail(toCommandError(err));
      }
    }

    run();
  }, [onto, options.json]);

  const performMove = async (
    pileInstance: PileInstance,
    current: string,
    currentParent: string,
    target: string,
    trunk: string
  ) => {
    try {
      setState("moving");

      // Descendants (depth-first) are restacked after the move, parents before children.
      const children = pileInstance.stack.getDescendants(current).slice(1);

      // Only this branch's own commits move: everything after the old parent's base.
      const storedBase = pileInstance.state.getBaseCommit(current);
      const oldBase =
        storedBase && (await pileInstance.git.isAncestor(storedBase, current))
          ? storedBase
          : await pileInstance.git.getMergeBase(current, currentParent);

      // Update the branch relationship
      const rel = pileInstance.state.getBranchRelationship(current);
      if (rel) {
        pileInstance.state.setBranchRelationship(current, {
          ...rel,
          parent: target,
        });
      }

      // Rebase onto new parent
      const rebaseResult = oldBase
        ? await pileInstance.git.rebaseOnto(target, oldBase, current)
        : (await pileInstance.git.checkout(current), await pileInstance.git.rebase(target));

      if (rebaseResult.conflicts) {
        if (options.json || !options.interactive) {
          exitWithError(options, {
            code: "CONFLICT",
            message: `Rebase conflict while moving ${current}`,
            hint: "Resolve the conflicts, `git add` them, then `git rebase --continue`.",
            data: { conflicts: true, branch: current },
          });
        }
        process.exitCode = 1;
        setState("conflict");
        return;
      }

      // Update base commit
      const newBaseCommit = await pileInstance.git.getCommitHash(target);
      pileInstance.state.setBaseCommit(current, newBaseCommit);

      // Restack children if any
      if (children.length > 0) {
        setState("restacking");
        const restacked: string[] = [];

        for (const child of children) {
          const childResult = await pileInstance.stack.restack(child);
          if (childResult.success) {
            restacked.push(child);
          } else if (childResult.conflicts) {
            // Stop on conflict
            setRebasedChildren(restacked);
            if (options.json || !options.interactive) {
              exitWithError(options, {
                code: "CONFLICT",
                message: `Conflict while restacking ${child}`,
                hint: "Resolve the conflicts, `git add` them, then run `pile restack --continue`.",
                data: { conflicts: true, branch: child, restacked },
              });
            }
            process.exitCode = 1;
            setError(`Conflict while restacking ${child}`);
            setState("conflict");
            return;
          }
        }

        setRebasedChildren(restacked);
        await pileInstance.git.checkout(current);
      }

      if (options.json) {
        console.log(
          formatJson(
            createResult(true, {
              branch: current,
              from: currentParent,
              to: target,
              childrenRestacked: children,
            })
          )
        );
        process.exit(0);
      }

      setState("success");
      setTimeout(() => exit(), 100);
    } catch (err) {
      fail(toCommandError(err));
    }
  };

  useInput(
    (input, key) => {
      if (state !== "selecting" || !pile) return;

      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setSelectedIndex((i) => Math.min(availableBranches.length - 1, i + 1));
      } else if (key.return) {
        const selected = availableBranches[selectedIndex];
        if (selected && !selected.isCurrentParent) {
          setNewParent(selected.name);
          const trunk = pile.stack.getTrunk();
          performMove(pile, currentBranch, oldParent, selected.name, trunk);
        }
      } else if (input === "q" || key.escape) {
        exit();
      }
    },
    { isActive: state === "selecting" }
  );

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Checking repository state..." />;
    case "selecting":
      return (
        <Box flexDirection="column">
          <Text bold>Move {currentBranch} onto:</Text>
          <Text color="gray" dimColor>
            Current parent: {oldParent}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {availableBranches.map((branch, index) => (
              <Box key={branch.name}>
                <Text color={index === selectedIndex ? "cyan" : undefined}>
                  {index === selectedIndex ? "❯ " : "  "}
                  {branch.name}
                  {branch.isCurrentParent && (
                    <Text color="gray"> (current parent)</Text>
                  )}
                </Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color="gray">↑/↓ navigate  enter select  q quit</Text>
          </Box>
        </Box>
      );
    case "moving":
      return <Spinner label={`Moving ${currentBranch} onto ${newParent}...`} />;
    case "restacking":
      return <Spinner label="Restacking child branches..." />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Moved {currentBranch} onto {newParent}
          </SuccessMessage>
          <Text color="gray">  Previous parent: {oldParent}</Text>
          {rebasedChildren.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Restacked children:</Text>
              {rebasedChildren.map((child) => (
                <Text key={child} color="green">
                  {"  "}✓ {child}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      );
    case "conflict":
      return (
        <Box flexDirection="column">
          <WarningMessage>Rebase conflict</WarningMessage>
          <Box flexDirection="column" marginTop={1}>
            <Text>Resolve the conflicts, then run:</Text>
            <Text color="cyan">{"  "}git add &lt;files&gt;</Text>
            <Text color="cyan">{"  "}git rebase --continue</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">Or abort with: git rebase --abort</Text>
          </Box>
        </Box>
      );
    case "no_change":
      return (
        <Text color="gray">
          {currentBranch} is already on {oldParent}
        </Text>
      );
    case "invalid_target":
      return <ErrorMessage>{error}</ErrorMessage>;
    case "not_tracked":
      return (
        <WarningMessage>
          Branch is not tracked by pile. Run `pile branches` to track it.
        </WarningMessage>
      );
    case "on_trunk":
      return (
        <WarningMessage>
          Cannot move trunk branch.
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

// Check if 'branch' is a descendant of 'ancestor'
function isDescendant(pile: PileInstance, branch: string, ancestor: string): boolean {
  return pile.stack.getDescendants(ancestor).slice(1).includes(branch);
}
