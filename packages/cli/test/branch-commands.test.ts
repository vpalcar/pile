import { describe, expect, it } from "vitest";
import { createCliRepo } from "./helpers.js";

const current = (repo: ReturnType<typeof createCliRepo>) => repo.git("branch", "--show-current");

describe("checkout", () => {
  it("needs a branch when not interactive and lists the choices", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    const result = repo.pile(["checkout", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ code: "NEEDS_INPUT", data: { arg: "branch", choices: ["main", "a", "b"] } });

    const text = repo.pile(["co"]);
    expect(text.code).toBe(2);
    expect(text.stdout).not.toMatch(/⠋|\u001b\[/);
    expect(text.stderr).toContain("<branch>");
  });

  it("checks out a branch, and reports unknown branches", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    expect(repo.pile(["checkout", "a", "--json"]).json).toMatchObject({ success: true, data: { branch: "a" } });
    expect(current(repo)).toBe("a");

    const missing = repo.pile(["checkout", "nope", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.json.code).toBe("BRANCH_NOT_FOUND");
  });
});

describe("branches", () => {
  it("lists tracked and untracked branches without a terminal", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    repo.git("branch", "loose", "main");

    const json = repo.pile(["branches", "--json"]);
    expect(json.code).toBe(0);
    expect(json.json.data.branches).toEqual(
      expect.arrayContaining([
        { name: "main", tracked: true, parent: null, isCurrent: false, isTrunk: true },
        { name: "a", tracked: true, parent: "main", isCurrent: true, isTrunk: false },
        { name: "loose", tracked: false, parent: "main", isCurrent: false, isTrunk: false },
      ]),
    );

    const text = repo.pile(["branches"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("* a  (on main)");
    expect(text.stdout).toContain("loose  (untracked)");
  });
});

describe("move", () => {
  it("needs --onto when not interactive", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    repo.chain(["x"]);
    repo.git("switch", "-q", "b");
    const result = repo.pile(["move", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json.data).toMatchObject({ flag: "--onto" });
    expect(result.json.data.choices).toEqual(expect.arrayContaining(["main", "x"]));
    expect(result.json.data.choices).not.toContain("a");
  });

  it("moves only the branch's own commits and restacks descendants", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b", "c"]);
    repo.chain(["x"]);
    repo.git("switch", "-q", "b");

    const result = repo.pile(["move", "--onto", "x", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ branch: "b", from: "a", to: "x", childrenRestacked: ["c"] });
    expect(repo.git("rev-list", "--count", "x..b")).toBe("1");
    expect(repo.git("merge-base", "--is-ancestor", "b", "c")).toBe("");
    expect(repo.git("rev-list", "--count", "b..c")).toBe("1");
    expect(current(repo)).toBe("b");
  });

  it("rejects moving onto a descendant", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    repo.git("switch", "-q", "a");
    expect(repo.pile(["move", "--onto", "b", "--json"]).json.code).toBe("INVALID_TARGET");
  });
});

describe("log", () => {
  it("includes every stack as a tree", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    repo.chain(["x"]);
    repo.git("switch", "-q", "b");

    const result = repo.pile(["log", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.currentBranch).toBe("b");
    expect(result.json.branches.map((b: { name: string }) => b.name)).toEqual(["a", "b"]);
    expect(result.json.stacks).toEqual([
      {
        name: "a",
        parent: "main",
        prNumber: null,
        prUrl: null,
        commits: 1,
        syncStatus: "pending",
        isCurrent: false,
        children: [
          { name: "b", parent: "a", prNumber: null, prUrl: null, commits: 1, syncStatus: "pending", isCurrent: true, children: [] },
        ],
      },
      { name: "x", parent: "main", prNumber: null, prUrl: null, commits: 1, syncStatus: "pending", isCurrent: false, children: [] },
    ]);
  });
});

describe("delete", () => {
  it("deletes another branch without switching, reparenting children with --force", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b", "c"]);

    const blocked = repo.pile(["delete", "b", "--json"]);
    expect(blocked.code).toBe(1);
    expect(blocked.json).toMatchObject({ code: "HAS_CHILDREN", data: { children: ["c"] } });

    const result = repo.pile(["delete", "b", "--force", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ deleted: "b", reparented: ["c"], switchedTo: null, prClosed: false });
    expect(current(repo)).toBe("c");
    expect(repo.git("config", "branch.c.pile-parent")).toBe("a");
    expect(repo.git("branch", "--list", "b")).toBe("");
  });

  it("switches to the parent when deleting the current branch", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    const result = repo.pile(["delete", "--json"]);
    expect(result.json.data).toMatchObject({ deleted: "b", switchedTo: "a" });
    expect(current(repo)).toBe("a");
  });

  it("refuses trunk and unknown branches", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    expect(repo.pile(["delete", "main", "--json"]).json.code).toBe("ON_TRUNK");
    expect(repo.pile(["delete", "nope", "--json"]).json.code).toBe("BRANCH_NOT_FOUND");
  });
});

describe("rename", () => {
  it("keeps pile metadata and updates children", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    repo.git("config", "branch.a.pile-pr-number", "12");
    repo.git("switch", "-q", "a");

    const result = repo.pile(["rename", "renamed", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ oldName: "a", newName: "renamed", childrenUpdated: ["b"] });
    expect(current(repo)).toBe("renamed");
    expect(repo.git("config", "branch.renamed.pile-parent")).toBe("main");
    expect(repo.git("config", "branch.renamed.pile-title")).toBe("add a");
    expect(repo.git("config", "branch.renamed.pile-pr-number")).toBe("12");
    expect(repo.git("config", "branch.b.pile-parent")).toBe("renamed");
    expect(repo.git("config", "--local", "--list")).not.toMatch(/^branch\.a\./m);
  });

  it("refuses an existing name", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    expect(repo.pile(["rename", "a", "--json"]).json.code).toBe("BRANCH_EXISTS");
  });
});
