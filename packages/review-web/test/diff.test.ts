import { describe, expect, it } from "vitest";
import { gapLines, gaps, languageFor, parsePatch, toSplitRows, treeOrder, wordDiff } from "../src/lib/diff";

const PATCH = `@@ -3,5 +3,6 @@ export function a() {
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 return x;
@@ -20,2 +21,2 @@ function b
-old
+new
\\ No newline at end of file`;

describe("parsePatch", () => {
  it("numbers lines on both sides and keeps the section text", () => {
    const [first, second] = parsePatch(PATCH);
    expect(first).toMatchObject({ oldStart: 3, oldLines: 5, newStart: 3, newLines: 6, section: "export function a() {" });
    expect(first.lines.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ["context", 3, 3],
      ["del", 4, null],
      ["add", null, 4],
      ["add", null, 5],
      ["context", 5, 6],
    ]);
    expect(second.lines.at(-1)).toMatchObject({ kind: "add", text: "new", noNewline: true });
  });

  it("handles single-line hunks without counts", () => {
    const [hunk] = parsePatch("@@ -1 +1 @@\n-a\n+b");
    expect(hunk).toMatchObject({ oldLines: 1, newLines: 1 });
  });
});

describe("toSplitRows", () => {
  it("pairs deletions with the additions that replace them", () => {
    const rows = toSplitRows(parsePatch(PATCH)[0].lines);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["const x = 1;", "const x = 1;"],
      ["const y = 2;", "const y = 3;"],
      [null, "const z = 4;"],
      ["return x;", "return x;"],
    ]);
  });
});

describe("gaps", () => {
  it("finds hidden lines before, between and after hunks", () => {
    const hunks = parsePatch(PATCH);
    expect(gaps(hunks, null)).toEqual([
      { beforeHunk: 0, oldStart: 1, newStart: 1, count: 2 },
      { beforeHunk: 1, oldStart: 8, newStart: 9, count: 12 },
      { beforeHunk: 2, oldStart: 22, newStart: 23, count: null },
    ]);
    expect(gaps(hunks, 30).at(-1)).toMatchObject({ count: 8 });
    expect(gaps(hunks, 22).some((g) => g.beforeHunk === 2)).toBe(false);
  });

  it("produces context lines for part of a gap", () => {
    const file = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const gap = gaps(parsePatch(PATCH), 30)[1];
    expect(gapLines(gap, file, 10, 12).map((l) => [l.oldNumber, l.newNumber, l.text])).toEqual([
      [18, 19, "line 19"],
      [19, 20, "line 20"],
    ]);
  });
});

describe("wordDiff", () => {
  it("marks the changed middle of similar lines", () => {
    expect(wordDiff("const y = 2;", "const y = 3;")).toEqual({ del: [10, 11], add: [10, 11] });
  });
  it("skips lines that share too little", () => {
    expect(wordDiff("alpha", "omega")).toEqual({ del: null, add: null });
  });
});

describe("treeOrder", () => {
  it("sorts folders before files at every level, like the tree", () => {
    const paths = ["README.md", "src/z.ts", "src/a/b.ts", "a.txt", "src/a.ts", "docs/x.md"];
    expect([...paths].sort(treeOrder)).toEqual(["docs/x.md", "src/a/b.ts", "src/a.ts", "src/z.ts", "a.txt", "README.md"]);
  });
});

describe("languageFor", () => {
  it("maps paths to grammars", () => {
    expect(languageFor("src/App.tsx")).toBe("tsx");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("notes.unknown")).toBeNull();
  });
});
