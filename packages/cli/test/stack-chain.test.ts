import { describe, expect, it } from "vitest";
import { createPile } from "@pile/core";
import type { GitHubInstance } from "@pile/github";
import { stackChain } from "../src/utils/stack-chain.js";
import { createCliRepo } from "./helpers.js";

/** A GitHub whose PRs are found only by branch (none were opened through pile). */
const github = (byBranch: Record<string, { number: number; state: string; merged?: boolean }>) =>
  ({
    prs: {
      get: async () => {
        throw new Error("pile has no numbers recorded");
      },
      findByBranchAnyState: async (branch: string) => {
        const pr = byBranch[branch];
        return pr ? { ...pr, merged: !!pr.merged, html_url: `https://github.com/o/r/pull/${pr.number}`, stack: null } : null;
      },
    },
  }) as unknown as GitHubInstance;

describe("stackChain (what pile submit registers as a GitHub stack)", () => {
  it("finds a PR opened outside pile by its branch, and records its number", async () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    const pile = await createPile(repo.dir);
    // b was just submitted; a's PR was opened with gh.
    const result = await stackChain(pile, github({ a: { number: 11, state: "open" } }), "b", new Map([["b", { number: 12 }]]));
    expect(result).toEqual({ chain: [{ number: 11, branch: "a", stack: null }, { number: 12, branch: "b", stack: null }] });
    expect(pile.state.getBranchRelationship("a")?.prNumber).toBe(11);
  });

  it("names the branch that keeps the chain from being a stack", async () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    const pile = await createPile(repo.dir);
    const result = await stackChain(pile, github({}), "b", new Map([["b", { number: 12 }]]));
    expect(result).toEqual({ blocked: "a has no open pull request (`pile submit -s` opens one)" });
  });

  it("leaves out branches whose PRs are already merged", async () => {
    const repo = createCliRepo();
    repo.chain(["a", "b", "c"]);
    const pile = await createPile(repo.dir);
    const result = await stackChain(pile, github({ a: { number: 11, state: "closed", merged: true }, b: { number: 12, state: "open" } }), "c", new Map([["c", { number: 13 }]]));
    expect("chain" in result && result.chain.map((l) => l.number)).toEqual([12, 13]);
  });
});
