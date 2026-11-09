/**
 * Unified diff model: hunks of typed lines with old/new line numbers, plus helpers
 * for side-by-side rows, gaps between hunks and word-level highlights.
 */

export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
  /** "\ No newline at end of file" follows this line. */
  noNewline?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second @@ (often the enclosing function). */
  section: string;
  lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const header = raw.match(HUNK_HEADER);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        section: header[5] ?? "",
        lines: [],
      };
      hunks.push(current);
      oldLine = current.oldStart;
      newLine = current.newStart;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("\\")) {
      const last = current.lines[current.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") {
      current.lines.push({ kind: "add", text, oldNumber: null, newNumber: newLine++ });
    } else if (marker === "-") {
      current.lines.push({ kind: "del", text, oldNumber: oldLine++, newNumber: null });
    } else if (marker === " " || raw === "") {
      // An empty line inside a hunk is context whose leading space was trimmed.
      if (raw === "" && oldLine >= current.oldStart + current.oldLines && newLine >= current.newStart + current.newLines) continue;
      current.lines.push({ kind: "context", text, oldNumber: oldLine++, newNumber: newLine++ });
    }
  }
  return hunks;
}

/** A side-by-side row: deletions pair with the additions that replace them. */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
    }
  }
  return rows;
}

/** Unchanged lines hidden between hunks (and before the first one). */
export interface Gap {
  /** Index of the hunk this gap precedes; hunks.length for the gap after the last hunk. */
  beforeHunk: number;
  oldStart: number;
  newStart: number;
  /** Null when the gap runs to the end of the file and its length isn't known yet. */
  count: number | null;
}

export function gaps(hunks: Hunk[], newFileLength: number | null): Gap[] {
  const result: Gap[] = [];
  let oldNext = 1;
  let newNext = 1;
  hunks.forEach((hunk, index) => {
    const count = hunk.newStart - newNext;
    if (count > 0) result.push({ beforeHunk: index, oldStart: oldNext, newStart: newNext, count });
    oldNext = hunk.oldStart + hunk.oldLines;
    newNext = hunk.newStart + hunk.newLines;
  });
  if (hunks.length > 0) {
    const tail = newFileLength === null ? null : newFileLength - newNext + 1;
    if (tail === null || tail > 0) {
      result.push({ beforeHunk: hunks.length, oldStart: oldNext, newStart: newNext, count: tail });
    }
  }
  return result;
}

/** Context lines for part of a gap, taken from the new version of the file. */
export function gapLines(gap: Gap, fileLines: string[], from: number, to: number): DiffLine[] {
  const lines: DiffLine[] = [];
  for (let offset = from; offset < to; offset++) {
    const newNumber = gap.newStart + offset;
    if (newNumber > fileLines.length) break;
    lines.push({ kind: "context", text: fileLines[newNumber - 1], oldNumber: gap.oldStart + offset, newNumber });
  }
  return lines;
}

/**
 * Character ranges that differ between a deleted line and the added line replacing
 * it, by common prefix and suffix. Skipped when the lines share too little.
 */
export function wordDiff(before: string, after: string): { del: [number, number] | null; add: [number, number] | null } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const shared = start + (before.length - endBefore);
  if (shared < Math.min(before.length, after.length) * 0.3) return { del: null, add: null };
  return {
    del: endBefore > start ? [start, endBefore] : null,
    add: endAfter > start ? [start, endAfter] : null,
  };
}

export function languageFor(path: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return EXTENSIONS[ext] ?? null;
}

const EXTENSIONS: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "json5",
  css: "css", scss: "scss", less: "less", html: "html", vue: "vue", svelte: "svelte",
  md: "markdown", mdx: "mdx", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  sql: "sql", graphql: "graphql", gql: "graphql", prisma: "prisma", xml: "xml", svg: "xml",
  tf: "hcl", hcl: "hcl", lua: "lua", ex: "elixir", exs: "elixir", dart: "dart", scala: "scala",
};

/** Orders paths like the file tree: folders before files at each level, then by name. */
export function treeOrder(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const aIsFile = i === pa.length - 1;
    const bIsFile = i === pb.length - 1;
    if (aIsFile !== bIsFile) return aIsFile ? 1 : -1;
    return pa[i].localeCompare(pb[i]);
  }
  return pa.length - pb.length;
}
