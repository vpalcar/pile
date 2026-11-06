import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  GitCommitHorizontal,
  Layers,
  MessageSquare,
  Pencil,
  UploadCloud,
} from "lucide-react";
import type { Detail as DetailData, ItemRef, ReviewRequest, StackEntry, TimelineEntry } from "../api";
import { api, load, refKey } from "../lib/client";
import { absoluteTime, copy, navigate, plural, timeAgo, useNow, useShortcuts } from "../lib/util";
import { Composer } from "./Composer";
import { FilesPanel } from "./FilesPanel";
import type { PendingComment } from "./FileDiff";
import { Markdown } from "./Markdown";
import { Avatar, CheckIcon, DiffStat, Kbd, PRStateIcon, PRStatePill, ReviewBadge, Spinner, useDismiss, useToast } from "./ui";

interface Props {
  detail: DetailData;
  scrollEl: HTMLElement | null;
  initialFile: string | null;
  trunk: string;
}

export function DetailView({ detail, scrollEl, initialFile, trunk }: Props) {
  useNow();
  const key = refKey(detail.ref);
  const toast = useToast();
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const discussionInput = useRef<HTMLTextAreaElement>(null);

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
    await api.review(detail.number!, {
      ...request,
      comments: pending.map(({ path, line, side, body }) => ({ path, line, side, body })),
    });
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
      <div className="page">
        <div style={{ minWidth: 0 }}>
          <Header detail={detail} />
          {detail.number !== null && (
            <ReviewPortal>
              <div style={{ position: "relative" }}>
                <button className={`btn sm ${reviewOpen ? "" : "primary"}`} onClick={() => setReviewOpen(!reviewOpen)} data-kbd="r" data-tip="Submit a review">
                  {detail.can.review ? "Review" : "Comment"}
                  {pending.length > 0 && (
                    <span className="pill amber" style={{ height: 16, padding: "0 6px" }}>
                      {pending.length}
                    </span>
                  )}
                  <ChevronDown size={13} />
                </button>
                {reviewOpen && <ReviewPopover detail={detail} pendingCount={pending.length} onClose={() => setReviewOpen(false)} onSubmit={submitReview} />}
              </div>
            </ReviewPortal>
          )}
          {detail.state === "local" && <LocalBanner detail={detail} />}
          {detail.local && detail.local.ahead > 0 && detail.number && (
            <div className="local-banner">
              <UploadCloud size={15} color="var(--amber)" />
              <span>
                {plural(detail.local.ahead, "local commit")} not pushed. Run <code>pile submit</code> to update this PR.
              </span>
            </div>
          )}
          {detail.stack.length > 1 && <StackSection stack={detail.stack} trunk={trunk} />}
          {detail.number !== null && <DescriptionSection detail={detail} />}
          <DiscussionSection detail={detail} inputRef={discussionInput} onCommented={refresh} />
        </div>
        <Rail detail={detail} onReview={() => setReviewOpen(true)} />
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
              <button className="btn ghost sm" onClick={() => setReviewOpen(true)}>
                Finish review
              </button>
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

// -----------------------------------------------------------------------------

/** Renders into the top bar's action slot, so the review button is always in reach. */
function ReviewPortal({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("topbar-actions")), []);
  return slot ? createPortal(children, slot) : null;
}

function Header({ detail }: { detail: DetailData }) {
  const toast = useToast();
  return (
    <header>
      <div className="eyebrow">
        <PRStatePill state={detail.state} />
        {detail.number !== null && <span className="num">#{detail.number}</span>}
        <span>·</span>
        <span>{detail.updatedAt ? `Updated ${timeAgo(detail.updatedAt)}` : ""}</span>
        <span style={{ flex: 1 }} />
      </div>
      <h1 className="title">{detail.title}</h1>
      <div className="byline">
        <Avatar person={detail.author} />
        <b style={{ fontWeight: 520, color: "var(--text)" }}>{detail.author?.login ?? "unknown"}</b>
        <button
          className="branch-chip"
          data-tip="Copy checkout command"
          onClick={() => copy(`pile checkout ${detail.branch}`).then((ok) => ok && toast(<>Copied <code>pile checkout {detail.branch}</code></>))}
        >
          {detail.branch}
        </button>
        <ArrowRight size={13} className="faint" />
        <span className="branch-chip" style={{ cursor: "default" }}>
          {detail.base}
        </span>
        <span className="spacer" />
        <span className="faint num">{plural(detail.files.length, "file")}</span>
        <DiffStat additions={detail.additions} deletions={detail.deletions} bar />
      </div>
    </header>
  );
}

function LocalBanner({ detail }: { detail: DetailData }) {
  return (
    <div className="local-banner">
      <UploadCloud size={15} color="var(--amber)" />
      <span>
        Local branch{detail.local?.unpushed ? ", not on GitHub yet" : ""}. Run <code>pile submit</code> to open a pull request.
      </span>
    </div>
  );
}

function ReviewPopover({
  detail,
  pendingCount,
  onClose,
  onSubmit,
}: {
  detail: DetailData;
  pendingCount: number;
  onClose: () => void;
  onSubmit: (request: ReviewRequest) => Promise<void>;
}) {
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
    <div className="popover review-pop" ref={ref} role="dialog" aria-label="Submit review">
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
      />
      <div className="review-choices" role="radiogroup">
        {choices.map(([value, label, help]) => {
          const disabled = own && value !== "COMMENT";
          return (
            <button
              key={value}
              className={`review-choice ${event === value ? "on" : ""}`}
              onClick={() => !disabled && setEvent(value)}
              disabled={disabled}
              style={disabled ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
              role="radio"
              aria-checked={event === value}
            >
              <span className="radio" />
              <span>
                <b>{label}</b>
                <small>{disabled ? "You can't approve or request changes on your own pull request." : help}</small>
              </span>
            </button>
          );
        })}
      </div>
      {error && (
        <div className="error-box" style={{ marginBottom: 10 }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="faint" style={{ fontSize: 12 }}>
          {pendingCount > 0 ? `Includes ${plural(pendingCount, "inline comment")}` : ""}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className={`btn ${event === "APPROVE" ? "success" : event === "REQUEST_CHANGES" ? "danger" : "primary"}`} onClick={submit} disabled={needsBody || busy}>
          {busy && <Spinner size={12} />}
          Submit review
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

function Section({ title, right, children, defaultOpen = true }: { title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`section ${open ? "" : "collapsed"}`}>
      <div className="section-head">
        <button className="toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ChevronDown size={13} />
          {title}
        </button>
        <span className="spacer" />
        {right}
      </div>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

function StackSection({ stack, trunk }: { stack: StackEntry[]; trunk: string }) {
  const current = stack.findIndex((s) => s.isCurrent);
  const [expanded, setExpanded] = useState(false);
  const top = [...stack].reverse();
  return (
    <Section
      title={
        <>
          <Layers size={13} /> Stack <span className="faint num">{current + 1} of {stack.length}</span>
        </>
      }
    >
      <div className="stack-list">
        <div className="stack-line" />
        {windowed(top, top.findIndex((e) => e.isCurrent), expanded).map((part, i) =>
          "hidden" in part ? (
            <button key={`more-${i}`} className="stack-more" onClick={() => setExpanded(true)}>
              <span className="dots">⋮</span>
              {part.hidden} more
            </button>
          ) : (
          <div
            key={refKey(part.entry.ref)}
            className={`stack-row ${part.entry.isCurrent ? "current" : ""} ${part.entry.state === "merged" ? "merged" : ""}`}
            onClick={() => !part.entry.isCurrent && navigate(part.entry.ref)}
            role="link"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && navigate(part.entry.ref)}
          >
            <span className="node" />
            <span className="stack-title">
              {part.entry.ref.kind === "pr" && <span className="n">#{part.entry.ref.number}</span>}
              {part.entry.title}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {part.entry.state !== "open" && part.entry.state !== "local" && <PRStateIcon state={part.entry.state} size={13} />}
            </span>
          </div>
          ),
        )}
        <div className="stack-row trunk">
          <span className="node" />
          <span>{trunk}</span>
          <span />
        </div>
      </div>
    </Section>
  );
}

/**
 * Long stacks show the ends and the neighborhood of the current entry; the rest
 * collapse into "N more" rows.
 */
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

function DescriptionSection({ detail }: { detail: DetailData }) {
  return (
    <Section
      title="Description"
      right={
        detail.url && (
          <a className="btn ghost sm" href={`${detail.url}`} target="_blank" rel="noreferrer">
            <Pencil size={12} /> Edit on GitHub
          </a>
        )
      }
    >
      {detail.bodyHtml ? (
        <div className="description">
          <Markdown html={detail.bodyHtml} />
        </div>
      ) : (
        <div className="description empty">No description provided.</div>
      )}
    </Section>
  );
}

function DiscussionSection({
  detail,
  inputRef,
  onCommented,
}: {
  detail: DetailData;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onCommented: () => void;
}) {
  const toast = useToast();
  // Runs of 3+ commits collapse into one expandable row.
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
          {comments > 0 && <span className="faint num">{comments}</span>}
        </>
      }
    >
      <div className="timeline">
        {groups.map((g, i) => (Array.isArray(g) ? <CommitGroup key={i} commits={g} url={detail.url} /> : <Event key={g.id} entry={g} />))}
        {groups.length === 0 && <div className="faint" style={{ paddingLeft: 34 }}>No activity yet.</div>}
      </div>
      {detail.can.comment && detail.number !== null && (
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
      )}
    </Section>
  );
}

function Event({ entry }: { entry: TimelineEntry }) {
  const verb =
    entry.kind === "review"
      ? { approved: "approved", changes_requested: "requested changes", commented: "reviewed", pending: "started a review", dismissed: "had a review dismissed" }[entry.reviewState ?? "commented"]
      : "commented";
  return (
    <div className={`event ${entry.kind === "review" ? `review-${entry.reviewState}` : ""}`}>
      <Avatar person={entry.author} size="lg" />
      <div style={{ minWidth: 0 }}>
        <div className="event-head">
          <b>{entry.author?.login}</b>
          <span>{verb}</span>
          {entry.kind === "review" && entry.reviewState === "approved" && <Check size={13} color="var(--green)" strokeWidth={2.5} />}
          {entry.kind === "review" && entry.reviewState === "changes_requested" && <AlertTriangle size={13} color="var(--red)" />}
          {entry.inlineCount ? <span className="faint">· {plural(entry.inlineCount, "inline comment")}</span> : null}
          <span data-tip={absoluteTime(entry.createdAt)}>{timeAgo(entry.createdAt)}</span>
        </div>
        {entry.bodyHtml && (
          <div className="event-body">
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
  return (
    <>
      {!open && (
        <div className="event commit">
          <span className="commit-icon">
            <GitCommitHorizontal size={14} />
          </span>
          <button className="btn ghost sm" style={{ justifySelf: "start", marginLeft: -8 }} onClick={() => setOpen(true)}>
            Show {commits.length - 1} earlier commits
          </button>
        </div>
      )}
      {shown.map((c) => (
        <div className="event commit" key={c.id}>
          <span className="commit-icon">
            <i />
          </span>
          <div className="commit-line">
            <Avatar person={c.author} size="sm" />
            <span className="msg">{c.message?.split("\n")[0]}</span>
            {c.url || url ? (
              <a className="sha" href={c.url ?? undefined} target="_blank" rel="noreferrer">
                {c.sha?.slice(0, 7)}
              </a>
            ) : (
              <span className="sha">{c.sha?.slice(0, 7)}</span>
            )}
            <span className="faint" style={{ fontSize: 11.5, flex: "none" }}>
              {timeAgo(c.createdAt)}
            </span>
          </div>
        </div>
      ))}
    </>
  );
}

// -----------------------------------------------------------------------------

function Rail({ detail, onReview }: { detail: DetailData; onReview: () => void }) {
  const summary = detail.checksSummary;
  const statusText = (() => {
    if (detail.state === "local") return ["Local branch", "Not submitted yet."];
    if (detail.state === "merged") return ["Merged", "This pull request has been merged."];
    if (detail.state === "closed") return ["Closed", "This pull request was closed without merging."];
    if (summary?.state === "failure") return ["Checks failing", `${summary.failed} of ${summary.total} checks failed.`];
    if (detail.reviewers.some((r) => r.state === "changes_requested")) return ["Changes requested", "A reviewer asked for changes."];
    if (detail.reviewers.some((r) => r.state === "approved")) return ["Approved", detail.mergeable === false ? "Has conflicts with the base branch." : "Ready to merge."];
    if (detail.state === "draft") return ["Draft", "Not ready for review yet."];
    if (detail.reviewers.some((r) => r.state === "requested")) return ["Waiting on reviewers", `${plural(detail.reviewers.filter((r) => r.state === "requested").length, "review")} requested.`];
    return ["Open", "No reviews yet."];
  })();

  return (
    <aside className="rail">
      <div className="rail-card">
        <div className="status-line">
          <PRStateIcon state={detail.state} />
          {statusText[0]}
        </div>
        <div className="status-sub">{statusText[1]}</div>
        <div className="rail-actions">
          {detail.number !== null && (
            <button className="btn block" onClick={onReview}>
              {detail.can.review ? "Leave a review" : "Comment"}
              <Kbd>R</Kbd>
            </button>
          )}
          {detail.url && (
            <a className="btn block ghost" href={detail.url} target="_blank" rel="noreferrer">
              Open on GitHub <ExternalLink size={12} />
            </a>
          )}
        </div>
      </div>

      {detail.number !== null && (
        <div className="rail-section">
          <h4>
            Checks
            <span className="spacer" />
            {summary && summary.total > 0 && (
              <span className="num">
                {summary.passed}/{summary.total}
              </span>
            )}
          </h4>
          {summary && summary.total > 0 && (
            <div className="check-progress" aria-hidden>
              <i style={{ width: `${(summary.passed / summary.total) * 100}%`, background: "var(--green)" }} />
              <i style={{ width: `${(summary.pending / summary.total) * 100}%`, background: "var(--amber)" }} />
              <i style={{ width: `${(summary.failed / summary.total) * 100}%`, background: "var(--red)" }} />
            </div>
          )}
          <div className="rail-list">
            {detail.checks.length === 0 && <span className="rail-empty">No checks reported.</span>}
            {detail.checks.map((check) => (
              <a key={check.name} className="rail-row" href={check.url ?? undefined} target="_blank" rel="noreferrer" data-tip={check.summary ?? undefined}>
                <CheckIcon state={check.state} />
                <span className="grow">{check.name}</span>
                {check.durationSeconds !== null && <span className="side num">{formatDuration(check.durationSeconds)}</span>}
              </a>
            ))}
          </div>
        </div>
      )}

      {detail.number !== null && (
        <div className="rail-section">
          <h4>Reviewers</h4>
          <div className="rail-list">
            {detail.reviewers.length === 0 && <span className="rail-empty">No reviewers yet.</span>}
            {detail.reviewers.map((r) => (
              <div className="rail-row" key={r.person.login}>
                <Avatar person={r.person} size="sm" />
                <span className="grow">{r.person.login}</span>
                {r.state === "requested" ? <span className="side">Requested</span> : <ReviewBadge decision={r.state} compact />}
                {r.state !== "requested" && r.state !== "approved" && r.state !== "changes_requested" && <span className="side">Commented</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.labels.length > 0 && (
        <div className="rail-section">
          <h4>Labels</h4>
          <div className="labels">
            {detail.labels.map((l) => (
              <span className="label" key={l.name}>
                <i style={{ background: `#${l.color}` }} />
                {l.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {detail.number !== null && (
        <div className="rail-section">
          <h4>Assignees</h4>
          <div className="rail-list">
            {detail.assignees.length === 0 && <span className="rail-empty">No one assigned.</span>}
            {detail.assignees.map((a) => (
              <div className="rail-row" key={a.login}>
                <Avatar person={a} size="sm" />
                <span className="grow">{a.login}</span>
              </div>
            ))}
          </div>
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
