import { describe, expect, it } from "vitest";
import { createPile } from "@pile/core";
import { createCliRepo } from "./helpers.js";

describe("pile notes", () => {
  it("prints the current branch's open notes for an agent, and marks them done", async () => {
    const repo = createCliRepo();
    repo.chain(["feature"]);
    const { notes } = await createPile(repo.dir);
    const note = notes.add({ branch: "feature", pr: null, path: "feature.txt", line: 1, side: "RIGHT", commit: null, code: ["feature"], codeStart: 1, body: "Rename this file." });
    notes.add({ branch: "main", pr: null, path: null, line: null, side: null, commit: null, code: [], codeStart: null, body: "Not for this branch." });

    const text = repo.pile(["notes"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`## feature.txt:1 (id \`${note.id}\`)`);
    expect(text.stdout).toContain("Rename this file.");
    expect(text.stdout).not.toContain("Not for this branch.");

    const all = repo.pile(["notes", "--all", "--json"]);
    expect(all.json.data.notes).toHaveLength(2);

    expect(repo.pile(["notes", "done", note.id]).stdout).toContain(`Done: ${note.id} feature.txt:1`);
    expect(repo.pile(["notes"]).stdout).toContain("No open review notes.");
    expect(repo.pile(["notes", "clear", "--json"]).json).toMatchObject({ success: true, data: { removed: 1 } });
  });

  it("asks for an id instead of guessing, and names unknown ones", () => {
    const repo = createCliRepo();
    const missing = repo.pile(["notes", "done", "--json"]);
    expect(missing.code).toBe(2);
    expect(missing.json).toMatchObject({ success: false, code: "NEEDS_INPUT" });
    expect(repo.pile(["notes", "done", "zzzzzz", "--json"]).json).toMatchObject({ success: false, code: "NOTE_NOT_FOUND" });
    expect(repo.pile(["notes", "bogus", "--json"]).json).toMatchObject({ success: false, code: "INVALID_ARGUMENT" });
  });
});
