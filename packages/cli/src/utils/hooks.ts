import type { CommandError } from "./output.js";

/**
 * A commit refused by the repository's hooks (pre-commit, commit-msg), as a command
 * error that shows what the hook said; null for any other error.
 */
export function hookFailure(err: unknown): CommandError | null {
  const git = err as { args?: string[]; stdout?: string; stderr?: string };
  if (!Array.isArray(git?.args) || git.args[0] !== "commit") return null;
  const said = `${git.stdout ?? ""}${git.stderr ?? ""}`.trim();
  return {
    code: "HOOK_FAILED",
    message: `A commit hook stopped the commit${said ? `:\n${said}` : ""}`,
    hint: "Fix what it reports and run the command again, or skip the hooks with --no-verify. Your changes are still staged.",
  };
}
