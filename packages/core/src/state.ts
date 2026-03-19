import { execSync } from "node:child_process";
import {
  RepoConfig,
  BranchRelationship,
  PendingOps,
  PendingOperation,
} from "./schemas.js";

export class StateManager {
  private repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  private gitConfig(key: string, value?: string, unset = false): string | null {
    try {
      if (unset) {
        execSync(`git config --unset ${key}`, {
          cwd: this.repoRoot,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return null;
      } else if (value !== undefined) {
        execSync(`git config ${key} "${value}"`, {
          cwd: this.repoRoot,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return value;
      } else {
        const result = execSync(`git config --get ${key}`, {
          cwd: this.repoRoot,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return result.trim();
      }
    } catch {
      return null;
    }
  }

  private gitConfigGetAll(pattern: string): Record<string, string> {
    try {
      const result = execSync(`git config --get-regexp "${pattern}"`, {
        cwd: this.repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const entries: Record<string, string> = {};
      for (const line of result.trim().split("\n")) {
        if (!line) continue;
        const [key, ...valueParts] = line.split(" ");
        entries[key] = valueParts.join(" ");
      }
      return entries;
    } catch {
      return {};
    }
  }

  isInitialized(): boolean {
    const initialized = this.gitConfig("pile.initialized");
    return initialized === "true";
  }

  getConfig(): RepoConfig | null {
    if (!this.isInitialized()) {
      return null;
    }
    const trunk = this.gitConfig("pile.trunk") ?? "main";
    const remote = this.gitConfig("pile.remote") ?? "origin";
    return {
      trunk,
      remote,
      initialized: true,
    };
  }

  saveConfig(config: RepoConfig): void {
    this.gitConfig("pile.trunk", config.trunk);
    this.gitConfig("pile.remote", config.remote);
    this.gitConfig("pile.initialized", config.initialized ? "true" : "false");
  }

  getBranchRelationship(branchName: string): BranchRelationship | null {
    const parent = this.gitConfig(`branch.${branchName}.pile-parent`);
    if (!parent) {
      return null;
    }
    const prNumber = this.gitConfig(`branch.${branchName}.pile-pr-number`);
    const prUrl = this.gitConfig(`branch.${branchName}.pile-pr-url`);
    return {
      name: branchName,
      parent,
      prNumber: prNumber ? parseInt(prNumber, 10) : undefined,
      prUrl: prUrl ?? undefined,
    };
  }

  setBranchRelationship(branchName: string, relationship: BranchRelationship): void {
    if (relationship.parent) {
      this.gitConfig(`branch.${branchName}.pile-parent`, relationship.parent);
    }
    if (relationship.prNumber !== undefined) {
      this.gitConfig(`branch.${branchName}.pile-pr-number`, String(relationship.prNumber));
    }
    if (relationship.prUrl !== undefined) {
      this.gitConfig(`branch.${branchName}.pile-pr-url`, relationship.prUrl);
    }
  }

  removeBranchRelationship(branchName: string): void {
    this.gitConfig(`branch.${branchName}.pile-parent`, undefined, true);
    this.gitConfig(`branch.${branchName}.pile-pr-number`, undefined, true);
    this.gitConfig(`branch.${branchName}.pile-pr-url`, undefined, true);
  }

  getParent(branchName: string): string | null {
    return this.gitConfig(`branch.${branchName}.pile-parent`);
  }

  getChildren(branchName: string): string[] {
    // Find all branches that have this branch as parent
    const allConfigs = this.gitConfigGetAll("^branch\\..*\\.pile-parent$");
    const children: string[] = [];

    for (const [key, value] of Object.entries(allConfigs)) {
      if (value === branchName) {
        // Extract branch name from key like "branch.feature-1.pile-parent"
        const match = key.match(/^branch\.(.+)\.pile-parent$/);
        if (match) {
          children.push(match[1]);
        }
      }
    }

    return children;
  }

  getAllTrackedBranches(): string[] {
    const allConfigs = this.gitConfigGetAll("^branch\\..*\\.pile-parent$");
    const branches: string[] = [];

    for (const key of Object.keys(allConfigs)) {
      const match = key.match(/^branch\.(.+)\.pile-parent$/);
      if (match) {
        branches.push(match[1]);
      }
    }

    return branches;
  }

  // Pending operations are stored in memory only for now
  // In a real implementation, these could be stored in git stash or similar
  private pendingOps: PendingOps = { operations: [] };

  getPendingOps(): PendingOps {
    return this.pendingOps;
  }

  savePendingOps(ops: PendingOps): void {
    this.pendingOps = ops;
  }

  queueOperation(op: Omit<PendingOperation, "id" | "createdAt" | "retries">): void {
    const newOp: PendingOperation = {
      ...op,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      retries: 0,
    };
    this.pendingOps.operations.push(newOp);
  }

  removeOperation(id: string): void {
    this.pendingOps.operations = this.pendingOps.operations.filter((op) => op.id !== id);
  }

  incrementOperationRetry(id: string): void {
    const op = this.pendingOps.operations.find((o) => o.id === id);
    if (op) {
      op.retries += 1;
    }
  }

  hasPendingOperations(): boolean {
    return this.pendingOps.operations.length > 0;
  }

  getPendingOperationCount(): number {
    return this.pendingOps.operations.length;
  }

  getPileDir(): string {
    return `${this.repoRoot}/.pile (git config)`;
  }
}

export function createStateManager(repoRoot: string): StateManager {
  return new StateManager(repoRoot);
}
