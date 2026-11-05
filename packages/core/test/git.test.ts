import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitOperations } from "../src/git.js";
import { createTestRepo } from "./helpers.js";

describe("GitOperations", () => {
  it("snapshots local and remote refs, skipping symbolic refs", async () => {
    const repo = createTestRepo();
    repo.git("switch", "-q", "-c", "feature");
    repo.git("push", "-q", "origin", "feature");
    repo.git("remote", "set-head", "origin", "main");

    const refs = await createGitOperations(repo.dir).getRefs();
    expect([...refs.local.keys()].sort()).toEqual(["feature", "main"]);
    expect([...refs.remote.keys()].sort()).toEqual(["origin/feature", "origin/main"]);
  });

  it("reports sync status for many branches", async () => {
    const repo = createTestRepo();
    const git = createGitOperations(repo.dir);
    for (const name of ["synced", "ahead", "behind", "diverged", "local-only"]) {
      repo.git("switch", "-q", "-c", name, "main");
      repo.commitFile(`${name}.txt`, "1\n");
      if (name !== "local-only") repo.git("push", "-q", "origin", name);
    }
    repo.git("switch", "-q", "ahead");
    repo.commitFile("ahead.txt", "2\n");
    repo.git("switch", "-q", "behind");
    repo.git("reset", "-q", "--hard", "HEAD~1");
    repo.git("switch", "-q", "diverged");
    repo.git("reset", "-q", "--hard", "HEAD~1");
    repo.commitFile("other.txt", "x\n");

    const statuses = await git.getSyncStatuses(["synced", "ahead", "behind", "diverged", "local-only"]);
    expect(statuses).toEqual(["synced", "ahead", "behind", "conflict", "pending"]);
  });

  it("reads commits with separators in the subject", async () => {
    const repo = createTestRepo();
    repo.git("switch", "-q", "-c", "feature");
    repo.commitFile("a.txt", "a\n", "feat: a | b, with \"quotes\"");
    const commits = await createGitOperations(repo.dir).getCommitsBetween("main", "feature");
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ message: 'feat: a | b, with "quotes"', author: "Pile Test" });
  });

  it("detects rebase conflicts from git state, then continues without an editor", async () => {
    const repo = createTestRepo();
    const git = createGitOperations(repo.dir);
    repo.git("switch", "-q", "-c", "feature");
    repo.commitFile("README.md", "feature\n");
    repo.git("switch", "-q", "main");
    repo.commitFile("README.md", "main\n");

    const result = await git.rebaseOnto("main", repo.git("merge-base", "main", "feature"), "feature");
    expect(result).toEqual({ success: false, conflicts: true });
    expect(await git.isRebaseInProgress()).toBe(true);

    writeFileSync(join(repo.dir, "README.md"), "resolved\n");
    repo.git("add", "README.md");
    expect(await git.rebaseContinue()).toEqual({ success: true, conflicts: false });
    expect(await git.isRebaseInProgress()).toBe(false);
  });

  it("throws for rebase failures that are not conflicts", async () => {
    const repo = createTestRepo();
    await expect(createGitOperations(repo.dir).rebase("does-not-exist")).rejects.toThrow(/git rebase/);
  });

  it("fast-forwards a branch without checking it out, and refuses when diverged", async () => {
    const repo = createTestRepo();
    const git = createGitOperations(repo.dir);
    const before = repo.git("rev-parse", "main");

    // Advance origin/main from a second clone.
    repo.git("switch", "-q", "-c", "tmp");
    const advanced = repo.commitFile("new.txt", "x\n");
    repo.git("push", "-q", "origin", "tmp:main");
    repo.git("fetch", "-q", "origin");

    expect(await git.fastForward("main")).toBe(true);
    expect(repo.git("rev-parse", "main")).toBe(advanced);
    expect(await git.getCurrentBranch()).toBe("tmp");

    repo.git("update-ref", "refs/heads/main", before);
    repo.git("switch", "-q", "main");
    repo.commitFile("local.txt", "y\n");
    expect(await git.fastForward("main")).toBe(false);
  });

  it("lists renamed files by their new path", async () => {
    const repo = createTestRepo();
    repo.git("switch", "-q", "-c", "feature");
    repo.git("mv", "README.md", "DOCS.md");
    repo.git("commit", "-q", "-m", "rename");
    repo.commitFile("new file.txt", "x\n");

    const files = await createGitOperations(repo.dir).getDiffFiles("main", "feature");
    expect(files).toEqual(
      expect.arrayContaining([
        { status: "R", path: "DOCS.md" },
        { status: "A", path: "new file.txt" },
      ]),
    );
  });

  it("pushes several branches in one call", async () => {
    const repo = createTestRepo();
    const git = createGitOperations(repo.dir);
    repo.git("branch", "one");
    repo.git("branch", "two");
    await git.pushMultiple(["one", "two"]);
    expect(repo.git("ls-remote", "--heads", "origin")).toMatch(/refs\/heads\/one[\s\S]*refs\/heads\/two/);
  });
});
