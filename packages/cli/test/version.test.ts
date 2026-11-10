import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("version", () => {
  it("`pile --version` matches package.json", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const bin = readFileSync(new URL("../src/bin/pile.ts", import.meta.url), "utf8");
    expect(bin).toContain(`.version("${version}")`);
  });
});
