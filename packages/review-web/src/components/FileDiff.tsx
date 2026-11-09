import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronsUpDown, Copy, ExternalLink, FileCode2, Plus } from "lucide-react";
import type { DiffFile, InlineComment } from "../api";
import { gapLines, gaps, languageFor, parsePatch, toSplitRows, wordDiff, type DiffLine, type Gap, type Hunk } from "../lib/diff";
import { highlightLines, type Token } from "../lib/highlight";
import { api } from "../lib/client";
import { copy, timeAgo } from "../lib/util";
import { Avatar, DiffStat, useToast } from "./ui";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";

export type Side = "LEFT" | "RIGHT";
export interface PendingComment {
  id: string;
  path: string;
  line: number;
  side: Side;
  body: string;
}

interface Props {
  file: DiffFile;
  headSha: string;
  baseSha: string;
  mode: "split" | "unified";
  wrap: boolean;
  viewed: boolean;
  active: boolean;
  comments: InlineComment[];
  pending: PendingComment[];
  canComment: boolean;
  webUrl: string | null;
  onToggleViewed: () => void;
  onAddPending: (comment: Omit<PendingComment, "id">) => void;
  onRemovePending: (id: string) => void;
}

const LARGE_DIFF = 1200;
const EXPAND_STEP = 20;

export const FileDiff = memo(function FileDiff(props: Props) {
  const { file, viewed, active } = props;
  const [collapsed, setCollapsed] = useState(viewed);
  const [forceLarge, setForceLarge] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visible = useNearViewport(ref);
  const toast = useToast();

  // Collapse when marked viewed, expand when unmarked.
  const wasViewed = useRef(viewed);
  useEffect(() => {
    if (viewed !== wasViewed.current) setCollapsed(viewed);
    wasViewed.current = viewed;
  }, [viewed]);

  const lineCount = useMemo(() => (file.patch ? file.patch.split("\n").length : 0), [file.patch]);
  const tooLarge = lineCount > LARGE_DIFF && !forceLarge;
  const slash = file.path.lastIndexOf("/");

  return (
    <div ref={ref} id={fileAnchor(file.path)} className={`file ${collapsed ? "collapsed" : ""} ${active ? "active" : ""}`} data-path={file.path}>
      <div className="file-head">
        <button className="btn ghost sm icon chev-btn" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Expand file" : "Collapse file"}>
          <ChevronDown size={14} />
        </button>
        <span className={`file-status ${file.status}`} data-tip={file.status}>
          {statusLetter(file.status)}
        </span>
        <div className="file-path" title={file.path}>
          <span>
            {file.previousPath && file.previousPath !== file.path && (
              <span className="dir">{file.previousPath} → </span>
            )}
            <span className="dir">{slash >= 0 ? file.path.slice(0, slash + 1) : ""}</span>
            {file.path.slice(slash + 1)}
          </span>
        </div>
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <span className="spacer" />
        <button
          className="btn ghost sm icon"
          data-tip="Copy path"
          onClick={() => copy(file.path).then((ok) => ok && toast(<>Copied <code>{file.path}</code></>))}
        >
          <Copy size={13} />
        </button>
        {props.webUrl && (
          <a className="btn ghost sm icon" data-tip="Open on GitHub" href={props.webUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={13} />
          </a>
        )}
        <button className={`viewed-toggle ${viewed ? "on" : ""}`} onClick={props.onToggleViewed} data-tip="Mark as viewed" data-kbd="v">
          <span className={`box ${viewed ? "pop" : ""}`}>{viewed && <CheckMark />}</span>
          Viewed
        </button>
      </div>
      {!collapsed &&
        (file.binary || !file.patch ? (
          <div className="file-note">
            <FileCode2 size={16} style={{ verticalAlign: -3, marginRight: 6 }} />
            {file.binary ? "Binary file not shown" : file.status === "renamed" ? "File renamed without changes" : "This diff is too large for GitHub to show here"}
          </div>
        ) : tooLarge ? (
          <div className="file-note">
            Large diff ({lineCount.toLocaleString()} lines).{" "}
            <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setForceLarge(true)}>
              Load diff
            </button>
          </div>
        ) : visible ? (
          <DiffBody {...props} />
        ) : (
          <div className="file-placeholder" style={{ height: Math.min(lineCount, 400) * 20 }} />
        ))}
    </div>
  );
});

export const fileAnchor = (path: string) => `file-${path.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

function statusLetter(status: DiffFile["status"]): string {
  return { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M", unchanged: "·" }[status];
}

function CheckMark() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden>
      <path d="M2.5 6.5l2.3 2.3L9.5 3.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** True once the element comes within ~1000px of the viewport (and stays true). */
function useNearViewport(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !ref.current) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), {
      rootMargin: "1000px 0px",
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

// -----------------------------------------------------------------------------

type Row =
  | { type: "hunk"; hunk: Hunk; index: number }
  | { type: "gap"; gap: Gap; hidden: number; key: string }
  | { type: "line"; line: DiffLine }
  | { type: "thread"; side: Side; line: number };

function DiffBody(props: Props) {
  const { file, wrap, comments, pending } = props;
  // A whole-file addition or deletion has nothing to show on the other side.
  const mode = file.status === "added" || file.status === "removed" ? "unified" : props.mode;
  const hunks = useMemo(() => parsePatch(file.patch ?? ""), [file.patch]);
  const lang = languageFor(file.path);

  // Full file (new side), fetched when the user expands context.
  const [fileLines, setFileLines] = useState<string[] | null>(null);
  const [revealed, setRevealed] = useState<Record<string, number>>({});
  const [loadingGap, setLoadingGap] = useState<string | null>(null);

  const allGaps = useMemo(() => gaps(hunks, fileLines?.length ?? null), [hunks, fileLines]);

  // Syntax tokens: each side highlighted as one block; the full file when loaded.
  const [tokens, setTokens] = useState<{ old: Map<number, Token[]>; new: Map<number, Token[]> }>({ old: new Map(), new: new Map() });
  useEffect(() => {
    let cancelled = false;
    const oldLines = hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "add"));
    const newLines = hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "del"));
    Promise.all([
      highlightLines(oldLines.map((l) => l.text), lang),
      fileLines ? highlightLines(fileLines, lang) : highlightLines(newLines.map((l) => l.text), lang),
    ]).then(([oldTokens, newTokens]) => {
      if (cancelled) return;
      const oldMap = new Map<number, Token[]>();
      const newMap = new Map<number, Token[]>();
      oldTokens?.forEach((t, i) => oldMap.set(oldLines[i].oldNumber!, t));
      if (fileLines) newTokens?.forEach((t, i) => newMap.set(i + 1, t));
      else newTokens?.forEach((t, i) => newMap.set(newLines[i].newNumber!, t));
      setTokens({ old: oldMap, new: newMap });
    });
    return () => {
      cancelled = true;
    };
  }, [hunks, lang, fileLines]);

  const expand = async (key: string, gap: Gap, all: boolean) => {
    let lines = fileLines;
    if (!lines) {
      setLoadingGap(key);
      try {
        lines = (await api.file(props.headSha, file.path)).lines;
        setFileLines(lines);
      } catch {
        setLoadingGap(null);
        return;
      }
      setLoadingGap(null);
    }
    const count = gap.count ?? Math.max(0, lines.length - gap.newStart + 1);
    setRevealed((r) => ({ ...r, [key]: all ? count : Math.min(count, (r[key] ?? 0) + EXPAND_STEP) }));
  };

  // Word-level highlights for replaced lines.
  const words = useMemo(() => {
    const map = new Map<DiffLine, [number, number] | null>();
    for (const hunk of hunks) {
      for (const row of toSplitRows(hunk.lines)) {
        if (row.left && row.right && row.left.kind === "del" && row.right.kind === "add") {
          const { del, add } = wordDiff(row.left.text, row.right.text);
          map.set(row.left, del);
          map.set(row.right, add);
        }
      }
    }
    return map;
  }, [hunks]);

  // Threads: existing comments plus pending ones, by side and line.
  const threads = useMemo(() => {
    const map = new Map<string, { comments: InlineComment[]; pending: PendingComment[] }>();
    const at = (side: Side, line: number) => {
      const key = `${side}:${line}`;
      if (!map.has(key)) map.set(key, { comments: [], pending: [] });
      return map.get(key)!;
    };
    for (const c of comments) if (c.line) at(c.side, c.line).comments.push(c);
    for (const p of pending) at(p.side, p.line).pending.push(p);
    return map;
  }, [comments, pending]);
  const [composerAt, setComposerAt] = useState<string | null>(null);

  // Rows in display order: gap, hunk header, lines (and threads), …, trailing gap.
  const rows = useMemo(() => {
    const result: Row[] = [];
    const gapFor = (index: number) => allGaps.find((g) => g.beforeHunk === index);
    const pushGap = (gap: Gap | undefined, trailing: boolean) => {
      if (!gap) return;
      const key = `gap-${gap.beforeHunk}`;
      const shown = revealed[key] ?? 0;
      const total = gap.count;
      const hidden = total === null ? (fileLines ? 0 : -1) : total - shown;
      if (trailing) {
        // After the last hunk: reveal from the top of the gap down.
        if (fileLines && shown > 0) gapLines(gap, fileLines, 0, shown).forEach((line) => result.push({ type: "line", line }));
        if (hidden !== 0) result.push({ type: "gap", gap, hidden, key });
      } else {
        if (hidden > 0) result.push({ type: "gap", gap, hidden, key });
        if (fileLines && shown > 0) gapLines(gap, fileLines, total! - shown, total!).forEach((line) => result.push({ type: "line", line }));
      }
    };
    hunks.forEach((hunk, index) => {
      pushGap(gapFor(index), false);
      if (!(index > 0 && revealed[`gap-${index}`] === allGaps.find((g) => g.beforeHunk === index)?.count)) {
        result.push({ type: "hunk", hunk, index });
      }
      for (const line of hunk.lines) result.push({ type: "line", line });
    });
    pushGap(gapFor(hunks.length), true);
    return result;
  }, [hunks, allGaps, revealed, fileLines]);

  const codeFor = (line: DiffLine) => {
    const tk = line.kind === "del" ? tokens.old.get(line.oldNumber!) : tokens.new.get(line.newNumber!);
    return <Code text={line.text} tokens={tk ?? null} range={words.get(line) ?? null} kind={line.kind} />;
  };

  // Whole-file additions and deletions have only one line-number column.
  const hideOld = mode === "unified" && file.status === "added";
  const hideNew = mode === "unified" && file.status === "removed";
  const lineNumberCell = (line: DiffLine | null, side: Side, cls = "") => {
    if ((side === "LEFT" && hideOld) || (side === "RIGHT" && hideNew)) return null;
    const number = line ? (side === "LEFT" ? line.oldNumber : line.newNumber) : null;
    const commentable = props.canComment && line && number !== null && (side === "RIGHT" ? line.kind !== "del" : line.kind === "del" || mode === "split");
    return (
      <td className={`ln ${cls}`}>
        {number}
        {commentable && (
          <button
            className="add-comment-btn"
            aria-label={`Comment on line ${number}`}
            onClick={() => setComposerAt(`${side}:${number}`)}
          >
            <Plus size={12} strokeWidth={2.5} />
          </button>
        )}
      </td>
    );
  };

  const colSpan = mode === "split" ? 5 : hideOld || hideNew ? 3 : 4;
  const threadRow = (side: Side, line: number) => {
    const key = `${side}:${line}`;
    const thread = threads.get(key);
    if (!thread && composerAt !== key) return null;
    return (
      <tr key={`thread-${key}`}>
        <td colSpan={colSpan}>
          <Thread
            comments={thread?.comments ?? []}
            pending={thread?.pending ?? []}
            composing={composerAt === key}
            onCancel={() => setComposerAt(null)}
            onSubmit={(body) => {
              props.onAddPending({ path: file.path, line, side, body });
              setComposerAt(null);
            }}
            onRemovePending={props.onRemovePending}
          />
        </td>
      </tr>
    );
  };

  const gapRow = (row: Extract<Row, { type: "gap" }>) => (
    <tr className="hunk" key={row.key}>
      <td colSpan={colSpan}>
        <button className="expand-btn" onClick={() => expand(row.key, row.gap, false)} disabled={loadingGap === row.key}>
          <ChevronsUpDown size={12} />
          {loadingGap === row.key
            ? "Loading…"
            : row.hidden < 0
              ? "Show more lines"
              : row.hidden <= EXPAND_STEP
                ? `Show ${row.hidden} more line${row.hidden === 1 ? "" : "s"}`
                : `Show ${EXPAND_STEP} lines`}
        </button>
        {row.hidden > EXPAND_STEP && (
          <button className="expand-btn" onClick={() => expand(row.key, row.gap, true)}>
            Show all {row.hidden}
          </button>
        )}
      </td>
    </tr>
  );

  const hunkRow = (row: Extract<Row, { type: "hunk" }>) => (
    <tr className="hunk" key={`hunk-${row.index}`}>
      <td colSpan={colSpan}>
        <div className="hunk-text">
          @@ -{row.hunk.oldStart},{row.hunk.oldLines} +{row.hunk.newStart},{row.hunk.newLines} @@{" "}
          <span style={{ color: "var(--text-3)" }}>{row.hunk.section}</span>
        </div>
      </td>
    </tr>
  );

  if (mode === "unified") {
    return (
      <div className="diff-scroll">
        <table className={`diff-table ${wrap ? "wrap" : ""}`}>
          <colgroup>
            {!hideOld && <col style={{ width: 52 }} />}
            {!hideNew && <col style={{ width: 52 }} />}
            <col style={{ width: 18 }} />
            <col />
          </colgroup>
          <tbody>
            {rows.map((row, i) => {
              if (row.type === "hunk") return hunkRow(row);
              if (row.type === "gap") return gapRow(row);
              if (row.type !== "line") return null;
              const { line } = row;
              const side: Side = line.kind === "del" ? "LEFT" : "RIGHT";
              const number = side === "LEFT" ? line.oldNumber! : line.newNumber!;
              return (
                <Fragment key={i}>
                  <tr className={line.kind}>
                    {lineNumberCell(line, "LEFT")}
                    {lineNumberCell(line, "RIGHT")}
                    <td className="marker">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
                    <td className="code">{codeFor(line)}</td>
                  </tr>
                  {threadRow(side, number)}
                  {line.kind === "context" && threadRow("LEFT", line.oldNumber!)}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // Split view: consecutive lines between headers become side-by-side rows.
  const body: ReactNode[] = [];
  let buffer: DiffLine[] = [];
  const flush = () => {
    for (const split of toSplitRows(buffer)) {
      const { left, right } = split;
      const key = `${left?.oldNumber ?? "x"}-${right?.newNumber ?? "x"}-${body.length}`;
      body.push(
        <tr key={key}>
          {left ? lineNumberCell(left, "LEFT", left.kind) : <td className="ln empty" />}
          {left ? <td className={`code ${left.kind}`}>{codeFor(left)}</td> : <td className="empty" />}
          <td className="split-divider" />
          {right ? lineNumberCell(right, "RIGHT", right.kind) : <td className="ln empty" />}
          {right ? <td className={`code ${right.kind}`}>{codeFor(right)}</td> : <td className="empty" />}
        </tr>,
      );
      if (right) {
        const t = threadRow("RIGHT", right.newNumber!);
        if (t) body.push(t);
      }
      if (left && left.kind === "del") {
        const t = threadRow("LEFT", left.oldNumber!);
        if (t) body.push(t);
      }
    }
    buffer = [];
  };
  for (const row of rows) {
    if (row.type === "line") {
      buffer.push(row.line);
      continue;
    }
    flush();
    if (row.type === "hunk") body.push(hunkRow(row));
    if (row.type === "gap") body.push(gapRow(row));
  }
  flush();

  return (
    <div className="diff-scroll">
      <table className={`diff-table split ${wrap ? "wrap" : ""}`}>
        <colgroup>
          <col style={{ width: 48 }} />
          <col />
          <col style={{ width: 1 }} />
          <col style={{ width: 48 }} />
          <col />
        </colgroup>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}

/** Code with syntax colors and an optional changed-range highlight. */
function Code({ text, tokens, range, kind }: { text: string; tokens: Token[] | null; range: [number, number] | null; kind: DiffLine["kind"] }) {
  if (text === "") return <>{"​"}</>;
  const segments: Array<{ text: string; color?: string; light?: string }> = tokens?.length
    ? tokens.map((t) => ({ text: t.content, color: t.dark, light: t.light }))
    : [{ text }];
  if (!range) return <>{segments.map((s, i) => <Seg key={i} {...s} />)}</>;

  const out: ReactNode[] = [];
  let offset = 0;
  const markClass = kind === "add" ? "w-add" : "w-del";
  segments.forEach((seg, i) => {
    const start = offset;
    const end = offset + seg.text.length;
    offset = end;
    const [a, b] = range;
    if (end <= a || start >= b) {
      out.push(<Seg key={i} {...seg} />);
      return;
    }
    const before = seg.text.slice(0, Math.max(0, a - start));
    const inside = seg.text.slice(Math.max(0, a - start), Math.min(seg.text.length, b - start));
    const after = seg.text.slice(Math.min(seg.text.length, b - start));
    if (before) out.push(<Seg key={`${i}a`} {...seg} text={before} />);
    out.push(
      <mark key={`${i}b`} className={markClass}>
        <Seg {...seg} text={inside} />
      </mark>,
    );
    if (after) out.push(<Seg key={`${i}c`} {...seg} text={after} />);
  });
  return <>{out}</>;
}

function Seg({ text, color, light }: { text: string; color?: string; light?: string }) {
  if (!color && !light) return <>{text}</>;
  return <span style={{ "--shiki-dark": color, "--shiki-light": light ?? color } as React.CSSProperties}>{text}</span>;
}

function Thread(props: {
  comments: InlineComment[];
  pending: PendingComment[];
  composing: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
  onRemovePending: (id: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  return (
    <div className="inline-thread">
      {props.comments.map((c) => (
        <div className="inline-comment" key={c.id}>
          <div className="event-head">
            <Avatar person={c.author} size="sm" />
            <b>{c.author?.login}</b>
            <span>{timeAgo(c.createdAt)}</span>
          </div>
          <Markdown html={c.bodyHtml} />
        </div>
      ))}
      {props.pending.map((p) => (
        <div className="inline-comment" key={p.id}>
          <div className="event-head">
            <span className="pending-tag">Pending</span>
            <span className="faint">Submitted with your review</span>
            <span style={{ flex: 1 }} />
            <button className="btn ghost sm" onClick={() => props.onRemovePending(p.id)}>
              Remove
            </button>
          </div>
          <div style={{ whiteSpace: "pre-wrap" }}>{p.body}</div>
        </div>
      ))}
      {props.composing || replying ? (
        <Composer
          autoFocus
          placeholder="Leave a comment"
          submitLabel="Add to review"
          onCancel={() => {
            setReplying(false);
            props.onCancel();
          }}
          onSubmit={async (body) => {
            props.onSubmit(body);
            setReplying(false);
          }}
        />
      ) : (
        props.comments.length + props.pending.length > 0 && (
          <div style={{ padding: "0 8px 8px" }}>
            <button className="btn ghost sm" onClick={() => setReplying(true)}>
              Reply…
            </button>
          </div>
        )
      )}
    </div>
  );
}
