import { Stack, StackStatusOutput, CommandResult, GitError } from "@pile/core";
import { PileGitHubError } from "@pile/github";

export interface OutputOptions {
  json: boolean;
  /**
   * Prompts and pickers are allowed. True only with a terminal on stdin and stdout,
   * and without --json, --no-interactive or CI. Commands that would prompt otherwise
   * fail with NEEDS_INPUT and name the flag or argument that answers the question.
   */
  interactive?: boolean;
  /** --yes: consent to destructive actions without a confirmation prompt. */
  yes?: boolean;
}

export interface GlobalFlags {
  json?: boolean;
  interactive?: boolean;
  yes?: boolean;
}

/**
 * Same rule Ink uses (is-in-ci): any CI, CONTINUOUS_INTEGRATION or CI_* variable,
 * even empty, unless CI is "0" or "false". Ink stops drawing live frames in CI, so
 * a prompt shown there would be invisible and the command would hang.
 */
export function isCI(env: NodeJS.ProcessEnv): boolean {
  if (env.CI === "0" || env.CI === "false") return false;
  return "CI" in env || "CONTINUOUS_INTEGRATION" in env || Object.keys(env).some((key) => key.startsWith("CI_"));
}

export function resolveOptions(flags: GlobalFlags, env = process.env): OutputOptions {
  const json = !!flags.json;
  const ci = isCI(env);
  return {
    json,
    interactive:
      flags.interactive !== false &&
      !json &&
      !ci &&
      !!process.stdin.isTTY &&
      !!process.stdout.isTTY,
    yes: !!flags.yes,
  };
}

/** Process exit codes. Agents can branch on these without parsing output. */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  /** A prompt would be needed; rerun with the argument or flag named in the error. */
  NEEDS_INPUT: 2,
} as const;

export interface CommandError {
  /** Stable, machine-readable error code, e.g. NOT_INITIALIZED, PR_NOT_FOUND, NEEDS_INPUT. */
  code: string;
  message: string;
  hint?: string;
  data?: unknown;
}

/** Extracts a code, message and hint from anything a command might throw. */
export function toCommandError(error: unknown): CommandError {
  if (error instanceof PileGitHubError) {
    return { code: error.code, message: error.message, hint: error.hint };
  }
  if (error instanceof GitError) {
    return { code: "GIT_ERROR", message: error.stderr.trim() || error.message };
  }
  const status = (error as { status?: number })?.status;
  if (typeof status === "number") {
    const message = error instanceof Error ? error.message : String(error);
    if (status === 401) {
      return { code: "GITHUB_AUTH", message, hint: "Run `gh auth login` or set GITHUB_TOKEN." };
    }
    return { code: `GITHUB_${status}`, message };
  }
  return { code: "ERROR", message: error instanceof Error ? error.message : String(error) };
}

/**
 * Prints an error (JSON envelope with --json, otherwise a line on stderr) and exits.
 * The JSON shape extends the success envelope: { success: false, error, code, hint, data }.
 */
export function exitWithError(
  options: OutputOptions,
  error: CommandError,
  exitCode: number = ExitCode.ERROR,
): never {
  if (options.json) {
    console.log(
      formatJson({
        success: false,
        error: error.message,
        code: error.code,
        ...(error.hint ? { hint: error.hint } : {}),
        ...(error.data !== undefined ? { data: error.data } : {}),
      }),
    );
  } else {
    process.stderr.write(`✗ ${error.message}\n`);
    if (error.hint) process.stderr.write(`  ${error.hint}\n`);
  }
  process.exit(exitCode);
}

export interface InputRequest {
  message: string;
  /** Positional argument that answers the question, e.g. "branch". */
  arg?: string;
  /** Flag that answers the question, e.g. "--onto". */
  flag?: string;
  /** Valid values, when the set is known. */
  choices?: string[];
}

/** Fails with NEEDS_INPUT (exit code 2) when a prompt is needed but not allowed. */
export function exitNeedsInput(options: OutputOptions, request: InputRequest): never {
  const how = request.flag ?? (request.arg ? `<${request.arg}>` : undefined);
  const choices = request.choices?.length
    ? ` Choices: ${request.choices.slice(0, 20).join(", ")}${request.choices.length > 20 ? ", …" : ""}`
    : "";
  return exitWithError(
    options,
    {
      code: "NEEDS_INPUT",
      message: request.message,
      hint: `${how ? `Pass ${how}.` : "Run in an interactive terminal."}${choices}`,
      data: { arg: request.arg, flag: request.flag, choices: request.choices },
    },
    ExitCode.NEEDS_INPUT,
  );
}

export function formatJson<T>(data: T): string {
  return JSON.stringify(data, null, 2);
}

export function stackToJson(
  stack: Stack | null,
  currentBranch: string,
  pendingOps: number,
  isOnline = true
): StackStatusOutput {
  if (!stack) {
    return {
      branches: [],
      currentBranch,
      trunk: "main",
      hasConflicts: false,
      pendingOperations: pendingOps,
      isOffline: !isOnline,
    };
  }

  return {
    branches: stack.branches.map((b) => ({
      name: b.name,
      parent: b.parent,
      pr: b.prNumber ?? null,
      prUrl: b.prUrl ?? null,
      status: null, // Would be populated from GitHub API
      reviews: 0, // Would be populated from GitHub API
      isCurrent: b.name === currentBranch,
    })),
    currentBranch,
    trunk: stack.trunk,
    hasConflicts: stack.branches.some((b) => b.syncStatus === "conflict"),
    pendingOperations: pendingOps,
    isOffline: !isOnline,
  };
}

export function createResult<T>(
  success: boolean,
  data?: T,
  error?: string,
  message?: string
): CommandResult<T> {
  return {
    success,
    data,
    error,
    message,
  };
}

export function outputResult<T>(
  result: CommandResult<T>,
  options: OutputOptions
): void {
  if (options.json) {
    console.log(formatJson(result));
  }
}
