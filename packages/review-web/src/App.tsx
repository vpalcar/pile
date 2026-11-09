import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, CircleHelp, ExternalLink, Inbox as InboxIcon, KeyRound, Moon, RefreshCw, Search, Sun } from "lucide-react";
import type { Detail, InboxItem } from "./api";
import { api, load, prefetch, refKey, RequestError, useResource } from "./lib/client";
import { modKey, navigate, sameRef, useRoute, useShortcuts, usePersisted } from "./lib/util";
import { DetailView } from "./components/Detail";
import { flatItems } from "./components/Inbox";
import { InboxPage } from "./components/InboxPage";
import { Palette, ShortcutsSheet } from "./components/Palette";
import { Avatar, Button, buttonClass, Centered, cx, Kbd, PRStateIcon, TooltipLayer, ToastProvider } from "./components/ui";

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
  const session = useResource("session", api.session);
  const inbox = useResource("inbox", () => api.inbox(), { refreshMs: 30_000 });
  const detailKey = route.ref ? refKey(route.ref) : null;
  const detail = useResource<Detail>(detailKey, () => api.detail(route.ref!), { refreshMs: 60_000 });

  // The first answer may be the quick list; ask again until the full version arrives.
  useEffect(() => {
    if (!inbox.data?.partial) return;
    const timer = setTimeout(() => load("inbox", () => api.inbox(), true).catch(() => {}), 1200);
    return () => clearTimeout(timer);
  }, [inbox.data]);

  const [theme, setTheme] = usePersisted<Theme>("pile:theme", "system");
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
      if (neighbor) prefetch(refKey(neighbor.ref), () => api.detail(neighbor.ref));
    }
  }, [index, items]);

  const step = (delta: number) => {
    const next = items[index + delta];
    if (next) navigate(next.ref);
  };

  const refresh = useCallback(() => {
    load("inbox", () => api.inbox(true), true).catch(() => {});
    if (detailKey && route.ref) load(detailKey, () => api.detail(route.ref!, true), true).catch(() => {});
  }, [detailKey, route.ref]);

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
  const refreshing = (inbox.loading && !!inbox.data) || (detail.loading && !!detail.data);

  // Every control in the bar is 28px tall.
  const navLink = "inline-flex h-7 shrink-0 items-center gap-2 rounded-lg px-2.5 font-medium leading-none text-fg-2 transition-colors hover:bg-hover hover:text-fg [&_svg]:shrink-0";

  return (
    <div className="flex h-full flex-col">
      <nav className="relative z-30 flex h-[var(--topbar-h)] shrink-0 items-center gap-1.5 border-b border-line bg-bg/80 pl-3 pr-3.5 backdrop-blur-xl backdrop-saturate-150">
        <button className="flex h-7 shrink-0 items-center gap-2 rounded-lg px-1.5 text-fg hover:bg-hover" onClick={goInbox} data-tip="Inbox" data-kbd="g">
          <BrandMark />
          <span className="text-sm font-semibold leading-none tracking-tight">pile</span>
        </button>
        {repo && (
          <a className={cx(navLink, "gap-1 no-underline max-[1000px]:hidden")} href={repo.url} target="_blank" rel="noreferrer">
            {repo.owner}
            <span className="text-fg-4">/</span>
            {repo.name}
          </a>
        )}
        <span className="mx-1 h-[18px] w-px shrink-0 bg-line-2 max-[1000px]:hidden" />
        <button className={cx(navLink, !route.ref && "bg-active text-fg")} onClick={goInbox}>
          <InboxIcon size={14} />
          Inbox
          {waiting > 0 && <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-none text-white tabular">{waiting}</span>}
        </button>
        {route.ref && (
          <div className="flex min-w-0 flex-1 animate-fade-in items-center gap-2 text-fg-2">
            <ChevronRight size={14} className="shrink-0 text-fg-4" />
            {detail.error && !current ? (
              <CircleHelp size={14} className="shrink-0 text-fg-4" />
            ) : (
              <PRStateIcon state={detail.data?.state ?? current?.state ?? "open"} size={14} />
            )}
            <span className="shrink-0 text-fg-3 tabular">{route.ref.kind === "pr" ? `#${route.ref.number}` : route.ref.name}</span>
            <b className="min-w-0 truncate font-medium text-fg">{detail.data?.title ?? current?.title ?? ""}</b>
          </div>
        )}
        {!route.ref && <span className="flex-1" />}
        {detail.data?.url && route.ref && (
          <a className={cx(buttonClass({ variant: "ghost" }), "no-underline")} href={detail.data.url} target="_blank" rel="noreferrer" data-kbd="o" data-tip="Open on GitHub">
            <span className="max-[1100px]:hidden">GitHub</span> <ExternalLink size={13} />
          </a>
        )}
        <span id="topbar-actions" className="contents" />
        {route.ref && index >= 0 && (
          <div className="mr-1 flex shrink-0 items-center gap-0.5 whitespace-nowrap text-xs text-fg-3 tabular">
            <Button variant="ghost" icon onClick={() => step(-1)} disabled={index <= 0} data-tip="Previous" data-kbd="[">
              <ChevronLeft size={14} />
            </Button>
            <span className="px-0.5">
              {index + 1} of {items.length}
            </span>
            <Button variant="ghost" icon onClick={() => step(1)} disabled={index >= items.length - 1} data-tip="Next" data-kbd="]">
              <ChevronRight size={14} />
            </Button>
          </div>
        )}
        <button
          className="mx-1 inline-flex h-7 shrink-0 items-center gap-2 rounded-lg border border-line bg-panel pl-2.5 pr-1.5 text-[12.5px] leading-none text-fg-3 transition-colors hover:border-line-2 hover:text-fg-2"
          onClick={() => setPalette(true)}
        >
          <Search size={13} className="shrink-0" />
          <span className="mr-5 max-[1000px]:hidden">Search</span>
          <Kbd>{modKey}</Kbd>
          <Kbd>K</Kbd>
        </button>
        <Button variant="ghost" icon data-tip={`Theme: ${theme}`} onClick={() => setTheme(theme === "system" ? "dark" : theme === "dark" ? "light" : "system")}>
          {theme === "light" ? <Sun size={14} /> : <Moon size={14} />}
        </Button>
        <Button variant="ghost" icon data-tip="Refresh" data-kbd="⇧ R" onClick={refresh} className={refreshing ? "[&_svg]:animate-spin" : ""}>
          <RefreshCw size={14} />
        </Button>
        {session.data?.viewer && (
          <span className="ml-1 flex">
            <Avatar person={session.data.viewer} size="lg" />
          </span>
        )}
        {refreshing && <div className="refreshing top-full" />}
      </nav>

      <main className="relative flex-1 overflow-y-auto overflow-x-hidden scroll-smooth" ref={setScrollEl}>
        <div className="glow pointer-events-none absolute inset-x-0 top-0 h-[440px]" aria-hidden />
        <div className="relative">
          {!route.ref ? (
            <InboxPage inbox={inbox.data} session={session.data} loading={inbox.loading} />
          ) : detail.data ? (
            <DetailView key={detailKey} detail={detail.data} scrollEl={scrollEl} initialFile={route.file} trunk={session.data?.trunk ?? "main"} inboxItems={items} />
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
