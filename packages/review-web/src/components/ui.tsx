import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  CircleDashed,
  CircleDot,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  X,
} from "lucide-react";
import type { CheckState, ChecksSummary, InboxItem, Person, PRState } from "../api";

export function Avatar({ person, size = "md" }: { person: Person | null; size?: "sm" | "md" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const cls = `avatar ${size === "md" ? "" : size}`;
  if (person?.avatarUrl && !failed) {
    return <img className={cls} src={`${person.avatarUrl}${person.avatarUrl.includes("?") ? "&" : "?"}s=64`} alt="" onError={() => setFailed(true)} />;
  }
  const initials = (person?.login ?? "?").replace(/[^a-zA-Z0-9]/g, "").slice(0, 2);
  return <span className={cls} aria-hidden>{initials}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Hover tooltips: any element with `data-tip` (and optionally `data-kbd`). */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; kbd?: string; x: number; y: number } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const over = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tip]");
      clearTimeout(timer);
      if (!target) return setTip(null);
      timer = setTimeout(() => {
        const rect = target.getBoundingClientRect();
        const below = rect.top < 60;
        setTip({
          text: target.dataset.tip!,
          kbd: target.dataset.kbd,
          x: rect.left + rect.width / 2,
          y: below ? rect.bottom + 8 : rect.top - 8,
        });
      }, 350);
    };
    const hide = () => {
      clearTimeout(timer);
      setTip(null);
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("mousedown", hide);
    document.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mousedown", hide);
      document.removeEventListener("scroll", hide, true);
    };
  }, []);
  if (!tip) return null;
  const below = tip.y > 60 && tip.y < 70;
  return (
    <div
      className="tooltip"
      style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${below || tip.y < 70 ? "0" : "-100%"})` }}
    >
      {tip.text}
      {tip.kbd && tip.kbd.split(" ").map((k) => <Kbd key={k}>{k}</Kbd>)}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Status

export function PRStateIcon({ state, size = 15 }: { state: PRState | "local"; size?: number }) {
  switch (state) {
    case "merged":
      return <GitMerge size={size} color="var(--purple)" />;
    case "closed":
      return <GitPullRequestClosed size={size} color="var(--red)" />;
    case "draft":
      return <GitPullRequestDraft size={size} color="var(--text-3)" />;
    case "local":
      return <GitBranch size={size} color="var(--text-3)" />;
    default:
      return <GitPullRequest size={size} color="var(--green)" />;
  }
}

export function PRStatePill({ state }: { state: PRState | "local" }) {
  const map = {
    open: ["green", "Open"],
    draft: ["", "Draft"],
    merged: ["purple", "Merged"],
    closed: ["red", "Closed"],
    local: ["", "Local branch"],
  } as const;
  const [tone, label] = map[state];
  return (
    <span className={`pill ${tone}`}>
      <PRStateIcon state={state} size={12} />
      {label}
    </span>
  );
}

export function CheckIcon({ state, size = 14 }: { state: CheckState; size?: number }) {
  switch (state) {
    case "success":
      return <Check size={size} color="var(--green)" strokeWidth={2.5} />;
    case "failure":
      return <X size={size} color="var(--red)" strokeWidth={2.5} />;
    case "pending":
      return <CircleDashed size={size} color="var(--amber)" className="spin-slow" />;
    default:
      return <CircleDot size={size} color="var(--text-3)" />;
  }
}

export function ChecksDot({ checks }: { checks: ChecksSummary | null }) {
  if (!checks || checks.state === "none") return null;
  const tip =
    checks.state === "success"
      ? `${checks.passed} checks passed`
      : checks.state === "failure"
        ? `${checks.failed} of ${checks.total} checks failed`
        : `${checks.pending} of ${checks.total} checks running`;
  const tone = checks.state === "success" ? "green" : checks.state === "failure" ? "red" : "amber";
  return <span className={`dot ${tone} ${checks.state === "pending" ? "pulse" : ""}`} data-tip={tip} />;
}

export function ReviewBadge({ decision, compact }: { decision: InboxItem["reviewDecision"]; compact?: boolean }) {
  if (!decision) return null;
  const map: Record<string, [string, string]> = {
    approved: ["green", "Approved"],
    changes_requested: ["red", "Changes requested"],
    review_required: ["", "Needs review"],
    commented: ["blue", "Commented"],
    pending: ["amber", "Pending"],
    dismissed: ["", "Dismissed"],
  };
  const [tone, label] = map[decision] ?? ["", decision];
  if (compact) {
    if (decision === "approved") return <Check size={13} color="var(--green)" strokeWidth={2.5} data-tip={label} />;
    if (decision === "changes_requested") return <span className="dot red" data-tip={label} />;
    return null;
  }
  return <span className={`pill ${tone}`}>{label}</span>;
}

export function DiffStat({ additions, deletions, bar = false }: { additions: number | null; deletions: number | null; bar?: boolean }) {
  if (additions === null || deletions === null) return null;
  const total = additions + deletions;
  const blocks = 5;
  const adds = total === 0 ? 0 : Math.round((additions / total) * blocks);
  const dels = total === 0 ? 0 : Math.min(blocks - adds, Math.round((deletions / total) * blocks));
  return (
    <span className="diffstat num">
      <span className="plus">+{additions.toLocaleString()}</span>
      <span className="minus">−{deletions.toLocaleString()}</span>
      {bar && (
        <span className="bar" aria-hidden>
          {Array.from({ length: blocks }, (_, i) => (
            <i key={i} className={i < adds ? "a" : i < adds + dels ? "d" : ""} />
          ))}
        </span>
      )}
    </span>
  );
}

export function CommentCount({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="faint" style={{ display: "inline-flex", alignItems: "center", gap: 3 }} data-tip={`${count} comments`}>
      <MessageSquare size={11.5} />
      <span className="num" style={{ fontSize: 11 }}>{count}</span>
    </span>
  );
}

// -----------------------------------------------------------------------------
// Toasts

interface Toast {
  id: number;
  content: ReactNode;
  leaving?: boolean;
}

const ToastContext = createContext<(content: ReactNode) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const id = useRef(0);
  const show = useCallback((content: ReactNode) => {
    const toast = { id: ++id.current, content };
    setToasts((all) => [...all.slice(-2), toast]);
    setTimeout(() => setToasts((all) => all.map((t) => (t.id === toast.id ? { ...t, leaving: true } : t))), 3200);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== toast.id)), 3400);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.leaving ? "leaving" : ""}`}>
            {t.content}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Closes on outside click and Escape. */
export function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", click));
    window.addEventListener("keydown", key, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", click);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, onClose]);
  return ref;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
