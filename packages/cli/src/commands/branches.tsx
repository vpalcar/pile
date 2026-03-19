import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { createPile, PileInstance } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import { ErrorMessage, SuccessMessage } from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface BranchesCommandProps {
  options: OutputOptions;
}

interface TrackedBranchItem {
  type: "tracked";
  name: string;
  depth: number;
  isCurrent: boolean;
  parent?: string;
}

interface UntrackedBranchItem {
  type: "untracked";
  name: string;
  isCurrent: boolean;
  isRemoteOnly: boolean;
  suggestedParent?: string;
}

interface SeparatorItem {
  type: "separator";
  label: string;
}

type ListItem = TrackedBranchItem | UntrackedBranchItem | SeparatorItem;

type State =
  | "loading"
  | "browsing"
  | "confirming_parent"
  | "success"
  | "not_initialized"
  | "error";

export function BranchesCommand({
  options,
}: BranchesCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<State>("loading");
  const [items, setItems] = useState<ListItem[]>([]);
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
    const remoteBranches = await pile.git.getRemoteBranches();
    const trackedBranches = pile.stack.getAllTrackedBranches();

    const listItems: ListItem[] = [];

    // Build tree structure for tracked branches (like co command)
    const rootBranches = trackedBranches.filter(
      (b) => pile.state.getParent(b) === trunkBranch
    );

    const addBranchAndChildren = (branchName: string, depth: number) => {
      const children = pile.state.getChildren(branchName);
      const hasMultipleChildren = children.length > 1;

      // Add children first (they appear above in the inverted tree)
      for (let index = 0; index < children.length; index++) {
        const child = children[index];
        const childDepth = hasMultipleChildren && index > 0 ? depth + 1 : depth;
        addBranchAndChildren(child, childDepth);
      }

      // Then add this branch
      listItems.push({
        type: "tracked",
        name: branchName,
        depth,
        isCurrent: branchName === currentBranch,
        parent: pile.state.getParent(branchName) ?? undefined,
      });
    };

    // Add tracked branches with tree structure
    for (let index = 0; index < rootBranches.length; index++) {
      addBranchAndChildren(rootBranches[index], index);
    }

    // Add trunk
    listItems.push({
      type: "tracked",
      name: trunkBranch,
      depth: 0,
      isCurrent: trunkBranch === currentBranch,
    });

    // Find untracked local branches
    const untrackedLocal = localBranches.filter(
      (b) => !trackedBranches.includes(b) && b !== trunkBranch
    );

    // Find remote-only branches
    const remoteOnly = remoteBranches
      .filter((r) => {
        const name = r.replace(/^origin\//, "");
        return name !== "HEAD" && !localBranches.includes(name);
      })
      .map((r) => r.replace(/^origin\//, ""));

    // Add separator and untracked branches if any
    if (untrackedLocal.length > 0 || remoteOnly.length > 0) {
      listItems.push({ type: "separator", label: "Untracked" });

      // Get candidate parents for auto-detection
      const parentCandidates = [trunkBranch, ...trackedBranches];

      for (const name of untrackedLocal) {
        // Find suggested parent
        const suggested = await pile.git.findLikelyParent(name, parentCandidates);

        listItems.push({
          type: "untracked",
          name,
          isCurrent: name === currentBranch,
          isRemoteOnly: false,
          suggestedParent: suggested ?? trunkBranch,
        });
      }

      for (const name of remoteOnly) {
        listItems.push({
          type: "untracked",
          name: `origin/${name}`,
          isCurrent: false,
          isRemoteOnly: true,
        });
      }
    }

    setItems(listItems);
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

  const handleTrack = async (item: UntrackedBranchItem) => {
    if (!pileInstance || item.isRemoteOnly) return;

    // Auto-track with suggested parent, show confirmation
    setTrackingBranch(item.name);
    setSuggestedParent(item.suggestedParent ?? trunk);
    setState("confirming_parent");
  };

  const handleUntrack = async (item: TrackedBranchItem) => {
    if (!pileInstance || item.name === trunk) return;

    await pileInstance.stack.untrackBranch(item.name);
    setSuccessMessage(`Untracked ${item.name}`);
    await loadBranches(pileInstance);
  };

  const confirmTrack = async () => {
    if (!pileInstance || !trackingBranch || !suggestedParent) return;

    await pileInstance.stack.trackBranch(trackingBranch, suggestedParent);
    setSuccessMessage(`Tracking ${trackingBranch} (parent: ${suggestedParent})`);
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

  // Get selectable items (exclude separators)
  const selectableItems = items.filter((item) => item.type !== "separator");

  useInput(
    (input, key) => {
      if (state === "browsing") {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setSelectedIndex((prev) =>
            Math.min(selectableItems.length - 1, prev + 1)
          );
        } else if (input === "t" || input === "T") {
          const selected = selectableItems[selectedIndex];
          if (selected?.type === "untracked" && !selected.isRemoteOnly) {
            handleTrack(selected);
          } else if (selected?.type === "tracked" && selected.name !== trunk) {
            handleUntrack(selected);
          }
        } else if (input === "q" || key.escape) {
          exit();
        }
        setSuccessMessage(null);
      } else if (state === "confirming_parent") {
        if (key.return || input === "y" || input === "Y") {
          confirmTrack();
        } else if (key.escape || input === "n" || input === "N") {
          cancelTrack();
        }
      }
    },
    { isActive: state === "browsing" || state === "confirming_parent" }
  );

  if (options.json) {
    return <></>;
  }

  // Calculate max depth for alignment
  const maxDepth = Math.max(
    ...items
      .filter((i): i is TrackedBranchItem => i.type === "tracked")
      .map((i) => i.depth),
    0
  );

  switch (state) {
    case "loading":
      return <Spinner label="Loading branches..." />;

    case "confirming_parent":
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
      let selectableIndex = 0;

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

          {items.map((item, index) => {
            if (item.type === "separator") {
              return (
                <Box key={`sep-${index}`} marginTop={1}>
                  <Text color="gray" dimColor>
                    ── {item.label} ──
                  </Text>
                </Box>
              );
            }

            const currentSelectableIndex = selectableIndex++;
            const isSelected = currentSelectableIndex === selectedIndex;

            if (item.type === "tracked") {
              const isTrunk = item.name === trunk;
              let prefix = "";
              for (let d = 0; d < item.depth; d++) {
                prefix += "│ ";
              }

              if (isTrunk) {
                const trunkColor = isSelected
                  ? "cyan"
                  : item.isCurrent
                    ? "blue"
                    : undefined;
                return (
                  <Box key={item.name}>
                    <Text color={isSelected ? "cyan" : undefined}>
                      {isSelected ? "› " : "  "}
                    </Text>
                    <Text color={trunkColor}>◆</Text>
                    <Text dimColor>{maxDepth > 0 ? "─┘" : "  "}</Text>
                    <Text>{" ".repeat(maxDepth)} </Text>
                    <Text color={trunkColor} bold={isSelected || item.isCurrent}>
                      {item.name}
                    </Text>
                    {item.isCurrent && <Text color="blue"> (current)</Text>}
                    <Text color="magenta"> trunk</Text>
                  </Box>
                );
              }

              const branchColor = isSelected
                ? "cyan"
                : item.isCurrent
                  ? "blue"
                  : undefined;

              return (
                <Box key={item.name}>
                  <Text color={isSelected ? "cyan" : undefined}>
                    {isSelected ? "› " : "  "}
                  </Text>
                  <Text dimColor>{prefix}</Text>
                  <Text color="green" bold={isSelected || item.isCurrent}>
                    ●
                  </Text>
                  <Text>{" ".repeat(maxDepth - item.depth + 2)} </Text>
                  <Text color={branchColor} bold={isSelected || item.isCurrent}>
                    {item.name}
                  </Text>
                  {item.isCurrent && <Text color="blue"> (current)</Text>}
                </Box>
              );
            }

            // Untracked branch
            const branchColor = isSelected
              ? "cyan"
              : item.isCurrent
                ? "blue"
                : undefined;

            return (
              <Box key={item.name}>
                <Text color={isSelected ? "cyan" : undefined}>
                  {isSelected ? "› " : "  "}
                </Text>
                <Text color="gray">{item.isRemoteOnly ? "◌" : "○"}</Text>
                <Text>{"   "}</Text>
                <Text color={branchColor} bold={isSelected || item.isCurrent}>
                  {item.name}
                </Text>
                {item.isCurrent && <Text color="blue"> (current)</Text>}
                {item.suggestedParent && !item.isRemoteOnly && (
                  <Text color="gray" dimColor>
                    {" "}
                    → {item.suggestedParent}
                  </Text>
                )}
                {item.isRemoteOnly && (
                  <Text color="gray" dimColor>
                    {" "}
                    (remote)
                  </Text>
                )}
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
