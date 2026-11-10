import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPile } from "@pile/core";
import { createCliRepo } from "./helpers.js";

const hook = (dir: string, script: string) => {
  const path = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
};

describe("commit hooks", () => {
  it("run on create, and what they print comes back", async () => {
    const repo = createCliRepo();
    hook(repo.dir, 'echo "lint: ok"');
    repo.writeFile("a.txt", "a");
    repo.git("add", "a.txt");
    const pile = await createPile(repo.dir);
    const branch = await pile.stack.createBranch("feature", "Add a");
    expect(branch.hookOutput).toBe("lint: ok");
  });

  it("a hook that refuses leaves you where you were, changes still staged", async () => {
    const repo = createCliRepo();
    hook(repo.dir, 'echo "secret found"; exit 1');
    repo.writeFile("a.txt", "a");
    repo.git("add", "a.txt");
    const pile = await createPile(repo.dir);
    await expect(pile.stack.createBranch("feature", "Add a")).rejects.toThrow(/secret found/);
    expect(repo.git("branch", "--show-current")).toBe("main");
    expect(repo.git("branch", "--list", "feature")).toBe("");
    expect(repo.git("diff", "--cached", "--name-only")).toBe("a.txt");
    // And --no-verify skips them.
    const branch = await pile.stack.createBranch("feature", "Add a", { verify: false });
    expect(branch.commits).toHaveLength(1);
  });
});
