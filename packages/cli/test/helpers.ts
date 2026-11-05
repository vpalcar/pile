import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach } from "vitest";

/** Built CLI under test. Override with PILE_BIN to test another build output. */
export const PILE_BIN = process.env.PILE_BIN ?? resolve(__dirname, "../dist/bin/pile.js");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function gitIn(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.replace(/\n$/, "");
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON, when it is JSON. */
  json: any;
}

export interface CliRepo {
  dir: string;
  remoteDir: string;
  git(...args: string[]): string;
  commitFile(name: string, content: string, message?: string): string;
  writeFile(name: string, content: string): void;
  /** Runs the CLI without a TTY (so it is non-interactive) and with no GitHub access. */
  pile(args: string[], options?: { input?: string; env?: NodeJS.ProcessEnv }): RunResult;
  /** Creates tracked branches in a chain on top of `parent`, each with one commit. */
  chain(names: string[], parent?: string): void;
}

/**
 * A repo on `main` with one commit, a local bare `origin` (so GitHub is never
 * contacted), and pile initialized.
 */
export function createCliRepo(options: { init?: boolean } = {}): CliRepo {
  const remoteDir = tempDir("pile-cli-remote-");
  gitIn(remoteDir, ["init", "--bare", "-q", "-b", "main"]);

  const dir = tempDir("pile-cli-repo-");
  const git = (...args: string[]) => gitIn(dir, args);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Pile Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", remoteDir);
  if (options.init !== false) {
    git("config", "pile.initialized", "true");
    git("config", "pile.trunk", "main");
    git("config", "pile.remote", "origin");
  }

  const writeFile = (name: string, content: string) => writeFileSync(join(dir, name), content);
  const commitFile = (name: string, content: string, message = `update ${name}`) => {
    writeFile(name, content);
    git("add", name);
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  commitFile("README.md", "# test\n", "initial");
  git("push", "-q", "origin", "main");

  const pile = (args: string[], runOptions: { input?: string; env?: NodeJS.ProcessEnv } = {}): RunResult => {
    const result = spawnSync(process.execPath, [PILE_BIN, ...args], {
      cwd: dir,
      encoding: "utf-8",
      input: runOptions.input ?? "",
      timeout: 30_000,
      env: {
        ...process.env,
        CI: "",
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        NO_COLOR: "1",
        ...runOptions.env,
      },
    });
    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      json = undefined;
    }
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
  };

  const chain = (names: string[], parent = "main") => {
    git("switch", "-q", parent);
    let current = parent;
    for (const name of names) {
      git("switch", "-q", "-c", name);
      git("config", `branch.${name}.pile-parent`, current);
      git("config", `branch.${name}.pile-base`, git("rev-parse", current));
      git("config", `branch.${name}.pile-title`, `add ${name}`);
      commitFile(`${name.replace(/\//g, "_")}.txt`, `${name}\n`, `add ${name}`);
      current = name;
    }
  };

  return { dir, remoteDir, git, commitFile, writeFile, pile, chain };
}
