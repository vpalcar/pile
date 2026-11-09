import { createPile, formatNotes, type Note } from "@pile/core";
import { createResult, exitWithError, formatJson, toCommandError, type OutputOptions } from "../utils/output.js";

export interface NotesCommandOptions {
  /** list (default), done, reopen, rm or clear */
  action?: string;
  ids: string[];
  branch?: string;
  all?: boolean;
  options: OutputOptions;
}

/**
 * `pile notes`: the review notes left in `pile review` for the agent working on a
 * branch. Prints them as instructions (or JSON), and marks them done or removes them.
 * Plain text on stdout, so it can be piped straight into an agent:
 *
 *   claude "$(pile notes)"
 */
export async function runNotes({ action = "list", ids, branch, all, options }: NotesCommandOptions): Promise<void> {
  try {
    const pile = await createPile();
    const store = pile.notes;
    const current = branch ?? (all ? undefined : await pile.git.getCurrentBranch());
    const print = (data: unknown, text: string) => console.log(options.json ? formatJson(createResult(true, data)) : text);

    switch (action) {
      case "list": {
        const notes = store.list({ branch: current, open: true });
        print({ branch: current ?? null, notes }, formatNotes(notes).trimEnd());
        return;
      }
      case "done":
      case "reopen": {
        if (ids.length === 0) {
          exitWithError(options, { code: "NEEDS_INPUT", message: `Which note? Pass its id: pile notes ${action} <id>`, hint: "`pile notes` lists them with their ids." }, 2);
        }
        const updated = ids.map((id) => store.update(id, { done: action === "done" }));
        print({ notes: updated }, updated.map((n) => `${action === "done" ? "Done" : "Reopened"}: ${describe(n)}`).join("\n"));
        return;
      }
      case "rm": {
        if (ids.length === 0) exitWithError(options, { code: "NEEDS_INPUT", message: "Which note? Pass its id: pile notes rm <id>" }, 2);
        ids.forEach((id) => store.remove(id));
        print({ removed: ids }, `Removed ${ids.length === 1 ? "1 note" : `${ids.length} notes`}.`);
        return;
      }
      case "clear": {
        const count = store.clearDone({ branch: current });
        print({ removed: count }, `Removed ${count === 1 ? "1 finished note" : `${count} finished notes`}.`);
        return;
      }
      default:
        exitWithError(options, { code: "INVALID_ARGUMENT", message: `Unknown action "${action}"`, hint: "Use list, done, reopen, rm or clear." }, 2);
    }
  } catch (error) {
    const failure = toCommandError(error);
    exitWithError(options, /No note with id/.test(failure.message) ? { ...failure, code: "NOTE_NOT_FOUND" } : failure);
  }
}

const describe = (note: Note) => `${note.id} ${note.path ? `${note.path}:${note.line}` : note.branch}`;
