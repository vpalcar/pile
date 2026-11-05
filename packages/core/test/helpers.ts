import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { runGitSync } from "../src/exec.js";
import { createPile, PileInstance } from "../src/pile.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export interface TestRepo {
  dir: string;
  remoteDir: string;
  git(...args: string[]): string;
  /** Writes a file and commits it on the current branch. */
  commitFile(name: string, content: string, message?: string): string;
  pile(): Promise<PileInstance>;
}

/** A repo on `main` with one commit, an `origin` bare remote, and pile initialized. */
export function createTestRepo(): TestRepo {
  const remoteDir = tempDir("pile-remote-");
  runGitSync(["init", "--bare", "-q", "-b", "main", remoteDir]);

  const dir = tempDir("pile-repo-");
  const git = (...args: string[]) => runGitSync(args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Pile Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", remoteDir);
  git("config", "pile.initialized", "true");
  git("config", "pile.trunk", "main");
  git("config", "pile.remote", "origin");

  const commitFile = (name: string, content: string, message = `update ${name}`) => {
    writeFileSync(join(dir, name), content);
    git("add", name);
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };

  commitFile("README.md", "# test\n", "initial");
  git("push", "-q", "origin", "main");

  return { dir, remoteDir, git, commitFile, pile: () => createPile(dir) };
}

/**
 * Creates a linear chain of tracked branches on top of `parent`, each with one commit.
 * Leaves the last branch checked out.
 */
export async function createChain(repo: TestRepo, names: string[], parent = "main"): Promise<void> {
  const pile = await repo.pile();
  repo.git("switch", "-q", parent);
  for (const name of names) {
    await pile.stack.createBranch(name);
    repo.commitFile(`${name.replace(/\//g, "_")}.txt`, `${name}\n`, `add ${name}`);
  }
}
