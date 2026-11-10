import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The repository's pull request template, from where GitHub looks for one: `.github/`,
 * the root, or `docs/` (any letter case). Null when there's none.
 */
export function readPRTemplate(root: string): string | null {
  for (const dir of [".github", "", "docs"]) {
    let names: string[];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    const name = names.find((n) => /^pull_request_template\.md$/i.test(n));
    if (name) {
      try {
        return readFileSync(join(root, dir, name), "utf8");
      } catch {
        // Unreadable: no template.
      }
    }
  }
  return null;
}
