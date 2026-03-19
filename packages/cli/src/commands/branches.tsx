import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { createPile, PileInstance } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import { ErrorMessage, SuccessMessage } from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface BranchesCommandProps {
  options: OutputOptions;
}

interface BranchInfo {
  name: string;
  isTracked: boolean;
  isLocal: boolean;
  isRemote: boolean;
  isCurrent: boolean;
  isTrunk: boolean;
  parent?: string;
  children: string[];
}

type State =
  | "loading"
  | "browsing"
  | "selecting_parent"
  | "success"
  | "not_initialized"
  | "error";

export function BranchesCommand({
  options,
}: BranchesCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<State>("loading");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [pileInstance, setPileInstance] = useState<PileInstance | null>(null);
  const [trunk, setTrunk] = useState("main");
  const [trackingBranch, setTrackingBranch] = useState<string | null>(null);

  const loadBranches = async (pile: PileInstance) => {
    const config = pile.state.getConfig();
    const trunkBranch = config?.trunk ?? "main";
    setTrunk(trunkBranch);

    const currentBranch = await pile.git.getCurrentBranch();
    const localBranches = await pile.git.getAllBranches();
    const remoteBranches = await pile.git.getRemoteBranches();
    const trackedBranches = pile.stack.getAllTrackedBranches();

    const branchInfos: BranchInfo[] = [];

    // Add local branches
    for (const name of localBranches) {
      const isTracked = trackedBranches.includes(name);
      const parent = pile.state.getParent(name) ?? undefined;
      const children = pile.state.getChildren(name);
      const hasRemote = remoteBranches.some((r) => r.endsWith(`/${name}`));

      branchInfos.push({
        name,
        isTracked,
        isLocal: true,
        isRemote: hasRemote,
        isCurrent: name === currentBranch,
        isTrunk: name === trunkBranch,
        parent,
        children,
      });
    }

    // Add remote-only branches
    for (const remoteName of remoteBranches) {
      const name = remoteName.replace(/^origin\//, "");
      if (name === "HEAD") continue;
      if (!localBranches.includes(name)) {
        branchInfos.push({
          name: remoteName,
          isTracked: false,
          isLocal: false,
          isRemote: true,
          isCurrent: false,
          isTrunk: false,
          children: [],
        });
      }
    }

    // Sort: current first, then tracked, then local, then remote
    branchInfos.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.isTrunk !== b.isTrunk) return a.isTrunk ? -1 : 1;
      if (a.isTracked !== b.isTracked) return a.isTracked ? -1 : 1;
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    setBranches(branchInfos);
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

  const handleTrack = async (branch: BranchInfo) => {
    if (!pileInstance || branch.isTrunk) return;

    if (branch.isTracked) {
      // Untrack
      await pileInstance.stack.untrackBranch(branch.name);
      setSuccessMessage(`Untracked ${branch.name}`);
      await loadBranches(pileInstance);
    } else {
      // Start tracking - need to select parent
      setTrackingBranch(branch.name);
      setState("selecting_parent");
    }
  };

  const handleSelectParent = async (parent: string) => {
    if (!pileInstance || !trackingBranch) return;

    await pileInstance.stack.trackBranch(trackingBranch, parent);
    setSuccessMessage(`Tracking ${trackingBranch} (parent: ${parent})`);
    setTrackingBranch(null);
    await loadBranches(pileInstance);
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
          if (selected && selected.isLocal && !selected.isTrunk) {
            handleTrack(selected);
          }
        } else if (input === "q" || key.escape) {
          exit();
        }
        setSuccessMessage(null);
      } else if (state === "selecting_parent") {
        const eligibleParents = branches.filter(
          (b) => b.isLocal && b.name !== trackingBranch
        );

        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setSelectedIndex((prev) =>
            Math.min(eligibleParents.length - 1, prev + 1)
          );
        } else if (key.return) {
          const parent = eligibleParents[selectedIndex];
          if (parent) {
            handleSelectParent(parent.name);
          }
        } else if (key.escape) {
          setTrackingBranch(null);
          setState("browsing");
        }
      }
    },
    { isActive: state === "browsing" || state === "selecting_parent" }
  );

  if (options.json) {
    return <></>;
  }

  const getIcon = (branch: BranchInfo): { icon: string; color: string } => {
    if (branch.isTrunk) {
      return { icon: "◆", color: "magenta" };
    }
    if (branch.isTracked) {
      return { icon: "●", color: "green" };
    }
    if (branch.isLocal) {
      return { icon: "○", color: "gray" };
    }
    return { icon: "◌", color: "gray" };
  };

  switch (state) {
    case "loading":
      return <Spinner label="Loading branches..." />;

    case "selecting_parent":
      const eligibleParents = branches.filter(
        (b) => b.isLocal && b.name !== trackingBranch
      );
      return (
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text bold>Select parent for {trackingBranch}</Text>
            <Text color="gray">↑↓ navigate  enter select  esc cancel</Text>
          </Box>
          {eligibleParents.map((branch, index) => {
            const isSelected = index === selectedIndex;
            const icon = getIcon(branch);

            return (
              <Box key={branch.name}>
                <Text color={isSelected ? "cyan" : undefined}>
                  {isSelected ? "› " : "  "}
                </Text>
                <Text color={icon.color}>{icon.icon}</Text>
                <Text> </Text>
                <Text
                  color={isSelected ? "cyan" : undefined}
                  bold={isSelected}
                >
                  {branch.name}
                </Text>
                {branch.isTrunk && <Text color="magenta"> (trunk)</Text>}
              </Box>
            );
          })}
        </Box>
      );

    case "browsing":
      return (
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text bold>All Branches</Text>
            <Text color="gray">
              ↑↓ navigate  t track/untrack  q quit
            </Text>
          </Box>

          {successMessage && (
            <Box marginBottom={1}>
              <SuccessMessage>{successMessage}</SuccessMessage>
            </Box>
          )}

          <Box marginBottom={1} flexDirection="column">
            <Text color="gray" dimColor>
              <Text color="green">●</Text> tracked{"  "}
              <Text color="gray">○</Text> local{"  "}
              <Text color="gray">◌</Text> remote-only{"  "}
              <Text color="magenta">◆</Text> trunk
            </Text>
          </Box>

          {branches.map((branch, index) => {
            const isSelected = index === selectedIndex;
            const icon = getIcon(branch);

            return (
              <Box key={branch.name}>
                <Text color={isSelected ? "cyan" : undefined}>
                  {isSelected ? "› " : "  "}
                </Text>
                <Text color={icon.color}>{icon.icon}</Text>
                <Text> </Text>
                <Text
                  color={
                    isSelected
                      ? "cyan"
                      : branch.isCurrent
                        ? "blue"
                        : undefined
                  }
                  bold={isSelected || branch.isCurrent}
                >
                  {branch.name}
                </Text>
                {branch.isCurrent && <Text color="blue"> (current)</Text>}
                {branch.isTracked && branch.parent && (
                  <Text color="gray"> ← {branch.parent}</Text>
                )}
                {!branch.isLocal && <Text color="gray" dimColor> (remote)</Text>}
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
