import { describe, expect, it } from "vitest";
import { createCliRepo } from "./helpers.js";

describe("pile diff", () => {
  it("diffs the current branch against its pile parent", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);

    const result = repo.pile(["diff", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toEqual({
      success: true,
      data: { branch: "b", parent: "a", files: [{ status: "A", path: "b.txt" }] },
    });
  });

  it("diffs a named branch without checking it out", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    repo.git("switch", "-q", "main");

    const result = repo.pile(["diff", "a", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.data).toEqual({ branch: "a", parent: "main", files: [{ status: "A", path: "a.txt" }] });
    expect(repo.git("branch", "--show-current")).toBe("main");
  });

  it("falls back to trunk for untracked branches", () => {
    const repo = createCliRepo();
    repo.git("switch", "-q", "-c", "loose");
    repo.commitFile("loose.txt", "x\n");

    expect(repo.pile(["diff", "--json"]).json.data.parent).toBe("main");
  });

  it("fails with BRANCH_NOT_FOUND for an unknown branch", () => {
    const repo = createCliRepo();
    const result = repo.pile(["diff", "nope", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ success: false, code: "BRANCH_NOT_FOUND" });
  });

  it("fails with ON_TRUNK on trunk without a target", () => {
    const repo = createCliRepo();
    const result = repo.pile(["diff", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ success: false, code: "ON_TRUNK" });
    expect(result.json.hint).toBeTruthy();
  });

  it("reports errors on stderr with exit code 1 without --json", () => {
    const repo = createCliRepo();
    const result = repo.pile(["diff", "nope"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Branch "nope" not found');
    expect(result.stdout.trim()).toBe("");
  });

  it("fails with NOT_INITIALIZED outside a pile repo", () => {
    const repo = createCliRepo({ init: false });
    const result = repo.pile(["diff", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ code: "NOT_INITIALIZED" });
  });
});

describe("GitHub PR commands without GitHub access", () => {
  // origin is a local path, so there is no GitHub repo to talk to.
  const commands: Array<[string, string[]]> = [
    ["status", ["status"]],
    ["close", ["close"]],
    ["edit", ["edit", "-t", "New title"]],
    ["request", ["request", "someone"]],
    ["merge", ["merge"]],
  ];

  for (const [name, args] of commands) {
    describe(`pile ${name}`, () => {
      it("fails with NO_GITHUB on a stacked branch", () => {
        const repo = createCliRepo();
        repo.chain(["a"]);
        const result = repo.pile([...args, "--json"]);
        expect(result.code).toBe(1);
        expect(result.json).toMatchObject({ success: false, code: "NO_GITHUB" });
        expect(result.json.hint).toMatch(/GITHUB_TOKEN|gh auth login/);
      });

      it("fails with ON_TRUNK on trunk without a target", () => {
        const repo = createCliRepo();
        const result = repo.pile([...args, "--json"]);
        expect(result.code).toBe(1);
        expect(result.json).toMatchObject({ code: "ON_TRUNK" });
      });

      it.each(["a", "42", "#42", "https://github.com/o/r/pull/42"])(
        "accepts target %s from trunk and gets as far as GitHub",
        (target) => {
          const repo = createCliRepo();
          repo.chain(["a"]);
          repo.git("switch", "-q", "main");
          // request takes reviewers positionally, so its target is --pr
          const withTarget =
            name === "request" ? [...args, "--pr", target] : [args[0], target, ...args.slice(1)];
          const result = repo.pile([...withTarget, "--json"]);
          expect(result.code).toBe(1);
          expect(result.json).toMatchObject({ code: "NO_GITHUB" });
        },
      );

      it("fails with NOT_INITIALIZED outside a pile repo", () => {
        const repo = createCliRepo({ init: false });
        const result = repo.pile([...args, "--json"]);
        expect(result.code).toBe(1);
        expect(result.json).toMatchObject({ code: "NOT_INITIALIZED" });
      });
    });
  }
});

describe("missing input never prompts", () => {
  it("request without reviewers exits with NEEDS_INPUT", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    const result = repo.pile(["request", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ success: false, code: "NEEDS_INPUT", data: { arg: "reviewers..." } });
  });

  it("edit without changes exits with NEEDS_INPUT", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    const result = repo.pile(["edit", "--json"]);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ code: "NEEDS_INPUT" });
    expect(result.json.data.flag).toContain("--title");
  });

  it("edit -b without a value needs a terminal for the editor", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    const result = repo.pile(["edit", "-b"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--body");
  });

  it("edit rejects --draft together with --ready", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    const result = repo.pile(["edit", "--draft", "--ready", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ code: "INVALID_ARGS" });
  });
});
