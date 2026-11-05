import { createContext, forwardRef, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import {
  Check,
  CircleDashed,
  CircleDot,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  X,
} from "lucide-react";
import type { CheckState, ChecksSummary, Person, PRState } from "../api";
import type { Readiness, Tone } from "../lib/status";

/** Joins class names, skipping falsy ones. */
export const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" ");

// -----------------------------------------------------------------------------
// Buttons. Two heights (sm 24px, md 28px); content is always vertically centred.

type Variant = "default" | "primary" | "ghost" | "success" | "danger";
const VARIANTS: Record<Variant, string> = {
  default: "border-line-2 bg-panel-2 text-fg hover:bg-panel-3 hover:border-line-3",
  primary: "border-transparent bg-primary text-on-primary hover:opacity-90",
  ghost: "border-transparent bg-transparent text-fg-2 hover:bg-hover hover:text-fg",
  success: "border-transparent bg-ok text-[#04140c] hover:opacity-90",
  danger: "border-bad/35 bg-bad-soft text-bad hover:bg-bad/20",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  icon?: boolean;
  block?: boolean;
}

export const buttonClass = ({ variant = "default", size = "md", icon = false, block = false }: Omit<ButtonProps, "children">) =>
  cx(
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border font-medium leading-none",
    "transition-[background,border-color,color,opacity,transform] duration-100 active:translate-y-px",
    "disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0",
    size === "sm" ? "h-6 rounded-md text-xs" : "h-7 rounded-lg text-[12.5px]",
    icon ? (size === "sm" ? "w-6" : "w-7") : size === "sm" ? "px-2" : "px-2.5",
    block && "w-full",
    VARIANTS[variant],
  );

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, icon, block, className, type = "button", ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={cx(buttonClass({ variant, size, icon, block }), className)} {...rest} />;
});

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-b-[1.5px] border-line-2 bg-panel px-1 font-sans text-[10.5px] font-medium leading-none text-fg-3">
      {children}
    </kbd>
  );
}

const AVATAR_SIZES = { sm: "size-4 text-[8px]", md: "size-5 text-[9px]", lg: "size-6 text-[10px]" } as const;

export function Avatar({ person, size = "md" }: { person: Person | null; size?: keyof typeof AVATAR_SIZES }) {
  const [failed, setFailed] = useState(false);
  const cls = cx("inline-grid shrink-0 place-items-center rounded-full bg-panel-3 object-cover font-semibold uppercase text-fg-2", AVATAR_SIZES[size]);
  if (person?.avatarUrl && !failed) {
    return <img className={cls} src={`${person.avatarUrl}${person.avatarUrl.includes("?") ? "&" : "?"}s=64`} alt="" onError={() => setFailed(true)} />;
  }
  return (
    <span className={cls} aria-hidden>
      {(person?.login ?? "?").replace(/[^a-zA-Z0-9]/g, "").slice(0, 2)}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Pills and badges

const TONES: Record<Tone, string> = {
  green: "bg-ok-soft text-ok",
  red: "bg-bad-soft text-bad",
  amber: "bg-warn-soft text-warn",
  blue: "bg-accent-soft text-accent",
  purple: "bg-merged-soft text-merged",
  gray: "bg-panel-2 text-fg-2 border-line",
};

export function Pill({ tone = "gray", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-transparent px-2 text-[11px] font-medium leading-none", TONES[tone], className)}>
      {children}
    </span>
  );
}

/** The single "where is this?" badge: Local, Draft, In review, Ready to merge, … */
export function StatusBadge({ status, size = "md" }: { status: Readiness; size?: "sm" | "md" }) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent font-medium leading-none",
        size === "sm" ? "h-5 px-2 text-[11px]" : "h-[22px] px-2.5 text-[11.5px]",
        TONES[status.tone],
      )}
      data-tip={status.detail.replace(/`/g, "")}
    >
      <i className={cx("size-1.5 shrink-0 rounded-full", status.tone === "gray" ? "bg-fg-3" : "bg-current", status.tone === "blue" && "shadow-[0_0_0_3px_var(--accent-soft)]")} />
      {status.label}
    </span>
  );
}

export function PRStateIcon({ state, size = 15 }: { state: PRState | "local"; size?: number }) {
  const props = { size, className: "shrink-0" };
  switch (state) {
    case "merged":
      return <GitMerge {...props} color="var(--purple)" />;
    case "closed":
      return <GitPullRequestClosed {...props} color="var(--red)" />;
    case "draft":
      return <GitPullRequestDraft {...props} color="var(--text-3)" />;
    case "local":
      return <GitBranch {...props} color="var(--text-3)" />;
    default:
      return <GitPullRequest {...props} color="var(--green)" />;
  }
}

export function CheckIcon({ state, size = 14 }: { state: CheckState; size?: number }) {
  switch (state) {
    case "success":
      return <Check size={size} color="var(--green)" strokeWidth={2.5} className="shrink-0" />;
    case "failure":
      return <X size={size} color="var(--red)" strokeWidth={2.5} className="shrink-0" />;
    case "pending":
      return <CircleDashed size={size} color="var(--amber)" className="shrink-0 animate-spin [animation-duration:2.4s]" />;
    default:
      return <CircleDot size={size} color="var(--text-3)" className="shrink-0" />;
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
  const color = checks.state === "success" ? "bg-ok" : checks.state === "failure" ? "bg-bad" : "bg-warn animate-pulse-soft";
  return <span className={cx("inline-block size-[7px] shrink-0 rounded-full", color)} data-tip={tip} />;
}

export function DiffStat({ additions, deletions, bar = false }: { additions: number | null; deletions: number | null; bar?: boolean }) {
  if (additions === null || deletions === null) return null;
  const total = additions + deletions;
  const blocks = 5;
  const adds = total === 0 ? 0 : Math.round((additions / total) * blocks);
  const dels = total === 0 ? 0 : Math.min(blocks - adds, Math.round((deletions / total) * blocks));
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs leading-none tabular">
      <span className={additions ? "text-ok" : "text-fg-4"}>+{additions.toLocaleString()}</span>
      <span className={deletions ? "text-bad" : "text-fg-4"}>−{deletions.toLocaleString()}</span>
      {bar && (
        <span className="ml-0.5 inline-flex items-center gap-[2px]" aria-hidden>
          {Array.from({ length: blocks }, (_, i) => (
            <i key={i} className={cx("size-1.5 rounded-[1.5px]", i < adds ? "bg-ok" : i < adds + dels ? "bg-bad" : "bg-panel-3")} />
          ))}
        </span>
      )}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0 animate-spin" aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// Tooltips: any element with `data-tip` (and optionally `data-kbd`).

export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; kbd?: string; x: number; y: number; below: boolean } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const over = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tip]");
      clearTimeout(timer);
      if (!target || !target.dataset.tip) return setTip(null);
      timer = setTimeout(() => {
        const rect = target.getBoundingClientRect();
        const below = rect.top < 70;
        setTip({ text: target.dataset.tip!, kbd: target.dataset.kbd, x: rect.left + rect.width / 2, y: below ? rect.bottom + 8 : rect.top - 8, below });
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
  return (
    <div
      className="pointer-events-none fixed z-[100] flex animate-fade-in items-center gap-1.5 whitespace-nowrap rounded-md bg-panel-3 px-2 py-1 text-[11.5px] leading-none text-fg shadow-pop"
      style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.below ? "0" : "-100%"})` }}
    >
      {tip.text}
      {tip.kbd && tip.kbd.split(" ").map((k) => <Kbd key={k}>{k}</Kbd>)}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Toasts: bottom-right, at most three. A toast with a key replaces the previous one
// with the same key (so "Posting…" can become "Posted" or an error), and all toasts
// clear when you move to another page.

interface Toast {
  id: number;
  key?: string;
  content: ReactNode;
  leaving?: boolean;
}

type ShowToast = (content: ReactNode, options?: { key?: string }) => void;
const ToastContext = createContext<ShowToast>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const id = useRef(0);
  const show = useCallback<ShowToast>((content, options = {}) => {
    const toast = { id: ++id.current, key: options.key, content };
    setToasts((all) => [...all.filter((t) => !options.key || t.key !== options.key).slice(-1), toast]);
    setTimeout(() => setToasts((all) => all.map((t) => (t.id === toast.id ? { ...t, leaving: true } : t))), 3500);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== toast.id)), 3700);
  }, []);
  useEffect(() => {
    const clear = () => setToasts([]);
    window.addEventListener("hashchange", clear);
    return () => window.removeEventListener("hashchange", clear);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[70] flex flex-col items-end gap-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "pointer-events-auto flex h-10 animate-toast-in items-center gap-2.5 rounded-xl border border-line-2 bg-panel-2 pl-3 pr-3 font-medium text-fg shadow-pop transition-opacity duration-200 [&:has(button)]:pr-1.5 [&_code]:text-xs [&_svg]:shrink-0",
              t.leaving && "opacity-0",
            )}
          >
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
  // Read the latest callback through a ref, so the listeners stay attached across
  // re-renders (a new inline onClose each render must not detach them).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const openedAt = performance.now();
    // Capture phase: nothing on the page can stop it from arriving. Events that began
    // before the popover opened (the click that opened it) are ignored.
    const pointer = (event: PointerEvent) => {
      if (event.timeStamp < openedAt) return;
      if (ref.current && !ref.current.contains(event.target as Node)) close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
      }
    };
    document.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return ref;
}

/** Text with `code` spans (used for status explanations). */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") ? (
          <code key={i} className="rounded bg-panel-3 px-1 py-px text-[11.5px] text-fg">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Section label, used in the rail and above lists. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <h4 className={cx("mb-2 flex items-center gap-1.5 text-[11.5px] font-medium leading-none text-fg-3", className)}>{children}</h4>;
}

export function Centered({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-10 text-center text-fg-2">
      <div>
        <div className="mx-auto mb-3.5 grid size-14 place-items-center rounded-2xl border border-line bg-panel-2 text-fg-3">{icon}</div>
        <h2 className="mb-1 text-[15px] font-semibold text-fg">{title}</h2>
        <p className="mx-auto max-w-sm">{children}</p>
      </div>
    </div>
  );
}

/** A / M / D / R marker for a changed file. */
export function StatusLetter({ status }: { status: import("../api").FileStatus }) {
  const letter = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M", unchanged: "·" }[status];
  const color = status === "added" ? "text-ok" : status === "removed" ? "text-bad" : status === "renamed" || status === "copied" ? "text-merged" : "text-warn";
  return (
    <span className={cx("grid w-3.5 shrink-0 place-items-center font-mono text-[10px] font-bold leading-none", color)} data-tip={status}>
      {letter}
    </span>
  );
}

