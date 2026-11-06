import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowRight, Check, ChevronDown, CircleAlert, Copy, ExternalLink, Eye, GitMerge, Layers, MessageSquare, MoreHorizontal, Pencil, PencilLine, RotateCw, Tag, UploadCloud, UserPlus } from "lucide-react";
import type { CheckRun, Inbox, Session, Detail as DetailData, InboxItem, ItemRef, PRUpdate, ReviewRequest, StackEntry, TimelineEntry } from "../api";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/client";
import { keys, queryClient, refKey, useOptions } from "../lib/queries";
import { afterReview } from "../lib/inbox";
import { detailReadiness, entryReadiness, type Readiness } from "../lib/status";
import { absoluteTime, copy, modKey, navigate, plural, timeAgo, useNow, useShortcuts } from "../lib/util";
import { Composer } from "./Composer";
import { FilesPanel } from "./FilesPanel";
import type { PendingComment } from "./FileDiff";
import { Markdown } from "./Markdown";
import { Picker, type PickerItem } from "./Picker";
import { NotesProvider, NotesSection } from "./Notes";
import { RailCell, railWidth } from "./StackRail";
import { layoutTree, type TreeNode } from "../lib/stack-tree";
import { Avatar, Button, buttonClass, CheckIcon, cx, DiffStat, Kbd, Label, Pill, RichText, Spinner, StatusBadge, useDismiss, useToast } from "./ui";

interface Props {
  detail: DetailData;
  /** Inbox items, for the status of other PRs in the stack. */
  inboxItems: InboxItem[];
  scrollEl: HTMLElement | null;
  initialFile: string | null;
  /** The branch checked out locally, so the notes command can leave out --branch. */
  currentBranch: string | null;
  trunk: string;
}

export function DetailView({ detail, scrollEl, initialFile, trunk, inboxItems, currentBranch }: Props) {
  useNow();
  const key = keys.detail(detail.ref);
  const toast = useToast();
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const discussionInput = useRef<HTMLTextAreaElement>(null);
  const status = detailReadiness(detail);

  // After a change: both refetch past the server's cache (see lib/queries).
  const refresh = useCallback(
    () => Promise.all([queryClient.invalidateQueries({ queryKey: key }), queryClient.invalidateQueries({ queryKey: keys.inbox })]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail.ref],
  );

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

  // Edits show at once, roll back if GitHub refuses, and refresh the inbox either way.
  const update = useMutation({
    mutationFn: ({ change }: { change: PRUpdate; optimistic: (d: DetailData) => DetailData; done?: string }) => api.update(detail.number!, change),
    onMutate: async ({ optimistic }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DetailData>(key);
      queryClient.setQueryData<DetailData>(key, (d) => d && optimistic(d));
      return { previous };
    },
    onError: (error, _change, context) => {
      queryClient.setQueryData(key, context?.previous);
      toast(<span className="text-bad">{error.message}</span>, { key: "update" });
    },
    onSuccess: (fresh, { done }) => {
      queryClient.setQueryData(key, fresh);
      if (done) toast(done, { key: "update" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.inbox }),
  });
  const rerun = useMutation({
    mutationFn: (check?: CheckRun) => api.rerun(detail.number!, { jobId: check?.jobId ?? undefined }),
    onSuccess: (_fresh, check) => {
      // GitHub queues the job a moment later; show it running now. Polling takes over from here.
      const hit = (c: CheckRun) => (check ? c.name === check.name : c.state === "failure" && c.jobId !== null);
      queryClient.setQueryData<DetailData>(key, (d) => d && { ...d, checks: d.checks.map((c) => (hit(c) ? { ...c, state: "pending", durationSeconds: null } : c)) });
      toast(check ? `Re-running ${check.name}` : "Re-running failed checks", { key: "rerun" });
    },
    onError: (error) => toast(<span className="text-bad">{error.message}</span>, { key: "rerun" }),
  });
  const merge = useMutation({
    mutationFn: (stack: boolean) => api.merge(detail.number!, { stack }),
    onSuccess: (result) => {
      toast(
        result.queued ? (
          "GitHub queued the merge; it finishes shortly"
        ) : (
          <>
            <GitMerge size={14} className="text-merged" />
            Merged {result.merged.map((n) => `#${n}`).join(", ")}
          </>
        ),
        { key: "merge" },
      );
    },
    onError: (error) => toast(<span className="text-bad">{error.message}</span>, { key: "merge" }),
    // Merging changes the stack, the inbox and every PR above: refetch all of it.
    onSettled: () => queryClient.invalidateQueries(),
  });
  const railActions: RailActions = {
    merge: (stack) => merge.mutateAsync(stack).then(() => {}, () => {}),
    update: (change, optimistic, done) => update.mutateAsync({ change, optimistic, done }).then(() => {}, () => {}),
    rerun: (check) => rerun.mutateAsync(check).then(() => {}, () => {}),
  };

  const submitReview = async (request: ReviewRequest) => {
    await api.review(detail.number!, { ...request, comments: pending.map(({ path, line, side, body }) => ({ path, line, side, body })) });
    // The inbox too: the PR leaves "Needs your review" now, not after the next full inbox.
    queryClient.setQueryData<Inbox>(keys.inbox, (inbox) =>
      inbox && afterReview(inbox, detail.number!, request.event === "APPROVE" ? "approved" : request.event === "REQUEST_CHANGES" ? "changes_requested" : "commented"),
    );
    // Show the verdict now; the refetch below confirms it (and the merge rules) from GitHub.
    const viewer = queryClient.getQueryData<Session>(keys.session)?.viewer;
    const verdict = request.event === "APPROVE" ? "approved" : request.event === "REQUEST_CHANGES" ? "changes_requested" : "commented";
    queryClient.setQueryData<DetailData>(key, (d) =>
      d && viewer
        ? {
            ...d,
            reviewDecision: d.can.review && verdict !== "commented" ? verdict : d.reviewDecision,
            reviewers: [...d.reviewers.filter((r) => r.person.login !== viewer.login), { person: viewer, state: verdict }],
          }
        : d,
    );
    setPending([]);
    setReviewOpen(false);
    const verb = request.event === "APPROVE" ? "Approved" : request.event === "REQUEST_CHANGES" ? "Requested changes on" : "Reviewed";
    toast(
      <>
        {request.event === "APPROVE" ? <Check size={15} color="var(--green)" strokeWidth={2.5} /> : <MessageSquare size={14} className="text-ok" />}
        {verb} #{detail.number}
      </>,
      { key: "pending" },
    );
    refresh();
  };

  return (
    <NotesProvider detail={detail} currentBranch={currentBranch}>
      {detail.number !== null && (
        <TopbarSlot>
          <div className="relative">
            <Button variant={reviewOpen ? "default" : "primary"} onClick={() => setReviewOpen(!reviewOpen)} data-kbd="r" data-tip="Submit a review">
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
          {detail.stack.length > 1 && <StackSection stack={detail.stack} native={detail.nativeStack} trunk={trunk} items={inboxItems} current={status} />}
          {detail.number !== null && <DescriptionSection detail={detail} onSave={(body) => update.mutateAsync({ change: { body }, optimistic: (d) => d, done: "Description saved" })} />}
          <DiscussionSection detail={detail} inputRef={discussionInput} onCommented={refresh} />
          <NotesSection local={detail.state === "local"} />
        </div>
        <Rail detail={detail} status={status} actions={railActions} />
      </div>

      <FilesPanel
        detail={detail}
        itemKey={refKey(detail.ref)}
        scrollEl={scrollEl}
        pending={pending}
        onAddPending={(c) => {
          setPending((p) => [...p, { ...c, id: `${Date.now()}-${Math.random()}` }]);
          toast(
            <>
              <MessageSquare size={14} className="text-warn" /> Comment added to your review
              <Button variant="ghost" size="sm" onClick={() => setReviewOpen(true)}>
                Finish review
              </Button>
            </>,
            { key: "pending" },
          );
        }}
        onRemovePending={(id) => setPending((p) => p.filter((c) => c.id !== id))}
        initialFile={initialFile}
        onFileChange={onFileChange}
      />
    </NotesProvider>
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
  // Branch names are often long: they shrink (with an ellipsis) so the row never wraps.
  const chip = "block h-[22px] min-w-[72px] max-w-[300px] shrink truncate rounded-md border border-line bg-panel-2 px-2 font-mono text-[11.5px] leading-5 text-fg-2";
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
      <h1 className="mb-3.5 mt-3 text-[27px] font-semibold leading-[34px] tracking-[-0.028em] text-balance">{detail.title}</h1>
      <div className="flex min-w-0 items-center gap-x-2.5 text-fg-2" data-header-meta>
        <Avatar person={detail.author} />
        <b className="shrink-0 whitespace-nowrap font-medium leading-none text-fg">{detail.author?.login ?? "unknown"}</b>
        <button
          className={cx(chip, "text-left transition-colors hover:border-line-2 hover:text-fg")}
          data-branch-chip
          data-tip={`Copy checkout command for ${detail.branch}`}
          onClick={() =>
            copy(`pile checkout ${detail.branch}`).then(
              (ok) =>
                ok &&
                toast(
                  <>
                    <Copy size={14} className="text-fg-3" /> Copied <code>pile checkout {detail.branch}</code>
                  </>,
                  { key: "copy" },
                ),
            )
          }
        >
          {detail.branch}
        </button>
        <ArrowRight size={13} className="shrink-0 text-fg-4" />
        <span className={chip} title={detail.base} data-branch-chip>
          {detail.base}
        </span>
        <span className="min-w-2 flex-1" />
        <span className="shrink-0 whitespace-nowrap text-xs leading-none text-fg-3 tabular">{plural(detail.files.length, "file")}</span>
        <span className="shrink-0">
          <DiffStat additions={detail.additions} deletions={detail.deletions} bar />
        </span>
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
    <div ref={ref} role="dialog" aria-label="Submit review"
      // ⌘↵ submits from anywhere in the popover, not only while typing the summary.
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
      className="popover absolute right-0 top-[calc(100%+14px)] z-50 w-[420px] origin-top-right animate-pop-in rounded-[14px] bg-panel p-3 shadow-pop">
      <textarea
        autoFocus
        placeholder={event === "APPROVE" || pendingCount > 0 ? "Leave a summary (optional)" : "Leave a summary (required)"}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="block min-h-24 w-full resize-none rounded-lg border border-line-2 bg-bg px-3 py-2.5 text-fg outline-none placeholder:text-fg-3 focus:border-line-3 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
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
                <small className="text-xs text-fg-3">{help}</small>
              </span>
            </button>
          );
        })}
      </div>
      {own && <p className="-mt-1 mb-2.5 pl-[36px] pr-2 text-xs text-fg-3">You can't approve or request changes on your own pull request.</p>}
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
            <Kbd>{modKey}</Kbd>
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

/** Every entry with the entry it's built on (null: the trunk), for the rail layout. */
export function stackTree(stack: StackEntry[]): TreeNode[] {
  const byBranch = new Map(stack.map((e) => [e.branch, e]));
  return stack.map((e) => ({ id: refKey(e.ref), parent: byBranch.has(e.base) ? refKey(byBranch.get(e.base)!.ref) : null }));
}

function StackSection({ stack, native, trunk, items, current }: { stack: StackEntry[]; native: number | null; trunk: string; items: InboxItem[]; current: Readiness }) {
  const [expanded, setExpanded] = useState(false);
  const { rows, lanes } = useMemo(() => layoutTree(stackTree(stack)), [stack]);
  const byId = new Map(stack.map((e) => [refKey(e.ref), e]));
  const entryRows = rows.filter((r) => r.id !== null);
  const trunkRow = rows[rows.length - 1];
  const currentRow = entryRows.findIndex((r) => byId.get(r.id!)?.isCurrent);
  // Long straight stacks fold around the current PR; diverging ones show every branch.
  const parts = lanes === 1 ? windowed(entryRows, currentRow, expanded) : entryRows.map((entry) => ({ entry }));
  const depth = (entry: StackEntry): number => {
    let n = 1;
    for (let e = byId.get(stackTree([entry])[0].id); e && byId.has(refKey(e.ref)); ) {
      const parent = stack.find((p) => p.branch === e!.base);
      if (!parent) break;
      n++;
      e = parent;
    }
    return n;
  };
  const me = stack.find((e) => e.isCurrent);
  const row = "grid h-9 items-center gap-3 rounded-lg pr-2";
  const cols = { gridTemplateColumns: `${railWidth(lanes)}px minmax(0,1fr) auto` };
  const dot = (entry: StackEntry) => (
    <i
      className={cx(
        "block size-[9px] rounded-full border-[1.5px]",
        entry.isCurrent ? "border-accent bg-accent shadow-[0_0_0_3px_var(--accent-soft)]" : entry.state === "merged" ? "border-merged bg-merged" : "border-fg-3 bg-bg",
      )}
    />
  );

  return (
    <Section
      title={
        <>
          <Layers size={13} /> Stack{" "}
          <span className="font-normal text-fg-3 tabular">
            {lanes > 1 ? `${stack.length} PRs · ${lanes} branches` : me ? `${depth(me)} of ${stack.length}` : stack.length}
          </span>
        </>
      }
      right={
        // GitHub's stack is the source of truth; say when this one is only pile's reading of the branches.
        <span className="text-xs font-normal text-fg-3" data-stack-kind={native ? "github" : "branches"} data-tip={native ? undefined : "Not a GitHub stack: pile submit registers it"}>
          {native ? `GitHub stack #${native}` : "Linked by branches"}
        </span>
      }
    >
      <div className="flex flex-col" data-stack-lanes={lanes}>
        {parts.map((part, i) =>
          "hidden" in part ? (
            <button key={`more-${i}`} className={cx(row, "text-left text-xs text-fg-3 hover:bg-hover hover:text-fg-2")} style={cols} onClick={() => setExpanded(true)}>
              <RailCell row={{ id: null, lane: 0, up: true, down: true, joins: [], through: [] }} lanes={lanes} node={null} dashed />
              <span>{part.hidden} more</span>
              <span />
            </button>
          ) : (
            (() => {
              const entry = byId.get(part.entry.id!)!;
              return (
                <div
                  key={part.entry.id}
                  role="link"
                  tabIndex={0}
                  data-stack-entry={entry.branch}
                  onClick={() => !entry.isCurrent && navigate(entry.ref)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(entry.ref)}
                  className={cx(row, entry.isCurrent ? "bg-active text-fg" : "cursor-pointer text-fg-2 hover:bg-hover hover:text-fg")}
                  style={cols}
                >
                  <RailCell row={part.entry} lanes={lanes} node={dot(entry)} />
                  <span className="truncate leading-5">
                    {entry.ref.kind === "pr" && <span className="mr-1.5 text-fg-3 tabular">#{entry.ref.number}</span>}
                    {entry.title}
                  </span>
                  <StatusBadge status={entry.isCurrent ? current : entryReadiness(entry, items)} size="sm" />
                </div>
              );
            })()
          ),
        )}
        <div className={cx(row, "font-mono text-[11.5px] text-fg-3")} style={cols}>
          <RailCell row={trunkRow} lanes={lanes} node={<i className="block size-[9px] rounded-sm border-[1.5px] border-fg-3 bg-bg" />} />
          <span>{trunk}</span>
          <span />
        </div>
      </div>
    </Section>
  );
}

function DescriptionSection({ detail, onSave }: { detail: DetailData; onSave: (body: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const start = () => {
    setText(detail.body ?? "");
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      await onSave(text);
      setEditing(false);
    } catch {
      // The toast says why; keep the text to try again.
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    if (!editing) return;
    input.current?.focus({ preventScroll: true });
    input.current?.setSelectionRange(input.current.value.length, input.current.value.length);
  }, [editing]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.7)}px`;
  }, [text, editing]);

  return (
    <Section
      title="Description"
      right={
        !editing &&
        (detail.can.edit ? (
          <Button variant="ghost" size="sm" onClick={start} data-edit-description>
            <Pencil size={12} /> Edit
          </Button>
        ) : (
          detail.url && (
            <a className={cx(buttonClass({ variant: "ghost", size: "sm" }), "no-underline")} href={detail.url} target="_blank" rel="noreferrer">
              <ExternalLink size={12} /> On GitHub
            </a>
          )
        ))
      }
    >
      {editing ? (
        <div className="rounded-xl border border-line-2 bg-panel focus-within:border-accent" data-description-editor>
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              }
            }}
            spellCheck
            placeholder="Describe the change, in markdown"
            aria-label="Description, in markdown"
            className="block min-h-40 w-full resize-none rounded-t-xl bg-transparent px-4 py-3.5 font-mono text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-fg-4"
          />
          <div className="flex items-center gap-2 border-t border-line px-3 py-2">
            <span className="text-[12px] text-fg-3">Markdown</span>
            <span className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || text === (detail.body ?? "")}>
              {saving ? <Spinner size={12} /> : null}
              Save <Kbd>{modKey}↵</Kbd>
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-panel px-4 py-3.5">
          {detail.bodyHtml ? <Markdown html={detail.bodyHtml} /> : <span className="text-fg-3">No description provided.</span>}
        </div>
      )}
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
        {groups.length === 0 && <div className="pl-[34px] text-fg-3">No activity yet.</div>}
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
                    <MessageSquare size={14} className="text-ok" /> Comment posted
                  </>,
                  { key: "discussion" },
                );
                onCommented();
              } catch (e) {
                toast(
                  <>
                    <CircleAlert size={14} color="var(--red)" /> {(e as Error).message}
                  </>,
                  { key: "discussion" },
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
          {entry.inlineCount ? (
            <>
              <span className="text-fg-4">·</span>
              <span>{plural(entry.inlineCount, "inline comment")}</span>
            </>
          ) : null}
          <span className="text-fg-4">·</span>
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

interface RailActions {
  /** Applies `change` on GitHub, showing `optimistic` until it's confirmed. */
  update: (change: PRUpdate, optimistic: (d: DetailData) => DetailData, done?: string) => Promise<void>;
  rerun: (check?: CheckRun) => Promise<void>;
  /** Merges this PR, or the stack up to it. */
  merge: (stack: boolean) => Promise<void>;
}

function Rail({ detail, status, actions }: { detail: DetailData; status: Readiness; actions: RailActions }) {
  // Count and bar come from the same list as the rows below, so they always agree.
  const summary =
    detail.checks.length > 0
      ? {
          total: detail.checks.length,
          passed: detail.checks.filter((c) => c.state === "success").length,
          failed: detail.checks.filter((c) => c.state === "failure").length,
          pending: detail.checks.filter((c) => c.state === "pending").length,
          skipped: detail.checks.filter((c) => c.state === "neutral").length,
        }
      : null;
  const row = "-mx-1.5 flex min-h-7 items-center gap-2 rounded-md px-1.5 text-fg no-underline";
  const empty = <span className="text-xs text-fg-3">None</span>;
  const isPR = detail.number !== null;
  const editable = isPR && (detail.state === "open" || detail.state === "draft");
  const rerunnable = detail.checks.filter((c) => c.state === "failure" && c.jobId !== null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = (id: string, task: () => Promise<void>) => {
    setBusy(id);
    task().finally(() => setBusy(null));
  };

  const [picker, setPicker] = useState<"reviewers" | "assignees" | "labels" | null>(null);
  // Loaded on first use; shared by all three pickers.
  const options = useOptions(picker !== null);
  const people = (exclude?: string): PickerItem[] | undefined =>
    options.data?.people.map((p) => ({
      id: p.login,
      label: p.login,
      icon: <Avatar person={p} size="sm" />,
      disabled: p.login === exclude,
      hint: p.login === exclude ? "Author" : undefined,
    }));
  const swatch = (color: string) => (
    <i className="size-2.5 shrink-0 rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--text)_28%,transparent)]" style={{ background: `#${color}` }} />
  );
  const editButton = (which: "reviewers" | "assignees" | "labels", label: string) =>
    editable && (
      <Button
        variant="ghost"
        size="sm"
        icon
        className="-my-1 -mr-1.5 ml-auto"
        aria-label={label}
        data-tip={label}
        onClick={() => setPicker((p) => (p === which ? null : which))}
      >
        {which === "labels" ? <Tag size={13} /> : <UserPlus size={13} />}
      </Button>
    );

  const requested = detail.reviewers.filter((r) => r.state === "requested" && !r.isTeam).map((r) => r.person.login);
  const applyReviewers = (next: string[]) => {
    const add = next.filter((l) => !requested.includes(l));
    const remove = requested.filter((l) => !next.includes(l));
    actions.update(
      { reviewers: { add, remove } },
      (d) => ({
        ...d,
        reviewers: [
          ...d.reviewers.filter((r) => !remove.includes(r.person.login) && !add.includes(r.person.login)),
          ...add.map((login) => ({ person: options.data?.people.find((p) => p.login === login) ?? { login, avatarUrl: null }, state: "requested" as const })),
        ],
      }),
      add.length && !remove.length ? `Requested review from ${add.join(", ")}` : "Reviewers updated",
    );
  };
  const applyAssignees = (next: string[]) => {
    const current = detail.assignees.map((a) => a.login);
    const add = next.filter((l) => !current.includes(l));
    const remove = current.filter((l) => !next.includes(l));
    actions.update(
      { assignees: { add, remove } },
      (d) => ({ ...d, assignees: next.map((login) => options.data?.people.find((p) => p.login === login) ?? { login, avatarUrl: null }) }),
      "Assignees updated",
    );
  };
  const applyLabels = (next: string[]) =>
    actions.update(
      { labels: next },
      (d) => ({
        ...d,
        labels: next.map((name) => d.labels.find((l) => l.name === name) ?? options.data?.labels.find((l) => l.name === name) ?? { name, color: "8b8b8b" }),
      }),
      "Labels updated",
    );

  return (
    <aside className="flex min-w-0 flex-col gap-6">
      <StatusCard detail={detail} status={status} actions={actions} />
      {isPR && (
        <div>
          <Label>
            Checks
            <span className="flex-1" />
            {summary && (
              <span className="truncate whitespace-nowrap tabular" data-checks-summary>
                {summary.failed || summary.pending || summary.skipped
                  ? [
                      summary.failed && `${summary.failed} failed`,
                      summary.pending && `${summary.pending} running`,
                      summary.passed && `${summary.passed} passed`,
                      // Only when nothing needs attention; otherwise its own row says it.
                      !summary.failed && !summary.pending && summary.skipped && `${summary.skipped} skipped`,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : `${summary.passed} of ${summary.total} passed`}
              </span>
            )}
          </Label>
          {summary && (
            // Each part its own rounded pill with a hairline gap, so every colour reads as
            // the same thickness (square joins made the middle ones look thinner).
            <div className="mb-2.5 flex h-[3px] gap-[2px]" aria-hidden data-checks-bar>
              {(
                [
                  [summary.passed, "bg-ok"],
                  [summary.pending, "bg-warn"],
                  [summary.failed, "bg-bad"],
                  // Skipped checks didn't fail: grey, like the empty track.
                  [summary.skipped, "bg-line-3"],
                  [summary.total - summary.passed - summary.pending - summary.failed - summary.skipped, "bg-panel-3"],
                ] as const
              )
                .filter(([n]) => n > 0)
                .map(([n, color]) => (
                  <i key={color} className={cx("h-full min-w-[3px] rounded-full transition-[flex-grow] duration-500", color)} style={{ flexGrow: n, flexBasis: 0 }} />
                ))}
            </div>
          )}
          <ChecksList checks={detail.checks} row={row} busy={busy} onRerun={(check) => run(`check-${check.name}`, () => actions.rerun(check))} />
          {rerunnable.length > 0 && (
            <Button size="sm" variant="ghost" className="-ml-1.5 mt-1.5 text-fg-2" disabled={busy === "rerun"} onClick={() => run("rerun", () => actions.rerun())}>
              {busy === "rerun" ? <Spinner size={11} /> : <RotateCw size={12} />}
              Re-run failed {rerunnable.length === 1 ? "check" : `checks (${rerunnable.length})`}
            </Button>
          )}
        </div>
      )}

      {isPR && (
        <div className="relative">
          <Label>
            Reviewers
            {editButton("reviewers", "Request reviewers")}
          </Label>
          {picker === "reviewers" && (
            <Picker
              title="Request reviews from"
              items={people(detail.author?.login)}
              initial={requested}
              onApply={applyReviewers}
              onClose={() => setPicker(null)}
              empty="Nobody else has access to this repository"
            />
          )}
          <div className="flex flex-col gap-0.5">
            {detail.reviewers.length === 0 && <span className="text-xs text-fg-3">No reviewers yet.</span>}
            {detail.reviewers.map((r) => (
              <div className={row} key={r.person.login}>
                <Avatar person={r.person} size="sm" />
                <span className="min-w-0 flex-1 truncate">{r.person.login}</span>
                {r.state === "approved" ? (
                  <Pill tone="green">Approved</Pill>
                ) : r.state === "changes_requested" ? (
                  <Pill tone="red">Changes requested</Pill>
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

      {isPR && (
        <div className="relative">
          <Label>
            Labels
            {editButton("labels", "Edit labels")}
          </Label>
          {picker === "labels" && (
            <Picker
              title="Labels"
              items={options.data?.labels.map((l) => ({ id: l.name, label: l.name, icon: swatch(l.color), hint: undefined }))}
              initial={detail.labels.map((l) => l.name)}
              onApply={applyLabels}
              onClose={() => setPicker(null)}
              create={(name) => ({ id: name, label: name, icon: swatch("8b8b8b"), hint: "New" })}
              empty="This repository has no labels yet"
            />
          )}
          {detail.labels.length === 0 ? (
            empty
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {detail.labels.map((l) => (
                <span key={l.name} className="inline-flex h-[22px] items-center gap-1.5 rounded-full border border-line-2 px-2 text-[11.5px] font-medium leading-none text-fg-2" data-tip={l.description ?? undefined}>
                  <i className="size-2 shrink-0 rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--text)_28%,transparent)]" style={{ background: `#${l.color}` }} />
                  {l.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {isPR && (
        <div className="relative">
          <Label>
            Assignees
            {editButton("assignees", "Edit assignees")}
          </Label>
          {picker === "assignees" && (
            <Picker
              title="Assign to"
              items={people()}
              initial={detail.assignees.map((a) => a.login)}
              onApply={applyAssignees}
              onClose={() => setPicker(null)}
              empty="Nobody has access to this repository"
            />
          )}
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

/**
 * Where the PR stands and the one thing to do next: mark your draft ready, or merge
 * (this PR, or the stack up to it) once nothing blocks it. Everything else lives in
 * the ⋯ menu.
 */
function StatusCard({ detail, status, actions }: { detail: DetailData; status: Readiness; actions: RailActions }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = (task: () => Promise<void>) => {
    setBusy(true);
    task().finally(() => setBusy(false));
  };
  const merge = detail.merge;
  const options = merge
    ? ([merge.single.possible && { stack: false, label: `Merge #${detail.number}`, ...merge.single }, merge.stack && { stack: true, label: `Merge stack (${merge.stack.count})`, ...merge.stack }].filter(
        Boolean,
      ) as Array<{ stack: boolean; label: string; blockers: string[] }>)
    : [];
  // Prefer an option that can go now; the whole stack when both can.
  const [choice, setChoice] = useState<boolean | null>(null);
  const ready = options.filter((o) => o.blockers.length === 0);
  const option = options.find((o) => o.stack === choice) ?? ready.at(-1) ?? options[0];
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useDismiss(menu, () => setMenu(false));
  const [picking, setPicking] = useState(false);
  const pickRef = useDismiss(picking, () => setPicking(false));
  const method = merge?.method === "squash" ? "Squash and merge" : merge?.method === "rebase" ? "Rebase and merge" : "Merge";
  const into = detail.stack.length && option?.stack ? detail.stack.find((e) => !e.isCurrent && e.state !== "merged")?.branch : detail.base;

  const menuItem = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg-2 no-underline hover:bg-hover hover:text-fg [&_svg]:shrink-0";
  return (
    <div className="rounded-xl border border-line bg-panel p-3" data-status-card>
      <div className="flex h-[22px] items-center">
        <StatusBadge status={status} />
        <span className="flex-1" />
        <div className="relative" ref={menuRef}>
          <Button variant="ghost" size="sm" icon className="-mr-1" aria-label="More actions" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <MoreHorizontal size={15} />
          </Button>
          {menu && (
            <div role="menu" className="popover absolute right-0 top-[calc(100%+6px)] z-50 w-56 origin-top-right animate-pop-in rounded-xl bg-panel p-1.5 shadow-pop">
              {detail.url && (
                <a role="menuitem" className={menuItem} href={detail.url} target="_blank" rel="noreferrer" onClick={() => setMenu(false)}>
                  <ExternalLink size={14} /> Open on GitHub
                  <span className="ml-auto">
                    <Kbd>O</Kbd>
                  </span>
                </a>
              )}
              <button
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  setMenu(false);
                  copy(`pile checkout ${detail.branch}`);
                  toast("Copied checkout command", { key: "copy" });
                }}
              >
                <Copy size={14} /> Copy checkout command
              </button>
              {detail.can.draft && detail.state === "open" && (
                <button
                  role="menuitem"
                  className={menuItem}
                  onClick={() => {
                    setMenu(false);
                    run(() => actions.update({ draft: true }, (d) => ({ ...d, state: "draft" }), `#${detail.number} is a draft again`));
                  }}
                >
                  <PencilLine size={14} /> Convert to draft
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-fg-2">
        <RichText text={status.detail} />
      </p>

      {detail.can.draft && detail.state === "draft" ? (
        <Button
          block
          variant="primary"
          className="mt-3"
          disabled={busy}
          onClick={() => run(() => actions.update({ draft: false }, (d) => ({ ...d, state: "open" }), `#${detail.number} is ready for review`))}
        >
          {busy ? <Spinner size={12} /> : <Eye size={13} />}
          Ready for review
        </Button>
      ) : (
        option && (
          <div className="mt-3">
            {confirming ? (
              <div className="grid gap-1.5 rounded-lg border border-line-2 bg-bg p-2" role="group" aria-label="Confirm merge">
                <p className="px-0.5 text-xs text-fg-2">
                  {method} {option.stack ? `${merge!.stack!.count} PRs` : `#${detail.number}`} into <code className="text-[11px]">{into}</code>?
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button
                    variant="success"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await actions.merge(option.stack);
                        setConfirming(false);
                      })
                    }
                  >
                    {busy && <Spinner size={12} />}
                    Merge
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex" ref={pickRef}>
                <Button
                  block
                  variant={option.blockers.length ? "default" : "success"}
                  className={cx(options.length > 1 && "rounded-r-none")}
                  disabled={option.blockers.length > 0}
                  onClick={() => setConfirming(true)}
                >
                  <GitMerge size={13} />
                  {option.label}
                </Button>
                {options.length > 1 && (
                  <div className="relative">
                    <Button
                      variant={option.blockers.length ? "default" : "success"}
                      icon
                      className="h-7 rounded-l-none border-l border-l-black/20"
                      aria-label="Merge options"
                      onClick={() => setPicking((p) => !p)}
                    >
                      <ChevronDown size={13} />
                    </Button>
                    {picking && (
                      <div role="menu" className="popover absolute right-0 top-[calc(100%+6px)] z-50 w-60 origin-top-right animate-pop-in rounded-xl bg-panel p-1.5 shadow-pop">
                        {options.map((o) => (
                          <button
                            key={String(o.stack)}
                            role="menuitemradio"
                            aria-checked={o === option}
                            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
                            onClick={() => {
                              setChoice(o.stack);
                              setPicking(false);
                            }}
                          >
                            <span className="mt-0.5 w-3.5 shrink-0">{o === option && <Check size={13} />}</span>
                            <span className="grid gap-0.5">
                              <span className="text-[13px] text-fg">{o.label}</span>
                              <span className="text-[11.5px] text-fg-3">
                                {o.stack ? "Every open PR from the bottom of the stack up to this one" : `Only this PR, into ${detail.base}`}
                                {o.blockers.length > 0 && " · blocked"}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {option.blockers.length > 0 && !confirming && (
              <ul className="mt-2 grid gap-1 text-[11.5px] leading-4 text-fg-3" aria-label="What blocks merging">
                {option.blockers.map((b) => (
                  <li key={b} className="flex gap-1.5">
                    <CircleAlert size={12} className="mt-0.5 shrink-0 text-warn" />
                    {b}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      )}
    </div>
  );
}

/**
 * Checks, with what needs attention first: failing and running checks are always
 * listed; passed and skipped ones fold into a summary row each once there are more
 * than a handful, so a repo with dozens of checks doesn't make the rail endless.
 */
function ChecksList({ checks, row, busy, onRerun }: { checks: CheckRun[]; row: string; busy: string | null; onRerun: (check: CheckRun) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (checks.length === 0) return <span className="text-xs text-fg-3">No checks reported.</span>;
  const fold = checks.length > 6;
  const groups: Array<{ key: string; label: string; state: CheckRun["state"]; items: CheckRun[] }> = [
    { key: "passed", label: "passed", state: "success", items: checks.filter((c) => c.state === "success") },
    { key: "skipped", label: "skipped", state: "neutral", items: checks.filter((c) => c.state === "neutral" || c.state === "none") },
  ];
  const urgent = checks.filter((c) => c.state === "failure" || c.state === "pending");
  const item = (check: CheckRun) => (
    <div key={check.name} className={cx(row, "group/check relative hover:bg-hover")} data-tip={check.summary ?? undefined} data-check={check.state}>
      <CheckIcon state={check.state} />
      <a className="min-w-0 flex-1 truncate text-fg no-underline after:absolute after:inset-0" href={check.url ?? undefined} target="_blank" rel="noreferrer">
        {check.name}
      </a>
      {check.durationSeconds !== null && (
        <span className={cx("shrink-0 text-[11.5px] text-fg-3 tabular", check.jobId !== null && check.state !== "pending" && "group-hover/check:hidden")}>
          {formatDuration(check.durationSeconds)}
        </span>
      )}
      {check.jobId !== null && check.state !== "pending" && (
        <span className="relative z-[1] -mr-1 hidden group-focus-within/check:flex group-hover/check:flex">
          <Button variant="ghost" size="sm" icon aria-label={`Re-run ${check.name}`} data-tip="Re-run" disabled={busy === `check-${check.name}`} onClick={() => onRerun(check)}>
            <RotateCw size={12} />
          </Button>
        </span>
      )}
    </div>
  );
  if (!fold) return <div className="flex flex-col gap-0.5">{checks.map(item)}</div>;
  return (
    <div className="flex flex-col gap-0.5">
      {urgent.map(item)}
      {groups.map(
        (group) =>
          group.items.length > 0 && (
            <div key={group.key} className="flex flex-col gap-0.5">
              <button
                className={cx(row, "w-full text-left text-fg-2 hover:bg-hover hover:text-fg")}
                aria-expanded={!!open[group.key]}
                onClick={() => setOpen((o) => ({ ...o, [group.key]: !o[group.key] }))}
              >
                <CheckIcon state={group.state} />
                <span className="flex-1">
                  {group.items.length} {group.label}
                </span>
                <ChevronDown size={13} className={cx("shrink-0 text-fg-3 transition-transform duration-150", !open[group.key] && "-rotate-90")} />
              </button>
              {open[group.key] && <div className="ml-3 flex flex-col gap-0.5 border-l border-line pl-1.5">{group.items.map(item)}</div>}
            </div>
          ),
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
