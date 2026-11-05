import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { createPile, PileInstance } from "@pile/core";
import { createPRCacheManager } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { ErrorMessage } from "../components/Message.js";
import {
  OutputOptions,
  CommandError,
  formatJson,
  createResult,
  exitWithError,
  exitNeedsInput,
  toCommandError,
} from "../utils/output.js";
import { PRStatusType } from "../components/StackTree.js";

export interface CheckoutCommandProps {
  branch?: string;
  options: OutputOptions;
}

interface BranchItem {
  name: string;
  depth: number;
  isCurrent: boolean;
  isTrunk?: boolean;
  prNumber?: number;
  prStatus?: PRStatusType;
  syncStatus?: string;
}

type State =
  | "loading"
  | "selecting"
  | "checking_out"
  | "success"
  | "already_on_branch"
  | "aborted"
  | "not_initialized"
  | "error";

export function CheckoutCommand({
  branch: targetBranch,
  options,
}: CheckoutCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<State>("loading");
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [checkedOutBranch, setCheckedOutBranch] = useState<string | null>(null);
  const [pileInstance, setPileInstance] = useState<PileInstance | null>(null);

  // Non-interactive runs exit with a structured error; interactive runs render it.
  const fail = (err: CommandError) => {
    if (options.json || !options.interactive) {
      exitWithError(options, err);
    }
    process.exitCode = 1;
    setError(err.message);
    setState("error");
  };

  useEffect(() => {
    async function load() {
      try {
        const pile = await createPile();
        setPileInstance(pile);

        if (!pile.state.isInitialized()) {
          if (options.json || !options.interactive) {
            exitWithError(options, {
              code: "NOT_INITIALIZED",
              message: "Pile not initialized",
              hint: "Run `pile init` first.",
            });
          }
          setState("not_initialized");
          return;
        }

        const config = pile.state.getConfig();
        const trunkBranch = config?.trunk ?? "main";
        const currentBranch = await pile.git.getCurrentBranch();

        // Direct checkout when branch name is provided
        if (targetBranch) {
          if (targetBranch === currentBranch) {
            if (options.json) {
              console.log(formatJson(createResult(true, { branch: targetBranch }, undefined, "Already on this branch")));
              process.exit(0);
            }
            setState("already_on_branch");
            setTimeout(() => exit(), 100);
            return;
          }
          const refs = await pile.git.getRefs();
          if (
            !refs.local.has(targetBranch) &&
            !refs.remote.has(`${pile.git.remoteName}/${targetBranch}`)
          ) {
            fail({
              code: "BRANCH_NOT_FOUND",
              message: `Branch "${targetBranch}" does not exist`,
              hint: "Run `pile log` to see tracked branches.",
            });
            return;
          }
          try {
            await pile.git.checkout(targetBranch);
            if (options.json) {
              console.log(formatJson(createResult(true, { branch: targetBranch }, undefined, `Switched to ${targetBranch}`)));
              process.exit(0);
            }
            setCheckedOutBranch(targetBranch);
            setState("success");
            setTimeout(() => exit(), 100);
          } catch (err) {
            fail(toCommandError(err));
          }
          return;
        }

        // Non-interactive: the branch list is the answer to "which branch?"
        if (!options.interactive) {
          exitNeedsInput(options, {
            message: "No branch given and no terminal to pick one",
            arg: "branch",
            choices: [trunkBranch, ...pile.stack.getAllTrackedBranches()],
          });
        }

        // Load PR cache
        const cacheManager = createPRCacheManager(pile.state.getPileDir());
        const cachedPRs = cacheManager.getAllCachedPRs();

        const prCacheMap: Record<string, { number: number; status: PRStatusType }> =
          {};
        for (const pr of cachedPRs) {
          prCacheMap[pr.branch] = { number: pr.number, status: pr.status };
        }

        // Build flat list of branches
        const allTracked = pile.stack.getAllTrackedBranches();
        const rootBranches = allTracked.filter(
          (b) => pile.state.getParent(b) === trunkBranch
        );

        const flatList: BranchItem[] = [];
        const syncStatuses = new Map(
          (await pile.git.getSyncStatuses(allTracked)).map((status, i) => [allTracked[i], status]),
        );

        const addBranchAndChildren = async (
          branchName: string,
          stackDepth: number
        ) => {
          const children = pile.state.getChildren(branchName);
          const hasMultipleChildren = children.length > 1;

          for (let index = 0; index < children.length; index++) {
            const child = children[index];
            const childDepth =
              hasMultipleChildren && index > 0 ? stackDepth + 1 : stackDepth;
            await addBranchAndChildren(child, childDepth);
          }

          const prInfo = prCacheMap[branchName];
          const syncStatus = syncStatuses.get(branchName);

          flatList.push({
            name: branchName,
            depth: stackDepth,
            isCurrent: currentBranch === branchName,
            prNumber: prInfo?.number,
            prStatus: prInfo?.status,
            syncStatus,
          });
        };

        for (let index = 0; index < rootBranches.length; index++) {
          await addBranchAndChildren(rootBranches[index], index);
        }

        // Add trunk at the bottom
        flatList.push({
          name: trunkBranch,
          depth: 0,
          isCurrent: currentBranch === trunkBranch,
          isTrunk: true,
        });

        setBranches(flatList);

        // Set initial selection to current branch
        const currentIndex = flatList.findIndex((b) => b.isCurrent);
        if (currentIndex >= 0) {
          setSelectedIndex(currentIndex);
        }

        setState("selecting");
      } catch (err) {
        fail(toCommandError(err));
      }
    }

    load();
  }, [options.json]);

  useInput(
    (input, key) => {
      if (state !== "selecting") return;

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(branches.length - 1, prev + 1));
      } else if (key.return) {
        const selected = branches[selectedIndex];
        if (selected) {
          if (selected.isCurrent) {
            // Already on this branch
            setState("already_on_branch");
            setTimeout(() => exit(), 100);
          } else if (pileInstance) {
            setState("checking_out");
            pileInstance.git
              .checkout(selected.name)
              .then(() => {
                setCheckedOutBranch(selected.name);
                setState("success");
                setTimeout(() => exit(), 100);
              })
              .catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
                setState("error");
              });
          }
        }
      } else if (input === "q" || key.escape) {
        setState("aborted");
        setTimeout(() => exit(), 100);
      }
    },
    { isActive: state === "selecting" }
  );

  if (options.json) {
    return <></>;
  }

  const maxDepth = Math.max(...branches.map((b) => b.depth), 0);

  const getStatusIcon = (
    branch: BranchItem
  ): { icon: string; color: string } => {
    if (branch.isTrunk) {
      return { icon: "", color: "gray" };
    }
    if (branch.prStatus === "merged") {
      return { icon: "✓", color: "magenta" };
    }
    if (branch.prStatus === "closed") {
      return { icon: "✗", color: "gray" };
    }
    if (branch.prStatus === "approved") {
      return { icon: "✓", color: "green" };
    }
    if (branch.prStatus === "changes_requested") {
      return { icon: "!", color: "red" };
    }
    if (branch.prStatus === "draft") {
      return { icon: "◐", color: "gray" };
    }
    if (branch.prNumber) {
      return { icon: "○", color: "blue" };
    }
    return { icon: "⬡", color: "yellow" };
  };

  switch (state) {
    case "loading":
      return <Spinner label="Loading branches..." />;
    case "checking_out":
      return (
        <Spinner label={`Checking out ${branches[selectedIndex]?.name}...`} />
      );
    case "success":
      return (
        <Text color="green">
          ✓ Switched to {checkedOutBranch}
        </Text>
      );
    case "selecting":
      return (
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text bold>Switch to branch</Text>
            <Text color="gray">↑↓ navigate  enter select  q quit</Text>
          </Box>
          {branches.map((branch, index) => {
            const isSelected = index === selectedIndex;
            const isTrunk = branch.isTrunk === true;
            const status = getStatusIcon(branch);

            let prefix = "";
            for (let d = 0; d < branch.depth; d++) {
              prefix += "│ ";
            }

            if (isTrunk) {
              // Build the horizontal line connecting all branches
              let trunkLine = "";
              if (maxDepth > 0) {
                for (let d = 0; d < maxDepth; d++) {
                  trunkLine += "─┴";
                }
                trunkLine += "─┘";
              }

              const trunkColor = isSelected ? "cyan" : branch.isCurrent ? "blue" : undefined;

              return (
                <Box key={branch.name}>
                  <Text color={isSelected ? "cyan" : undefined}>
                    {isSelected ? "› " : "  "}
                  </Text>
                  <Text color={trunkColor}>○</Text>
                  <Text dimColor>{trunkLine}</Text>
                  <Text> </Text>
                  <Text color={trunkColor} bold={isSelected || branch.isCurrent}>
                    {branch.name}
                  </Text>
                  {branch.isCurrent && <Text color="blue"> (current)</Text>}
                </Box>
              );
            }

            const branchColor = isSelected
              ? "cyan"
              : branch.isCurrent
                ? "blue"
                : undefined;

            return (
              <Box key={branch.name}>
                <Text color={isSelected ? "cyan" : undefined}>
                  {isSelected ? "› " : "  "}
                </Text>
                <Text dimColor>{prefix}</Text>
                <Text color={branchColor} bold={isSelected || branch.isCurrent}>
                  {status.icon}
                </Text>
                <Text>{" ".repeat(maxDepth - branch.depth + 2)} </Text>
                <Text color={branchColor} bold={isSelected || branch.isCurrent}>
                  {branch.name}
                </Text>
                {branch.isCurrent && <Text color="blue"> (current)</Text>}
              </Box>
            );
          })}
        </Box>
      );
    case "already_on_branch":
      return <Text color="gray">Already on this branch</Text>;
    case "aborted":
      return <Text color="gray">Checkout aborted</Text>;
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
