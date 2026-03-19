import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { createPile, PileInstance } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import { ErrorMessage, SuccessMessage } from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface BranchesCommandProps {
  options: OutputOptions;
}

interface BranchItem {
  name: string;
  depth: number;
  isCurrent: boolean;
  isTrunk: boolean;
  isTracked: boolean;
  parent?: string;
}

type State =
  | "loading"
  | "browsing"
  | "confirming_track"
  | "success"
  | "not_initialized"
  | "error";

export function BranchesCommand({
  options,
}: BranchesCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<State>("loading");
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [pileInstance, setPileInstance] = useState<PileInstance | null>(null);
  const [trunk, setTrunk] = useState("main");
  const [trackingBranch, setTrackingBranch] = useState<string | null>(null);
  const [suggestedParent, setSuggestedParent] = useState<string | null>(null);

  const loadBranches = async (pile: PileInstance) => {
    const config = pile.state.getConfig();
    const trunkBranch = config?.trunk ?? "main";
    setTrunk(trunkBranch);

    const currentBranch = await pile.git.getCurrentBranch();
    const localBranches = await pile.git.getAllBranches();
    const trackedBranches = pile.stack.getAllTrackedBranches();

    // Build a map of branch -> parent for all branches
    const parentMap: Record<string, string> = {};
    const childrenMap: Record<string, string[]> = {};

    // Initialize children map
    for (const branch of localBranches) {
      childrenMap[branch] = [];
    }

    // First, add tracked branch relationships
    for (const branch of trackedBranches) {
      const parent = pile.state.getParent(branch);
      if (parent) {
        parentMap[branch] = parent;
        if (!childrenMap[parent]) childrenMap[parent] = [];
        childrenMap[parent].push(branch);
      }
    }

    // For untracked branches, find their likely parent
    const untrackedBranches = localBranches.filter(
      (b) => !trackedBranches.includes(b) && b !== trunkBranch
    );

    // Candidates for parents: trunk + all local branches
    const parentCandidates = localBranches;

    for (const branch of untrackedBranches) {
      const likelyParent = await pile.git.findLikelyParent(branch, parentCandidates);
      const parent = likelyParent ?? trunkBranch;
      parentMap[branch] = parent;
      if (!childrenMap[parent]) childrenMap[parent] = [];
      childrenMap[parent].push(branch);
    }

    // Build tree structure starting from trunk
    const flatList: BranchItem[] = [];

    const addBranchAndChildren = (branchName: string, depth: number) => {
      const children = childrenMap[branchName] || [];

      // Sort children: tracked first, then alphabetically
      children.sort((a, b) => {
        const aTracked = trackedBranches.includes(a);
        const bTracked = trackedBranches.includes(b);
        if (aTracked !== bTracked) return aTracked ? -1 : 1;
        return a.localeCompare(b);
      });

      const hasMultipleChildren = children.length > 1;

      // Add children first (they appear above in the inverted tree)
      for (let index = 0; index < children.length; index++) {
        const child = children[index];
        const childDepth = hasMultipleChildren && index > 0 ? depth + 1 : depth;
        addBranchAndChildren(child, childDepth);
      }

      // Then add this branch
      flatList.push({
        name: branchName,
        depth,
        isCurrent: branchName === currentBranch,
        isTrunk: branchName === trunkBranch,
        isTracked: trackedBranches.includes(branchName) || branchName === trunkBranch,
        parent: parentMap[branchName],
      });
    };

    // Start building tree from trunk
    addBranchAndChildren(trunkBranch, 0);

    setBranches(flatList);
  };

  useEffect(() => {
    async function load() {
      try {
        const pile = await createPile();
        setPileInstance(pile);

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

        await loadBranches(pile);

        if (options.json) {
          const config = pile.state.getConfig();
          const trackedBranches = pile.stack.getAllTrackedBranches();
          const localBranches = await pile.git.getAllBranches();
          const remoteBranches = await pile.git.getRemoteBranches();

          console.log(
            formatJson(
              createResult(true, {
                trunk: config?.trunk ?? "main",
                tracked: trackedBranches,
                local: localBranches,
                remote: remoteBranches,
              })
            )
          );
          process.exit(0);
        }

        setState("browsing");
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

    load();
  }, [options.json]);

  const handleToggleTrack = async (branch: BranchItem) => {
    if (!pileInstance || branch.isTrunk) return;

    if (branch.isTracked) {
      // Untrack
      await pileInstance.stack.untrackBranch(branch.name);
      setSuccessMessage(`Untracked ${branch.name}`);
      await loadBranches(pileInstance);
    } else {
      // Track - show confirmation with suggested parent
      setTrackingBranch(branch.name);
      setSuggestedParent(branch.parent ?? trunk);
      setState("confirming_track");
    }
  };

  const confirmTrack = async () => {
    if (!pileInstance || !trackingBranch || !suggestedParent) return;

    await pileInstance.stack.trackBranch(trackingBranch, suggestedParent);
    setSuccessMessage(`Tracking ${trackingBranch}`);
    setTrackingBranch(null);
    setSuggestedParent(null);
    await loadBranches(pileInstance);
    setState("browsing");
  };

  const cancelTrack = () => {
    setTrackingBranch(null);
    setSuggestedParent(null);
    setState("browsing");
  };

  useInput(
    (input, key) => {
      if (state === "browsing") {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setSelectedIndex((prev) => Math.min(branches.length - 1, prev + 1));
        } else if (input === "t" || input === "T") {
          const selected = branches[selectedIndex];
          if (selected && !selected.isTrunk) {
            handleToggleTrack(selected);
          }
        } else if (input === "q" || key.escape) {
          exit();
        }
        setSuccessMessage(null);
      } else if (state === "confirming_track") {
        if (key.return || input === "y" || input === "Y") {
          confirmTrack();
        } else if (key.escape || input === "n" || input === "N") {
          cancelTrack();
        }
      }
    },
    { isActive: state === "browsing" || state === "confirming_track" }
  );

  if (options.json) {
    return <></>;
  }

  // Calculate max depth for alignment
  const maxDepth = Math.max(...branches.map((b) => b.depth), 0);

  switch (state) {
    case "loading":
      return <Spinner label="Loading branches..." />;

    case "confirming_track":
      return (
        <Box flexDirection="column">
          <Text>
            Track <Text color="cyan" bold>{trackingBranch}</Text> with parent{" "}
            <Text color="green" bold>{suggestedParent}</Text>?
          </Text>
          <Text color="gray">y confirm  n cancel</Text>
        </Box>
      );

    case "browsing":
      return (
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text bold>All Branches</Text>
            <Text color="gray">↑↓ navigate  t track/untrack  q quit</Text>
          </Box>

          {successMessage && (
            <Box marginBottom={1}>
              <SuccessMessage>{successMessage}</SuccessMessage>
            </Box>
          )}

          {branches.map((branch, index) => {
            const isSelected = index === selectedIndex;

            let prefix = "";
            for (let d = 0; d < branch.depth; d++) {
              prefix += "│ ";
            }

            if (branch.isTrunk) {
              const trunkColor = isSelected
                ? "cyan"
                : branch.isCurrent
                  ? "blue"
                  : undefined;
              return (
                <Box key={branch.name}>
                  <Text color={isSelected ? "cyan" : undefined}>
                    {isSelected ? "› " : "  "}
                  </Text>
                  <Text color={trunkColor}>◆</Text>
                  <Text dimColor>{maxDepth > 0 ? "─┘" : "  "}</Text>
                  <Text>{" ".repeat(maxDepth)} </Text>
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

            // Icon: ● for tracked, ○ for untracked
            const icon = branch.isTracked ? "●" : "○";
            const iconColor = branch.isTracked ? "green" : "gray";

            return (
              <Box key={branch.name}>
                <Text color={isSelected ? "cyan" : undefined}>
                  {isSelected ? "› " : "  "}
                </Text>
                <Text dimColor>{prefix}</Text>
                <Text color={iconColor}>{icon}</Text>
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

    case "success":
      return <SuccessMessage>{successMessage}</SuccessMessage>;

    case "not_initialized":
      return (
        <ErrorMessage>
          Pile not initialized. Run `pile init` first.
        </ErrorMessage>
      );

    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;

    default:
      return <></>;
  }
}
