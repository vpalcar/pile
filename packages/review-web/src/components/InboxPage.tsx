import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, GitBranch, Layers, MessageSquare, Search, Sparkles } from "lucide-react";
import type { Inbox, InboxGroup, InboxItem, Session } from "../api";
import { api, prefetch, refKey } from "../lib/client";
import { itemReadiness } from "../lib/status";
import { navigate, plural, timeAgo, useNow, useShortcuts, usePersisted } from "../lib/util";
import { ChecksDot, cx, Kbd, Pill, PRStateIcon, StatusBadge } from "./ui";

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

/**
 * Row columns, shared by every row so badges, sizes and times line up:
 * icon · title · status · checks · comments · size · time · arrow
 */
const ROW_GRID = "grid grid-cols-[22px_minmax(0,1fr)_136px_10px_40px_96px_44px_14px] items-center gap-x-3";

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
    <div data-page="inbox" data-partial={inbox?.partial ? "" : undefined} className="mx-auto max-w-[1100px] px-8 pb-20 pt-11">
      <header>
        <div className="font-mono text-[11.5px] leading-none text-fg-3">{session?.repo ? `${session.repo.owner} / ${session.repo.name}` : "Local repository"}</div>
        <h1 className="mb-2 mt-3 text-[30px] font-semibold leading-tight tracking-[-0.03em]">
          {greeting()}
          {viewer ? `, ${viewer}` : ""}
        </h1>
        <p className="max-w-[64ch] text-sm text-fg-2">
          {loading && !inbox
            ? "Loading pull requests…"
            : waiting > 0
              ? `${plural(waiting, "pull request")} ${waiting === 1 ? "is" : "are"} waiting for your review.`
              : "Nothing is waiting for your review."}{" "}
          {counts.mine ? `${plural(counts.mine, "of yours", "of yours")} open. ` : ""}
          {counts.local ? `${plural(counts.local, "local branch", "local branches")} not on GitHub yet.` : ""}
        </p>
      </header>

      <div className="sticky top-0 z-10 mb-2 mt-7 flex items-center gap-3 bg-gradient-to-b from-bg from-70% to-transparent py-2.5">
        <div className="inline-flex items-center gap-0.5 rounded-[10px] border border-line bg-panel p-[3px]" role="tablist">
          {FILTERS.map(([id, label], i) => (
            <button
              key={id}
              role="tab"
              aria-selected={filter === id}
              onClick={() => setFilter(id)}
              data-tip={label}
              data-kbd={String(i + 1)}
              className={cx(
                "inline-flex h-7 items-center gap-2 rounded-[7px] px-3 font-medium leading-none transition-colors",
                filter === id ? "bg-active text-fg shadow-[0_0_0_1px_var(--border-2)]" : "text-fg-2 hover:text-fg",
              )}
            >
              {label}
              <span
                className={cx(
                  "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md px-1 text-[11px] leading-none tabular",
                  filter === id ? "bg-accent-soft text-accent" : "bg-panel-2 text-fg-3",
                )}
              >
                {counts[id] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <label className="relative flex h-8 w-[300px] items-center">
          <Search size={13} className="pointer-events-none absolute left-2.5 text-fg-3" />
          <input
            ref={searchRef}
            className="h-8 w-full rounded-lg border border-line bg-panel pl-8 pr-8 text-[12.5px] text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-3 focus:border-line-3 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
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
          <span className="pointer-events-none absolute right-2 flex">
            <Kbd>/</Kbd>
          </span>
        </label>
      </div>

      {loading && !inbox ? (
        <InboxSkeleton />
      ) : visible.length === 0 && query ? (
        <div className="rounded-xl border border-dashed border-line-2 p-5 text-center text-fg-3">No pull requests or branches match “{query}”.</div>
      ) : (
        groups.map((group) => (
          <section className="mt-7" key={group.id}>
            <h2 className="mb-2.5 ml-0.5 flex h-5 items-center gap-2 text-[13px] font-semibold leading-none tracking-[-0.005em]">
              {GROUP_TITLES[group.id]}
              <span className="font-normal text-fg-3 tabular">{group.items.length}</span>
              {inbox?.partial && <span className="animate-pulse-soft tracking-[2px] text-fg-3">···</span>}
            </h2>
            {group.items.length === 0 ? (
              <div className="flex h-14 items-center justify-center gap-2 rounded-xl border border-line bg-panel text-fg-2">
                <Sparkles size={15} className="shrink-0" /> You're all caught up.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
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

      <footer className="mt-10 flex justify-center gap-5 text-xs text-fg-3">
        {[
          [["j", "k"], "move"],
          [["↵"], "open"],
          [["1", "5"], "filter"],
          [["⌘", "K"], "jump anywhere"],
        ].map(([keys, label]) => (
          <span key={label as string} className="inline-flex items-center gap-1">
            {(keys as string[]).map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
            <span className="ml-0.5">{label as string}</span>
          </span>
        ))}
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
    <div className="overflow-hidden rounded-[14px] border border-line bg-panel/60">
      <div className="flex h-10 items-center gap-2 border-b border-line px-4 text-xs leading-none text-fg-2">
        <Layers size={13} className="shrink-0" />
        <span className="inline-flex items-center gap-1">
          Stack of {cluster.items.length} on <code className="text-[11.5px] text-fg">{bottom.base}</code>
        </span>
        {bottom.stack?.nativeStack && <Pill>GitHub stack #{bottom.stack.nativeStack}</Pill>}
        <span className="flex-1" />
        <StackMap items={cluster.items} />
      </div>
      <div className="flex flex-col gap-1 p-1.5">
        {shown.map((item, i) => (
          <div key={item.id} className={cx(i === 0 && "rail-first", i === shown.length - 1 && "rail-last")}>
            {!open && i === 2 && (
              <button className={cx(ROW_GRID, "mb-1 h-8 w-full rounded-lg px-4 text-left text-xs text-fg-3 hover:bg-hover hover:text-fg-2")} onClick={() => setOpen(true)}>
                <span className="rail-node rail-dashed" />
                <span>{cluster.items.length - 3} more in this stack</span>
              </button>
            )}
            <Row item={item} active={cursor === item.id} onHover={onHover} stacked />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One segment per stack entry, colored by its status, bottom on the left. */
function StackMap({ items }: { items: InboxItem[] }) {
  const tone = { green: "bg-ok", red: "bg-bad", amber: "bg-warn/80", blue: "bg-accent", purple: "bg-merged", gray: "bg-line-3" } as const;
  return (
    <span className="inline-flex items-center gap-[3px]">
      {items.slice(0, 12).map((i) => {
        const status = itemReadiness(i);
        return <i key={i.id} className={cx("h-1.5 w-3.5 rounded-full", tone[status.tone])} data-tip={`${i.ref.kind === "pr" ? `#${i.ref.number}` : i.branch}: ${status.label}`} />;
      })}
    </span>
  );
}

const Row = memo(function Row({ item, active, onHover, stacked }: { item: InboxItem; active: boolean; onHover: (id: string) => void; stacked?: boolean }) {
  const total = (item.additions ?? 0) + (item.deletions ?? 0);
  const loadingSignals = item.checks === null && item.state !== "local" && item.state !== "draft";
  return (
    <a
      data-row={item.id}
      href={item.ref.kind === "pr" ? `#/pr/${item.ref.number}` : `#/branch/${encodeURIComponent(item.ref.name)}`}
      className={cx(
        ROW_GRID,
        "group relative min-h-[58px] px-4 py-2.5 text-fg no-underline transition-[background,border-color,box-shadow] duration-150",
        stacked
          ? cx("rounded-[10px] border", active ? "border-accent/40 bg-accent-soft" : "border-transparent hover:bg-hover")
          : cx("rounded-xl border bg-panel", active ? "border-accent/55 shadow-[0_0_0_3px_var(--accent-soft)]" : "border-line hover:border-line-2 hover:bg-panel-2"),
      )}
      onClick={(e) => {
        e.preventDefault();
        navigate(item.ref);
      }}
      onMouseEnter={() => {
        onHover(item.id);
        prefetch(refKey(item.ref), () => api.detail(item.ref));
      }}
    >
      {stacked ? (
        <span className="rail-node">
          <i className={cx("block size-2.5 rounded-full border-2 bg-bg", active ? "border-accent bg-accent shadow-[0_0_0_4px_var(--accent-soft)]" : "border-fg-3")} />
        </span>
      ) : (
        <span className="grid place-items-center">{item.state === "local" ? <GitBranch size={15} className="shrink-0 text-fg-3" /> : <PRStateIcon state={item.state} />}</span>
      )}

      <span className="grid min-w-0 gap-1">
        <span className="truncate text-sm font-medium leading-5 tracking-[-0.01em]">{item.title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-fg-3">
          {item.ref.kind === "pr" && <span className="shrink-0 tabular">#{item.ref.number}</span>}
          <span className="truncate font-mono text-[11.5px]">{item.branch}</span>
          {item.author && (
            <>
              <span className="text-fg-4">·</span>
              <span className="shrink-0">{item.author.login}</span>
            </>
          )}
        </span>
      </span>

      <span className="flex">{loadingSignals ? <span className="skeleton h-[22px] w-20 rounded-full" /> : <StatusBadge status={itemReadiness(item)} />}</span>
      <span className="flex justify-center">
        <ChecksDot checks={item.checks} />
      </span>
      <span className="flex items-center justify-end gap-1 text-xs leading-none text-fg-3 tabular" data-tip={item.comments ? plural(item.comments, "comment") : undefined}>
        {item.comments > 0 && (
          <>
            <MessageSquare size={12} className="shrink-0" />
            {item.comments}
          </>
        )}
      </span>
      <span className="flex items-center justify-end gap-2" data-tip={item.additions !== null ? `+${item.additions} −${item.deletions}` : undefined}>
        {item.additions !== null ? (
          <>
            <span className="inline-flex h-1.5 overflow-hidden rounded-full bg-panel-3">
              <i className="h-full bg-ok" style={{ width: `${sizeWidth(total) * ((item.additions ?? 0) / Math.max(1, total))}px` }} />
              <i className="h-full bg-bad" style={{ width: `${sizeWidth(total) * ((item.deletions ?? 0) / Math.max(1, total))}px` }} />
            </span>
            <span className="w-8 text-right font-mono text-[11px] leading-none text-fg-3 tabular">{compact(total)}</span>
          </>
        ) : (
          <span className="h-1.5 w-16 animate-pulse-soft rounded-full bg-panel-3" />
        )}
      </span>
      <span className="text-right text-xs leading-none text-fg-3 tabular" data-tip={item.updatedAt ?? undefined}>
        {timeAgo(item.updatedAt).replace(" ago", "")}
      </span>
      <ArrowUpRight size={14} className="-translate-x-0.5 translate-y-0.5 text-fg-2 opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100" />
    </a>
  );
});

const sizeWidth = (lines: number) => Math.max(6, Math.min(56, Math.log10(lines + 1) * 20));
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function InboxSkeleton() {
  return (
    <div className="mt-7 flex flex-col gap-2" aria-busy>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className={cx(ROW_GRID, "min-h-[58px] rounded-xl border border-line bg-panel px-4")}>
          <span className="skeleton size-4 rounded-full" />
          <span className="grid gap-2">
            <span className="skeleton h-3" style={{ width: `${60 - i * 7}%` }} />
            <span className="skeleton h-2.5 w-1/3" />
          </span>
        </div>
      ))}
    </div>
  );
}
