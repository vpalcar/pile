import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPRTemplate } from "../src/utils/pr-template.js";

describe("readPRTemplate", () => {
  it("finds the template where GitHub looks, in any letter case", () => {
    const root = mkdtempSync(join(tmpdir(), "pile-template-"));
    expect(readPRTemplate(root)).toBeNull();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "pull_request_template.md"), "## Docs template\n");
    expect(readPRTemplate(root)).toBe("## Docs template\n");
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".github", "PULL_REQUEST_TEMPLATE.md"), "## Summary\n\n## Test plan\n");
    // .github wins, as on GitHub.
    expect(readPRTemplate(root)).toBe("## Summary\n\n## Test plan\n");
  });
});
