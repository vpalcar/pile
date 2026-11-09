import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatNotes, type NewNote } from "../src/notes.js";
import { createTestRepo } from "./helpers.js";

const line = (extra: Partial<NewNote> = {}): NewNote => ({
  branch: "feature",
  pr: null,
  path: "src/api.ts",
  line: 12,
  side: "RIGHT",
  commit: "abc123",
  code: ["  const a = 1;", "  const b = 2;", "  return a + b;"],
  codeStart: 11,
  body: "Name these after what they mean.",
  ...extra,
});

describe("notes", () => {
  it("adds, filters, completes and clears notes", async () => {
    const repo = createTestRepo();
    const { notes } = await repo.pile();
    const first = notes.add(line());
    notes.add(line({ branch: "other", body: "Elsewhere" }));
    const general = notes.add(line({ path: null, line: null, side: null, code: [], codeStart: null, body: "Add a test for the empty case." }));

    expect(first.id).toMatch(/^[0-9a-f]{6}$/);
    expect(notes.list({ branch: "feature" }).map((n) => n.body)).toEqual(["Name these after what they mean.", "Add a test for the empty case."]);

    notes.update(first.id, { done: true });
    expect(notes.list({ branch: "feature", open: true }).map((n) => n.id)).toEqual([general.id]);
    expect(notes.clearDone({ branch: "feature" })).toBe(1);
    expect(notes.list().length).toBe(2);

    notes.remove(general.id);
    expect(notes.list().map((n) => n.branch)).toEqual(["other"]);
    expect(() => notes.update("nope00", { done: true })).toThrow(/No note/);
    expect(() => notes.add(line({ body: "   " }))).toThrow(/text/);
  });

  it("keeps .pile out of git status and writes a readable copy", async () => {
    const repo = createTestRepo();
    const { notes } = await repo.pile();
    notes.add(line());
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(readFileSync(join(repo.dir, ".git", "info", "exclude"), "utf8")).toContain("/.pile/");
    expect(existsSync(join(repo.dir, ".pile", "notes.md"))).toBe(true);
    // Only added once.
    notes.add(line());
    expect(readFileSync(join(repo.dir, ".git", "info", "exclude"), "utf8").match(/\/\.pile\//g)?.length).toBe(1);
  });
});

describe("formatNotes", () => {
  const note = (extra: Partial<NewNote> = {}) => ({ ...line(extra), id: "a1b2c3", createdAt: "", done: false });

  it("shows where, the code with the line marked, the comment, and how to finish", () => {
    const text = formatNotes([note()]);
    expect(text).toContain("## src/api.ts:12 (id `a1b2c3`)");
    expect(text).toContain("```ts\n  11 |   const a = 1;\n> 12 |   const b = 2;\n  13 |   return a + b;\n```");
    expect(text).toContain("Name these after what they mean.");
    expect(text).toContain("pile notes done <id>");
  });

  it("says when a note is about the old code", () => {
    expect(formatNotes([note({ side: "LEFT" })])).toContain("line 12 of the old version");
  });

  it("groups by branch when there are several", () => {
    const text = formatNotes([note(), note({ branch: "other" })]);
    expect(text).toContain("## Branch `feature`");
    expect(text).toContain("### src/api.ts:12");
  });

  it("says so when there's nothing to do", () => {
    expect(formatNotes([])).toBe("No open review notes.\n");
  });
});
