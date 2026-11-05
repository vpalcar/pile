import { describe, expect, it } from "vitest";
import { createCliRepo } from "./helpers.js";

const current = (repo: ReturnType<typeof createCliRepo>) => repo.git("branch", "--show-current");

describe("navigation: up / down / top / bottom", () => {
  it("moves through a linear stack", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b", "c"]);
    repo.git("switch", "-q", "a");

    expect(repo.pile(["up", "--json"]).json).toEqual({ success: true, data: { from: "a", to: "b", moved: true } });
    expect(current(repo)).toBe("b");

    expect(repo.pile(["top", "--json"]).json.data).toMatchObject({ from: "b", to: "c" });
    expect(repo.pile(["down", "2", "--json"]).json.data).toMatchObject({ from: "c", to: "a" });
    expect(repo.pile(["bottom", "--json"]).json.data).toMatchObject({ from: "a", to: "main" });
    expect(current(repo)).toBe("main");
  });

  it("reports when there is nowhere to go", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    const result = repo.pile(["up", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.data).toEqual({ from: "a", to: null, moved: false });
  });

  it("asks which child to follow at a fork, and follows --to", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    repo.chain(["b2", "c2"], "a");
    repo.git("switch", "-q", "a");

    const ask = repo.pile(["up", "--json"]);
    expect(ask.code).toBe(2);
    expect(ask.json).toMatchObject({ success: false, code: "NEEDS_INPUT", data: { flag: "--to", choices: ["b", "b2"] } });
    expect(current(repo)).toBe("a");

    expect(repo.pile(["up", "--to", "b2", "--json"]).json.data).toMatchObject({ to: "b2" });
    repo.git("switch", "-q", "a");
    expect(repo.pile(["top", "--to", "b2", "--json"]).json.data).toMatchObject({ to: "c2" });
  });

  it("fails with NEEDS_INPUT in plain text mode too, without hanging", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    repo.chain(["b2"], "a");
    repo.git("switch", "-q", "a");
    const result = repo.pile(["up"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--to");
  });
});

describe("track / untrack", () => {
  it("tracks with an explicit parent and sets the base commit", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    repo.git("switch", "-q", "-c", "feature");
    repo.commitFile("f.txt", "f\n");

    const result = repo.pile(["track", "--parent", "a", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ branch: "feature", parent: "a", detected: false });
    expect(repo.git("config", "branch.feature.pile-parent")).toBe("a");
    expect(repo.git("config", "branch.feature.pile-base")).toBe(repo.git("rev-parse", "a"));
  });

  it("detects the parent when none is given", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    repo.git("switch", "-q", "-c", "on-a");
    repo.commitFile("x.txt", "x\n");
    repo.git("switch", "-q", "-c", "on-main", "main");
    repo.commitFile("y.txt", "y\n");

    expect(repo.pile(["track", "on-a", "--json"]).json.data).toMatchObject({ parent: "a", detected: true });
    expect(repo.pile(["track", "on-main", "--json"]).json.data).toMatchObject({ parent: "main", detected: true });
  });

  it("rejects trunk, missing and already tracked branches", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    expect(repo.pile(["track", "main", "--json"]).json.code).toBe("ON_TRUNK");
    expect(repo.pile(["track", "nope", "--json"]).json.code).toBe("BRANCH_NOT_FOUND");
    const again = repo.pile(["track", "a", "--json"]);
    expect(again.code).toBe(1);
    expect(again.json.code).toBe("ALREADY_TRACKED");
  });

  it("untracks and moves children onto the parent", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b", "c"]);

    const result = repo.pile(["untrack", "b", "--json"]);
    expect(result.json.data).toEqual({ branch: "b", newParent: "a", reparented: ["c"] });
    expect(repo.git("config", "branch.c.pile-parent")).toBe("a");
    expect(repo.git("config", "branch.c.pile-title")).toBe("add c");
    expect(repo.pile(["untrack", "b", "--json"]).json.code).toBe("NOT_TRACKED");
  });
});
