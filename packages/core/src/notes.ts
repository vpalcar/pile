import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGitSync } from "./exec.js";

/**
 * A review note for whoever (or whatever) works on the branch next, usually a coding
 * agent: a comment on a line of the diff, or on the branch as a whole. Notes stay on
 * this machine, in `.pile/notes.json`, with a readable copy in `.pile/notes.md`.
 */
export interface Note {
  id: string;
  branch: string;
  /** The PR the note was written on, if any. */
  pr: number | null;
  /** null for a note on the branch as a whole. */
  path: string | null;
  line: number | null;
  /** RIGHT: the new code; LEFT: the code as it was before the change. */
  side: "LEFT" | "RIGHT" | null;
  /** The commit the note was written against. */
  commit: string | null;
  /** The code around the line when the note was written, starting at `codeStart`. */
  code: string[];
  codeStart: number | null;
  body: string;
  createdAt: string;
  done: boolean;
}

export type NewNote = Omit<Note, "id" | "createdAt" | "done">;

export interface NoteFilter {
  branch?: string;
  /** Only notes that aren't done. */
  open?: boolean;
}

export class NotesStore {
  readonly dir: string;
  private readonly file: string;

  constructor(private readonly repoRoot: string) {
    this.dir = join(repoRoot, ".pile");
    this.file = join(this.dir, "notes.json");
  }

  list(filter: NoteFilter = {}): Note[] {
    return this.read().filter((n) => (!filter.branch || n.branch === filter.branch) && (!filter.open || !n.done));
  }

  get(id: string): Note | undefined {
    return this.read().find((n) => n.id === id);
  }

  add(input: NewNote): Note {
    const body = input.body.trim();
    if (!body) throw new Error("A note needs some text");
    const note: Note = { ...input, body, id: randomBytes(4).toString("hex").slice(0, 6), createdAt: new Date().toISOString(), done: false };
    this.write([...this.read(), note]);
    return note;
  }

  update(id: string, change: Partial<Pick<Note, "done" | "body">>): Note {
    const notes = this.read();
    const note = notes.find((n) => n.id === id);
    if (!note) throw new Error(`No note with id ${id}`);
    Object.assign(note, change);
    this.write(notes);
    return note;
  }

  remove(id: string): void {
    const notes = this.read();
    if (!notes.some((n) => n.id === id)) throw new Error(`No note with id ${id}`);
    this.write(notes.filter((n) => n.id !== id));
  }

  /** Deletes notes that are done; returns how many. */
  clearDone(filter: Pick<NoteFilter, "branch"> = {}): number {
    const notes = this.read();
    const keep = notes.filter((n) => !n.done || (filter.branch && n.branch !== filter.branch));
    this.write(keep);
    return notes.length - keep.length;
  }

  private read(): Note[] {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(data.notes) ? data.notes : [];
    } catch {
      return [];
    }
  }

  private write(notes: Note[]): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      this.ignore();
    }
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, notes }, null, 2)}\n`);
    renameSync(temp, this.file);
    writeFileSync(join(this.dir, "notes.md"), formatNotes(notes.filter((n) => !n.done)));
  }

  /** Keeps `.pile/` out of `git status` through .git/info/exclude, without touching .gitignore. */
  private ignore(): void {
    try {
      const gitDir = runGitSync(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: this.repoRoot });
      const exclude = join(gitDir, "info", "exclude");
      const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
      if (!current.split("\n").some((l) => l.trim() === "/.pile/")) {
        mkdirSync(join(gitDir, "info"), { recursive: true });
        appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}/.pile/\n`);
      }
    } catch {
      // Not fatal: the notes still work, they just show up as untracked.
    }
  }
}

export function createNotesStore(repoRoot: string): NotesStore {
  return new NotesStore(repoRoot);
}

/**
 * Notes as instructions for a coding agent: what to address, where, with the code the
 * reviewer was looking at, and how to mark each one done.
 */
export function formatNotes(notes: Note[]): string {
  if (notes.length === 0) return "No open review notes.\n";
  const out: string[] = [
    "# Review notes",
    "",
    `${notes.length === 1 ? "A reviewer left a note" : `A reviewer left ${notes.length} notes`} on your changes. Address each one; when it's handled, run \`pile notes done <id>\`.`,
  ];
  const byBranch = new Map<string, Note[]>();
  for (const note of notes) byBranch.set(note.branch, [...(byBranch.get(note.branch) ?? []), note]);
  for (const [branch, group] of byBranch) {
    if (byBranch.size > 1) out.push("", `## Branch \`${branch}\``);
    for (const note of group) {
      const level = byBranch.size > 1 ? "###" : "##";
      out.push("");
      if (!note.path) {
        out.push(`${level} On the branch as a whole (id \`${note.id}\`)`);
      } else {
        const where = note.side === "LEFT" ? `${note.path}, line ${note.line} of the old version` : `${note.path}:${note.line}`;
        out.push(`${level} ${where} (id \`${note.id}\`)`);
        if (note.side === "LEFT") out.push("", "This is about code the change removed or replaced; the reviewer may prefer how it was.");
        if (note.code.length && note.codeStart !== null) {
          const width = String(note.codeStart + note.code.length - 1).length;
          out.push("", "```" + language(note.path));
          note.code.forEach((text, i) => {
            const number = note.codeStart! + i;
            out.push(`${number === note.line ? ">" : " "} ${String(number).padStart(width)} | ${text}`);
          });
          out.push("```");
        }
      }
      out.push("", note.body);
    }
  }
  return `${out.join("\n")}\n`;
}

const language = (path: string) => (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
