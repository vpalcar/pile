import { GitOperations } from "./git.js";
import { StateManager, RestackState } from "./state.js";
import { Branch, Stack, StackNode } from "./schemas.js";

export type NavigationDirection = "up" | "down" | "top" | "bottom";

export interface NavigationPlan {
  /** Branch to check out, or null when there is nowhere to go (or a choice is needed). */
  target: string | null;
  /** Set when moving up reaches a branch with several children. */
  choices?: string[];
}

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
    return (await this.loadBranches([name])).get(name) ?? null;
  }

  /**
   * Loads branch details for many branches at once: one ref snapshot, then commit
   * ranges and sync statuses in parallel. Branches that don't exist locally are omitted.
   */
  async loadBranches(names: string[]): Promise<Map<string, Branch>> {
    const trunk = this.getTrunk();
    const refs = await this.git.getRefs();
    const existing = names.filter((name) => refs.local.has(name));
    const parents = existing.map((name) => this.state.getParent(name));

    const [commits, statuses] = await Promise.all([
      this.git.getCommitsForRanges(
        existing.map((name, i) => ({ base: parents[i] ?? trunk, head: name })),
      ),
      this.git.getSyncStatuses(existing, this.git.remoteName, refs),
    ]);

    const branches = new Map<string, Branch>();
    existing.forEach((name, i) => {
      const rel = this.state.getBranchRelationship(name);
      branches.set(name, {
        name,
        parent: parents[i] ?? trunk,
        commits: commits[i],
        syncStatus: statuses[i],
        tracked: !!rel,
        prNumber: rel?.prNumber,
        prUrl: rel?.prUrl,
      });
    });
    return branches;
  }

  /** Branch names from `branchName` down to (excluding) trunk, bottom first. */
  getAncestry(branchName: string): string[] {
    const trunk = this.getTrunk();
    const chain: string[] = [];
    const seen = new Set<string>();
    let branch: string | null = branchName;
    // `seen` guards against parent cycles in hand-edited or corrupted config.
    while (branch && branch !== trunk && !seen.has(branch)) {
      seen.add(branch);
      chain.unshift(branch);
      branch = this.state.getParent(branch);
    }
    return chain;
  }

  async getStack(branchName?: string): Promise<Stack> {
    const current = branchName ?? (await this.git.getCurrentBranch());
    const names = this.getAncestry(current);
    const loaded = await this.loadBranches(names);

    return {
      id: current,
      branches: names.map((name) => loaded.get(name)).filter((b): b is Branch => !!b),
      trunk: this.getTrunk(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /** Builds trees for the given roots from already-loaded branch data. */
  private buildTrees(roots: string[], branches: Map<string, Branch>, currentBranch: string): StackNode[] {
    const seen = new Set<string>();
    const build = (name: string, depth: number): StackNode | null => {
      const branch = branches.get(name);
      if (!branch || seen.has(name)) return null;
      seen.add(name);
      return {
        branch,
        children: this.state
          .getChildren(name)
          .map((child) => build(child, depth + 1))
          .filter((node): node is StackNode => !!node),
        depth,
        isCurrentBranch: name === currentBranch,
      };
    };
    return roots.map((root) => build(root, 0)).filter((node): node is StackNode => !!node);
  }

  /** All descendants of `branchName` (depth-first), including the branch itself. */
  getDescendants(branchName: string): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const visit = (branch: string) => {
      if (seen.has(branch)) return;
      seen.add(branch);
      result.push(branch);
      for (const child of this.state.getChildren(branch)) visit(child);
    };
    visit(branchName);
    return result;
  }

  async getStackTree(branchName?: string): Promise<StackNode | null> {
    const currentBranch = await this.git.getCurrentBranch();
    const root = branchName ?? currentBranch;
    const branches = await this.loadBranches(this.getDescendants(root));
    return this.buildTrees([root], branches, currentBranch)[0] ?? null;
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

    // Already on top of the parent: nothing to rebase.
    if (await this.git.isAncestor(newParentCommit, current)) {
      this.state.setBaseCommit(current, newParentCommit);
      return { success: true, conflicts: false };
    }

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

  /**
   * Works out where a navigation would land without checking anything out.
   * Moving up stops at a branch with several children and reports them as `choices`,
   * so callers can ask (interactive) or require an explicit branch (non-interactive).
   */
  planNavigation(from: string, direction: NavigationDirection, steps = 1): NavigationPlan {
    const trunk = this.getTrunk();

    if (direction === "down" || direction === "bottom") {
      const ancestry = this.getAncestry(from);
      if (from === trunk || ancestry.length === 0) return { target: null };
      // ancestry is bottom-first and ends with `from`
      const index = ancestry.length - 1;
      if (direction === "bottom") {
        return { target: index === 0 ? trunk : ancestry[0] };
      }
      const targetIndex = index - steps;
      return { target: targetIndex < 0 ? trunk : ancestry[targetIndex] };
    }

    let target = from;
    const seen = new Set<string>([from]);
    for (let i = 0; direction === "top" || i < steps; i++) {
      const children = from === trunk && target === trunk
        ? this.getRootBranches()
        : this.state.getChildren(target);
      if (children.length === 0) break;
      if (children.length > 1) {
        return { target: target === from ? null : target, choices: children };
      }
      if (seen.has(children[0])) break;
      seen.add(children[0]);
      target = children[0];
    }
    return { target: target === from ? null : target };
  }

  private async navigate(direction: NavigationDirection, steps = 1): Promise<string | null> {
    const current = await this.git.getCurrentBranch();
    const plan = this.planNavigation(current, direction, steps);
    const target = plan.target ?? plan.choices?.[0] ?? null;
    if (!target) return null;
    await this.git.checkout(target);
    return target;
  }

  /** Checks out the child `steps` levels up; with several children, takes the first. */
  async navigateUp(steps = 1): Promise<string | null> {
    return this.navigate("up", steps);
  }

  async navigateDown(steps = 1): Promise<string | null> {
    return this.navigate("down", steps);
  }

  async navigateToTop(): Promise<string | null> {
    return this.navigate("top");
  }

  async navigateToBottom(): Promise<string | null> {
    return this.navigate("bottom");
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
    const [currentBranch, branches] = await Promise.all([
      this.git.getCurrentBranch(),
      this.loadBranches(this.getAllTrackedBranches()),
    ]);
    return this.buildTrees(this.getRootBranches(), branches, currentBranch);
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

      // Update trunk without checking it out; a diverged trunk is left alone.
      const trunkUpdated = await this.git.fastForward(trunk);

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
    return this.getRootBranches().flatMap((root) => this.getDescendants(root));
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
    const root = this.getAncestry(branchName)[0] ?? trunk;

    // If the branch is trunk or not tracked, return empty
    if (root === trunk || !this.state.getBranchRelationship(root)) {
      return [];
    }

    return this.getDescendants(root);
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
