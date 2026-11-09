import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronDown, GitBranch, GitPullRequest, Inbox as InboxIcon, Layers, MessageSquare, Search, Sparkles } from "lucide-react";
import type { Inbox, InboxGroup, InboxItem, Session } from "../api";
import { prefetchDetail } from "../lib/queries";
import { itemReadiness } from "../lib/status";
import { modKey, navigate, plural, timeAgo, useNow, useShortcuts, usePersisted } from "../lib/util";
import { Avatar, ChecksDot, cx, Kbd, Pill, PRStateIcon, StatusBadge } from "./ui";
import { clusters, type Cluster } from "./Inbox";
import { RailCell, railWidth } from "./StackRail";
import type { RailRow } from "../lib/stack-tree";

type Filter = "all" | InboxGroup["id"];

const FILTERS: Array<[Filter, string]> = [
  ["all", "All"],
  ["needs_review", "Needs review"],
  ["mine", "Yours"],
  ["local", "Local"],
];

const GROUP_TITLES: Record<InboxGroup["id"], string> = {
  needs_review: "Waiting for your review",
  mine: "Your pull requests",
  local: "Local branches",
  others: "Other open pull requests",
};

/**
 * Row columns, shared by every row so badges, sizes and times line up:
 * icon · title · status · checks · comments · size · time · arrow
 */
/** PRs a section shows before "Show all" (whole stacks, so it can be a few more). */
const SECTION_LIMIT = 10;
/** How many PRs "Recently in review" shows. */
const RECENT = 5;
const ROW_GRID = "grid grid-cols-[22px_minmax(0,1fr)_136px_10px_40px_96px_44px_14px] items-center gap-x-3";
/** The same columns with a wider rail for diverging stacks; everything else stays aligned. */
const rowColumns = (lanes: number) => ({ gridTemplateColumns: `${railWidth(lanes)}px minmax(0,1fr) 136px 10px 40px 96px 44px 14px` });

export function InboxPage({ inbox, session, loading, onSearch }: { inbox: Inbox | undefined; session: Session | undefined; loading: boolean; onSearch: () => void }) {
  useNow();
  const [filter, setFilter] = usePersisted<Filter>("pile:inbox-filter", "all");
  const [cursor, setCursor] = usePersisted<string | null>("pile:inbox-cursor", null);
  // The filter bar gets a hairline border once it sticks to the top.
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!sentinel.current) return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), { threshold: 0 });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, []);

  // The inbox is your work; everyone else's PRs are found with ⌘K.
  const groups = useMemo(() => {
    const shown = FILTERS.some(([id]) => id === filter) ? filter : "all";
    return (inbox?.groups ?? [])
      .filter((g) => !g.searchOnly && g.id !== "others" && (shown === "all" || g.id === shown))
      .filter((g) => g.items.length > 0 || g.id === "needs_review");
  }, [inbox, filter]);

  // The few PRs most recently active in review, one row each (not their whole stacks).
  const recent = useMemo(
    () =>
      (inbox?.groups ?? [])
        .filter((g) => g.id === "needs_review" || g.id === "mine")
        .flatMap((g) => g.items)
        // In review: open on GitHub and not a draft, whatever the verdict or checks.
        .filter((i) => i.state === "open")
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .slice(0, RECENT),
    [inbox],
  );

  // Display order: stacks top first, as drawn, so j / k move the way the rows read.
  // Sections fold (remembered), and long ones show their first ~10 PRs, whole stacks only.
  const [collapsed, setCollapsed] = usePersisted<Record<string, boolean>>("pile:inbox-collapsed", {});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  const shown = useMemo(() => {
    const result = new Map<string, ReturnType<typeof clusters>>();
    for (const g of groups) {
      if (collapsed[g.id]) {
        result.set(g.id, []);
        continue;
      }
      const all = clusters(g.items);
      let count = 0;
      result.set(g.id, showAll[g.id] ? all : all.filter((c) => (count += c.items.length) - c.items.length < SECTION_LIMIT));
    }
    return result;
  }, [groups, collapsed, showAll]);
  // j / k move through the rows on screen.
  const visible = useMemo(() => groups.flatMap((g) => (shown.get(g.id) ?? []).flatMap((c) => c.items)), [groups, shown]);
  const index = Math.max(0, visible.findIndex((i) => i.id === cursor));
  const counts = useMemo(() => {
    const all = inbox?.groups ?? [];
    const inboxGroups = all.filter((g) => !g.searchOnly);
    return Object.fromEntries([["all", inboxGroups.reduce((n, g) => n + g.items.length, 0)], ...all.map((g) => [g.id, g.items.length])]) as Record<Filter, number>;
  }, [inbox]);

  // Warm the first few so opening them is instant.
  useEffect(() => {
    visible.slice(0, 6).forEach((i) => prefetchDetail(i.ref));
  }, [visible]);

  useEffect(() => {
    document.querySelector(`[data-row="${CSS.escape(visible[index]?.id ?? "")}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, visible]);

  const move = (delta: number) => {
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + delta))];
    if (next) {
      setCursor(next.id);
      prefetchDetail(next.ref);
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
      ...Object.fromEntries(FILTERS.map(([id], i) => [String(i + 1), () => setFilter(id)])),
    },
    [visible, index],
  );

  const viewer = session?.viewer?.login;
  const waiting = counts.needs_review ?? 0;

  return (
    <div data-page="inbox" data-partial={inbox?.partial ? "" : undefined} className="mx-auto max-w-[1100px] px-8 pb-20 pt-11">
      <header>
        <div className="font-mono text-[11.5px] leading-3 text-fg-3">{session?.repo ? `${session.repo.owner} / ${session.repo.name}` : "Local repository"}</div>
        <h1 className="mb-2 mt-3 text-[30px] font-semibold leading-[38px] tracking-[-0.03em]">
          {greeting()}
          {viewer ? `, ${viewer}` : ""}
        </h1>
        <p className="max-w-[72ch] text-sm text-fg-2 text-pretty">
          {loading && !inbox
            ? "Loading pull requests…"
            : waiting > 0
              ? `${plural(waiting, "pull request")} ${waiting === 1 ? "is" : "are"} waiting for your review.`
              : "Nothing is waiting for your review."}{" "}
          {counts.mine ? `${plural(counts.mine, "of yours", "of yours")} open. ` : ""}
          {counts.local ? `${plural(counts.local, "local branch", "local branches")} not on GitHub yet.` : ""}
        </p>
      </header>

      <div ref={sentinel} className="mt-7 h-px" aria-hidden />
      <div
        className={cx(
          "sticky top-0 z-10 -mx-8 mb-2 flex items-center gap-3 bg-bg px-8 py-2.5",
          // The hairline spans the content column, not the padded bleed.
          "after:absolute after:inset-x-8 after:bottom-0 after:h-px after:transition-colors",
          stuck ? "after:bg-line" : "after:bg-transparent",
        )}
      >
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
        <button
          className="inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg-2"
          onClick={onSearch}
          data-tip="Search every open pull request"
        >
          <Search size={13} />
          Search all PRs
          <Kbd>/</Kbd>
        </button>
      </div>

      {loading && !inbox ? (
        <InboxSkeleton />
      ) : groups.length === 0 ? (
        <EmptyTab filter={filter} onSearch={onSearch} />
      ) : (
        groups.map((group) => (
          <Fragment key={group.id}>
          {/* Under All, right after what waits for your review (or first, if nothing does). */}
          {filter === "all" && recent.length > 0 && group === (groups.find((g) => g.id !== "needs_review") ?? groups[groups.length - 1]) && group.id !== "needs_review" && (
            <RecentSection items={recent} collapsed={!!collapsed.recent} onToggle={() => toggle("recent")} />
          )}
          <section className="mt-7" data-section={group.id}>
            <SectionHeader title={GROUP_TITLES[group.id]} count={group.items.length} collapsed={!!collapsed[group.id]} onToggle={() => toggle(group.id)}>
              {inbox?.partial && <span className="animate-pulse-soft tracking-[2px] text-fg-3">···</span>}
            </SectionHeader>
            {collapsed[group.id] ? null : group.items.length === 0 ? (
              <div className="flex h-14 items-center justify-center gap-2 rounded-xl border border-line bg-panel text-fg-2">
                <Sparkles size={15} className="shrink-0" /> You're all caught up.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {(shown.get(group.id) ?? []).map((cluster) =>
                  cluster.items.length > 1 ? (
                    <StackCluster key={cluster.key} cluster={cluster} cursor={visible[index]?.id} onHover={setCursor} loading={!!inbox?.partial} />
                  ) : (
                    <Row key={cluster.key} item={cluster.items[0]} active={visible[index]?.id === cluster.items[0].id} onHover={setCursor} loading={!!inbox?.partial} />
                  ),
                )}
                {(() => {
                  const hidden = group.items.length - (shown.get(group.id) ?? []).reduce((n, c) => n + c.items.length, 0);
                  return hidden > 0 ? (
                    <button
                      className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-2 text-[12.5px] text-fg-2 hover:border-line-3 hover:bg-hover hover:text-fg"
                      onClick={() => setShowAll((s) => ({ ...s, [group.id]: true }))}
                    >
                      <ChevronDown size={13} /> Show all {group.items.length} <span className="text-fg-3">({hidden} more)</span>
                    </button>
                  ) : null;
                })()}
              </div>
            )}
          </section>
          </Fragment>
        ))
      )}
      {!(loading && !inbox) && filter === "all" && recent.length > 0 && groups.every((g) => g.id === "needs_review") && (
        <RecentSection items={recent} collapsed={!!collapsed.recent} onToggle={() => toggle("recent")} />
      )}

      <footer className="mt-10 flex justify-center gap-5 text-xs text-fg-3">
        {[
          [["j", "k"], "move"],
          [["↵"], "open"],
          [["1–4"], "filter"],
          [["/"], "search"],
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

/** The latest open PRs among yours and those waiting on you, one row each. */
function RecentSection({ items, collapsed, onToggle }: { items: InboxItem[]; collapsed: boolean; onToggle: () => void }) {
  return (
    <section className="mt-7" data-recent>
      <SectionHeader title="Recently in review" count={items.length} collapsed={collapsed} onToggle={onToggle}>
        <span className="font-normal text-fg-3">latest activity first</span>
      </SectionHeader>
      {!collapsed && (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <Row key={item.id} item={item} active={false} onHover={() => {}} showStack recent />
          ))}
        </div>
      )}
    </section>
  );
}

/** A section's title and count; click to fold the section away. */
function SectionHeader({ title, count, collapsed, onToggle, children }: { title: string; count: number; collapsed: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <h2 className={cx("ml-0.5 flex h-6 items-center gap-2 text-[13px] font-semibold leading-none tracking-[-0.005em]", collapsed ? "mb-0" : "mb-2")}>
      <button
        className="-ml-2 inline-flex h-6 items-center gap-1.5 rounded-md pl-1 pr-2 transition-colors hover:bg-hover"
        aria-expanded={!collapsed}
        onClick={onToggle}
        data-tip={collapsed ? "Show" : "Hide"}
      >
        <ChevronDown size={14} className={cx("shrink-0 text-fg-3 transition-transform duration-150", collapsed && "-rotate-90")} />
        {title}
        <span className="font-normal text-fg-3 tabular">{count}</span>
      </button>
      {children}
    </h2>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function StackCluster({ cluster, cursor, onHover, loading }: { cluster: Cluster; cursor: string | undefined; onHover: (id: string) => void; loading: boolean }) {
  // Long straight stacks fold to their ends; diverging ones always show every branch.
  const [open, setOpen] = useState(cluster.lanes > 1 || cluster.items.length <= 6 || cluster.items.some((i) => i.id === cursor));
  const top = cluster.items;
  const shown = open ? top : [...top.slice(0, 2), ...top.slice(-1)];
  const bottom = top[top.length - 1];
  const branches = cluster.lanes > 1 ? ` · ${cluster.lanes} branches` : "";
  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-panel/60">
      <div className="flex h-10 items-center gap-2 border-b border-line px-4 text-xs leading-none text-fg-2">
        <Layers size={13} className="shrink-0" />
        <span className="inline-flex items-center gap-1">
          Stack of {cluster.items.length} on <code className="text-[11.5px] text-fg">{bottom.base}</code>
          {branches}
        </span>
        {bottom.stack?.nativeStack && <Pill>GitHub stack #{bottom.stack.nativeStack}</Pill>}
        <span className="flex-1" />
        <StackMap items={cluster.items} />
      </div>
      <div className="flex flex-col gap-1 p-1.5" data-stack-lanes={cluster.lanes}>
        {shown.map((item, i) => (
          <Fragment key={item.id}>
            {!open && i === 2 && (
              <button className={cx(ROW_GRID, "h-8 w-full rounded-lg px-[9px] text-left text-xs text-fg-3 hover:bg-hover hover:text-fg-2")} onClick={() => setOpen(true)}>
                <RailCell row={{ id: null, lane: 0, up: true, down: true, joins: [], through: [] }} lanes={1} node={null} gap={4} dashed />
                <span>{cluster.items.length - 3} more in this stack</span>
              </button>
            )}
            <Row item={item} active={cursor === item.id} onHover={onHover} loading={loading} rail={{ row: cluster.rails!.get(item.id)!, lanes: cluster.lanes }} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** One segment per stack entry, colored by its status, in the same order as the rows (top first). */
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

const Row = memo(function Row({
  item,
  active,
  onHover,
  rail,
  loading,
  showStack,
  recent,
}: {
  item: InboxItem;
  active: boolean;
  onHover: (id: string) => void;
  /** Set for rows in a stack: where this row sits on the stack's rail. */
  /** The inbox is still the quick first pass. */
  loading?: boolean;
  /** Say where it sits in its stack (rows shown on their own, outside their stack). */
  showStack?: boolean;
  /** A shortcut row in "Recently in review": not part of j / k. */
  recent?: boolean;
  rail?: { row: RailRow; lanes: number };
}) {
  const stacked = !!rail;
  const total = (item.additions ?? 0) + (item.deletions ?? 0);
  // Skeletons only while the full inbox is on its way; search-only rows never get checks.
  const loadingSignals = loading && item.checks === null && item.state !== "local" && item.state !== "draft";
  return (
    <a
      data-row={recent ? undefined : item.id}
      data-recent-row={recent ? item.id : undefined}
      href={item.ref.kind === "pr" ? `#/pr/${item.ref.number}` : `#/branch/${encodeURIComponent(item.ref.name)}`}
      style={rail && rail.lanes > 1 ? rowColumns(rail.lanes) : undefined}
      className={cx(
        ROW_GRID,
        "group relative min-h-[58px] py-2.5 text-fg no-underline transition-[background,border-color] duration-150",
        // Stacked rows sit 7px inside their card; matching padding keeps every column
        // (icon, title, status, size, time) on the same x as standalone rows.
        stacked ? "rounded-[10px] px-[9px]" : "rounded-xl px-4",
        active
          ? "border border-accent/50 bg-accent-soft"
          : stacked
            ? "border border-transparent hover:bg-hover"
            : "border border-line bg-panel hover:border-line-2 hover:bg-panel-2",
      )}
      onClick={(e) => {
        e.preventDefault();
        navigate(item.ref);
      }}
      onMouseEnter={() => {
        onHover(item.id);
        prefetchDetail(item.ref);
      }}
    >
      {rail ? (
        <RailCell
          row={rail.row}
          lanes={rail.lanes}
          // Lines bridge the row's 10px padding and 1px border on each side, plus half the 4px gap.
          gap={26}
          node={<i className={cx("block size-2.5 rounded-full border-2 bg-bg", active ? "border-accent bg-accent shadow-[0_0_0_4px_var(--accent-soft)]" : "border-fg-3")} />}
        />
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
              <span className="inline-flex shrink-0 items-center gap-1.5" data-author>
                <Avatar person={item.author} size="sm" />
                {item.author.login}
              </span>
            </>
          )}
          {showStack && item.stack && (
            <>
              <span className="text-fg-4">·</span>
              <span className="inline-flex shrink-0 items-center gap-1">
                <Layers size={11} />
                {item.stack.index} of {item.stack.size} in a stack
              </span>
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
            <span className="w-8 text-right text-xs leading-none text-fg-3 tabular">{compact(total)}</span>
          </>
        ) : (
          <span className="h-1.5 w-16 animate-pulse-soft rounded-full bg-panel-3" />
        )}
      </span>
      <span className="text-right text-xs leading-none text-fg-3 tabular" data-tip={item.updatedAt ?? undefined}>
        {timeAgo(item.updatedAt).replace(" ago", "").replace("just now", "now")}
      </span>
      <ArrowUpRight
        size={14}
        className={cx(
          "text-fg-2 transition-all duration-150",
          active ? "opacity-100" : "-translate-x-0.5 translate-y-0.5 opacity-0 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100",
        )}
      />
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

/** A tab with nothing in it: what would show here, and how to get it there. */
function EmptyTab({ filter, onSearch }: { filter: string; onSearch: () => void }) {
  const [Icon, title, hint] = (
    {
      mine: [GitPullRequest, "You have no open pull requests", <>Run <code>pile submit</code> on a branch to open one.</>],
      local: [GitBranch, "No local branches waiting", <>Branches you make with <code>pile create</code> show up here until they're on GitHub.</>],
      needs_review: [Sparkles, "Nothing is waiting for your review", <>You're all caught up.</>],
    } as Record<string, [typeof Sparkles, string, ReactNode]>
  )[filter] ?? [InboxIcon, "Your inbox is empty", <>Your pull requests, review requests and local branches show up here.</>];
  return (
    <div className="mt-7 flex flex-col items-center rounded-xl border border-dashed border-line-2 px-6 py-12 text-center" data-empty={filter}>
      <span className="mb-3.5 grid size-10 place-items-center rounded-full bg-panel-2 text-fg-3">
        <Icon size={18} />
      </span>
      <div className="font-medium text-fg">{title}</div>
      <div className="mt-1 text-[13px] text-fg-3 [&_code]:rounded [&_code]:bg-panel-3 [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-fg-2">{hint}</div>
      <button className="mt-4 inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-fg-2 transition-colors hover:bg-hover hover:text-fg" onClick={onSearch}>
        <Search size={13} /> Search all PRs
        <Kbd>/</Kbd>
      </button>
    </div>
  );
}

