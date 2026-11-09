import { describe, expect, it } from "vitest";
import { createPile } from "@pile/core";
import type { GitHubInstance } from "@pile/github";
import { cleanupMergedBranch } from "../src/utils/merge-cleanup.js";
import { createCliRepo } from "./helpers.js";

describe("cleanupMergedBranch", () => {
  it("moves the next PR onto the trunk even when pile never recorded its number", async () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    repo.git("checkout", "-q", "main");
    const pile = await createPile(repo.dir);
    // PRs opened outside pile (gh, the website): no PR numbers in pile's state.
    expect(pile.state.getBranchRelationship("b")?.prNumber).toBeFalsy();
    const updates: Array<{ number: number; base?: string }> = [];
    const github = {
      prs: {
        findByBranch: async (branch: string) => (branch === "b" ? { number: 12 } : null),
        update: async (params: { number: number; base?: string }) => {
          updates.push(params);
          return {};
        },
      },
    } as unknown as GitHubInstance;
    await cleanupMergedBranch(pile, github, "a", "main");
    expect(updates).toEqual([{ number: 12, base: "main" }]);
    expect(pile.state.getParent("b")).toBe("main");
  });
});
