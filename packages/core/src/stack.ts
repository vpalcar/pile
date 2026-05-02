import { GitOperations } from "./git.js";
import { StateManager, RestackState } from "./state.js";
import { Branch, Stack, StackNode } from "./schemas.js";

export interface RestackResult {
  success: boolean;
  completed: string[];
  conflictBranch?: string;
  remaining: string[];
}

export class StackManager {
  private git: GitOperations;
  private state: StateManager;

  constructor(git: GitOperations, state: StateManager) {
    this.git = git;
    this.state = state;
  }

  async getCurrentBranch(): Promise<string> {
    return this.git.getCurrentBranch();
  }

  getTrunk(): string {
    const config = this.state.getConfig();
    return config?.trunk ?? "main";
  }

  async createBranch(
    name: string,
    message?: string,
    options?: { insert?: boolean }
  ): Promise<Branch> {
    const currentBranch = await this.git.getCurrentBranch();
    const trunk = this.getTrunk();

    // Create the new branch
    await this.git.createBranch(name);

    // If there's a message and staged changes, commit them
    const commits: Branch["commits"] = [];
    if (message) {
      const stagedFiles = await this.git.getStagedFiles();
      if (stagedFiles.length > 0) {
        const hash = await this.git.commit(message);
        commits.push({
          hash,
          message,
          author: "", // Will be filled from git log
          date: new Date().toISOString(),
        });
      }
    }

    // Track the relationship
    const parent = currentBranch === trunk ? trunk : currentBranch;
    const baseCommit = await this.git.getCommitHash(parent);
    this.state.setBranchRelationship(name, {
      name,
      parent,
      baseCommit, // Store parent's commit for smarter rebasing
      title: message, // Store original message for PR title
    });

    // Handle insert mode - reparent children of current branch to new branch
    if (options?.insert && currentBranch !== trunk) {
      const children = this.state.getChildren(currentBranch);
      for (const child of children) {
        if (child !== name) {
          const childRel = this.state.getBranchRelationship(child);
          if (childRel) {
            this.state.setBranchRelationship(child, {
              ...childRel,
              parent: name,
            });
          }
        }
      }
    }

    return {
      name,
      parent,
      commits,
      syncStatus: "pending",
      tracked: true,
    };
  }

  async getBranch(name: string): Promise<Branch | null> {
    const exists = await this.git.branchExists(name);
    if (!exists) return null;

    const rel = this.state.getBranchRelationship(name);
    const trunk = this.getTrunk();
    const parent = rel?.parent ?? trunk;

    const commits = await this.git.getCommitsBetween(parent, name);
    const syncStatus = await this.git.getBranchSyncStatus(name);

    return {
      name,
      parent,
      commits,
      syncStatus,
      tracked: !!rel,
      prNumber: rel?.prNumber,
      prUrl: rel?.prUrl,
    };
  }

  async getStack(branchName?: string): Promise<Stack> {
    const current = branchName ?? (await this.git.getCurrentBranch());
    const trunk = this.getTrunk();
    const branches: Branch[] = [];

    // Walk up from current to trunk to get the stack
    let branch = current;
    while (branch && branch !== trunk) {
      const branchData = await this.getBranch(branch);
      if (branchData) {
        branches.unshift(branchData);
      }
      const parent = this.state.getParent(branch);
      branch = parent ?? "";
    }

    return {
      id: current,
      branches,
      trunk,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async getStackTree(branchName?: string): Promise<StackNode | null> {
    const current = branchName ?? (await this.git.getCurrentBranch());
    const currentBranch = await this.git.getCurrentBranch();

    const buildTree = async (name: string, depth: number): Promise<StackNode | null> => {
      const branch = await this.getBranch(name);
      if (!branch) return null;

      const children = this.state.getChildren(name);
      const childNodes: StackNode[] = [];

      for (const childName of children) {
        const childNode = await buildTree(childName, depth + 1);
        if (childNode) {
          childNodes.push(childNode);
        }
      }

      return {
        branch,
        children: childNodes,
        depth,
        isCurrentBranch: name === currentBranch,
      };
    };

    return buildTree(current, 0);
  }

  async restack(branchName?: string): Promise<{ success: boolean; conflicts: boolean }> {
    const current = branchName ?? (await this.git.getCurrentBranch());
    const parent = this.state.getParent(current);

    if (!parent) {
      return { success: true, conflicts: false };
    }

    // Get the stored base commit (parent's commit when branch was created/last synced)
    const oldBase = this.state.getBaseCommit(current);
    const newParentCommit = await this.git.getCommitHash(parent);

    let result: { success: boolean; conflicts: boolean };

    // Check if we can use smart rebase with --onto
    const canUseOnto = oldBase &&
      oldBase !== newParentCommit &&
      await this.git.commitExists(oldBase);

    if (canUseOnto) {
      // Use --onto rebase to avoid reapplying commits already in parent
      // git rebase --onto <newParent> <oldBase> <branch>
      result = await this.git.rebaseOnto(parent, oldBase, current);
    } else {
      // Fall back to simple rebase
      await this.git.checkout(current);
      result = await this.git.rebase(parent);
    }

    // Update the base commit after successful rebase
    if (result.success) {
      this.state.setBaseCommit(current, newParentCommit);
    }

    return result;
  }

  async restackUpstream(
    branchName?: string
  ): Promise<Array<{ branch: string; success: boolean; conflicts: boolean }>> {
    const current = branchName ?? (await this.git.getCurrentBranch());
    const results: Array<{ branch: string; success: boolean; conflicts: boolean }> = [];

    // Restack current branch first
    const currentResult = await this.restack(current);
    results.push({ branch: current, ...currentResult });

    if (!currentResult.success) {
      return results;
    }

    // Then restack all children recursively
    const children = this.state.getChildren(current);
    for (const child of children) {
      const childResults = await this.restackUpstream(child);
      results.push(...childResults);
      if (childResults.some((r) => !r.success)) {
        break;
      }
    }

    return results;
  }

  async navigateUp(steps = 1): Promise<string | null> {
    const current = await this.git.getCurrentBranch();
    const children = this.state.getChildren(current);

    if (children.length === 0) {
      return null;
    }

    // Navigate to the first child
    let target = children[0];
    for (let i = 1; i < steps; i++) {
      const nextChildren = this.state.getChildren(target);
      if (nextChildren.length === 0) break;
      target = nextChildren[0];
    }

    await this.git.checkout(target);
    return target;
  }

  async navigateDown(steps = 1): Promise<string | null> {
    const current = await this.git.getCurrentBranch();
    const trunk = this.getTrunk();

    let target = current;
    for (let i = 0; i < steps; i++) {
      const parent = this.state.getParent(target);
      if (!parent || parent === trunk) {
        if (i === 0) {
          // Already at trunk level
          return null;
        }
        break;
      }
      target = parent;
    }

    if (target === current) {
      return null;
    }

    await this.git.checkout(target);
    return target;
  }

  async navigateToTop(): Promise<string | null> {
    const current = await this.git.getCurrentBranch();
    let target = current;

    while (true) {
      const children = this.state.getChildren(target);
      if (children.length === 0) break;
      target = children[0];
    }

    if (target === current) {
      return null;
    }

    await this.git.checkout(target);
    return target;
  }

  async navigateToBottom(): Promise<string | null> {
    const current = await this.git.getCurrentBranch();
    const trunk = this.getTrunk();

    // Find the bottom of the stack (first branch off trunk)
    let target = current;
    while (true) {
      const parent = this.state.getParent(target);
      if (!parent || parent === trunk) break;
      target = parent;
    }

    if (target === current) {
      // Check if we should go to trunk
      const parent = this.state.getParent(current);
      if (parent === trunk) {
        await this.git.checkout(trunk);
        return trunk;
      }
      return null;
    }

    await this.git.checkout(target);
    return target;
  }

  async deleteBranch(branchName: string, force = false): Promise<void> {
    // Remove from tracking first
    this.state.removeBranchRelationship(branchName);

    // Then delete the git branch
    await this.git.deleteBranch(branchName, force);
  }

  async trackBranch(branchName: string, parent?: string): Promise<void> {
    const trunk = this.getTrunk();
    const current = await this.git.getCurrentBranch();

    this.state.setBranchRelationship(branchName, {
      name: branchName,
      parent: parent ?? (branchName === current ? trunk : current),
    });
  }

  async untrackBranch(branchName: string): Promise<void> {
    this.state.removeBranchRelationship(branchName);
  }

  setPRInfo(branchName: string, prNumber: number, prUrl?: string): void {
    const rel = this.state.getBranchRelationship(branchName);
    if (rel) {
      this.state.setBranchRelationship(branchName, {
        ...rel,
        prNumber,
        prUrl,
      });
    }
  }

  getAllTrackedBranches(): string[] {
    return this.state.getAllTrackedBranches();
  }

  /**
   * Get all root branches (branches whose parent is trunk)
   */
  getRootBranches(): string[] {
    const trunk = this.getTrunk();
    const allBranches = this.getAllTrackedBranches();
    return allBranches.filter((b) => this.state.getParent(b) === trunk);
  }

  /**
   * Get all stack trees (one for each root branch)
   */
  async getAllStackTrees(): Promise<StackNode[]> {
    const roots = this.getRootBranches();
    const currentBranch = await this.git.getCurrentBranch();
    const trees: StackNode[] = [];

    const buildTree = async (name: string, depth: number): Promise<StackNode | null> => {
      const branch = await this.getBranch(name);
      if (!branch) return null;

      const children = this.state.getChildren(name);
      const childNodes: StackNode[] = [];

      for (const childName of children) {
        const childNode = await buildTree(childName, depth + 1);
        if (childNode) {
          childNodes.push(childNode);
        }
      }

      return {
        branch,
        children: childNodes,
        depth,
        isCurrentBranch: name === currentBranch,
      };
    };

    for (const root of roots) {
      const tree = await buildTree(root, 0);
      if (tree) {
        trees.push(tree);
      }
    }

    return trees;
  }

  /**
   * Sync the entire stack:
   * 1. Fetch from remote
   * 2. Update trunk with latest changes
   * 3. Restack all branches from trunk
   */
  async syncStack(): Promise<{
    fetched: boolean;
    trunkUpdated: boolean;
    restacked: Array<{ branch: string; success: boolean; conflicts: boolean }>;
    error?: string;
  }> {
    const trunk = this.getTrunk();
    const currentBranch = await this.git.getCurrentBranch();

    try {
      // Fetch from remote
      await this.git.fetch(true);
      const fetched = true;

      // Update trunk
      let trunkUpdated = false;
      try {
        await this.git.checkout(trunk);
        await this.git.pull(trunk);
        trunkUpdated = true;
      } catch {
        // Trunk might not have a remote
      }

      // Get all root branches and restack them
      const roots = this.getRootBranches();
      const restacked: Array<{ branch: string; success: boolean; conflicts: boolean }> = [];

      for (const root of roots) {
        const results = await this.restackUpstream(root);
        restacked.push(...results);

        // Stop if we hit a conflict
        if (results.some((r) => r.conflicts)) {
          break;
        }
      }

      // Go back to original branch if possible
      try {
        await this.git.checkout(currentBranch);
      } catch {
        // Branch might have been affected by conflicts
      }

      return { fetched, trunkUpdated, restacked };
    } catch (error) {
      return {
        fetched: false,
        trunkUpdated: false,
        restacked: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get all branches that need to be restacked in order (depth-first from roots)
   */
  getBranchesToRestack(): string[] {
    const branches: string[] = [];
    const roots = this.getRootBranches();

    const collectBranches = (branch: string) => {
      branches.push(branch);
      const children = this.state.getChildren(branch);
      for (const child of children) {
        collectBranches(child);
      }
    };

    for (const root of roots) {
      collectBranches(root);
    }

    return branches;
  }

  /**
   * Check if there's a restack in progress
   */
  hasRestackInProgress(): boolean {
    return this.state.hasRestackInProgress();
  }

  /**
   * Get the current restack state
   */
  getRestackState(): RestackState | null {
    return this.state.getRestackState();
  }

  /**
   * Get branches to restack for the stack containing the given branch
   */
  getBranchesToRestackForStack(branchName: string): string[] {
    const trunk = this.getTrunk();

    // Walk up to find the root of this branch's stack
    let root = branchName;
    while (true) {
      const parent = this.state.getParent(root);
      if (!parent || parent === trunk) break;
      root = parent;
    }

    // If the branch is trunk or not tracked, return empty
    if (root === trunk || !this.state.getBranchRelationship(root)) {
      return [];
    }

    // Collect this root and all its descendants
    const branches: string[] = [];
    const collectBranches = (branch: string) => {
      branches.push(branch);
      const children = this.state.getChildren(branch);
      for (const child of children) {
        collectBranches(child);
      }
    };
    collectBranches(root);

    return branches;
  }

  /**
   * Start a new restack operation with state management
   * If onlyForBranch is provided, only restack the stack containing that branch
   */
  async startRestack(onlyForBranch?: string): Promise<RestackResult> {
    const currentBranch = await this.git.getCurrentBranch();
    const branches = onlyForBranch
      ? this.getBranchesToRestackForStack(onlyForBranch)
      : this.getBranchesToRestack();

    if (branches.length === 0) {
      return { success: true, completed: [], remaining: [] };
    }

    return this.restackBranches(branches, [], currentBranch);
  }

  /**
   * Continue a restack after conflict resolution
   */
  async continueRestack(): Promise<RestackResult> {
    const restackState = this.state.getRestackState();

    if (!restackState) {
      throw new Error("No restack in progress");
    }

    // Continue the current rebase
    const rebaseResult = await this.git.rebaseContinue();

    if (!rebaseResult.success) {
      // Still has conflicts
      return {
        success: false,
        completed: restackState.completedBranches,
        conflictBranch: restackState.conflictBranch,
        remaining: restackState.remainingBranches,
      };
    }

    // Update base commit for the branch that was being rebased
    const parent = this.state.getParent(restackState.conflictBranch);
    if (parent) {
      const newParentCommit = await this.git.getCommitHash(parent);
      this.state.setBaseCommit(restackState.conflictBranch, newParentCommit);
    }

    // Add to completed
    const completed = [...restackState.completedBranches, restackState.conflictBranch];

    // Clear state and continue with remaining branches
    this.state.clearRestackState();

    if (restackState.remainingBranches.length === 0) {
      // All done, go back to original branch
      if (restackState.originalBranch) {
        try {
          await this.git.checkout(restackState.originalBranch);
        } catch {
          // Branch might not exist
        }
      }
      return { success: true, completed, remaining: [] };
    }

    return this.restackBranches(
      restackState.remainingBranches,
      completed,
      restackState.originalBranch
    );
  }

  /**
   * Abort a restack in progress
   */
  async abortRestack(): Promise<void> {
    const restackState = this.state.getRestackState();

    if (!restackState) {
      throw new Error("No restack in progress");
    }

    // Abort the current rebase
    try {
      await this.git.rebaseAbort();
    } catch {
      // Rebase might not be in progress
    }

    // Go back to original branch
    if (restackState.originalBranch) {
      try {
        await this.git.checkout(restackState.originalBranch);
      } catch {
        // Branch might not exist
      }
    }

    // Clear state
    this.state.clearRestackState();
  }

  /**
   * Internal: restack a list of branches with state management
   */
  private async restackBranches(
    branches: string[],
    alreadyCompleted: string[],
    originalBranch?: string
  ): Promise<RestackResult> {
    const completed = [...alreadyCompleted];
    const remaining = [...branches];

    while (remaining.length > 0) {
      const branch = remaining.shift()!;

      const result = await this.restack(branch);

      if (result.conflicts) {
        // Save state for continue/abort
        this.state.saveRestackState({
          conflictBranch: branch,
          remainingBranches: remaining,
          completedBranches: completed,
          originalBranch,
        });

        return {
          success: false,
          completed,
          conflictBranch: branch,
          remaining,
        };
      }

      if (result.success) {
        completed.push(branch);
      }
    }

    // All done, go back to original branch
    if (originalBranch) {
      try {
        await this.git.checkout(originalBranch);
      } catch {
        // Branch might not exist
      }
    }

    return { success: true, completed, remaining: [] };
  }
}

export function createStackManager(git: GitOperations, state: StateManager): StackManager {
  return new StackManager(git, state);
}
