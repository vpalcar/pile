import { createHash } from "node:crypto";
import type { PileInstance } from "@pile/core";
import type { DiffFile, FileStatus, LocalState, TimelineEntry } from "@pile/review-web/api";

/** Splits `git diff` output into one entry per file, keeping only the hunks as the patch. */
export function parseGitDiff(output: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = output.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const header = lines[0].match(/^diff --git a\/(.+) b\/(.+)$/);
    let oldPath = header?.[1] ?? "";
    let newPath = header?.[2] ?? "";
    let status: FileStatus = "modified";
    let binary = false;
    let hunkStart = lines.length;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("@@")) {
        hunkStart = i;
        break;
      }
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "removed";
      else if (line.startsWith("rename from ")) {
        oldPath = line.slice("rename from ".length);
        status = "renamed";
      } else if (line.startsWith("rename to ")) newPath = line.slice("rename to ".length);
      else if (line.startsWith("copy from ")) {
        oldPath = line.slice("copy from ".length);
        status = "copied";
      } else if (line.startsWith("copy to ")) newPath = line.slice("copy to ".length);
      else if (line.startsWith("Binary files")) binary = true;
      else if (line.startsWith("--- ") && line !== "--- /dev/null") oldPath = line.slice(6);
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") newPath = line.slice(6);
    }

    const hunks = lines.slice(hunkStart).join("\n").replace(/\n$/, "");
    let additions = 0;
    let deletions = 0;
    for (const line of lines.slice(hunkStart)) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
    const path = status === "removed" ? oldPath : newPath;
    files.push({
      path,
      previousPath: status === "renamed" || status === "copied" ? oldPath : null,
      status,
      additions,
      deletions,
      patch: binary ? null : hunks || null,
      sha: createHash("sha1").update(chunk).digest("hex").slice(0, 16),
      binary,
    });
  }
  return files;
}

export async function localFiles(pile: PileInstance, base: string, head: string): Promise<DiffFile[]> {
  const output = await pile.git.run([
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "--unified=3",
    `${base}..${head}`,
  ]);
  return parseGitDiff(output);
}

export async function localCommits(pile: PileInstance, base: string, head: string): Promise<TimelineEntry[]> {
  const commits = await pile.git.getCommitsBetween(base, head);
  return commits
    .map((c) => ({
      id: `commit-${c.hash}`,
      kind: "commit" as const,
      author: { login: c.author, avatarUrl: null },
      createdAt: c.date,
      bodyHtml: null,
      sha: c.hash,
      message: c.message,
      url: null,
    }))
    .reverse();
}

/** Ahead/behind against the remote branch, for branches that exist locally. */
export async function localState(
  pile: PileInstance,
  branch: string,
  refs: Awaited<ReturnType<PileInstance["git"]["getRefs"]>>,
  currentBranch: string,
): Promise<LocalState | null> {
  const local = refs.local.get(branch);
  if (!local) return null;
  const remote = refs.remote.get(`${pile.git.remoteName}/${branch}`);
  let ahead = 0;
  let behind = 0;
  if (remote && remote !== local) {
    const counts = await pile.git.run(["rev-list", "--left-right", "--count", `${local}...${remote}`]).catch(() => "0\t0");
    [ahead, behind] = counts.split(/\s+/).map(Number);
  }
  return { ahead, behind, unpushed: !remote || ahead > 0, isCurrent: branch === currentBranch };
}

export function diffStats(files: DiffFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );
}
