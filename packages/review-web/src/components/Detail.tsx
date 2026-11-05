import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowRight, Check, ChevronDown, CircleAlert, ExternalLink, Layers, MessageSquare, Pencil, UploadCloud } from "lucide-react";
import type { Detail as DetailData, InboxItem, ItemRef, ReviewRequest, StackEntry, TimelineEntry } from "../api";
import { api, load, refKey } from "../lib/client";
import { detailReadiness, entryReadiness, type Readiness } from "../lib/status";
import { absoluteTime, copy, navigate, plural, timeAgo, useNow, useShortcuts } from "../lib/util";
import { Composer } from "./Composer";
import { FilesPanel } from "./FilesPanel";
import type { PendingComment } from "./FileDiff";
import { Markdown } from "./Markdown";
import { Avatar, Button, buttonClass, CheckIcon, cx, DiffStat, Kbd, Label, Pill, Spinner, StatusBadge, useDismiss, useToast } from "./ui";

interface Props {
  detail: DetailData;
  /** Inbox items, for the status of other PRs in the stack. */
  inboxItems: InboxItem[];
  scrollEl: HTMLElement | null;
  initialFile: string | null;
  trunk: string;
}

export function DetailView({ detail, scrollEl, initialFile, trunk, inboxItems }: Props) {
  useNow();
  const key = refKey(detail.ref);
  const toast = useToast();
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const discussionInput = useRef<HTMLTextAreaElement>(null);
  const status = detailReadiness(detail);

  const refresh = useCallback(async () => {
    await Promise.all([load(key, () => api.detail(detail.ref, true), true), load("inbox", () => api.inbox(true), true)]).catch(() => {});
  }, [key, detail.ref]);

  const onFileChange = useCallback(
    (path: string | null) => history.replaceState(null, "", `${location.pathname}${location.search}#${routePath(detail.ref)}${path ? `/file/${encodeURIComponent(path)}` : ""}`),
    [detail.ref],
  );

  useShortcuts(
    {
      c: () => {
        discussionInput.current?.focus();
        discussionInput.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      },
      r: () => detail.number && setReviewOpen(true),
      o: () => detail.url && window.open(detail.url, "_blank"),
    },
    [detail],
  );

  const submitReview = async (request: ReviewRequest) => {
    await api.review(detail.number!, { ...request, comments: pending.map(({ path, line, side, body }) => ({ path, line, side, body })) });
    setPending([]);
    setReviewOpen(false);
    const verb = request.event === "APPROVE" ? "Approved" : request.event === "REQUEST_CHANGES" ? "Requested changes on" : "Reviewed";
    toast(
      <>
        {request.event === "APPROVE" ? <Check size={15} color="var(--green)" strokeWidth={2.5} /> : <MessageSquare size={14} />}
        {verb} #{detail.number}
      </>,
    );
    refresh();
  };

  return (
    <>
      {detail.number !== null && (
        <TopbarSlot>
          <div className="relative">
            <Button variant={reviewOpen ? "default" : "primary"} size="sm" onClick={() => setReviewOpen(!reviewOpen)} data-kbd="r" data-tip="Submit a review">
              {detail.can.review ? "Review" : "Comment"}
              {pending.length > 0 && <Pill tone="amber" className="h-4 px-1.5">{pending.length}</Pill>}
              <ChevronDown size={13} />
            </Button>
            {reviewOpen && <ReviewPopover detail={detail} pendingCount={pending.length} onClose={() => setReviewOpen(false)} onSubmit={submitReview} />}
          </div>
        </TopbarSlot>
      )}

      <div data-page="detail" className="mx-auto grid max-w-[1240px] grid-cols-[minmax(0,1fr)_272px] gap-10 px-9 pb-2 pt-9 max-[1080px]:grid-cols-1">
        <div className="min-w-0">
          <Header detail={detail} status={status} />
          {detail.state === "local" && (
            <Banner>
              Local branch{detail.local?.unpushed ? ", not on GitHub yet" : ""}. Run <code>pile submit</code> to open a pull request.
            </Banner>
          )}
          {detail.local && detail.local.ahead > 0 && detail.number && (
            <Banner>
              {plural(detail.local.ahead, "local commit")} not pushed. Run <code>pile submit</code> to update this PR.
            </Banner>
          )}
          {detail.stack.length > 1 && <StackSection stack={detail.stack} trunk={trunk} items={inboxItems} current={status} />}
          {detail.number !== null && <DescriptionSection detail={detail} />}
          <DiscussionSection detail={detail} inputRef={discussionInput} onCommented={refresh} />
        </div>
        <Rail detail={detail} status={status} onReview={() => setReviewOpen(true)} />
      </div>

      <FilesPanel
        detail={detail}
        itemKey={key}
        scrollEl={scrollEl}
        pending={pending}
        onAddPending={(c) => {
          setPending((p) => [...p, { ...c, id: `${Date.now()}-${Math.random()}` }]);
          toast(
            <>
              <MessageSquare size={14} /> Comment added to your review
              <Button variant="ghost" size="sm" onClick={() => setReviewOpen(true)}>
                Finish review
              </Button>
            </>,
          );
        }}
        onRemovePending={(id) => setPending((p) => p.filter((c) => c.id !== id))}
        initialFile={initialFile}
        onFileChange={onFileChange}
      />
    </>
  );
}

const routePath = (ref: ItemRef) => (ref.kind === "pr" ? `/pr/${ref.number}` : `/branch/${encodeURIComponent(ref.name)}`);

/** Renders into the nav bar's action slot, so the review button is always in reach. */
function TopbarSlot({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("topbar-actions")), []);
  return slot ? createPortal(children, slot) : null;
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex min-h-10 items-center gap-2.5 rounded-[10px] border border-warn/25 bg-warn-soft px-3 py-2 text-fg [&_code]:text-[11.5px]">
      <UploadCloud size={15} className="shrink-0 text-warn" />
      <span>{children}</span>
    </div>
  );
}

// -----------------------------------------------------------------------------

function Header({ detail, status }: { detail: DetailData; status: Readiness }) {
  const toast = useToast();
  const chip = "inline-flex h-[22px] max-w-[300px] items-center truncate rounded-md border border-line bg-panel-2 px-2 font-mono text-[11.5px] leading-none text-fg-2";
  return (
    <header>
      <div className="flex h-[22px] items-center gap-2 text-xs leading-none text-fg-3">
        <StatusBadge status={status} />
        {detail.number !== null && <span className="tabular">#{detail.number}</span>}
        {detail.updatedAt && (
          <>
            <span className="text-fg-4">·</span>
            <span data-tip={absoluteTime(detail.updatedAt)}>Updated {timeAgo(detail.updatedAt)}</span>
          </>
        )}
      </div>
      <h1 className="mb-3.5 mt-3 text-[27px] font-semibold leading-tight tracking-[-0.028em] text-balance">{detail.title}</h1>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-fg-2">
        <Avatar person={detail.author} />
        <b className="font-medium leading-none text-fg">{detail.author?.login ?? "unknown"}</b>
        <button
          className={cx(chip, "transition-colors hover:border-line-2 hover:text-fg")}
          data-tip="Copy checkout command"
          onClick={() => copy(`pile checkout ${detail.branch}`).then((ok) => ok && toast(<>Copied <code>pile checkout {detail.branch}</code></>))}
        >
          {detail.branch}
        </button>
        <ArrowRight size={13} className="shrink-0 text-fg-4" />
        <span className={chip}>{detail.base}</span>
        <span className="flex-1" />
        <span className="text-xs leading-none text-fg-3 tabular">{plural(detail.files.length, "file")}</span>
        <DiffStat additions={detail.additions} deletions={detail.deletions} bar />
      </div>
    </header>
  );
}

function ReviewPopover({ detail, pendingCount, onClose, onSubmit }: { detail: DetailData; pendingCount: number; onClose: () => void; onSubmit: (request: ReviewRequest) => Promise<void> }) {
  const ref = useDismiss(true, onClose);
  const own = !detail.can.review;
  const [event, setEvent] = useState<ReviewRequest["event"]>(own ? "COMMENT" : "APPROVE");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsBody = event !== "APPROVE" && !body.trim() && pendingCount === 0;

  const submit = async () => {
    if (needsBody || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ event, body: body.trim() || undefined });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const choices: Array<[ReviewRequest["event"], string, string]> = [
    ["COMMENT", "Comment", "General feedback without a verdict."],
    ["APPROVE", "Approve", "These changes can be merged."],
    ["REQUEST_CHANGES", "Request changes", "Changes must be addressed before merging."],
  ];

  return (
    <div ref={ref} role="dialog" aria-label="Submit review" className="popover absolute right-0 top-[calc(100%+8px)] z-50 w-[420px] origin-top-right animate-pop-in rounded-[14px] bg-panel p-3 shadow-pop">
      <textarea
        autoFocus
        placeholder="Leave a summary (optional for approvals)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        className="block min-h-24 w-full resize-y rounded-lg border border-line-2 bg-bg px-3 py-2.5 text-fg outline-none placeholder:text-fg-3 focus:border-line-3 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
      />
      <div className="my-2.5 grid gap-1" role="radiogroup">
        {choices.map(([value, label, help]) => {
          const disabled = own && value !== "COMMENT";
          const on = event === value;
          return (
            <button
              key={value}
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => setEvent(value)}
              className={cx(
                "grid grid-cols-[16px_1fr] items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-40",
                on ? "border-line-2 bg-panel-2" : "border-transparent hover:bg-hover",
              )}
            >
              <span className={cx("mt-0.5 grid size-4 place-items-center rounded-full border-[1.5px]", on ? "border-accent" : "border-fg-3")}>
                {on && <i className="size-1.5 rounded-full bg-accent" />}
              </span>
              <span className="grid gap-0.5">
                <b className="font-medium leading-5">{label}</b>
                <small className="text-xs text-fg-3">{disabled ? "You can't approve or request changes on your own pull request." : help}</small>
              </span>
            </button>
          );
        })}
      </div>
      {error && <div className="mb-2.5 rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-fg">{error}</div>}
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-3">{pendingCount > 0 ? `Includes ${plural(pendingCount, "inline comment")}` : ""}</span>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant={event === "APPROVE" ? "success" : event === "REQUEST_CHANGES" ? "danger" : "primary"} onClick={submit} disabled={needsBody || busy}>
          {busy && <Spinner size={12} />}
          Submit review
          <span className="ml-0.5 inline-flex gap-0.5 opacity-60 [&_kbd]:border-current/30 [&_kbd]:bg-transparent [&_kbd]:text-current">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </span>
        </Button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

function Section({ title, right, children, defaultOpen = true }: { title: ReactNode; right?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mt-7">
      <div className="mb-2.5 flex h-6 items-center gap-2 text-xs font-medium leading-none text-fg-2">
        <button className="flex items-center gap-1.5 [&_svg]:shrink-0" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ChevronDown size={13} className={cx("transition-transform duration-150", !open && "-rotate-90")} />
          {title}
        </button>
        <span className="flex-1" />
        {right}
      </div>
      {open && <div className="animate-fade-in">{children}</div>}
    </section>
  );
}

/** Long stacks show the ends and the neighborhood of the current entry; the rest collapse into "N more". */
export function windowed<T>(items: T[], current: number, expanded: boolean, radius = 2): Array<{ entry: T } | { hidden: number }> {
  if (expanded || items.length <= 7) return items.map((entry) => ({ entry }));
  const keep = new Set([0, items.length - 1]);
  for (let i = current - radius; i <= current + radius; i++) if (i >= 0 && i < items.length) keep.add(i);
  const out: Array<{ entry: T } | { hidden: number }> = [];
  let hidden = 0;
  items.forEach((entry, i) => {
    if (keep.has(i)) {
      if (hidden) out.push({ hidden });
      hidden = 0;
      out.push({ entry });
    } else hidden++;
  });
  if (hidden) out.push({ hidden });
  return out;
}

function StackSection({ stack, trunk, items, current }: { stack: StackEntry[]; trunk: string; items: InboxItem[]; current: Readiness }) {
  const currentIndex = stack.findIndex((s) => s.isCurrent);
  const [expanded, setExpanded] = useState(false);
  const top = [...stack].reverse();
  const parts = windowed(top, top.findIndex((e) => e.isCurrent), expanded);
  const row = "grid h-9 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg pl-1.5 pr-2";

  return (
    <Section
      title={
        <>
          <Layers size={13} /> Stack <span className="font-normal text-fg-3 tabular">{currentIndex + 1} of {stack.length}</span>
        </>
      }
    >
      <div className="flex flex-col">
        {parts.map((part, i) =>
          "hidden" in part ? (
            <button key={`more-${i}`} className={cx(row, "text-left text-xs text-fg-3 hover:bg-hover hover:text-fg-2")} onClick={() => setExpanded(true)}>
              <span className="rail-node rail-dashed" />
              <span>{part.hidden} more</span>
              <span />
            </button>
          ) : (
            <div
              key={refKey(part.entry.ref)}
              role="link"
              tabIndex={0}
              onClick={() => !part.entry.isCurrent && navigate(part.entry.ref)}
              onKeyDown={(e) => e.key === "Enter" && navigate(part.entry.ref)}
              className={cx(row, i === 0 && "rail-first", part.entry.isCurrent ? "bg-active text-fg" : "cursor-pointer text-fg-2 hover:bg-hover hover:text-fg")}
            >
              <span className="rail-node">
                <i
                  className={cx(
                    "block size-[9px] rounded-full border-[1.5px]",
                    part.entry.isCurrent ? "border-accent bg-accent shadow-[0_0_0_3px_var(--accent-soft)]" : part.entry.state === "merged" ? "border-merged bg-merged" : "border-fg-3 bg-bg",
                  )}
                />
              </span>
              <span className="truncate leading-5">
                {part.entry.ref.kind === "pr" && <span className="mr-1.5 text-fg-3 tabular">#{part.entry.ref.number}</span>}
                {part.entry.title}
              </span>
              <StatusBadge status={part.entry.isCurrent ? current : entryReadiness(part.entry, items)} size="sm" />
            </div>
          ),
        )}
        <div className={cx(row, "rail-last font-mono text-[11.5px] text-fg-3")}>
          <span className="rail-node">
            <i className="block size-[9px] rounded-sm border-[1.5px] border-fg-3 bg-bg" />
          </span>
          <span>{trunk}</span>
          <span />
        </div>
      </div>
    </Section>
  );
}

function DescriptionSection({ detail }: { detail: DetailData }) {
  return (
    <Section
      title="Description"
      right={
        detail.url && (
          <a className={cx(buttonClass({ variant: "ghost", size: "sm" }), "no-underline")} href={detail.url} target="_blank" rel="noreferrer">
            <Pencil size={12} /> Edit on GitHub
          </a>
        )
      }
    >
      <div className="rounded-xl border border-line bg-panel px-4 py-3.5">
        {detail.bodyHtml ? <Markdown html={detail.bodyHtml} /> : <span className="text-fg-3">No description provided.</span>}
      </div>
    </Section>
  );
}

function DiscussionSection({ detail, inputRef, onCommented }: { detail: DetailData; inputRef: React.RefObject<HTMLTextAreaElement | null>; onCommented: () => void }) {
  const toast = useToast();
  // Runs of commits group together; long runs collapse.
  const groups = useMemo(() => {
    const out: Array<TimelineEntry | TimelineEntry[]> = [];
    for (const entry of detail.timeline) {
      const last = out[out.length - 1];
      if (entry.kind === "commit" && Array.isArray(last)) last.push(entry);
      else if (entry.kind === "commit") out.push([entry]);
      else out.push(entry);
    }
    return out;
  }, [detail.timeline]);

  const comments = detail.timeline.filter((t) => t.kind !== "commit").length;
  return (
    <Section
      title={
        <>
          {detail.number ? "Discussion" : "Commits"}
          {comments > 0 && <span className="font-normal text-fg-3 tabular">{comments}</span>}
        </>
      }
    >
      <div className="relative flex flex-col before:absolute before:bottom-3 before:left-[11px] before:top-3 before:w-px before:bg-line">
        {groups.map((g, i) => (Array.isArray(g) ? <CommitGroup key={i} commits={g} url={detail.url} /> : <Event key={g.id} entry={g} />))}
        {groups.length === 0 && <div className="pl-9 text-fg-3">No activity yet.</div>}
      </div>
      {detail.can.comment && detail.number !== null && (
        <div className="mt-3">
          <Composer
            compact
            inputRef={inputRef}
            draftKey={`discussion:${detail.number}`}
            placeholder="Add to the discussion…"
            submitLabel="Comment"
            onSubmit={async (body) => {
              try {
                await api.comment(detail.number!, body);
                toast(
                  <>
                    <MessageSquare size={14} /> Comment posted
                  </>,
                );
                onCommented();
              } catch (e) {
                toast(
                  <>
                    <CircleAlert size={14} color="var(--red)" /> {(e as Error).message}
                  </>,
                );
                throw e;
              }
            }}
          />
        </div>
      )}
    </Section>
  );
}

function Event({ entry }: { entry: TimelineEntry }) {
  const verb =
    entry.kind === "review"
      ? { approved: "approved", changes_requested: "requested changes", commented: "reviewed", pending: "started a review", dismissed: "had a review dismissed" }[entry.reviewState ?? "commented"]
      : "commented";
  const border =
    entry.kind === "review" && entry.reviewState === "approved"
      ? "border-ok/30"
      : entry.kind === "review" && entry.reviewState === "changes_requested"
        ? "border-bad/30"
        : "border-line";
  return (
    <div className="relative grid grid-cols-[22px_minmax(0,1fr)] gap-3 py-1.5">
      <span className="relative z-[1] flex h-[22px] items-center justify-center">
        <span className="flex rounded-full shadow-[0_0_0_3px_var(--bg)]">
          <Avatar person={entry.author} size="lg" />
        </span>
      </span>
      <div className="min-w-0">
        <div className="flex h-[22px] flex-wrap items-center gap-1.5 leading-none text-fg-3">
          <b className="font-medium text-fg">{entry.author?.login}</b>
          <span>{verb}</span>
          {entry.kind === "review" && entry.reviewState === "approved" && <Check size={13} color="var(--green)" strokeWidth={2.5} />}
          {entry.kind === "review" && entry.reviewState === "changes_requested" && <AlertTriangle size={13} color="var(--red)" />}
          {entry.inlineCount ? <span>· {plural(entry.inlineCount, "inline comment")}</span> : null}
          <span data-tip={absoluteTime(entry.createdAt)}>{timeAgo(entry.createdAt)}</span>
        </div>
        {entry.bodyHtml && (
          <div className={cx("mt-1.5 rounded-xl border bg-panel px-3.5 py-3", border)}>
            <Markdown html={entry.bodyHtml} />
          </div>
        )}
      </div>
    </div>
  );
}

function CommitGroup({ commits, url }: { commits: TimelineEntry[]; url: string | null }) {
  const [open, setOpen] = useState(commits.length <= 3);
  const shown = open ? commits : commits.slice(-1);
  const line = "relative grid min-h-7 grid-cols-[22px_minmax(0,1fr)] items-center gap-3";
  const dot = (
    <span className="relative z-[1] grid place-items-center">
      <i className="block size-[7px] rounded-full border-[1.5px] border-fg-3 bg-bg" />
    </span>
  );
  return (
    <>
      {!open && (
        <div className={line}>
          {dot}
          <Button variant="ghost" size="sm" className="-ml-2 justify-self-start" onClick={() => setOpen(true)}>
            Show {commits.length - 1} earlier commits
          </Button>
        </div>
      )}
      {shown.map((c) => (
        <div className={line} key={c.id}>
          {dot}
          <div className="flex min-w-0 items-center gap-2 text-fg-2">
            <Avatar person={c.author} size="sm" />
            <span className="truncate">{c.message?.split("\n")[0]}</span>
            <span className="flex-1" />
            {c.url || url ? (
              <a className="shrink-0 font-mono text-[11.5px] leading-none text-fg-3 hover:text-fg-2" href={c.url ?? undefined} target="_blank" rel="noreferrer">
                {c.sha?.slice(0, 7)}
              </a>
            ) : (
              <span className="shrink-0 font-mono text-[11.5px] leading-none text-fg-3">{c.sha?.slice(0, 7)}</span>
            )}
            <span className="w-14 shrink-0 text-right text-[11.5px] leading-none text-fg-3">{timeAgo(c.createdAt)}</span>
          </div>
        </div>
      ))}
    </>
  );
}

// -----------------------------------------------------------------------------

function Rail({ detail, status, onReview }: { detail: DetailData; status: Readiness; onReview: () => void }) {
  const summary = detail.checksSummary;
  const row = "-mx-1.5 flex min-h-7 items-center gap-2 rounded-md px-1.5 text-fg no-underline";
  const empty = <span className="text-xs text-fg-3">None</span>;

  return (
    <aside className="flex min-w-0 flex-col gap-6 max-[1080px]:order-first">
      <div className="rounded-xl border border-line bg-panel p-3">
        <div className="flex h-[22px] items-center">
          <StatusBadge status={status} />
        </div>
        <p className="mb-3 mt-2 text-xs text-fg-2">{status.detail}</p>
        <div className="grid gap-1.5">
          {detail.number !== null && (
            <Button block onClick={onReview}>
              {detail.can.review ? "Leave a review" : "Comment"}
              <Kbd>R</Kbd>
            </Button>
          )}
          {detail.url && (
            <a className={cx(buttonClass({ variant: "ghost", block: true }), "no-underline")} href={detail.url} target="_blank" rel="noreferrer">
              Open on GitHub <ExternalLink size={12} />
            </a>
          )}
        </div>
      </div>

      {detail.number !== null && (
        <div>
          <Label>
            Checks
            <span className="flex-1" />
            {summary && summary.total > 0 && (
              <span className="tabular">
                {summary.passed}/{summary.total}
              </span>
            )}
          </Label>
          {summary && summary.total > 0 && (
            <div className="mb-2.5 flex h-[3px] overflow-hidden rounded-full bg-panel-3" aria-hidden>
              <i className="h-full bg-ok transition-[width] duration-500" style={{ width: `${(summary.passed / summary.total) * 100}%` }} />
              <i className="h-full bg-warn transition-[width] duration-500" style={{ width: `${(summary.pending / summary.total) * 100}%` }} />
              <i className="h-full bg-bad transition-[width] duration-500" style={{ width: `${(summary.failed / summary.total) * 100}%` }} />
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {detail.checks.length === 0 && <span className="text-xs text-fg-3">No checks reported.</span>}
            {detail.checks.map((check) => (
              <a key={check.name} className={cx(row, "hover:bg-hover")} href={check.url ?? undefined} target="_blank" rel="noreferrer" data-tip={check.summary ?? undefined}>
                <CheckIcon state={check.state} />
                <span className="min-w-0 flex-1 truncate">{check.name}</span>
                {check.durationSeconds !== null && <span className="shrink-0 text-[11.5px] text-fg-3 tabular">{formatDuration(check.durationSeconds)}</span>}
              </a>
            ))}
          </div>
        </div>
      )}

      {detail.number !== null && (
        <div>
          <Label>Reviewers</Label>
          <div className="flex flex-col gap-0.5">
            {detail.reviewers.length === 0 && <span className="text-xs text-fg-3">No reviewers yet.</span>}
            {detail.reviewers.map((r) => (
              <div className={row} key={r.person.login}>
                <Avatar person={r.person} size="sm" />
                <span className="min-w-0 flex-1 truncate">{r.person.login}</span>
                {r.state === "approved" ? (
                  <Pill tone="green">Approved</Pill>
                ) : r.state === "changes_requested" ? (
                  <Pill tone="red">Changes</Pill>
                ) : r.state === "requested" ? (
                  <Pill tone="blue">Requested</Pill>
                ) : (
                  <Pill>Commented</Pill>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.number !== null && (
        <div>
          <Label>Labels</Label>
          {detail.labels.length === 0 ? (
            empty
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {detail.labels.map((l) => (
                <span key={l.name} className="inline-flex h-[22px] items-center gap-1.5 rounded-full border border-line-2 px-2 text-[11.5px] font-medium leading-none text-fg-2">
                  <i className="size-2 shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--border-3)]" style={{ background: `#${l.color}` }} />
                  {l.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {detail.number !== null && (
        <div>
          <Label>Assignees</Label>
          {detail.assignees.length === 0
            ? empty
            : detail.assignees.map((a) => (
                <div className={row} key={a.login}>
                  <Avatar person={a} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{a.login}</span>
                </div>
              ))}
        </div>
      )}
    </aside>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
