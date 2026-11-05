import { describe, expect, it } from "vitest";
import { createCliRepo } from "./helpers.js";

describe("pile modify", () => {
  it("needs --all or --update for unstaged changes instead of prompting", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    repo.writeFile("a.txt", "changed\n");

    const result = repo.pile(["modify", "--amend", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ success: false, code: "NEEDS_INPUT" });
    expect(result.json.hint).toMatch(/--all/);
    expect(result.json.hint).toMatch(/--update/);

    // Same without --json: still no prompt, exit 2 with the hint on stderr
    const text = repo.pile(["modify", "--amend"]);
    expect(text.code).toBe(2);
    expect(text.stderr).toMatch(/--all/);
  });

  it("amends with --all", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    const before = repo.git("rev-parse", "HEAD");
    repo.writeFile("a.txt", "changed\n");

    const result = repo.pile(["modify", "--amend", "--all", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ success: true, data: { branch: "a" } });
    expect(repo.git("rev-parse", "HEAD")).not.toBe(before);
    expect(repo.git("rev-list", "--count", "main..a")).toBe("1");
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("squashes the branch's commits into one", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    repo.commitFile("a2.txt", "x\n");

    const result = repo.pile(["modify", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ branch: "a", squashed: 2 });
    expect(repo.git("rev-list", "--count", "main..a")).toBe("1");
    expect(repo.git("log", "-1", "--format=%s")).toBe("add a");
  });

  it("refuses to modify trunk with a stable code", () => {
    const repo = createCliRepo();
    const result = repo.pile(["modify", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ success: false, code: "ON_TRUNK" });
  });
});

describe("pile create", () => {
  it("needs --all or --update for unstaged changes", () => {
    const repo = createCliRepo();
    repo.writeFile("new.txt", "x\n");

    const result = repo.pile(["create", "feature", "-m", "Add feature", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ code: "NEEDS_INPUT", data: { flag: "--all" } });
    expect(repo.git("branch", "--list", "feature")).toBe("");
  });

  it("creates a tracked branch with --all", () => {
    const repo = createCliRepo();
    repo.writeFile("new file.txt", "x\n");

    const result = repo.pile(["create", "feature", "-m", "Add feature", "--all", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ success: true, data: { branch: "feature", parent: "main", commits: 1 } });
    expect(repo.git("config", "branch.feature.pile-parent")).toBe("main");
    expect(repo.git("config", "branch.feature.pile-title")).toBe("Add feature");
    expect(repo.git("log", "-1", "--format=%s")).toBe("Add feature");
  });

  it("reports NO_CHANGES when there is nothing to commit", () => {
    const repo = createCliRepo();
    const result = repo.pile(["create", "feature", "-m", "Nothing", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ code: "NO_CHANGES" });
  });

  it("inserts a branch between a branch and its children, restacking them", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    repo.git("switch", "-q", "a");
    repo.writeFile("mid.txt", "x\n");

    const result = repo.pile(["create", "mid", "-m", "Add mid", "--all", "--insert", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ branch: "mid", parent: "a", inserted: true });
    expect(repo.git("config", "branch.b.pile-parent")).toBe("mid");
    expect(repo.git("merge-base", "--is-ancestor", "mid", "b")).toBe("");
    expect(repo.git("rev-list", "--count", "mid..b")).toBe("1");
    expect(repo.git("branch", "--show-current")).toBe("mid");
  });
});

describe("pile add", () => {
  it("stages files with spaces and shell characters in their names", () => {
    const repo = createCliRepo();
    repo.writeFile("my file.txt", "x\n");
    repo.writeFile("weird $(name).txt", "y\n");
    repo.writeFile("untouched.txt", "z\n");

    const result = repo.pile(["add", "my file.txt", "weird $(name).txt", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.data.staged.sort()).toEqual(["my file.txt", "weird $(name).txt"]);
  });

  it("needs a terminal for --patch", () => {
    const repo = createCliRepo();
    repo.writeFile("README.md", "changed\n");
    const result = repo.pile(["add", "--patch", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ code: "NEEDS_INPUT" });
  });

  it("fails with a stable code for unknown paths", () => {
    const repo = createCliRepo();
    const result = repo.pile(["add", "missing.txt", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ success: false, code: "GIT_ERROR" });
  });
});

describe("pile init", () => {
  it("initializes from flags without prompting", () => {
    const repo = createCliRepo({ init: false });
    repo.git("remote", "add", "upstream", repo.remoteDir);

    const result = repo.pile(["init", "--trunk", "main", "--merge-method", "rebase", "--remote", "upstream", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      success: true,
      data: { trunk: "main", mergeMethod: "rebase", remote: "upstream" },
    });
    expect(repo.git("config", "pile.mergeMethod")).toBe("rebase");
    expect(repo.git("config", "pile.remote")).toBe("upstream");
  });

  it("initializes with defaults when there is no terminal", () => {
    const repo = createCliRepo({ init: false });
    const result = repo.pile(["init"]);
    expect(result.code).toBe(0);
    expect(repo.git("config", "pile.initialized")).toBe("true");
    expect(repo.git("config", "pile.trunk")).toBe("main");
  });

  it("rejects an invalid merge method and unknown remote", () => {
    const repo = createCliRepo({ init: false });
    const badMethod = repo.pile(["init", "--merge-method", "octopus", "--json"]);
    expect(badMethod.code).toBe(1);
    expect(badMethod.json).toMatchObject({ code: "INVALID_ARGUMENT" });

    const badRemote = repo.pile(["init", "--remote", "nope", "--json"]);
    expect(badRemote.code).toBe(1);
    expect(badRemote.json).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(badRemote.json.hint).toMatch(/origin/);
  });

  it("asks for --trunk when it can't be detected", () => {
    const repo = createCliRepo({ init: false });
    repo.git("branch", "-m", "main", "develop");
    repo.git("branch", "release");

    const result = repo.pile(["init", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({
      code: "NEEDS_INPUT",
      data: { flag: "--trunk", choices: ["develop", "release"] },
    });
  });

  it("updates settings passed as flags on an initialized repo", () => {
    const repo = createCliRepo();
    const result = repo.pile(["init", "--merge-method", "merge", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ alreadyInitialized: true, updated: true, mergeMethod: "merge" });
    expect(repo.git("config", "pile.mergeMethod")).toBe("merge");
  });
});

describe("pile restack", () => {
  function conflictedStack() {
    const repo = createCliRepo();
    repo.chain(["a", "b", "c"]);
    repo.git("switch", "-q", "b");
    repo.commitFile("a.txt", "changed in b\n");
    repo.git("switch", "-q", "a");
    repo.commitFile("a.txt", "changed in a\n");
    return repo;
  }

  it("reports a conflict with a code, then continues", () => {
    const repo = conflictedStack();

    const result = repo.pile(["restack", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({
      success: false,
      code: "RESTACK_CONFLICT",
      data: { conflictBranch: "b", completed: ["a"], remaining: ["c"] },
    });
    expect(result.json.hint).toMatch(/pile restack --continue/);

    const again = repo.pile(["restack", "--json"]);
    expect(again.json).toMatchObject({ code: "RESTACK_IN_PROGRESS" });

    repo.writeFile("a.txt", "resolved\n");
    repo.git("add", "a.txt");
    const continued = repo.pile(["restack", "--continue", "--json"]);
    expect(continued.code).toBe(0);
    expect(continued.json).toMatchObject({ success: true, data: { completed: ["a", "b", "c"] } });
    expect(repo.git("merge-base", "--is-ancestor", "b", "c")).toBe("");
  });

  it("aborts a conflicted restack", () => {
    const repo = conflictedStack();
    const bBefore = repo.git("rev-parse", "b");
    repo.pile(["restack", "--json"]);

    const aborted = repo.pile(["restack", "--abort", "--json"]);
    expect(aborted.code).toBe(0);
    expect(aborted.json).toMatchObject({ success: true, data: { aborted: true } });
    expect(repo.git("rev-parse", "b")).toBe(bBefore);

    const nothing = repo.pile(["restack", "--continue", "--json"]);
    expect(nothing.code).toBe(1);
    expect(nothing.json).toMatchObject({ code: "NO_RESTACK_IN_PROGRESS" });
  });
});

describe("pile sync", () => {
  it("fast-forwards trunk and restacks the current stack (no GitHub needed)", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    // Someone else pushes to main.
    repo.git("switch", "-q", "-c", "other", "main");
    const upstream = repo.commitFile("upstream.txt", "x\n");
    repo.git("push", "-q", "origin", "other:main");
    repo.git("switch", "-q", "b");
    repo.git("branch", "-D", "other");

    const result = repo.pile(["sync", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      success: true,
      data: {
        trunk: { name: "main", updated: true },
        restacked: { success: true, completed: ["a", "b"] },
        cleaned: [],
        cleanup: { deleted: [], skipped: [] },
      },
    });
    expect(repo.git("rev-parse", "main")).toBe(upstream);
    expect(repo.git("merge-base", "--is-ancestor", "main", "a")).toBe("");
    expect(repo.git("merge-base", "--is-ancestor", "a", "b")).toBe("");
    expect(repo.git("branch", "--show-current")).toBe("b");
  });

  it("reports restack conflicts with a code", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    repo.git("switch", "-q", "-c", "other", "main");
    repo.commitFile("a.txt", "upstream version\n");
    repo.git("push", "-q", "origin", "other:main");
    repo.git("switch", "-q", "a");
    repo.git("branch", "-D", "other");

    const result = repo.pile(["sync", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ code: "RESTACK_CONFLICT", data: { restacked: { conflictBranch: "a" } } });
  });
});

describe("pile submit", () => {
  it("fails with NO_GITHUB when the remote isn't GitHub", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    const result = repo.pile(["submit", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ success: false, code: "NO_GITHUB" });
    expect(result.json.hint).toBeTruthy();
  });

  it("refuses to submit trunk", () => {
    const repo = createCliRepo();
    const result = repo.pile(["submit", "--json"]);
    expect(result.json).toMatchObject({ code: "ON_TRUNK" });
  });
});
