import React, { useState, useEffect } from "react";
import { Text, useApp } from "ink";
import { createPile, PileInstance } from "@pile/core";
import { Spinner } from "../components/Spinner.js";
import { ErrorMessage, SuccessMessage } from "../components/Message.js";
import {
  OutputOptions,
  CommandError,
  formatJson,
  createResult,
  exitWithError,
  toCommandError,
} from "../utils/output.js";
import { BranchPicker } from "./nav.js";

/**
 * Tracks `branch` on top of `parent`. The base commit is the merge-base with the
 * parent, so a later restack replays only the branch's own commits. Existing
 * metadata (title, PR) is kept when re-parenting.
 */
export async function trackBranchWithParent(
  pile: PileInstance,
  branch: string,
  parent: string,
): Promise<{ baseCommit: string | null }> {
  const baseCommit = await pile.git.getMergeBase(parent, branch);
  const existing = pile.state.getBranchRelationship(branch);
  pile.state.setBranchRelationship(branch, {
    ...existing,
    name: branch,
    parent,
    baseCommit: baseCommit ?? undefined,
  });
  return { baseCommit };
}

/** Untracks `branch` and moves its children onto its parent, keeping their data. */
export function untrackBranchKeepingChildren(
  pile: PileInstance,
  branch: string,
): { parent: string; children: string[] } {
  const parent = pile.state.getParent(branch) ?? pile.stack.getTrunk();
  const children = pile.state.getChildren(branch);
  for (const child of children) {
    const rel = pile.state.getBranchRelationship(child);
    if (rel) pile.state.setBranchRelationship(child, { ...rel, parent });
  }
  pile.state.removeBranchRelationship(branch);
  return { parent, children };
}

function notInitialized(): CommandError {
  return { code: "NOT_INITIALIZED", message: "Pile not initialized", hint: "Run `pile init` first." };
}

export interface TrackCommandProps {
  branch?: string;
  parent?: string;
  options: OutputOptions;
}

type TrackState = "loading" | "choosing" | "tracked" | "aborted" | "error";

export function TrackCommand({ branch, parent, options }: TrackCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<TrackState>("loading");
  const [pile, setPile] = useState<PileInstance | null>(null);
  const [target, setTarget] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [detected, setDetected] = useState<string | null>(null);
  const [trackedParent, setTrackedParent] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fail = (err: CommandError) => {
    if (options.json || !options.interactive) {
      exitWithError(options, err);
    }
    process.exitCode = 1;
    setError(err.message);
    setState("error");
  };

  const apply = async (instance: PileInstance, name: string, newParent: string, wasDetected: boolean) => {
    const reparented = !!instance.state.getParent(name);
    const { baseCommit } = await trackBranchWithParent(instance, name, newParent);
    if (options.json) {
      console.log(
        formatJson(
          createResult(true, { branch: name, parent: newParent, baseCommit, detected: wasDetected, reparented }),
        ),
      );
      process.exit(0);
    }
    setTrackedParent(newParent);
    setState("tracked");
    setTimeout(() => exit(), 50);
  };

  useEffect(() => {
    async function run() {
      try {
        const instance = await createPile();
        setPile(instance);
        if (!instance.state.isInitialized()) {
          fail(notInitialized());
          return;
        }

        const trunk = instance.stack.getTrunk();
        const name = branch ?? (await instance.git.getCurrentBranch());
        setTarget(name);

        if (name === trunk) {
          fail({ code: "ON_TRUNK", message: "Trunk is always tracked" });
          return;
        }
        const refs = await instance.git.getRefs();
        if (!refs.local.has(name)) {
          fail({ code: "BRANCH_NOT_FOUND", message: `Branch "${name}" does not exist` });
          return;
        }

        const descendants = new Set(instance.stack.getDescendants(name));
        if (parent) {
          if (parent !== trunk && !refs.local.has(parent)) {
            fail({ code: "INVALID_TARGET", message: `Parent "${parent}" does not exist` });
            return;
          }
          if (descendants.has(parent)) {
            fail({ code: "INVALID_TARGET", message: "A branch cannot be tracked on itself or its descendant" });
            return;
          }
          await apply(instance, name, parent, false);
          return;
        }

        if (instance.state.getParent(name)) {
          fail({
            code: "ALREADY_TRACKED",
            message: `${name} is already tracked on ${instance.state.getParent(name)}`,
            hint: "Pass --parent <branch> to re-parent it.",
          });
          return;
        }

        // Trunk first so ties (no closer branch) resolve to trunk.
        const parentCandidates = [trunk, ...instance.stack.getAllTrackedBranches().filter((b) => !descendants.has(b))];
        const guess = (await instance.git.findLikelyParent(name, parentCandidates)) ?? trunk;

        if (!options.interactive) {
          await apply(instance, name, guess, true);
          return;
        }

        setDetected(guess);
        setCandidates([guess, ...parentCandidates.filter((c) => c !== guess)]);
        setState("choosing");
      } catch (err) {
        fail(toCommandError(err));
      }
    }

    run();
  }, [branch, parent, options.json]);

  if (options.json) return <></>;

  switch (state) {
    case "loading":
      return <Spinner label="Tracking branch..." />;
    case "choosing":
      return (
        <BranchPicker
          title={`Track ${target} on top of:`}
          choices={candidates}
          annotate={(c) => (c === detected ? "(detected)" : undefined)}
          onSelect={(picked) => {
            if (!pile) return;
            setState("loading");
            apply(pile, target, picked, picked === detected).catch((err) => fail(toCommandError(err)));
          }}
          onCancel={() => {
            setState("aborted");
            setTimeout(() => exit(), 50);
          }}
        />
      );
    case "tracked":
      return (
        <SuccessMessage>
          Tracking {target} on {trackedParent}
        </SuccessMessage>
      );
    case "aborted":
      return <Text color="gray">Cancelled</Text>;
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
    default:
      return <></>;
  }
}

export interface UntrackCommandProps {
  branch?: string;
  options: OutputOptions;
}

export function UntrackCommand({ branch, options }: UntrackCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [result, setResult] = useState<{ branch: string; parent: string; children: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function run() {
      const fail = (err: CommandError) => {
        if (options.json || !options.interactive) {
          exitWithError(options, err);
        }
        process.exitCode = 1;
        setError(err.message);
        setState("error");
      };
      try {
        const pile = await createPile();
        if (!pile.state.isInitialized()) {
          fail(notInitialized());
          return;
        }
        const name = branch ?? (await pile.git.getCurrentBranch());
        if (!pile.state.getParent(name)) {
          fail({ code: "NOT_TRACKED", message: `${name} is not tracked by pile` });
          return;
        }

        const { parent, children } = untrackBranchKeepingChildren(pile, name);
        if (options.json) {
          console.log(formatJson(createResult(true, { branch: name, newParent: parent, reparented: children })));
          process.exit(0);
        }
        setResult({ branch: name, parent, children });
        setState("done");
        setTimeout(() => exit(), 50);
      } catch (err) {
        fail(toCommandError(err));
      }
    }

    run();
  }, [branch, options.json]);

  if (options.json) return <></>;

  switch (state) {
    case "loading":
      return <Spinner label="Untracking branch..." />;
    case "done":
      return result ? (
        <SuccessMessage>
          Untracked {result.branch}
          {result.children.length > 0 && (
            <Text color="gray">
              {" "}
              ({result.children.join(", ")} now on {result.parent})
            </Text>
          )}
        </SuccessMessage>
      ) : (
        <></>
      );
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
  }
}
