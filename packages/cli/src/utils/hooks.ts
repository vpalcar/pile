import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandError } from "./output.js";

/** Lines hook runners print for steps that had nothing to do (lefthook's `(skip)` lines). */
const NOISE = /\(skip\)|no matching (staged )?files|^\s*[│┃|]?\s*$/i;
/** How many of the last meaningful lines a summary shows. */
const TAIL = 15;

/**
 * The useful part of what the hooks printed: the steps that failed (lefthook marks them
 * 🥊) and the last lines that aren't "skipped, nothing to do".
 */
export function summarizeHookOutput(output: string): { failed: string[]; tail: string[]; total: number } {
  const lines = output.split("\n").map((l) => l.trimEnd());
  const meaningful = lines.filter((l) => !NOISE.test(l));
  // In lefthook's summary a failed step is a line starting with 🥊 (its banner has one too,
  // inside the box, so only lines that start with it count).
  const failed = [...new Set(meaningful.flatMap((l) => l.match(/^\s*🥊\s*(.+)$/u)?.[1].trim() ?? []))];
  return { failed, tail: meaningful.slice(-TAIL), total: meaningful.length };
}

export interface HookContext {
  /** What was being done, for saying what state it left. */
  action: "create" | "modify";
  /** The branch you're on (create never left it). */
  branch: string;
  /** Print everything the hooks said instead of a summary. */
  verbose?: boolean;
  /** Where the full log is saved (`<git dir>/pile/last-hook.log`). */
  gitDir?: string | null;
}

/**
 * A commit refused by the repository's hooks (pre-commit, commit-msg), as a command
 * error: which steps failed and their last lines (all of it with --verbose), where the
 * full log is, and what state it left. Null for any other error.
 */
export function hookFailure(err: unknown, context?: HookContext): CommandError | null {
  const git = err as { args?: string[]; stdout?: string; stderr?: string };
  if (!Array.isArray(git?.args) || git.args[0] !== "commit") return null;
  const said = `${git.stdout ?? ""}${git.stderr ?? ""}`.trim();

  let logPath: string | null = null;
  if (context?.gitDir && said) {
    try {
      mkdirSync(join(context.gitDir, "pile"), { recursive: true });
      logPath = join(context.gitDir, "pile", "last-hook.log");
      writeFileSync(logPath, `${said}\n`);
    } catch {
      logPath = null;
    }
  }

  const { failed, tail, total } = summarizeHookOutput(said);
  const shown = context?.verbose ? said : `${total > tail.length ? `… (${total - tail.length} earlier lines)\n` : ""}${tail.join("\n")}`;
  const message = `A commit hook stopped the commit${failed.length ? ` (failed: ${failed.join(", ")})` : ""}${shown ? `:\n${shown}` : ""}`;

  const state =
    context?.action === "modify"
      ? `Nothing was committed: ${context.branch} keeps its commits.`
      : `No branch was created${context ? `; you're still on ${context.branch}` : ""}.`;
  const hint = [
    `${state} Your changes, including any fixes the hooks staged, are still staged.`,
    logPath && !context?.verbose ? `Full hook output: ${logPath} (or run again with --verbose).` : null,
    "Fix what it reports and run the command again, or skip the hooks with --no-verify.",
  ]
    .filter(Boolean)
    .join("\n");
  return { code: "HOOK_FAILED", message, hint, data: logPath ? { log: logPath, failed } : { failed } };
}
