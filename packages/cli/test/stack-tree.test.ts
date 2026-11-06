import { describe, expect, it } from "vitest";
import { layoutTree } from "@pile/review-web/stack-tree";
import { railText } from "../src/components/StackTree.js";

const draw = (nodes: Array<[string, string | null]>) => {
  const { rows, lanes } = layoutTree(nodes.map(([id, parent]) => ({ id, parent })));
  return rows.map((row) => `${railText(row, lanes, "○")}${row.id ?? "main"}`.replace(/\s+$/, ""));
};

describe("pile log graph", () => {
  it("draws a straight stack in one column", () => {
    expect(draw([["a", null], ["b", "a"]])).toEqual(["○ b", "○ a", "○ main"]);
  });

  it("joins a second branch where it forks, not at the trunk", () => {
    expect(draw([["a", null], ["b", "a"], ["c", "b"], ["x", "b"]])).toEqual(["  ○ x", "○ │ c", "○─┘ b", "○   a", "○   main"]);
  });

  it("joins several branches with ┴", () => {
    expect(draw([["a", null], ["b", null], ["c", null]])).toEqual(["    ○ c", "  ○ │ b", "○ │ │ a", "○─┴─┘ main"]);
  });
});
