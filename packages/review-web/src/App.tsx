import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, ExternalLink, Inbox as InboxIcon, KeyRound, Moon, RefreshCw, Search, Sun } from "lucide-react";
import type { Detail, InboxItem } from "./api";
import { api, load, prefetch, refKey, RequestError, useResource } from "./lib/client";
import { modKey, navigate, sameRef, useRoute, useShortcuts, usePersisted } from "./lib/util";
import { DetailView } from "./components/Detail";
import { flatItems } from "./components/Inbox";
import { InboxPage } from "./components/InboxPage";
import { Palette, ShortcutsSheet } from "./components/Palette";
import { Avatar, Kbd, PRStateIcon, TooltipLayer, ToastProvider } from "./components/ui";

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

  return (
    <div className="shell">
      <nav className="navbar">
        <button className="brand" onClick={goInbox} data-tip="Inbox" data-kbd="g">
          <span className="brand-mark">
            <span />
          </span>
          <span className="brand-name">pile</span>
        </button>
        {repo && (
          <a className="nav-repo" href={repo.url} target="_blank" rel="noreferrer">
            {repo.owner}
            <span className="faint">/</span>
            {repo.name}
          </a>
        )}
        <span className="nav-sep" />
        <button className={`nav-tab ${route.ref ? "" : "on"}`} onClick={goInbox}>
          <InboxIcon size={14} />
          Inbox
          {waiting > 0 && <span className="nav-badge num">{waiting}</span>}
        </button>
        {route.ref && (
          <div className="nav-crumb">
            <ChevronRight size={14} className="faint" />
            <PRStateIcon state={detail.data?.state ?? current?.state ?? "open"} size={14} />
            <span className="num faint">{route.ref.kind === "pr" ? `#${route.ref.number}` : route.ref.name}</span>
            <b>{detail.data?.title ?? current?.title ?? ""}</b>
          </div>
        )}
        <span className="spacer" />
        {route.ref && index >= 0 && (
          <div className="nav-stepper">
            <button className="btn ghost sm icon" onClick={() => step(-1)} disabled={index <= 0} data-tip="Previous" data-kbd="[">
              <ChevronLeft size={14} />
            </button>
            <span className="num faint">
              {index + 1} of {items.length}
            </span>
            <button className="btn ghost sm icon" onClick={() => step(1)} disabled={index >= items.length - 1} data-tip="Next" data-kbd="]">
              <ChevronRight size={14} />
            </button>
          </div>
        )}
        {detail.data?.url && route.ref && (
          <a className="btn ghost sm" href={detail.data.url} target="_blank" rel="noreferrer" data-kbd="o" data-tip="Open on GitHub">
            GitHub <ExternalLink size={12} />
          </a>
        )}
        <span id="topbar-actions" style={{ display: "contents" }} />
        <button className="search-pill" onClick={() => setPalette(true)}>
          <Search size={13} />
          <span>Search</span>
          <Kbd>{modKey}</Kbd>
          <Kbd>K</Kbd>
        </button>
        <button
          className="btn ghost sm icon"
          data-tip={`Theme: ${theme}`}
          onClick={() => setTheme(theme === "system" ? "dark" : theme === "dark" ? "light" : "system")}
        >
          {theme === "light" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <button className={`btn ghost sm icon ${refreshing ? "spinning" : ""}`} data-tip="Refresh" data-kbd="⇧ R" onClick={refresh}>
          <RefreshCw size={14} />
        </button>
        {session.data?.viewer && <Avatar person={session.data.viewer} />}
      </nav>
      {refreshing && <div className="refreshing" />}

      <main className="scroll" ref={setScrollEl}>
        <div className="glow" aria-hidden />
        {!route.ref ? (
          <InboxPage inbox={inbox.data} session={session.data} loading={inbox.loading} />
        ) : detail.data ? (
          <DetailView key={detailKey} detail={detail.data} scrollEl={scrollEl} initialFile={route.file} trunk={session.data?.trunk ?? "main"} />
        ) : detail.error ? (
          <Centered icon={<CircleAlert size={22} />} title="Couldn't load this">
            {detail.error.message}
            <br />
            <button className="btn" style={{ marginTop: 12 }} onClick={goInbox}>
              Back to inbox
            </button>
          </Centered>
        ) : (
          <DetailSkeleton item={current} />
        )}
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

function Centered({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <div>
        <div className="art">{icon}</div>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
    </div>
  );
}

/** While details load, show what the inbox already knows. */
function DetailSkeleton({ item }: { item: InboxItem | undefined }) {
  return (
    <div className="page" aria-busy>
      <div>
        {item ? (
          <>
            <div className="eyebrow">
              <span className="skeleton" style={{ height: 20, width: 64, borderRadius: 10 }} />
              {item.ref.kind === "pr" && <span className="num">#{item.ref.number}</span>}
            </div>
            <h1 className="title">{item.title}</h1>
            <div className="byline">
              <Avatar person={item.author} />
              <b style={{ fontWeight: 520, color: "var(--text)" }}>{item.author?.login}</b>
              <span className="branch-chip">{item.branch}</span>
            </div>
          </>
        ) : (
          <>
            <div className="skeleton" style={{ height: 20, width: 120, borderRadius: 10 }} />
            <div className="skeleton" style={{ height: 26, width: "70%", margin: "14px 0 16px" }} />
            <div className="skeleton" style={{ height: 14, width: "45%" }} />
          </>
        )}
        <div className="skeleton" style={{ height: 96, width: "100%", marginTop: 36, borderRadius: 12 }} />
        <div className="skeleton" style={{ height: 64, width: "100%", marginTop: 24, borderRadius: 12 }} />
      </div>
      <div>
        <div className="skeleton" style={{ height: 120, borderRadius: 12 }} />
        <div className="skeleton" style={{ height: 14, width: "50%", marginTop: 24 }} />
        <div className="skeleton" style={{ height: 14, width: "80%", marginTop: 10 }} />
      </div>
    </div>
  );
}
