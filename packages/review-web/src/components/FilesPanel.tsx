import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Columns2, PanelLeft, Rows3, Search, WrapText } from "lucide-react";
import type { Detail, DiffFile } from "../api";
import { FileDiff, fileAnchor, type PendingComment } from "./FileDiff";
import { Button, cx, DiffStat, StatusLetter } from "./ui";
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
      // Lands where the header sticks: 10px under the files bar, level with the tree filter.
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
      <div className="mt-9 border-t border-line p-10 text-center text-fg-3">No changes in this {detail.number ? "pull request" : "branch"}.</div>
    );
  }

  return (
    <section className="mt-9 border-t border-line" aria-label="Changed files">
      <div className="sticky top-0 z-[15] flex h-11 items-center gap-2.5 border-b border-line bg-bg/90 px-4 backdrop-blur-xl">
        <Button variant="ghost" size="sm" icon onClick={() => setTreeOpen((o) => !o)} data-tip={treeOpen ? "Hide file tree" : "Show file tree"} data-kbd="t">
          <PanelLeft size={14} />
        </Button>
        <b className="font-medium leading-none tabular">
          {files.length} {files.length === 1 ? "file" : "files"}
        </b>
        <DiffStat additions={detail.additions} deletions={detail.deletions} bar />
        <span className="flex-1" />
        <ProgressRing done={viewedCount} total={files.length} />
        <div className="inline-flex items-center rounded-lg border border-line bg-panel-2 p-0.5" role="group" aria-label="Diff layout">
          {([
            ["split", Columns2, "Split", "Side by side"],
            ["unified", Rows3, "Unified", "Unified"],
          ] as const).map(([value, Icon, label, tip]) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              data-tip={tip}
              data-kbd="s"
              className={cx(
                "inline-flex h-[22px] items-center gap-1.5 rounded-md px-2 text-xs font-medium leading-none transition-colors [&_svg]:shrink-0",
                mode === value ? "bg-panel-3 text-fg shadow-[0_0_0_1px_var(--border-2)]" : "text-fg-3 hover:text-fg-2",
              )}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        <Button variant={wrap ? "default" : "ghost"} size="sm" icon onClick={() => setWrap((w) => !w)} data-tip="Wrap long lines" data-kbd="w" aria-pressed={wrap}>
          <WrapText size={14} />
        </Button>
      </div>
      <div className={cx("grid items-start transition-[grid-template-columns] duration-200", treeOpen ? "grid-cols-[264px_minmax(0,1fr)]" : "grid-cols-[0_minmax(0,1fr)]")}>
        <FileTree files={files} active={files[index]?.path ?? null} isViewed={isViewed} onSelect={(p) => scrollTo(p)} />
        <div className="flex min-w-0 flex-col gap-3.5 px-4 pb-10 pt-2.5">
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
  // (rendered below)
  const r = 7;
  const c = 2 * Math.PI * r;
  const complete = done === total && total > 0;
  return (
    <span className="mr-1 inline-flex items-center gap-2 text-xs leading-none text-fg-2" data-tip="Files you've marked as viewed" data-kbd="v">
      <svg width="16" height="16" viewBox="0 0 18 18" className="shrink-0" aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border-3)" strokeWidth="2.5" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke={complete ? "var(--green)" : "var(--accent)"}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - (total ? done / total : 0))}
          transform="rotate(-90 9 9)"
          className="transition-[stroke-dashoffset] duration-300"
        />
      </svg>
      <span className="tabular">
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
  active: activePath,
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

  const rowClass = "flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left leading-none [&_svg]:shrink-0";
  const render = (node: TreeNode, depth: number): React.ReactNode[] => [
    ...[...node.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((dir) => [
        <button
          key={`d:${dir.path}`}
          className={cx(rowClass, "text-fg-3 hover:bg-hover hover:text-fg-2")}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() =>
            setClosed((s) => {
              const next = new Set(s);
              if (next.has(dir.path)) next.delete(dir.path);
              else next.add(dir.path);
              return next;
            })
          }
        >
          <span className="grid w-3.5 place-items-center">
            <ChevronDown size={12} className={cx("transition-transform duration-150", closed.has(dir.path) && "-rotate-90")} />
          </span>
          <span className="min-w-0 truncate">{dir.name}</span>
        </button>,
        ...(closed.has(dir.path) ? [] : render(dir, depth + 1)),
      ]),
    ...node.files
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => {
        const v = isViewed(file);
        const active = file.path === activePath;
        return (
          <button
            key={`f:${file.path}`}
            className={cx(rowClass, active ? "bg-active text-fg" : "text-fg-2 hover:bg-hover hover:text-fg")}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => onSelect(file.path)}
            title={file.path}
          >
            <StatusLetter status={file.status} />
            <span className={cx("min-w-0 flex-1 truncate", v && !active && "text-fg-3")}>{file.path.split("/").pop()}</span>
            {v ? (
              <Check size={12} strokeWidth={2.5} className="text-ok" />
            ) : (
              <span className="flex shrink-0 gap-1 font-mono text-[10.5px] tabular">
                {file.additions > 0 && <span className="text-ok">+{file.additions.toLocaleString()}</span>}
                {file.deletions > 0 && <span className="text-bad">−{file.deletions.toLocaleString()}</span>}
              </span>
            )}
          </button>
        );
      }),
  ];

  return (
    <aside className="sticky top-11 flex h-[calc(100vh-var(--topbar-h)-44px)] flex-col overflow-hidden border-r border-line" aria-label="File tree">
      <div className="px-2.5 pb-1.5 pt-2.5">
        <label className="relative flex h-7 items-center">
          <Search size={13} className="pointer-events-none absolute left-2.5 text-fg-3" />
          <input
            className="h-7 w-full rounded-lg border border-line bg-panel pl-8 pr-2 text-[12.5px] text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-3 focus:border-line-3 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
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
        </label>
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-6">
        {filtered.length === 0 ? <div className="px-2.5 py-2 text-xs text-fg-3">No files match</div> : render(tree, 0)}
      </div>
    </aside>
  );
});

/** Subsequence match, so "srcapi" finds "src/server/api.ts". */
function fuzzy(text: string, query: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === query[i]) i++;
  return i === query.length;
}
