import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getGitCallCount } from "../src/exec.js";
import { createChain, createTestRepo } from "./helpers.js";

describe("StackManager", () => {
  it("tracks parents and base commits when creating branches", async () => {
    const repo = createTestRepo();
    await createChain(repo, ["a", "b"]);
    const pile = await repo.pile();

    expect(pile.state.getBranchRelationship("a")).toMatchObject({ parent: "main", baseCommit: repo.git("rev-parse", "main") });
    expect(pile.state.getBranchRelationship("b")).toMatchObject({ parent: "a", baseCommit: repo.git("rev-parse", "a") });
  });

  it("builds every stack tree with a bounded number of git calls", async () => {
    const repo = createTestRepo();
    await createChain(repo, ["s1/a", "s1/b", "s1/c"]);
    await createChain(repo, ["s2/a", "s2/b"]);
    await createChain(repo, ["s1/b2"], "s1/a");

    const pile = await repo.pile();
    const before = getGitCallCount();
    const trees = await pile.stack.getAllStackTrees();
    const calls = getGitCallCount() - before;

    const shape = (node: (typeof trees)[number]): unknown => ({
      name: node.branch.name,
      commits: node.branch.commits.length,
      children: node.children.map(shape),
    });
    expect(trees.map(shape)).toEqual([
      {
        name: "s1/a",
        commits: 1,
        children: [
          { name: "s1/b", commits: 1, children: [{ name: "s1/c", commits: 1, children: [] }] },
          { name: "s1/b2", commits: 1, children: [] },
        ],
      },
      { name: "s2/a", commits: 1, children: [{ name: "s2/b", commits: 1, children: [] }] },
    ]);
    // current branch + ref snapshot + config + one log per branch (no per-branch config reads)
    expect(calls).toBeLessThanOrEqual(3 + 6);
  });

  it("survives a parent cycle in config", async () => {
    const repo = createTestRepo();
    await createChain(repo, ["a", "b"]);
    repo.git("config", "branch.a.pile-parent", "b");
    const pile = await repo.pile();

    expect(pile.stack.getAncestry("b")).toEqual(["a", "b"]);
    expect(pile.stack.getDescendants("a")).toEqual(["a", "b"]);
    expect(pile.stack.planNavigation("a", "top")).toEqual({ target: "b" });
    const stack = await pile.stack.getStack("b");
    expect(stack.branches.map((b) => b.name)).toEqual(["a", "b"]);
  });

  describe("planNavigation", () => {
    it("moves up and down a linear stack", async () => {
      const repo = createTestRepo();
      await createChain(repo, ["a", "b", "c"]);
      const { stack } = await repo.pile();

      expect(stack.planNavigation("a", "up")).toEqual({ target: "b" });
      expect(stack.planNavigation("a", "up", 2)).toEqual({ target: "c" });
      expect(stack.planNavigation("a", "top")).toEqual({ target: "c" });
      expect(stack.planNavigation("c", "down")).toEqual({ target: "b" });
      expect(stack.planNavigation("c", "down", 5)).toEqual({ target: "main" });
      expect(stack.planNavigation("c", "bottom")).toEqual({ target: "a" });
      expect(stack.planNavigation("a", "bottom")).toEqual({ target: "main" });
      expect(stack.planNavigation("c", "up")).toEqual({ target: null });
      expect(stack.planNavigation("main", "up")).toEqual({ target: "a" });
    });

    it("reports choices when a branch has several children", async () => {
      const repo = createTestRepo();
      await createChain(repo, ["a", "b"]);
      await createChain(repo, ["b2"], "a");
      const { stack } = await repo.pile();

      expect(stack.planNavigation("a", "up")).toEqual({ target: null, choices: ["b", "b2"] });
      expect(stack.planNavigation("main", "top")).toEqual({ target: "a", choices: ["b", "b2"] });
    });
  });

  describe("restack", () => {
    it("skips branches already on top of their parent", async () => {
      const repo = createTestRepo();
      await createChain(repo, ["a", "b"]);
      const { stack } = await repo.pile();
      const head = repo.git("rev-parse", "b");

      const result = await stack.startRestack();
      expect(result).toMatchObject({ success: true, completed: ["a", "b"] });
      expect(repo.git("rev-parse", "b")).toBe(head);
    });

    it("rebases children with --onto after the parent is amended", async () => {
      const repo = createTestRepo();
      await createChain(repo, ["a", "b", "c"]);
      repo.git("switch", "-q", "a");
      repo.git("commit", "-q", "--amend", "-m", "add a (amended)");

      const { stack } = await repo.pile();
      const result = await stack.startRestack();

      expect(result.success).toBe(true);
      expect(repo.git("merge-base", "--is-ancestor", "a", "b")).toBe("");
      expect(repo.git("merge-base", "--is-ancestor", "b", "c")).toBe("");
      // b keeps exactly its own commit, the old version of a is not replayed
      expect(repo.git("rev-list", "--count", "a..b")).toBe("1");
      expect(await stack.getCurrentBranch()).toBe("a");
    });

    it("pauses on conflict, then continues the remaining branches", async () => {
      const repo = createTestRepo();
      await createChain(repo, ["a", "b", "c"]);
      repo.git("switch", "-q", "b");
      repo.commitFile("a.txt", "changed in b\n");
      repo.git("switch", "-q", "a");
      repo.commitFile("a.txt", "changed in a\n");

      const pile = await repo.pile();
      const first = await pile.stack.startRestack();
      expect(first).toMatchObject({ success: false, conflictBranch: "b", completed: ["a"], remaining: ["c"] });
      expect(pile.stack.hasRestackInProgress()).toBe(true);

      writeFileSync(join(repo.dir, "a.txt"), "resolved\n");
      repo.git("add", "a.txt");
      const second = await (await repo.pile()).stack.continueRestack();
      expect(second).toMatchObject({ success: true, completed: ["a", "b", "c"] });
      expect((await repo.pile()).state.hasRestackInProgress()).toBe(false);
      expect(repo.git("rev-list", "--count", "b..c")).toBe("1");
      expect(repo.git("branch", "--show-current")).toBe("a");
    });

    it("aborts a conflicted restack and restores the original branch", async () => {
      const repo = createTestRepo();
      await createChain(repo, ["a", "b"]);
      repo.commitFile("a.txt", "changed in b\n");
      repo.git("switch", "-q", "a");
      repo.commitFile("a.txt", "changed in a\n");
      const bBefore = repo.git("rev-parse", "b");

      const { stack } = await repo.pile();
      await stack.startRestack();
      await stack.abortRestack();

      expect(repo.git("rev-parse", "b")).toBe(bBefore);
      expect(repo.git("branch", "--show-current")).toBe("a");
      expect(stack.hasRestackInProgress()).toBe(false);
    });
  });

  it("syncs: fast-forwards trunk without checkout and restacks onto it", async () => {
    const repo = createTestRepo();
    await createChain(repo, ["a"]);
    // Someone else pushes to main.
    repo.git("switch", "-q", "-c", "other", "main");
    const upstream = repo.commitFile("upstream.txt", "x\n");
    repo.git("push", "-q", "origin", "other:main");
    repo.git("switch", "-q", "a");
    repo.git("branch", "-D", "other");

    const { stack } = await repo.pile();
    const result = await stack.syncStack();

    expect(result).toMatchObject({ fetched: true, trunkUpdated: true });
    expect(result.restacked).toEqual([{ branch: "a", success: true, conflicts: false }]);
    expect(repo.git("rev-parse", "main")).toBe(upstream);
    expect(repo.git("merge-base", "--is-ancestor", "main", "a")).toBe("");
    expect(repo.git("branch", "--show-current")).toBe("a");
  });

  it("reparents children when deleting a branch", async () => {
    const repo = createTestRepo();
    await createChain(repo, ["a", "b", "c"]);
    await createChain(repo, ["b2"], "b");
    repo.git("switch", "-q", "main");
    const { stack, state } = await repo.pile();

    await stack.deleteBranch("b", true);
    expect(state.getParent("c")).toBe("a");
    expect(state.getParent("b2")).toBe("a");
    expect(stack.getAllTrackedBranches()).toEqual(["a", "b2", "c"]);
  });

  it("invalidates cached state when git deletes a branch", async () => {
    const repo = createTestRepo();
    await createChain(repo, ["a", "b"]);
    repo.git("switch", "-q", "main");
    const pile = await repo.pile();
    expect(pile.stack.getAllTrackedBranches()).toEqual(["a", "b"]);

    await pile.git.deleteBranch("b", true);
    expect(pile.stack.getAllTrackedBranches()).toEqual(["a"]);
  });
});
