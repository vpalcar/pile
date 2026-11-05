import { describe, expect, it } from "vitest";
import { resolveOptions } from "../src/utils/output.js";
import { createCliRepo } from "./helpers.js";

describe("global options", () => {
  it("is never interactive with --json, --no-interactive, CI, or without a TTY", () => {
    const tty = process.stdin.isTTY && process.stdout.isTTY;
    expect(resolveOptions({ json: true }).interactive).toBe(false);
    expect(resolveOptions({ interactive: false }).interactive).toBe(false);
    expect(resolveOptions({}, { CI: "true" }).interactive).toBe(false);
    expect(resolveOptions({}, {}).interactive).toBe(!!tty);
    expect(resolveOptions({ yes: true }).yes).toBe(true);
  });
});

describe("pile commands", () => {
  it("describes every command, global option and exit code as JSON", () => {
    const repo = createCliRepo();
    const result = repo.pile(["commands", "--json"]);
    expect(result.code).toBe(0);

    const { commands, globalOptions, exitCodes } = result.json.data;
    const names = commands.map((c: { name: string }) => c.name);
    for (const name of ["up", "down", "top", "bottom", "track", "untrack", "status", "submit", "sync", "checkout"]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("wisdom");
    expect(globalOptions.map((o: { flags: string }) => o.flags)).toEqual(
      expect.arrayContaining(["--json", "--no-interactive", "-y, --yes"]),
    );
    expect(exitCodes).toHaveProperty("2");

    const status = commands.find((c: { name: string }) => c.name === "status");
    expect(status.arguments).toEqual([expect.objectContaining({ name: "target", required: false })]);
  });

  it("accepts global flags after the command name", () => {
    const repo = createCliRepo();
    const result = repo.pile(["log", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ currentBranch: "main", trunk: "main" });
  });
});

describe("non-interactive output", () => {
  it("never prints spinner frames or cursor escape codes when piped", () => {
    const repo = createCliRepo();
    repo.chain(["a", "b"]);
    const result = repo.pile(["log"]);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(result.stdout + result.stderr).not.toMatch(/\x1b\[\d*[AGK]/);
  });

  it("does not create a .pile directory in the work tree", () => {
    const repo = createCliRepo();
    repo.chain(["a"]);
    repo.pile(["log"]);
    repo.pile(["status", "--json"]);
    expect(repo.git("status", "--porcelain")).toBe("");
  });
});
