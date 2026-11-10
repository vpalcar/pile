import { execFile, execFileSync } from "node:child_process";

/**
 * Every git invocation in pile goes through this module: arguments are passed as an
 * array (never through a shell), output is parsed in the C locale, and git never
 * blocks on an editor or a credential prompt.
 */

const GIT_ENV: NodeJS.ProcessEnv = {
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
};

const MAX_BUFFER = 64 * 1024 * 1024;

let callCount = 0;

/** Number of git processes spawned so far. Used by tests and `PILE_DEBUG`. */
export function getGitCallCount(): number {
  return callCount;
}

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(args: string[], exitCode: number | null, stdout: string, stderr: string) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    super(`git ${args.join(" ")} failed: ${detail}`);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export interface GitRunOptions {
  cwd?: string;
  /** Extra environment variables for this invocation. */
  env?: NodeJS.ProcessEnv;
  /** Strip the trailing newline (default true). */
  trim?: boolean;
  /** Resolve with stderr after stdout (hooks write to either). */
  both?: boolean;
}

function debug(args: string[]): void {
  if (process.env.PILE_DEBUG) {
    process.stderr.write(`[pile] git ${args.join(" ")}\n`);
  }
}

export function runGit(args: string[], options: GitRunOptions = {}): Promise<string> {
  callCount++;
  debug(args);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...GIT_ENV, ...options.env },
        maxBuffer: MAX_BUFFER,
        encoding: "utf-8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : null;
          reject(new GitError(args, code, stdout ?? "", stderr ?? ""));
          return;
        }
        const out = options.both ? `${stdout ?? ""}${stderr ?? ""}` : stdout;
        resolve(options.trim === false ? out : out.replace(/\n$/, ""));
      },
    );
  });
}

export function runGitSync(args: string[], options: GitRunOptions = {}): string {
  callCount++;
  debug(args);
  try {
    const stdout = execFileSync("git", args, {
      cwd: options.cwd,
      env: { ...process.env, ...GIT_ENV, ...options.env },
      maxBuffer: MAX_BUFFER,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return options.trim === false ? stdout : stdout.replace(/\n$/, "");
  } catch (error) {
    const err = error as { status?: number | null; stdout?: string; stderr?: string };
    throw new GitError(args, err.status ?? null, err.stdout ?? "", err.stderr ?? "");
  }
}

/** Runs async tasks with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
