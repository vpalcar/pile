import { describe, expect, it } from "vitest";
import { deriveBranchName } from "../src/utils/branch-name.js";

const nov6 = new Date(2026, 10, 6);

describe("deriveBranchName", () => {
  it("cuts long messages at a word boundary, never mid-word", () => {
    expect(deriveBranchName("Filter source usages by attachment context", nov6)).toBe("11-06-filter-source-usages-by-attachment");
  });

  it("keeps short messages whole, and a word that ends exactly at the limit", () => {
    expect(deriveBranchName("Add settings schema", nov6)).toBe("11-06-add-settings-schema");
    expect(deriveBranchName(`${"a".repeat(35)} bcde`, nov6)).toBe(`11-06-${"a".repeat(35)}-bcde`);
  });

  it("falls back to a hard cut for one very long word", () => {
    expect(deriveBranchName("x".repeat(60), nov6)).toBe(`11-06-${"x".repeat(40)}`);
  });
});
