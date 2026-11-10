import { existsSync } from "node:fs";
import { Commit, SyncStatus } from "./schemas.js";
import { GitError, mapLimit, runGit } from "./exec.js";

export interface RebaseResult {
  success: boolean;
  conflicts: boolean;
}

/** Snapshot of every local and remote-tracking branch head, read in one git call. */
export interface RefSnapshot {
  /** Local branch name -> commit SHA */
  local: Map<string, string>;
  /** Remote-tracking ref without the `refs/remotes/` prefix (e.g. `origin/main`) -> commit SHA */
  remote: Map<string, string>;
}

const FIELD = "\x1f";
const RECORD = "\x1e";
const COMMIT_FORMAT = `--format=%H${FIELD}%s${FIELD}%an${FIELD}%aI${RECORD}`;

/** How many git processes may run at once for batched reads. */
const READ_CONCURRENCY = 8;

function parseCommits(output: string): Commit[] {
  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, message, author, date] = record.split(FIELD);
      return { hash, message, author, date };
    });
}

export interface CommitOptions {
  /** Run the commit hooks (default true); false is `git commit --no-verify`. */
  verify?: boolean;
}

export class GitOperations {
  private readonly cwd: string | undefined;
  private remote = "origin";
  private gitDir: string | null = null;

  /**
   * Called after git commands that rewrite `branch.<name>.*` config sections
   * (branch delete and rename), so cached pile state can be refreshed.
   */
  onConfigChanged?: () => void;

  constructor(repoPath?: string) {
    this.cwd = repoPath;
  }

  /** Remote used for push, fetch and sync status (defaults to `origin`). */
  get remoteName(): string {
    return this.remote;
  }

  setRemoteName(remote: string): void {
    this.remote = remote;
  }

  run(args: string[]): Promise<string> {
    return runGit(args, { cwd: this.cwd });
  }

  private async tryRun(args: string[]): Promise<string | null> {
    try {
      return await this.run(args);
    } catch (error) {
      if (error instanceof GitError) return null;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Repository

  async isGitRepo(): Promise<boolean> {
    return (await this.tryRun(["rev-parse", "--is-inside-work-tree"])) === "true";
  }

  async initRepo(): Promise<void> {
    await this.run(["init"]);
  }

  async createInitialCommit(branchName = "main"): Promise<void> {
    await this.run(["checkout", "-b", branchName]);
    await this.run(["commit", "--allow-empty", "-m", "Initial commit"]);
  }

  async getRepoRoot(): Promise<string> {
    return this.run(["rev-parse", "--show-toplevel"]);
  }

  /** Absolute path of the common git directory (shared by all worktrees). */
  async getGitDir(): Promise<string> {
    if (!this.gitDir) {
      this.gitDir = await this.run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    }
    return this.gitDir;
  }

  async getRemote(): Promise<string | null> {
    return this.tryRun(["remote", "get-url", this.remote]);
  }

  // ---------------------------------------------------------------------------
  // Branches and refs

  async getCurrentBranch(): Promise<string> {
    const branch = await this.tryRun(["symbolic-ref", "--short", "-q", "HEAD"]);
    return branch || "HEAD";
  }

  async getRefs(): Promise<RefSnapshot> {
    const output = await this.run([
      "for-each-ref",
      `--format=%(refname)${FIELD}%(objectname)${FIELD}%(symref)`,
      "refs/heads",
      "refs/remotes",
    ]);
    const local = new Map<string, string>();
    const remote = new Map<string, string>();
    for (const line of output.split("\n")) {
      if (!line) continue;
      const [ref, sha, symref] = line.split(FIELD);
      if (symref) continue; // e.g. refs/remotes/origin/HEAD
      if (ref.startsWith("refs/heads/")) {
        local.set(ref.slice("refs/heads/".length), sha);
      } else if (ref.startsWith("refs/remotes/")) {
        remote.set(ref.slice("refs/remotes/".length), sha);
      }
    }
    return { local, remote };
  }

  async getAllBranches(): Promise<string[]> {
    return [...(await this.getRefs()).local.keys()];
  }

  async getRemoteBranches(): Promise<string[]> {
    return [...(await this.getRefs()).remote.keys()];
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.tryRun(["rev-parse", "--verify", "-q", `refs/heads/${branch}`])) !== null;
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    await this.run(["checkout", "-b", name, ...(startPoint ? [startPoint] : [])]);
  }

  async checkout(branch: string): Promise<void> {
    await this.run(["switch", branch]);
  }

  async deleteBranch(branch: string, force = false): Promise<void> {
    await this.run(["branch", force ? "-D" : "-d", branch]);
    this.onConfigChanged?.();
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.run(["branch", "-m", oldName, newName]);
    this.onConfigChanged?.();
  }

  async deleteRemoteBranch(branch: string, remote = this.remote): Promise<void> {
    await this.run(["push", remote, "--delete", branch]);
  }

  async getCommitHash(ref: string): Promise<string> {
    return this.run(["rev-parse", "--verify", `${ref}^{commit}`]);
  }

  async commitExists(hash: string): Promise<boolean> {
    return (await this.tryRun(["cat-file", "-e", `${hash}^{commit}`])) !== null;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await this.tryRun(["merge-base", "--is-ancestor", ancestor, descendant])) !== null;
  }

  async getMergeBase(ref1: string, ref2: string): Promise<string | null> {
    return this.tryRun(["merge-base", ref1, ref2]);
  }

  /**
   * Find the likely parent branch by checking merge-base with candidates.
   * Returns the branch with the fewest commits between the merge-base and `branch`.
   */
  async findLikelyParent(branch: string, candidates: string[]): Promise<string | null> {
    const distances = await mapLimit(
      candidates.filter((c) => c !== branch),
      READ_CONCURRENCY,
      async (candidate) => {
        const mergeBase = await this.getMergeBase(branch, candidate);
        if (!mergeBase) return { candidate, distance: Infinity };
        return { candidate, distance: await this.getCommitCount(mergeBase, branch) };
      },
    );
    const best = distances.reduce<{ candidate: string; distance: number } | null>(
      (min, d) => (d.distance < (min?.distance ?? Infinity) ? d : min),
      null,
    );
    return best?.candidate ?? null;
  }

  // ---------------------------------------------------------------------------
  // Commits

  async getBranchCommits(branch: string, since?: string): Promise<Commit[]> {
    const range = since ? `${since}..${branch}` : branch;
    const output = await this.tryRun(["log", COMMIT_FORMAT, range, "--"]);
    return output ? parseCommits(output) : [];
  }

  async getCommitsBetween(base: string, head: string): Promise<Commit[]> {
    return this.getBranchCommits(head, base);
  }

  /** Commits for many `base..head` ranges, read in parallel. */
  async getCommitsForRanges(
    ranges: Array<{ base: string; head: string }>,
  ): Promise<Commit[][]> {
    return mapLimit(ranges, READ_CONCURRENCY, ({ base, head }) =>
      this.getCommitsBetween(base, head),
    );
  }

  async getCommitCount(from: string, to: string): Promise<number> {
    const output = await this.tryRun(["rev-list", "--count", `${from}..${to}`]);
    return output ? parseInt(output, 10) : 0;
  }

  async hasUncommittedChanges(): Promise<boolean> {
    return (await this.run(["status", "--porcelain"])).length > 0;
  }

  async getStagedFiles(): Promise<string[]> {
    const output = await this.run(["diff", "--cached", "--name-only", "-z"]);
    return output.split("\0").filter(Boolean);
  }

  async stageAll(): Promise<void> {
    await this.run(["add", "-A"]);
  }

  async stageUpdated(): Promise<void> {
    await this.run(["add", "-u"]);
  }

  async stageFiles(files: string[]): Promise<void> {
    if (files.length > 0) await this.run(["add", "--", ...files]);
  }

  async commit(message: string, options: CommitOptions = {}): Promise<string> {
    return (await this.commitWithOutput(message, options)).hash;
  }

  /**
   * Commits, running the repository's hooks (pre-commit, commit-msg) unless `verify` is
   * false, and returns what the hooks printed: git's own summary is quieted, so the
   * output is theirs.
   */
  async commitWithOutput(message: string, options: CommitOptions = {}): Promise<{ hash: string; output: string }> {
    const output = await runGit(["commit", "--quiet", ...(options.verify === false ? ["--no-verify"] : []), "-m", message], { cwd: this.cwd, both: true });
    return { hash: await this.getCommitHash("HEAD"), output: output.trim() };
  }

  async amendCommit(message?: string, options: CommitOptions = {}): Promise<string> {
    return (await this.amendCommitWithOutput(message, options)).hash;
  }

  async amendCommitWithOutput(message?: string, options: CommitOptions = {}): Promise<{ hash: string; output: string }> {
    const output = await runGit(
      ["commit", "--amend", "--quiet", ...(options.verify === false ? ["--no-verify"] : []), ...(message ? ["-m", message] : ["--no-edit"])],
      { cwd: this.cwd, both: true },
    );
    return { hash: await this.getCommitHash("HEAD"), output: output.trim() };
  }

  /** Squash all commits since `parent` into one, keeping the working tree as is. */
  async squashCommits(parent: string, message: string, options: CommitOptions = {}): Promise<string> {
    return (await this.squashCommitsWithOutput(parent, message, options)).hash;
  }

  async squashCommitsWithOutput(parent: string, message: string, options: CommitOptions = {}): Promise<{ hash: string; output: string }> {
    const mergeBase = await this.getMergeBase("HEAD", parent);
    if (!mergeBase) {
      throw new Error(`Could not find merge base with ${parent}`);
    }
    const before = await this.getCommitHash("HEAD");
    await this.run(["reset", "--soft", mergeBase]);
    try {
      return await this.commitWithOutput(message, options);
    } catch (error) {
      // A hook refused the commit: put the branch's commits back as they were.
      await this.run(["reset", "--soft", before]).catch(() => {});
      throw error;
    }
  }

  async stash(): Promise<void> {
    await this.run(["stash", "push"]);
  }

  async stashPop(): Promise<void> {
    await this.run(["stash", "pop"]);
  }

  async getDiffFiles(base: string, head: string): Promise<Array<{ path: string; status: string }>> {
    const output = await this.tryRun(["diff", "--name-status", "-z", `${base}...${head}`]);
    if (!output) return [];
    const parts = output.split("\0").filter(Boolean);
    const files: Array<{ path: string; status: string }> = [];
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++].charAt(0);
      // Renames and copies list the old path, then the new one.
      if (status === "R" || status === "C") i++;
      files.push({ status, path: parts[i++] });
    }
    return files;
  }

  // ---------------------------------------------------------------------------
  // Rebase

  async isRebaseInProgress(): Promise<boolean> {
    // Rebase state lives in the per-worktree git dir, so let git resolve the paths.
    const output = await this.run([
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "rebase-merge",
      "--git-path",
      "rebase-apply",
    ]);
    return output.split("\n").some((path) => existsSync(path));
  }

  private async runRebase(args: string[]): Promise<RebaseResult> {
    try {
      await this.run(["rebase", ...args]);
      return { success: true, conflicts: false };
    } catch (error) {
      if (error instanceof GitError && (await this.isRebaseInProgress())) {
        return { success: false, conflicts: true };
      }
      throw error;
    }
  }

  async rebase(onto: string): Promise<RebaseResult> {
    return this.runRebase([onto]);
  }

  /**
   * Replays `oldBase..branch` onto `newParent`, skipping commits already in the parent.
   * Equivalent to `git rebase --onto <newParent> <oldBase> <branch>`.
   */
  async rebaseOnto(newParent: string, oldBase: string, branch: string): Promise<RebaseResult> {
    return this.runRebase(["--onto", newParent, oldBase, branch]);
  }

  async rebaseContinue(): Promise<RebaseResult> {
    return this.runRebase(["--continue"]);
  }

  async rebaseAbort(): Promise<void> {
    await this.run(["rebase", "--abort"]);
  }

  // ---------------------------------------------------------------------------
  // Remote

  async fetch(prune = true): Promise<void> {
    await this.run(["fetch", ...(prune ? ["--prune"] : []), this.remote]);
  }

  /** Pulls with fast-forward only, so a diverged trunk is reported instead of merged. */
  async pull(branch?: string): Promise<void> {
    await this.run(["pull", "--ff-only", ...(branch ? [this.remote, branch] : [])]);
  }

  /**
   * Fast-forwards a local branch to its remote-tracking ref without checking it out.
   * Returns false when the branch has diverged (nothing is changed then).
   */
  async fastForward(branch: string): Promise<boolean> {
    const remoteRef = `refs/remotes/${this.remote}/${branch}`;
    const [local, remote] = await Promise.all([
      this.tryRun(["rev-parse", "--verify", "-q", `refs/heads/${branch}`]),
      this.tryRun(["rev-parse", "--verify", "-q", remoteRef]),
    ]);
    if (!local || !remote || local === remote) return true;
    if (!(await this.isAncestor(local, remote))) return false;

    if ((await this.getCurrentBranch()) === branch) {
      await this.run(["merge", "--ff-only", remoteRef]);
    } else {
      await this.run(["update-ref", `refs/heads/${branch}`, remote, local]);
    }
    return true;
  }

  async push(branch: string, force = false): Promise<void> {
    await this.pushMultiple([branch], force);
  }

  async pushSetUpstream(branch: string): Promise<void> {
    await this.run(["push", "-u", this.remote, branch]);
  }

  /** Pushes several branches in one git call. */
  async pushMultiple(branches: string[], force = false): Promise<void> {
    if (branches.length === 0) return;
    await this.run([
      "push",
      ...(force ? ["--force-with-lease"] : []),
      this.remote,
      ...branches.map((b) => `refs/heads/${b}:refs/heads/${b}`),
    ]);
  }

  async getBranchSyncStatus(branch: string, remote = this.remote): Promise<SyncStatus> {
    const [status] = await this.getSyncStatuses([branch], remote);
    return status;
  }

  /**
   * Sync status of many branches against the remote. Reads all refs in one call and
   * only counts ahead/behind for branches whose local and remote heads differ.
   */
  async getSyncStatuses(
    branches: string[],
    remote = this.remote,
    refs?: RefSnapshot,
  ): Promise<SyncStatus[]> {
    const snapshot = refs ?? (await this.getRefs());
    return mapLimit(branches, READ_CONCURRENCY, async (branch) => {
      const localSha = snapshot.local.get(branch);
      const remoteSha = snapshot.remote.get(`${remote}/${branch}`);
      if (!localSha || !remoteSha) return "pending";
      if (localSha === remoteSha) return "synced";

      const counts = await this.tryRun(["rev-list", "--left-right", "--count", `${localSha}...${remoteSha}`]);
      if (!counts) return "pending";
      const [ahead, behind] = counts.split(/\s+/).map(Number);
      if (ahead > 0 && behind === 0) return "ahead";
      if (ahead === 0 && behind > 0) return "behind";
      return "conflict";
    });
  }
}

export function createGitOperations(repoPath?: string): GitOperations {
  return new GitOperations(repoPath);
}
