import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createStateManager } from "../src/state.js";
import { getGitCallCount } from "../src/exec.js";
import { createTestRepo } from "./helpers.js";

describe("StateManager", () => {
  it("reads all state with a single git call", () => {
    const repo = createTestRepo();
    for (let i = 0; i < 20; i++) {
      repo.git("config", `branch.b${i}.pile-parent`, i === 0 ? "main" : `b${i - 1}`);
      repo.git("config", `branch.b${i}.pile-title`, `title ${i}`);
    }

    const state = createStateManager(repo.dir);
    const before = getGitCallCount();
    expect(state.getConfig()?.trunk).toBe("main");
    expect(state.getAllTrackedBranches()).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      state.getBranchRelationship(`b${i}`);
      state.getChildren(`b${i}`);
    }
    expect(getGitCallCount() - before).toBe(1);
  });

  it("stores values with shell metacharacters verbatim", () => {
    const repo = createTestRepo();
    const state = createStateManager(repo.dir);
    const title = `Fix "quotes", $HOME, \`backticks\` and 'single' ; rm -rf /`;

    state.setBranchRelationship("feature", { name: "feature", parent: "main", title });

    expect(createStateManager(repo.dir).getTitle("feature")).toBe(title);
    expect(repo.git("config", "branch.feature.pile-title")).toBe(title);
  });

  it("handles branch names with dots, slashes and mixed case", () => {
    const repo = createTestRepo();
    const state = createStateManager(repo.dir);
    state.setBranchRelationship("Team/v1.2-Fix", { name: "Team/v1.2-Fix", parent: "main", prNumber: 7 });
    state.setBranchRelationship("team/v1.2-fix", { name: "team/v1.2-fix", parent: "Team/v1.2-Fix" });

    const fresh = createStateManager(repo.dir);
    expect(fresh.getBranchRelationship("Team/v1.2-Fix")).toMatchObject({ parent: "main", prNumber: 7 });
    expect(fresh.getChildren("Team/v1.2-Fix")).toEqual(["team/v1.2-fix"]);
    expect(fresh.getAllTrackedBranches()).toEqual(["Team/v1.2-Fix", "team/v1.2-fix"]);
  });

  it("reads mixed-case config keys written by older versions", () => {
    const repo = createTestRepo();
    repo.git("config", "pile.autoOpenPR", "true");
    repo.git("config", "pile.mergeMethod", "rebase");
    expect(createStateManager(repo.dir).getConfig()).toMatchObject({ autoOpenPR: true, mergeMethod: "rebase" });
  });

  it("removes relationships and keeps the cache consistent", () => {
    const repo = createTestRepo();
    const state = createStateManager(repo.dir);
    state.setBranchRelationship("a", { name: "a", parent: "main", title: "A", prNumber: 1, prUrl: "u" });
    state.removeBranchRelationship("a");

    expect(state.getBranchRelationship("a")).toBeNull();
    expect(createStateManager(repo.dir).getAllTrackedBranches()).toEqual([]);
  });

  it("sees changes made by git after invalidate()", () => {
    const repo = createTestRepo();
    const state = createStateManager(repo.dir);
    state.setBranchRelationship("a", { name: "a", parent: "main" });
    repo.git("config", "--remove-section", "branch.a");

    expect(state.getParent("a")).toBe("main"); // cached
    state.invalidate();
    expect(state.getParent("a")).toBeNull();
  });

  it("round-trips restack state", () => {
    const repo = createTestRepo();
    const state = createStateManager(repo.dir);
    state.saveRestackState({
      conflictBranch: "b",
      remainingBranches: ["c", "d"],
      completedBranches: ["a"],
      originalBranch: "d",
    });

    expect(createStateManager(repo.dir).getRestackState()).toEqual({
      conflictBranch: "b",
      remainingBranches: ["c", "d"],
      completedBranches: ["a"],
      originalBranch: "d",
    });
    state.clearRestackState();
    expect(createStateManager(repo.dir).hasRestackInProgress()).toBe(false);
  });

  it("persists the offline queue inside the git dir, not the work tree", () => {
    const repo = createTestRepo();
    const state = createStateManager(repo.dir);
    state.queueOperation({ type: "create_pr", payload: { branch: "a" } });

    const path = join(repo.dir, ".git", "pile", "pending-ops.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8")).operations).toHaveLength(1);

    const reloaded = createStateManager(repo.dir);
    expect(reloaded.getPendingOperationCount()).toBe(1);
    const [op] = reloaded.getPendingOps().operations;
    reloaded.incrementOperationRetry(op.id);
    expect(createStateManager(repo.dir).getPendingOps().operations[0].retries).toBe(1);
    reloaded.removeOperation(op.id);
    expect(createStateManager(repo.dir).hasPendingOperations()).toBe(false);
    expect(repo.git("status", "--porcelain")).toBe("");
  });
});
