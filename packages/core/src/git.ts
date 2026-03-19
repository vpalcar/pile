import simpleGit, { SimpleGit } from "simple-git";
import { Commit, SyncStatus } from "./schemas.js";

export class GitOperations {
  private git: SimpleGit;

  constructor(repoPath?: string) {
    this.git = simpleGit(repoPath);
  }

  async isGitRepo(): Promise<boolean> {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  async initRepo(): Promise<void> {
    await this.git.init();
  }

  async createInitialCommit(branchName = "main"): Promise<void> {
    // Create an empty initial commit
    await this.git.raw(["checkout", "-b", branchName]);
    await this.git.raw([
      "commit",
      "--allow-empty",
      "-m",
      "Initial commit",
    ]);
  }

  async getCurrentBranch(): Promise<string> {
    const result = await this.git.revparse(["--abbrev-ref", "HEAD"]);
    return result.trim();
  }

  async getAllBranches(): Promise<string[]> {
    const result = await this.git.branchLocal();
    return result.all;
  }

  async getRemoteBranches(): Promise<string[]> {
    const result = await this.git.branch(["-r"]);
    return result.all;
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    if (startPoint) {
      await this.git.checkoutBranch(name, startPoint);
    } else {
      await this.git.checkoutLocalBranch(name);
    }
  }

  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch);
  }

  async getBranchCommits(branch: string, since?: string): Promise<Commit[]> {
    const options: string[] = ["--format=%H|%s|%an|%aI"];
    if (since) {
      options.push(`${since}..${branch}`);
    } else {
      options.push(branch);
    }

    try {
      const result = await this.git.log(options);
      return result.all.map((log) => ({
        hash: log.hash,
        message: log.message,
        author: log.author_name,
        date: log.date,
      }));
    } catch {
      return [];
    }
  }

  async getCommitsBetween(base: string, head: string): Promise<Commit[]> {
    try {
      const result = await this.git.log([`${base}..${head}`]);
      return result.all.map((log) => ({
        hash: log.hash,
        message: log.message,
        author: log.author_name,
        date: log.date,
      }));
    } catch {
      return [];
    }
  }

  async rebase(onto: string): Promise<{ success: boolean; conflicts: boolean }> {
    try {
      await this.git.rebase([onto]);
      return { success: true, conflicts: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
        return { success: false, conflicts: true };
      }
      throw error;
    }
  }

  /**
   * Rebase using --onto to avoid reapplying commits already in the parent.
   * git rebase --onto <newParent> <oldBase> <branch>
   * This takes commits from oldBase..branch and replays them onto newParent.
   */
  async rebaseOnto(
    newParent: string,
    oldBase: string,
    branch: string
  ): Promise<{ success: boolean; conflicts: boolean }> {
    try {
      await this.git.rebase(["--onto", newParent, oldBase, branch]);
      return { success: true, conflicts: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
        return { success: false, conflicts: true };
      }
      throw error;
    }
  }

  async getCommitHash(ref: string): Promise<string> {
    const result = await this.git.revparse([ref]);
    return result.trim();
  }

  async commitExists(hash: string): Promise<boolean> {
    try {
      await this.git.catFile(["-t", hash]);
      return true;
    } catch {
      return false;
    }
  }

  async stash(): Promise<void> {
    await this.git.stash();
  }

  async stashPop(): Promise<void> {
    await this.git.stash(["pop"]);
  }

  /**
   * Find the merge-base (common ancestor) between two refs.
   * This is useful as a fallback when the stored base commit no longer exists.
   */
  async getMergeBase(ref1: string, ref2: string): Promise<string | null> {
    try {
      const result = await this.git.raw(["merge-base", ref1, ref2]);
      return result.trim();
    } catch {
      return null;
    }
  }

  async rebaseAbort(): Promise<void> {
    await this.git.rebase(["--abort"]);
  }

  async rebaseContinue(): Promise<{ success: boolean; conflicts: boolean }> {
    try {
      await this.git.rebase(["--continue"]);
      return { success: true, conflicts: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
        return { success: false, conflicts: true };
      }
      throw error;
    }
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.git.status();
    return !status.isClean();
  }

  async getStagedFiles(): Promise<string[]> {
    const status = await this.git.status();
    return status.staged;
  }

  async stageAll(): Promise<void> {
    await this.git.add("-A");
  }

  async stageUpdated(): Promise<void> {
    await this.git.add("-u");
  }

  async commit(message: string): Promise<string> {
    const result = await this.git.commit(message);
    return result.commit;
  }

  async amendCommit(message?: string): Promise<string> {
    const args = ["--amend"];
    if (message) {
      args.push("-m", message);
    } else {
      args.push("--no-edit");
    }
    const result = await this.git.commit(args);
    return result.commit;
  }

  /**
   * Squash all commits on the current branch since parent into a single commit.
   * Uses soft reset to parent and recommit.
   */
  async squashCommits(parent: string, message: string): Promise<string> {
    // Get the merge base with parent
    const mergeBase = await this.getMergeBase("HEAD", parent);
    if (!mergeBase) {
      throw new Error("Could not find merge base with parent");
    }

    // Soft reset to merge base (keeps all changes staged)
    await this.git.reset(["--soft", mergeBase]);

    // Commit with the new message
    const result = await this.git.commit(message);
    return result.commit;
  }

  /**
   * Get the number of commits between two refs.
   */
  async getCommitCount(from: string, to: string): Promise<number> {
    try {
      const result = await this.git.raw(["rev-list", "--count", `${from}..${to}`]);
      return parseInt(result.trim(), 10);
    } catch {
      return 0;
    }
  }

  async push(branch: string, force = false): Promise<void> {
    const args = force ? ["--force-with-lease"] : [];
    await this.git.push("origin", branch, args);
  }

  async pushSetUpstream(branch: string): Promise<void> {
    await this.git.push(["-u", "origin", branch]);
  }

  async fetch(prune = true): Promise<void> {
    const args = prune ? ["--prune"] : [];
    await this.git.fetch(args);
  }

  async pull(branch?: string): Promise<void> {
    if (branch) {
      await this.git.pull("origin", branch);
    } else {
      await this.git.pull();
    }
  }

  async getBranchSyncStatus(branch: string, remote = "origin"): Promise<SyncStatus> {
    try {
      const remoteBranch = `${remote}/${branch}`;

      // Check if remote branch exists
      const remoteBranches = await this.getRemoteBranches();
      if (!remoteBranches.includes(remoteBranch)) {
        return "pending";
      }

      // Get ahead/behind counts
      const result = await this.git.raw([
        "rev-list",
        "--left-right",
        "--count",
        `${branch}...${remoteBranch}`,
      ]);

      const [ahead, behind] = result.trim().split("\t").map(Number);

      if (ahead === 0 && behind === 0) {
        return "synced";
      } else if (ahead > 0 && behind === 0) {
        return "ahead";
      } else if (ahead === 0 && behind > 0) {
        return "behind";
      } else {
        return "conflict";
      }
    } catch {
      return "pending";
    }
  }

  async deleteBranch(branch: string, force = false): Promise<void> {
    await this.git.deleteLocalBranch(branch, force);
  }

  async deleteRemoteBranch(branch: string, remote = "origin"): Promise<void> {
    await this.git.push(remote, `:${branch}`);
  }

  async branchExists(branch: string): Promise<boolean> {
    const branches = await this.getAllBranches();
    return branches.includes(branch);
  }

  async getRemote(): Promise<string | null> {
    try {
      const result = await this.git.remote(["-v"]);
      if (!result) return null;
      const match = result.match(/origin\s+(\S+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async getRepoRoot(): Promise<string> {
    const result = await this.git.revparse(["--show-toplevel"]);
    return result.trim();
  }

  /**
   * Find the likely parent branch by checking merge-base with candidates.
   * Returns the branch with the closest common ancestor.
   */
  async findLikelyParent(branch: string, candidates: string[]): Promise<string | null> {
    if (candidates.length === 0) return null;

    let bestCandidate: string | null = null;
    let minDistance = Infinity;

    for (const candidate of candidates) {
      if (candidate === branch) continue;

      try {
        const mergeBase = await this.getMergeBase(branch, candidate);
        if (!mergeBase) continue;

        // Count commits between merge-base and branch head
        const result = await this.git.raw([
          "rev-list",
          "--count",
          `${mergeBase}..${branch}`,
        ]);
        const distance = parseInt(result.trim(), 10);

        if (distance < minDistance) {
          minDistance = distance;
          bestCandidate = candidate;
        }
      } catch {
        // Skip this candidate
      }
    }

    return bestCandidate;
  }
}

export function createGitOperations(repoPath?: string): GitOperations {
  return new GitOperations(repoPath);
}
