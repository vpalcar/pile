import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RepoConfig,
  BranchRelationship,
  PendingOps,
  PendingOperation,
  PendingOpsSchema,
} from "./schemas.js";
import { GitError, runGitSync } from "./exec.js";

/**
 * Pile state lives in the repository's local git config:
 *
 *   pile.trunk, pile.remote, pile.initialized, pile.autoOpenPR, pile.mergeMethod
 *   branch.<name>.pile-parent | pile-base | pile-title | pile-pr-number | pile-pr-url
 *   pile.restack.*   (restack progress, for --continue / --abort)
 *
 * All of it is read with a single `git config` call and cached; writes go straight to
 * git and update the cache. Git moves or drops `branch.<name>.*` sections when a branch
 * is renamed or deleted, so callers invalidate the cache after those operations.
 *
 * Data that is not configuration (the offline queue) lives in `<git-common-dir>/pile/`.
 */

const BRANCH_FIELDS = ["pile-parent", "pile-base", "pile-title", "pile-pr-number", "pile-pr-url"];
const RESTACK_KEYS = [
  "pile.restack.conflict-branch",
  "pile.restack.remaining",
  "pile.restack.completed",
  "pile.restack.original-branch",
];

/**
 * Git config section and variable names are case-insensitive and reported in lower
 * case; subsections (branch names) are case-sensitive.
 */
function normalizeKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === -1) return key.toLowerCase();
  if (first === last) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

export class StateManager {
  private readonly repoRoot: string;
  private cache: Map<string, string> | null = null;
  private gitDir: string | null = null;
  private pendingOps: PendingOps | null = null;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  // ---------------------------------------------------------------------------
  // Config storage

  private load(): Map<string, string> {
    if (this.cache) return this.cache;
    const cache = new Map<string, string>();
    try {
      // -z: entries are "key\nvalue" separated by NUL, so values may contain anything.
      const output = runGitSync(
        ["config", "--local", "-z", "--get-regexp", "^(pile\\.|branch\\..*\\.pile-)"],
        { cwd: this.repoRoot, trim: false },
      );
      for (const entry of output.split("\0")) {
        if (!entry) continue;
        const newline = entry.indexOf("\n");
        const key = newline === -1 ? entry : entry.slice(0, newline);
        const value = newline === -1 ? "" : entry.slice(newline + 1);
        cache.set(normalizeKey(key), value);
      }
    } catch (error) {
      // Exit code 1 means no matching keys.
      if (!(error instanceof GitError && error.exitCode === 1)) throw error;
    }
    this.cache = cache;
    return cache;
  }

  /** Drop cached config, e.g. after git renamed or deleted a branch section. */
  invalidate(): void {
    this.cache = null;
  }

  private get(key: string): string | null {
    return this.load().get(normalizeKey(key)) ?? null;
  }

  private set(key: string, value: string): void {
    if (this.get(key) === value) return;
    runGitSync(["config", "--local", key, value], { cwd: this.repoRoot });
    this.load().set(normalizeKey(key), value);
  }

  private unset(key: string): void {
    if (this.get(key) === null) return;
    try {
      runGitSync(["config", "--local", "--unset-all", key], { cwd: this.repoRoot });
    } catch (error) {
      // Exit code 5: the key did not exist.
      if (!(error instanceof GitError && error.exitCode === 5)) throw error;
    }
    this.load().delete(normalizeKey(key));
  }

  private branchKey(branch: string, field: string): string {
    return `branch.${branch}.${field}`;
  }

  /** All tracked branches mapped to their parent. */
  private parents(): Map<string, string> {
    const parents = new Map<string, string>();
    for (const [key, value] of this.load()) {
      if (key.startsWith("branch.") && key.endsWith(".pile-parent")) {
        parents.set(key.slice("branch.".length, -".pile-parent".length), value);
      }
    }
    return parents;
  }

  // ---------------------------------------------------------------------------
  // Repository config

  isInitialized(): boolean {
    return this.get("pile.initialized") === "true";
  }

  getConfig(): RepoConfig | null {
    if (!this.isInitialized()) {
      return null;
    }
    const mergeMethodRaw = this.get("pile.mergeMethod") ?? "squash";
    const mergeMethod = (["squash", "merge", "rebase"].includes(mergeMethodRaw)
      ? mergeMethodRaw
      : "squash") as RepoConfig["mergeMethod"];
    return {
      trunk: this.get("pile.trunk") ?? "main",
      remote: this.get("pile.remote") ?? "origin",
      initialized: true,
      autoOpenPR: this.get("pile.autoOpenPR") === "true",
      mergeMethod,
    };
  }

  saveConfig(config: RepoConfig): void {
    this.set("pile.trunk", config.trunk);
    this.set("pile.remote", config.remote);
    this.set("pile.initialized", config.initialized ? "true" : "false");
    if (config.autoOpenPR !== undefined) {
      this.set("pile.autoOpenPR", config.autoOpenPR ? "true" : "false");
    }
    if (config.mergeMethod !== undefined) {
      this.set("pile.mergeMethod", config.mergeMethod);
    }
  }

  // ---------------------------------------------------------------------------
  // Branch relationships

  getBranchRelationship(branchName: string): BranchRelationship | null {
    const parent = this.getParent(branchName);
    if (!parent) {
      return null;
    }
    const prNumber = this.get(this.branchKey(branchName, "pile-pr-number"));
    return {
      name: branchName,
      parent,
      baseCommit: this.getBaseCommit(branchName) ?? undefined,
      title: this.getTitle(branchName) ?? undefined,
      prNumber: prNumber ? parseInt(prNumber, 10) : undefined,
      prUrl: this.get(this.branchKey(branchName, "pile-pr-url")) ?? undefined,
    };
  }

  setBranchRelationship(branchName: string, relationship: BranchRelationship): void {
    if (relationship.parent) {
      this.set(this.branchKey(branchName, "pile-parent"), relationship.parent);
    }
    if (relationship.baseCommit !== undefined) {
      this.set(this.branchKey(branchName, "pile-base"), relationship.baseCommit);
    }
    if (relationship.title !== undefined) {
      this.set(this.branchKey(branchName, "pile-title"), relationship.title);
    }
    if (relationship.prNumber !== undefined) {
      this.set(this.branchKey(branchName, "pile-pr-number"), String(relationship.prNumber));
    }
    if (relationship.prUrl !== undefined) {
      this.set(this.branchKey(branchName, "pile-pr-url"), relationship.prUrl);
    }
  }

  removeBranchRelationship(branchName: string): void {
    for (const field of BRANCH_FIELDS) {
      this.unset(this.branchKey(branchName, field));
    }
  }

  getTitle(branchName: string): string | null {
    return this.get(this.branchKey(branchName, "pile-title"));
  }

  getBaseCommit(branchName: string): string | null {
    return this.get(this.branchKey(branchName, "pile-base"));
  }

  setBaseCommit(branchName: string, commit: string): void {
    this.set(this.branchKey(branchName, "pile-base"), commit);
  }

  getParent(branchName: string): string | null {
    return this.get(this.branchKey(branchName, "pile-parent"));
  }

  getChildren(branchName: string): string[] {
    return [...this.parents()]
      .filter(([, parent]) => parent === branchName)
      .map(([branch]) => branch)
      .sort();
  }

  getAllTrackedBranches(): string[] {
    return [...this.parents().keys()].sort();
  }

  // ---------------------------------------------------------------------------
  // Offline queue (persisted under <git-common-dir>/pile/)

  /** Directory for pile's non-config data (PR cache, offline queue). */
  getPileDir(): string {
    if (!this.gitDir) {
      this.gitDir = runGitSync(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: this.repoRoot,
      });
    }
    return join(this.gitDir, "pile");
  }

  private pendingOpsPath(): string {
    return join(this.getPileDir(), "pending-ops.json");
  }

  getPendingOps(): PendingOps {
    if (this.pendingOps) return this.pendingOps;
    try {
      const raw = JSON.parse(readFileSync(this.pendingOpsPath(), "utf-8"));
      this.pendingOps = PendingOpsSchema.parse(raw);
    } catch {
      this.pendingOps = { operations: [] };
    }
    return this.pendingOps;
  }

  savePendingOps(ops: PendingOps): void {
    this.pendingOps = ops;
    const path = this.pendingOpsPath();
    mkdirSync(this.getPileDir(), { recursive: true });
    // Write-then-rename so a crash never leaves a truncated file behind.
    writeFileSync(`${path}.tmp`, JSON.stringify(ops, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  queueOperation(op: Omit<PendingOperation, "id" | "createdAt" | "retries">): void {
    const ops = this.getPendingOps();
    ops.operations.push({
      ...op,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      retries: 0,
    });
    this.savePendingOps(ops);
  }

  removeOperation(id: string): void {
    const ops = this.getPendingOps();
    this.savePendingOps({ operations: ops.operations.filter((op) => op.id !== id) });
  }

  incrementOperationRetry(id: string): void {
    const ops = this.getPendingOps();
    const op = ops.operations.find((o) => o.id === id);
    if (op) {
      op.retries += 1;
      this.savePendingOps(ops);
    }
  }

  hasPendingOperations(): boolean {
    return this.getPendingOps().operations.length > 0;
  }

  getPendingOperationCount(): number {
    return this.getPendingOps().operations.length;
  }

  // ---------------------------------------------------------------------------
  // Restack progress, for conflict resolution

  getRestackState(): RestackState | null {
    const conflictBranch = this.get("pile.restack.conflict-branch");
    if (!conflictBranch) {
      return null;
    }
    const split = (value: string | null) => (value ? value.split(",").filter(Boolean) : []);
    return {
      conflictBranch,
      remainingBranches: split(this.get("pile.restack.remaining")),
      completedBranches: split(this.get("pile.restack.completed")),
      originalBranch: this.get("pile.restack.original-branch") ?? undefined,
    };
  }

  saveRestackState(state: RestackState): void {
    this.set("pile.restack.conflict-branch", state.conflictBranch);
    this.set("pile.restack.remaining", state.remainingBranches.join(","));
    this.set("pile.restack.completed", state.completedBranches.join(","));
    if (state.originalBranch) {
      this.set("pile.restack.original-branch", state.originalBranch);
    } else {
      this.unset("pile.restack.original-branch");
    }
  }

  clearRestackState(): void {
    for (const key of RESTACK_KEYS) {
      this.unset(key);
    }
  }

  hasRestackInProgress(): boolean {
    return this.get("pile.restack.conflict-branch") !== null;
  }
}

export interface RestackState {
  conflictBranch: string;
  remainingBranches: string[];
  completedBranches: string[];
  originalBranch?: string;
}

export function createStateManager(repoRoot: string): StateManager {
  return new StateManager(repoRoot);
}
