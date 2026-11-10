import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookFailure, summarizeHookOutput } from "../src/utils/hooks.js";

// What lefthook printed when Biome reformatted a file and fail_on_changes stopped the commit.
const lefthook = [
  "╭───────────────────────────────────────╮",
  "│ 🥊 lefthook v1.11.0  hook: pre-commit │",
  "╰───────────────────────────────────────╯",
  ...Array.from({ length: 100 }, (_, i) => `│  Step ${i} (skip) no matching staged files`),
  "┃  Lint and format ❯",
  "Formatted 1 file in 12ms. Fixed 1 file.",
  "summary: (done in 3.21 seconds)",
  "✔️ Secret scanning",
  "🥊 Lint and format",
  "Error: files were changed by the hook (fail_on_changes)",
].join("\n");

const failedCommit = () => Object.assign(new Error("git commit failed"), { args: ["commit", "--quiet", "-m", "x"], stdout: "", stderr: lefthook });

describe("hook failures", () => {
  it("drop the skipped steps and keep the failed ones and the end", () => {
    const { failed, tail } = summarizeHookOutput(lefthook);
    expect(failed).toEqual(["Lint and format"]);
    expect(tail.at(-1)).toBe("Error: files were changed by the hook (fail_on_changes)");
    expect(tail.some((l) => l.includes("(skip)"))).toBe(false);
    expect(tail.length).toBeLessThanOrEqual(15);
  });

  it("say what failed, where the full log is, and the state it left", () => {
    const gitDir = mkdtempSync(join(tmpdir(), "pile-gitdir-"));
    const error = hookFailure(failedCommit(), { action: "create", branch: "main", gitDir })!;
    expect(error.message).toMatch(/^A commit hook stopped the commit \(failed: Lint and format\):/);
    expect(error.message).toContain("fail_on_changes");
    expect(error.message).not.toContain("(skip)");
    expect(error.hint).toContain("No branch was created; you're still on main. Your changes, including any fixes the hooks staged, are still staged.");
    expect(error.hint).toContain(`Full hook output: ${join(gitDir, "pile", "last-hook.log")}`);
    expect(readFileSync(join(gitDir, "pile", "last-hook.log"), "utf8")).toContain("Step 99 (skip)");
  });

  it("print everything with --verbose, and say modify kept the commits", () => {
    const error = hookFailure(failedCommit(), { action: "modify", branch: "feature", verbose: true })!;
    expect(error.message).toContain("Step 99 (skip)");
    expect(error.hint).toContain("Nothing was committed: feature keeps its commits.");
  });
});
