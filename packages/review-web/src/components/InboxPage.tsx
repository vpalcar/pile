import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, GitBranch, Layers, MessageSquare, Search, Sparkles } from "lucide-react";
import type { Inbox, InboxGroup, InboxItem, Session } from "../api";
import { api, prefetch, refKey } from "../lib/client";
import { navigate, plural, timeAgo, useNow, useShortcuts, usePersisted } from "../lib/util";
import { Avatar, ChecksDot, Kbd, PRStateIcon } from "./ui";

type Filter = "all" | InboxGroup["id"];

const FILTERS: Array<[Filter, string]> = [
  ["all", "All"],
  ["needs_review", "Needs review"],
  ["mine", "Yours"],
  ["local", "Local"],
  ["others", "Others"],
];

const GROUP_TITLES: Record<InboxGroup["id"], string> = {
  needs_review: "Waiting for your review",
  mine: "Your pull requests",
  local: "Local branches",
  others: "Everyone else",
};

/** A stack of related items (bottom first) or a single item. */
interface Cluster {
  key: string;
  items: InboxItem[];
}

function clusters(items: InboxItem[]): Cluster[] {
  const out: Cluster[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    const prev = last?.items[last.items.length - 1];
    if (prev && item.stack && prev.stack && item.base === prev.branch) last.items.push(item);
    else out.push({ key: item.id, items: [item] });
  }
  return out;
}

export function InboxPage({ inbox, session, loading }: { inbox: Inbox | undefined; session: Session | undefined; loading: boolean }) {
  useNow();
  const [filter, setFilter] = usePersisted<Filter>("pile:inbox-filter", "all");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = usePersisted<string | null>("pile:inbox-cursor", null);
  const searchRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (inbox?.groups ?? [])
      .filter((g) => filter === "all" || g.id === filter)
      .map((g) => ({
        ...g,
        items: q
          ? g.items.filter((i) =>
              [i.title, i.branch, i.author?.login ?? "", i.ref.kind === "pr" ? `#${i.ref.number}` : ""].some((s) => s.toLowerCase().includes(q)),
            )
          : g.items,
      }))
      .filter((g) => g.items.length > 0 || (g.id === "needs_review" && !q));
  }, [inbox, filter, query]);

  const visible = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const index = Math.max(0, visible.findIndex((i) => i.id === cursor));
  const counts = useMemo(() => {
    const all = inbox?.groups ?? [];
    return Object.fromEntries([["all", all.reduce((n, g) => n + g.items.length, 0)], ...all.map((g) => [g.id, g.items.length])]) as Record<Filter, number>;
  }, [inbox]);

  // Warm the first few so opening them is instant.
  useEffect(() => {
    visible.slice(0, 6).forEach((i) => prefetch(refKey(i.ref), () => api.detail(i.ref)));
  }, [visible]);

  useEffect(() => {
    document.querySelector(`[data-row="${CSS.escape(visible[index]?.id ?? "")}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, visible]);

  const move = (delta: number) => {
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + delta))];
    if (next) {
      setCursor(next.id);
      prefetch(refKey(next.ref), () => api.detail(next.ref));
    }
  };

  useShortcuts(
    {
      j: () => move(1),
      k: () => move(-1),
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      Enter: () => visible[index] && navigate(visible[index].ref),
      o: () => visible[index] && navigate(visible[index].ref),
      "/": () => searchRef.current?.focus(),
      ...Object.fromEntries(FILTERS.map(([id], i) => [String(i + 1), () => setFilter(id)])),
    },
    [visible, index],
  );

  const viewer = session?.viewer?.login;
  const waiting = counts.needs_review ?? 0;

  return (
    <div className="inbox-page">
      <header className="inbox-hero">
        <div>
          <div className="eyebrow">{session?.repo ? `${session.repo.owner} / ${session.repo.name}` : "Local repository"}</div>
          <h1>{greeting()}{viewer ? `, ${viewer}` : ""}</h1>
          <p className="muted">
            {loading && !inbox
              ? "Loading pull requests…"
              : waiting > 0
                ? `${plural(waiting, "pull request")} ${waiting === 1 ? "is" : "are"} waiting for your review.`
                : "Nothing is waiting for your review."}{" "}
            {counts.mine ? `${plural(counts.mine, "of yours", "of yours")} open. ` : ""}
            {counts.local ? `${plural(counts.local, "local branch", "local branches")} not on GitHub yet.` : ""}
          </p>
        </div>
      </header>

      <div className="inbox-toolbar">
        <div className="tabs" role="tablist">
          {FILTERS.map(([id, label], i) => (
            <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? "on" : ""} onClick={() => setFilter(id)} data-tip={label} data-kbd={String(i + 1)}>
              {label}
              <span className="num">{counts[id] ?? 0}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="input-wrap inbox-search">
          <Search size={13} />
          <input
            ref={searchRef}
            className="input"
            placeholder="Filter by title, branch or author"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "Enter" && visible[0]) navigate(visible[0].ref);
            }}
          />
          <Kbd>/</Kbd>
        </div>
      </div>

      {loading && !inbox ? (
        <InboxSkeleton />
      ) : visible.length === 0 && groups.every((g) => g.items.length === 0) && query ? (
        <div className="inbox-empty">No pull requests or branches match “{query}”.</div>
      ) : (
        groups.map((group) => (
          <section className="inbox-group" key={group.id}>
            <h2>
              {GROUP_TITLES[group.id]}
              <span className="num">{group.items.length}</span>
              {inbox?.partial && <span className="loading-dots" aria-label="Loading details" />}
            </h2>
            {group.items.length === 0 ? (
              <div className="inbox-empty caught-up">
                <Sparkles size={15} /> You're all caught up.
              </div>
            ) : (
              <div className="inbox-list">
                {clusters(group.items).map((cluster) =>
                  cluster.items.length > 1 ? (
                    <StackCluster key={cluster.key} cluster={cluster} cursor={visible[index]?.id} onHover={setCursor} />
                  ) : (
                    <Row key={cluster.key} item={cluster.items[0]} active={visible[index]?.id === cluster.items[0].id} onHover={setCursor} />
                  ),
                )}
              </div>
            )}
          </section>
        ))
      )}

      <footer className="inbox-foot">
        <span>
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span>
          <Kbd>1</Kbd>–<Kbd>5</Kbd> filter
        </span>
        <span>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd> jump anywhere
        </span>
      </footer>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function StackCluster({ cluster, cursor, onHover }: { cluster: Cluster; cursor: string | undefined; onHover: (id: string) => void }) {
  const [open, setOpen] = useState(cluster.items.length <= 6 || cluster.items.some((i) => i.id === cursor));
  const top = [...cluster.items].reverse();
  const shown = open ? top : [...top.slice(0, 2), ...top.slice(-1)];
  const bottom = cluster.items[0];
  return (
    <div className="stack-card">
      <div className="stack-card-head">
        <Layers size={13} />
        <span>
          Stack of {cluster.items.length} on <code>{bottom.base}</code>
        </span>
        {bottom.stack?.nativeStack && <span className="pill ghost">GitHub stack #{bottom.stack.nativeStack}</span>}
        <span className="spacer" />
        <StackMap items={cluster.items} />
      </div>
      <div className="stack-card-rows">
        {shown.map((item, i) => (
          <div key={item.id}>
            {!open && i === 2 && (
              <button className="stack-expand" onClick={() => setOpen(true)}>
                {cluster.items.length - 3} more in this stack
              </button>
            )}
            <Row item={item} active={cursor === item.id} onHover={onHover} stacked />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One segment per stack entry, colored by its review state, bottom on the left. */
function StackMap({ items }: { items: InboxItem[] }) {
  return (
    <span className="stack-map" aria-hidden>
      {items.slice(0, 12).map((i) => (
        <i key={i.id} className={i.reviewDecision === "approved" ? "ok" : i.reviewDecision === "changes_requested" ? "bad" : i.state === "local" ? "local" : ""} />
      ))}
    </span>
  );
}

const Row = memo(function Row({ item, active, onHover, stacked }: { item: InboxItem; active: boolean; onHover: (id: string) => void; stacked?: boolean }) {
  const total = (item.additions ?? 0) + (item.deletions ?? 0);
  return (
    <a
      data-row={item.id}
      href={item.ref.kind === "pr" ? `#/pr/${item.ref.number}` : `#/branch/${encodeURIComponent(item.ref.name)}`}
      className={`row ${active ? "active" : ""} ${stacked ? "stacked" : ""}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(item.ref);
      }}
      onMouseEnter={() => {
        onHover(item.id);
        prefetch(refKey(item.ref), () => api.detail(item.ref));
      }}
    >
      <span className="row-icon">{stacked ? <span className="row-node" /> : item.state === "local" ? <GitBranch size={15} color="var(--text-3)" /> : <PRStateIcon state={item.state} />}</span>
      <span className="row-main">
        <span className="row-title">
          {item.title}
          {item.state === "draft" && <span className="pill">Draft</span>}
          {item.local?.unpushed && item.state !== "local" && <span className="pill amber">Unpushed</span>}
        </span>
        <span className="row-meta">
          {item.ref.kind === "pr" && <span className="num">#{item.ref.number}</span>}
          <span className="mono">{item.branch}</span>
          {item.author && (
            <>
              <span className="sep">·</span>
              <span>{item.author.login}</span>
            </>
          )}
        </span>
      </span>
      <span className="row-signals">
        <Decision item={item} />
        <ChecksDot checks={item.checks} />
        {item.comments > 0 && (
          <span className="faint num row-comments" data-tip={plural(item.comments, "comment")}>
            <MessageSquare size={12} />
            {item.comments}
          </span>
        )}
        {item.additions !== null ? (
          <span className="size" data-tip={`+${item.additions} −${item.deletions}`}>
            <span className="size-bar">
              <i className="a" style={{ width: `${sizeWidth(total) * ((item.additions ?? 0) / Math.max(1, total))}px` }} />
              <i className="d" style={{ width: `${sizeWidth(total) * ((item.deletions ?? 0) / Math.max(1, total))}px` }} />
            </span>
            <span className="num">{compact(total)}</span>
          </span>
        ) : (
          <span className="size skeleton-inline" />
        )}
        <span className="row-time num" data-tip={item.updatedAt ?? undefined}>
          {timeAgo(item.updatedAt).replace(" ago", "")}
        </span>
        <ArrowUpRight size={14} className="row-go" />
      </span>
    </a>
  );
});

function Decision({ item }: { item: InboxItem }) {
  switch (item.reviewDecision) {
    case "approved":
      return <span className="pill green">Approved</span>;
    case "changes_requested":
      return <span className="pill red">Changes</span>;
    case "review_required":
      return item.state === "draft" ? null : <span className="pill blue">Review</span>;
    case "commented":
      return <span className="pill">Commented</span>;
    default:
      return null;
  }
}

const sizeWidth = (lines: number) => Math.max(6, Math.min(56, Math.log10(lines + 1) * 20));
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function InboxSkeleton() {
  return (
    <div className="inbox-list" aria-busy>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="row" style={{ pointerEvents: "none" }}>
          <span className="skeleton" style={{ width: 16, height: 16, borderRadius: 8 }} />
          <span style={{ display: "grid", gap: 7 }}>
            <span className="skeleton" style={{ height: 12, width: `${60 - i * 7}%` }} />
            <span className="skeleton" style={{ height: 10, width: "30%" }} />
          </span>
          <span />
        </div>
      ))}
    </div>
  );
}

