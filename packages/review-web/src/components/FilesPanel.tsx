import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Columns2, PanelLeft, Rows3, Search, WrapText } from "lucide-react";
import type { Detail, DiffFile } from "../api";
import { FileDiff, fileAnchor, type PendingComment } from "./FileDiff";
import { DiffStat } from "./ui";
import { useShortcuts, usePersisted, useViewed } from "../lib/util";
import { treeOrder } from "../lib/diff";

interface Props {
  detail: Detail;
  itemKey: string;
  scrollEl: HTMLElement | null;
  pending: PendingComment[];
  onAddPending: (comment: Omit<PendingComment, "id">) => void;
  onRemovePending: (id: string) => void;
  initialFile: string | null;
  onFileChange: (path: string | null) => void;
}

export function FilesPanel({ detail, itemKey, scrollEl, pending, onAddPending, onRemovePending, initialFile, onFileChange }: Props) {
  // Same order as the tree (folders first, then files, alphabetically), so j/k follow it.
  const files = useMemo(() => [...detail.files].sort((a, b) => treeOrder(a.path, b.path)), [detail.files]);
  const [mode, setMode] = usePersisted<"split" | "unified">("pile:diff-mode", "split");
  const [wrap, setWrap] = usePersisted("pile:diff-wrap", false);
  const [treeOpen, setTreeOpen] = usePersisted("pile:tree-open", true);
  const [viewed, setViewed] = useViewed(itemKey);
  const [active, setActive] = useState<string | null>(initialFile ?? files[0]?.path ?? null);

  const isViewed = useCallback((f: DiffFile) => viewed[f.path] === f.sha, [viewed]);
  const viewedCount = files.filter(isViewed).length;

  const scrollTo = useCallback(
    (path: string, smooth = true) => {
      const el = document.getElementById(fileAnchor(path));
      if (!el || !scrollEl) return;
      const bar = 44;
      const top = el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop - bar - 10;
      scrollEl.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
      setActive(path);
      onFileChange(path);
    },
    [scrollEl, onFileChange],
  );

  // Deep link to a file on first render.
  useEffect(() => {
    if (initialFile) requestAnimationFrame(() => scrollTo(initialFile, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey]);

  // Track the file under the sticky toolbar while scrolling.
  useEffect(() => {
    if (!scrollEl) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const limit = scrollEl.getBoundingClientRect().top + 120;
        let current: string | null = null;
        for (const el of scrollEl.querySelectorAll<HTMLElement>(".file[data-path]")) {
          if (el.getBoundingClientRect().top <= limit) current = el.dataset.path!;
          else break;
        }
        if (current) setActive((prev) => (prev === current ? prev : current));
      });
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [scrollEl]);

  const toggleViewed = useCallback(
    (file: DiffFile) => {
      setViewed((v) => {
        const next = { ...v };
        if (next[file.path] === file.sha) delete next[file.path];
        else next[file.path] = file.sha;
        return next;
      });
    },
    [setViewed],
  );

  const index = Math.max(0, files.findIndex((f) => f.path === active));
  useShortcuts(
    {
      j: () => files[index + 1] && scrollTo(files[index + 1].path),
      k: () => files[index - 1] && scrollTo(files[index - 1].path),
      v: () => {
        const file = files[index];
        if (!file) return;
        const wasViewed = isViewed(file);
        toggleViewed(file);
        if (!wasViewed) {
          const next = files.slice(index + 1).find((f) => !isViewed(f));
          if (next) setTimeout(() => scrollTo(next.path), 120);
        }
      },
      s: () => setMode((m) => (m === "split" ? "unified" : "split")),
      w: () => setWrap((w) => !w),
      t: () => setTreeOpen((o) => !o),
    },
    [files, index, isViewed, scrollTo, toggleViewed],
  );

  const pendingByPath = useMemo(() => groupBy(pending, (p) => p.path), [pending]);
  const commentsByPath = useMemo(() => groupBy(detail.inlineComments, (c) => c.path), [detail.inlineComments]);
  const fileUrl = (f: DiffFile) => (detail.url ? `${detail.url}/files#diff-${f.sha.split(":")[0]}` : null);

  if (files.length === 0) {
    return (
      <div className="files-section">
        <div className="file-note" style={{ padding: 40 }}>No changes in this {detail.number ? "pull request" : "branch"}.</div>
      </div>
    );
  }

  return (
    <section className="files-section" aria-label="Changed files">
      <div className="files-bar">
        <button className="btn ghost sm icon" onClick={() => setTreeOpen((o) => !o)} data-tip={treeOpen ? "Hide file tree" : "Show file tree"} data-kbd="t">
          <PanelLeft size={14} />
        </button>
        <b style={{ fontWeight: 550 }}>
          {files.length} {files.length === 1 ? "file" : "files"}
        </b>
        <DiffStat additions={detail.additions} deletions={detail.deletions} bar />
        <span className="spacer" />
        <ProgressRing done={viewedCount} total={files.length} />
        <div className="segmented" role="group" aria-label="Diff layout">
          <button className={mode === "split" ? "on" : ""} onClick={() => setMode("split")} data-tip="Side by side" data-kbd="s">
            <Columns2 size={13} /> Split
          </button>
          <button className={mode === "unified" ? "on" : ""} onClick={() => setMode("unified")} data-tip="Unified" data-kbd="s">
            <Rows3 size={13} /> Unified
          </button>
        </div>
        <button className={`btn sm icon ${wrap ? "" : "ghost"}`} onClick={() => setWrap((w) => !w)} data-tip="Wrap long lines" data-kbd="w" aria-pressed={wrap}>
          <WrapText size={14} />
        </button>
      </div>
      <div className={`files ${treeOpen ? "" : "tree-hidden"}`}>
        <FileTree files={files} active={files[index]?.path ?? null} isViewed={isViewed} onSelect={(p) => scrollTo(p)} />
        <div className="diffs">
          {files.map((file) => (
            <FileDiff
              key={file.path}
              file={file}
              headSha={detail.headSha}
              baseSha={detail.baseSha}
              mode={mode}
              wrap={wrap}
              viewed={isViewed(file)}
              active={file.path === files[index]?.path}
              comments={commentsByPath.get(file.path) ?? EMPTY}
              pending={pendingByPath.get(file.path) ?? EMPTY}
              canComment={detail.can.comment && detail.number !== null}
              webUrl={fileUrl(file)}
              onToggleViewed={() => toggleViewed(file)}
              onAddPending={onAddPending}
              onRemovePending={onRemovePending}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

const EMPTY: never[] = [];


function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const complete = done === total && total > 0;
  return (
    <span className="progress-ring" data-tip="Files you've marked as viewed" data-kbd="v">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="2" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke={complete ? "var(--green)" : "var(--accent)"}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - (total ? done / total : 0))}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="num">
        {done}/{total} viewed
      </span>
    </span>
  );
}

// -----------------------------------------------------------------------------

interface TreeNode {
  name: string;
  path: string;
  dirs: Map<string, TreeNode>;
  files: DiffFile[];
}

function buildTree(files: DiffFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    parts.slice(0, -1).forEach((part, i) => {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] });
      node = node.dirs.get(part)!;
    });
    node.files.push(file);
  }
  // Collapse chains of single-directory folders: a/b/c.
  const compress = (node: TreeNode): TreeNode => {
    for (const [key, child] of node.dirs) node.dirs.set(key, compress(child));
    if (node.files.length === 0 && node.dirs.size === 1 && node.name) {
      const [only] = node.dirs.values();
      return { ...only, name: `${node.name}/${only.name}` };
    }
    return node;
  };
  return compress(root);
}

const FileTree = memo(function FileTree({
  files,
  active,
  isViewed,
  onSelect,
}: {
  files: DiffFile[];
  active: string | null;
  isViewed: (f: DiffFile) => boolean;
  onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? files.filter((f) => fuzzy(f.path.toLowerCase(), q)) : files;
  }, [files, query]);
  const tree = useMemo(() => buildTree(filtered), [filtered]);

  const render = (node: TreeNode, depth: number): React.ReactNode[] => [
    ...[...node.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((dir) => [
        <button
          key={`d:${dir.path}`}
          className={`tree-dir ${closed.has(dir.path) ? "closed" : ""}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() =>
            setClosed((s) => {
              const next = new Set(s);
              if (next.has(dir.path)) next.delete(dir.path);
              else next.add(dir.path);
              return next;
            })
          }
        >
          <ChevronDown size={12} className="chev" />
          <span className="name" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {dir.name}
          </span>
        </button>,
        ...(closed.has(dir.path) ? [] : render(dir, depth + 1)),
      ]),
    ...node.files
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => {
        const v = isViewed(file);
        return (
          <button
            key={`f:${file.path}`}
            className={`tree-file ${file.path === active ? "active" : ""} ${v ? "viewed" : ""}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => onSelect(file.path)}
            title={file.path}
          >
            <span className={`file-status ${file.status}`}>{statusLetter(file.status)}</span>
            <span className="name">{file.path.split("/").pop()}</span>
            {v ? (
              <Check size={12} className="check" strokeWidth={2.5} />
            ) : (
              <span className="stat">
                {file.additions > 0 && <span className="plus">+{file.additions}</span>}
                {file.deletions > 0 && <span className="minus">−{file.deletions}</span>}
              </span>
            )}
          </button>
        );
      }),
  ];

  return (
    <aside className="tree" aria-label="File tree">
      <div className="tree-search">
        <div className="input-wrap">
          <Search size={13} />
          <input
            className="input"
            placeholder="Filter files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered[0]) onSelect(filtered[0].path);
              if (e.key === "Escape") {
                setQuery("");
                (e.target as HTMLInputElement).blur();
              }
            }}
            id="file-filter"
          />
        </div>
      </div>
      <div className="tree-scroll">
        {filtered.length === 0 ? <div className="rail-empty" style={{ padding: "8px 10px" }}>No files match</div> : render(tree, 0)}
      </div>
    </aside>
  );
});

function statusLetter(status: DiffFile["status"]): string {
  return { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M", unchanged: "·" }[status];
}

/** Subsequence match, so "srcapi" finds "src/server/api.ts". */
function fuzzy(text: string, query: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === query[i]) i++;
  return i === query.length;
}
