import { describe, expect, it } from "vitest";
import { layoutTree } from "../src/lib/stack-tree";

const draw = (nodes: Array<[string, string | null]>) =>
  layoutTree(nodes.map(([id, parent]) => ({ id, parent }))).rows.map((r) => `${r.id ?? "main"}@${r.lane}${r.joins.length ? ` joins ${r.joins}` : ""}${r.through.length ? ` through ${r.through}` : ""}`);

describe("layoutTree", () => {
  it("keeps a straight stack in one lane, trunk at the bottom", () => {
    const { rows, lanes } = layoutTree([
      { id: "a", parent: null },
      { id: "b", parent: "a" },
      { id: "c", parent: "b" },
    ]);
    expect(lanes).toBe(1);
    expect(rows.map((r) => r.id)).toEqual(["c", "b", "a", null]);
    expect(rows.map((r) => [r.up, r.down])).toEqual([
      [false, true],
      [true, true],
      [true, true],
      [true, false],
    ]);
  });

  it("gives a second branch its own lane that joins its parent", () => {
    // main <- 1 <- (2 <- 4, 3 <- 5)
    expect(
      draw([
        ["1", null],
        ["2", "1"],
        ["3", "1"],
        ["4", "2"],
        ["5", "3"],
      ]),
    ).toEqual(["5@1", "3@1", "4@0 through 1", "2@0 through 1", "1@0 joins 1", "main@0"]);
  });

  it("nests branches of branches without crossing lanes", () => {
    // main <- 1 <- (2 <- (4, 5), 3)
    const rows = draw([
      ["1", null],
      ["2", "1"],
      ["3", "1"],
      ["4", "2"],
      ["5", "2"],
    ]);
    expect(rows).toEqual(["3@1", "5@2 through 1", "4@0 through 1,2", "2@0 joins 2 through 1", "1@0 joins 1", "main@0"]);
  });

  it("treats entries whose parent isn't in the stack as built on the trunk", () => {
    expect(draw([["x", "gone"]])).toEqual(["x@0", "main@0"]);
  });
});
