import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, CircleHelp, Gauge, Inbox as InboxIcon, Keyboard, KeyRound, Monitor, Moon, RefreshCw, Search, Settings, Sun } from "lucide-react";
import type { Inbox, InboxItem, Person } from "./api";
import { api, RequestError } from "./lib/client";
import { keys, prefetchDetail, queryClient, refKey, useDetail, useInbox, usePreference, useSession } from "./lib/queries";
import { modKey, navigate, sameRef, useRoute, useShortcuts } from "./lib/util";
import { DetailView } from "./components/Detail";
import { flatItems } from "./components/Inbox";
import { InboxPage } from "./components/InboxPage";
import { Palette, ShortcutsSheet } from "./components/Palette";
import { Avatar, Button, Centered, cx, Kbd, PRStateIcon, TooltipLayer, ToastProvider, useDismiss } from "./components/ui";

type Theme = "system" | "dark" | "light";

export function App() {
  return (
    <ToastProvider>
      <Shell />
      <TooltipLayer />
    </ToastProvider>
  );
}

function Shell() {
  const route = useRoute();
  const session = useSession();
  const inbox = useInbox();
  const detailKey = route.ref ? refKey(route.ref) : null;
  const detail = useDetail(route.ref ?? null);

  // The server writes the saved theme into the page, so start from that.
  const [theme, setTheme] = usePreference("theme", (document.documentElement.dataset.theme as Theme | undefined) ?? "system");
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  // `pile review <target>` opens straight on that item.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (openedInitial.current || !session.data) return;
    openedInitial.current = true;
    if (!route.ref && session.data.initial) navigate(session.data.initial, null, true);
  }, [session.data, route.ref]);

  // Each page starts at the top (unless deep-linked to a file).
  const lastKey = useRef(detailKey);
  useEffect(() => {
    if (lastKey.current !== detailKey && scrollEl && !route.file) {
      scrollEl.classList.add("instant");
      scrollEl.scrollTop = 0;
      scrollEl.classList.remove("instant");
    }
    lastKey.current = detailKey;
  }, [detailKey, scrollEl, route.file]);

  const items = flatItems(inbox.data);
  const index = items.findIndex((i) => sameRef(i.ref, route.ref));
  const current: InboxItem | undefined = items[index];

  // Neighbors load in the background, so [ and ] feel instant.
  useEffect(() => {
    for (const neighbor of [items[index + 1], items[index - 1]]) {
      if (neighbor) prefetchDetail(neighbor.ref);
    }
  }, [index, items]);

  const step = (delta: number) => {
    const next = items[index + delta];
    if (next) navigate(next.ref);
  };

  // Invalidated queries refetch past the server's cache (see lib/queries).
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => {
    setRefreshing(true);
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.inbox }),
      route.ref && queryClient.invalidateQueries({ queryKey: keys.detail(route.ref) }),
    ]).finally(() => setRefreshing(false));
  }, [route.ref]);

  const goInbox = () => navigate(null);

  useShortcuts(
    {
      "mod+k": () => setPalette((p) => !p),
      "]": () => step(1),
      "[": () => step(-1),
      R: () => refresh(),
      "?": () => setShortcuts((s) => !s),
      Escape: () => route.ref && !palette && !shortcuts && !document.querySelector(".popover") && goInbox(),
      g: () => goInbox(),
    },
    [items, index, refresh, route.ref, palette, shortcuts],
    { always: ["mod+k"] },
  );

  if (!api.hasToken()) {
    return (
      <Centered icon={<KeyRound size={22} />} title="Open the link from your terminal">
        This page needs the access link that <code>pile review</code> printed, so other sites can't read your repository through it.
      </Centered>
    );
  }
  if (session.error) {
    const unauthorized = session.error instanceof RequestError && session.error.status === 401;
    return (
      <Centered icon={<CircleAlert size={22} />} title={unauthorized ? "This link has expired" : "Can't reach pile"}>
        {unauthorized ? (
          <>Run <code>pile review</code> again and open the new link.</>
        ) : (
          <>Is <code>pile review</code> still running in your terminal?</>
        )}
      </Centered>
    );
  }

  const repo = session.data?.repo;
  const waiting = inbox.data?.groups.find((g) => g.id === "needs_review")?.items.length ?? 0;

  // Every control in the bar is 28px tall.
  const navLink = "inline-flex h-7 shrink-0 items-center gap-2 rounded-lg px-2.5 font-medium leading-none text-fg-2 transition-colors hover:bg-hover hover:text-fg [&_svg]:shrink-0";

  return (
    <div className="flex h-full flex-col">
      {/* Left: where you are. Middle: which repo. Right: this page's actions, then app tools. */}
      <nav className="relative z-30 grid h-[var(--topbar-h)] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-line bg-bg/80 px-3 backdrop-blur-xl backdrop-saturate-150">
        <div className="flex min-w-0 items-center gap-1">
          <button className="grid size-7 shrink-0 place-items-center rounded-lg hover:bg-hover" onClick={goInbox} aria-label="Inbox" data-tip="Inbox" data-kbd="g">
            <BrandMark />
          </button>
          <button className={cx(navLink, !route.ref && "bg-active text-fg")} onClick={goInbox}>
            <InboxIcon size={14} />
            Inbox
            {waiting > 0 && <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-none text-white tabular">{waiting}</span>}
          </button>
          {route.ref && (
            <div className="flex min-w-0 animate-fade-in items-center gap-1.5 text-fg-2" data-tip={detail.data?.title ?? current?.title}>
              <ChevronRight size={14} className="shrink-0 text-fg-4" />
              {detail.error && !current ? (
                <CircleHelp size={14} className="shrink-0 text-fg-4" />
              ) : (
                <PRStateIcon state={detail.data?.state ?? current?.state ?? "open"} size={14} />
              )}
              <span className="min-w-0 truncate font-mono text-[12.5px] text-fg" data-breadcrumb>
                {detail.data?.branch ?? current?.branch ?? (route.ref.kind === "branch" ? route.ref.name : `#${route.ref.number}`)}
              </span>
            </div>
          )}
        </div>

        {repo ? (
          <a
            className="truncate rounded-md px-2 py-1 text-[13px] font-medium text-fg-2 no-underline transition-colors hover:bg-hover hover:text-fg max-[760px]:hidden"
            href={repo.url}
            target="_blank"
            rel="noreferrer"
            data-repo
            data-tip="Open on GitHub"
          >
            {repo.owner}
            <span className="mx-1 text-fg-4">/</span>
            <span className="text-fg">{repo.name}</span>
          </a>
        ) : (
          <span className="text-[13px] font-medium text-fg-2 max-[760px]:hidden" data-repo>
            pile review
          </span>
        )}

        <div className="flex items-center justify-end gap-1">
          {route.ref && index >= 0 && (
            <div className="flex shrink-0 items-center whitespace-nowrap text-xs text-fg-3 tabular">
              <Button variant="ghost" icon onClick={() => step(-1)} disabled={index <= 0} aria-label="Previous" data-tip="Previous" data-kbd="[">
                <ChevronLeft size={14} />
              </Button>
              <span className="px-0.5 max-[1000px]:hidden">
                {index + 1} of {items.length}
              </span>
              <Button variant="ghost" icon onClick={() => step(1)} disabled={index >= items.length - 1} aria-label="Next" data-tip="Next" data-kbd="]">
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
          <span id="topbar-actions" className="contents" />
          {route.ref && <span className="mx-1.5 h-[18px] w-px shrink-0 bg-line-2" />}
          <Button variant="ghost" icon onClick={() => setPalette(true)} aria-label="Search" data-tip="Search" data-kbd={`${modKey} K`}>
            <Search size={15} />
          </Button>
          <Button variant="ghost" icon aria-label="Refresh" data-tip="Refresh" data-kbd="⇧ R" onClick={refresh} className={refreshing ? "[&_svg]:animate-spin" : ""}>
            <RefreshCw size={14} />
          </Button>
          <AccountMenu viewer={session.data?.viewer ?? null} theme={theme} onTheme={setTheme} onShortcuts={() => setShortcuts(true)} />
        </div>
        {refreshing && <div className="refreshing top-full" />}
      </nav>

      <QuotaBanner quota={inbox.data?.quota ?? null} errors={[inbox.error, detail.error]} />
      <main className="relative flex-1 overflow-y-auto overflow-x-hidden scroll-smooth" ref={setScrollEl}>
        <div className="glow pointer-events-none absolute inset-x-0 top-0 h-[440px]" aria-hidden />
        <div className="relative">
          {!route.ref ? (
            <InboxPage inbox={inbox.data} session={session.data} loading={inbox.isPending} />
          ) : detail.data ? (
            <DetailView key={detailKey} detail={detail.data} scrollEl={scrollEl} initialFile={route.file} trunk={session.data?.trunk ?? "main"} inboxItems={items} currentBranch={session.data?.currentBranch ?? null} />
          ) : detail.error ? (
            <div className="h-[70vh]">
              <Centered icon={<CircleAlert size={22} />} title="Couldn't load this">
                {detail.error.message}
                <br />
                <Button className="mt-3" onClick={goInbox}>
                  Back to inbox
                </Button>
              </Centered>
            </div>
          ) : (
            <DetailSkeleton item={current} />
          )}
        </div>
      </main>

      {palette && (
        <Palette
          inbox={inbox.data}
          detail={route.ref ? detail.data : undefined}
          onClose={() => setPalette(false)}
          onRefresh={refresh}
          onInbox={goInbox}
          onShortcuts={() => setShortcuts(true)}
          onTheme={setTheme}
        />
      )}
      {shortcuts && <ShortcutsSheet onClose={() => setShortcuts(false)} />}
    </div>
  );
}

/** The viewer's avatar; opens app settings (theme, shortcuts). */
function AccountMenu({ viewer, theme, onTheme, onShortcuts }: { viewer: Person | null; theme: Theme; onTheme: (t: Theme) => void; onShortcuts: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const themes: Array<[Theme, string, ReactNode]> = [
    ["system", "System", <Monitor size={14} key="s" />],
    ["light", "Light", <Sun size={14} key="l" />],
    ["dark", "Dark", <Moon size={14} key="d" />],
  ];
  return (
    <div className="relative ml-1" ref={ref}>
      <button className="flex size-7 items-center justify-center rounded-full hover:ring-2 hover:ring-line-2" onClick={() => setOpen((o) => !o)} aria-label="Account and settings" aria-expanded={open}>
        {viewer ? <Avatar person={viewer} size="lg" /> : <Settings size={15} className="text-fg-2" />}
      </button>
      {open && (
        <div role="menu" className="popover absolute right-0 top-[calc(100%+10px)] z-50 w-[272px] origin-top-right animate-pop-in rounded-xl bg-panel p-2 shadow-pop">
          {viewer && (
            <div className="mb-1 flex items-center gap-2.5 border-b border-line px-2 pb-2.5 pt-1">
              <Avatar person={viewer} />
              <span className="min-w-0 truncate text-[13px] font-medium">{viewer.login}</span>
            </div>
          )}
          <div className="px-2 pb-1.5 pt-2 text-[11.5px] font-medium text-fg-3">Theme</div>
          <div className="mx-1 mb-2 grid grid-cols-3 gap-1 rounded-[10px] border border-line bg-bg p-1" role="radiogroup" aria-label="Theme">
            {themes.map(([value, label, icon]) => (
              <button
                key={value}
                role="radio"
                aria-checked={theme === value}
                onClick={() => onTheme(value)}
                className={cx("flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-[12.5px]", theme === value ? "bg-panel-3 text-fg shadow-sm" : "text-fg-3 hover:bg-hover hover:text-fg-2")}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
          <button
            role="menuitem"
            className="flex h-9 w-full items-center gap-2 rounded-md border-t border-line px-2 pt-0.5 text-[13px] text-fg-2 hover:bg-hover hover:text-fg"
            onClick={() => {
              setOpen(false);
              onShortcuts();
            }}
          >
            <Keyboard size={14} />
            Keyboard shortcuts
            <span className="ml-auto">
              <Kbd>?</Kbd>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * GitHub allows 5,000 API requests an hour per account, shared by everything signed
 * in as you. Says so when pile is close to the limit, or past it.
 */
function QuotaBanner({ quota, errors }: { quota: Inbox["quota"]; errors: Array<Error | null | undefined> }) {
  const limited = errors.find((e): e is RequestError => e instanceof RequestError && e.body.code === "RATE_LIMITED");
  const low = quota && quota.remaining < Math.max(300, quota.limit * 0.1);
  if (!limited && !low) return null;
  const reset = quota?.resetAt ? new Date(quota.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="flex min-h-9 shrink-0 items-center justify-center gap-2 border-b border-warn/25 bg-warn-soft px-4 text-xs text-fg" role="status" data-quota-banner>
      <Gauge size={14} className="shrink-0 text-warn" />
      {limited ? (
        <span>
          {limited.message}. Showing what pile already has. <span className="text-fg-3">{limited.body.hint}</span>
        </span>
      ) : (
        <span>
          GitHub API: {quota!.remaining.toLocaleString()} of {quota!.limit.toLocaleString()} requests left this hour{reset ? ` (resets ${reset})` : ""}. pile is
          refreshing less often until then.
        </span>
      )}
    </div>
  );
}

function BrandMark() {
  return (
    <span className="grid size-[22px] shrink-0 place-items-center rounded-[7px] bg-gradient-to-br from-accent to-merged shadow-[inset_0_0_0_1px_rgba(255,255,255,.12),0_4px_14px_-4px_var(--accent)]">
      <span className="flex flex-col gap-[2px]">
        <i className="block h-[2px] w-2.5 rounded-full bg-white/40" />
        <i className="block h-[2px] w-2.5 rounded-full bg-white/70" />
        <i className="block h-[2px] w-2.5 rounded-full bg-white" />
      </span>
    </span>
  );
}

/** While details load, show what the inbox already knows. */
function DetailSkeleton({ item }: { item: InboxItem | undefined }) {
  return (
    <div className="mx-auto grid max-w-[1240px] grid-cols-[minmax(0,1fr)_272px] gap-10 px-9 pt-9" aria-busy>
      <div>
        {item ? (
          <>
            <div className="flex h-[22px] items-center gap-2 text-xs text-fg-3">
              <span className="skeleton h-[22px] w-20 rounded-full" />
              {item.ref.kind === "pr" && <span className="tabular">#{item.ref.number}</span>}
            </div>
            <h1 className="mb-3.5 mt-3 text-[27px] font-semibold leading-tight tracking-[-0.028em] text-balance">{item.title}</h1>
            <div className="flex items-center gap-2.5 text-fg-2">
              <Avatar person={item.author} />
              <b className="font-medium text-fg">{item.author?.login}</b>
              <span className="inline-flex h-[22px] items-center rounded-md border border-line bg-panel-2 px-2 font-mono text-[11.5px] leading-none text-fg-2">{item.branch}</span>
            </div>
          </>
        ) : (
          <>
            <div className="skeleton h-5 w-28 rounded-full" />
            <div className="skeleton mb-4 mt-3.5 h-7 w-2/3" />
            <div className="skeleton h-3.5 w-2/5" />
          </>
        )}
        <div className="skeleton mt-9 h-24 rounded-xl" />
        <div className="skeleton mt-6 h-16 rounded-xl" />
      </div>
      <div>
        <div className="skeleton h-32 rounded-xl" />
        <div className="skeleton mt-6 h-3.5 w-1/2" />
        <div className="skeleton mt-2.5 h-3.5 w-4/5" />
      </div>
    </div>
  );
}
