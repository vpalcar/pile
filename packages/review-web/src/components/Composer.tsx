import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, cx, Kbd, Spinner } from "./ui";
import { modKey } from "../lib/util";

interface Props {
  placeholder: string;
  submitLabel: string;
  /** Replaces the "Markdown supported" hint at the start of the footer. */
  footerStart?: React.ReactNode;
  onSubmit: (body: string) => Promise<void> | void;
  onCancel?: () => void;
  autoFocus?: boolean;
  /** Footer hidden until focused or typed in. */
  compact?: boolean;
  /**
   * Sits inside another rounded container (an inline thread): uses the smaller
   * radius so the corners stay concentric with the container's.
   */
  inset?: boolean;
  /** Persist the unsent text under this key. */
  draftKey?: string;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function Composer({ placeholder, submitLabel, footerStart, onSubmit, onCancel, autoFocus, compact, inset, draftKey, inputRef }: Props) {
  const [text, setText] = useState(() => (draftKey ? readDraft(draftKey) : ""));
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const local = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const ref = inputRef ?? local;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text, ref]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus, ref]);

  // Once the footer has rendered, bring the whole composer (buttons included) into view.
  useEffect(() => {
    if (focused) box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  useEffect(() => {
    if (draftKey) writeDraft(draftKey, text);
  }, [draftKey, text]);

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setText("");
      if (draftKey) writeDraft(draftKey, "");
    } catch {
      // The caller reports the error; keep the text so nothing is lost.
    } finally {
      setBusy(false);
    }
  };

  const showFooter = !compact || focused || !!text;

  return (
    <div
      ref={box}
      className={cx(
        "scroll-my-6 border border-line bg-panel transition-[border-color,box-shadow] duration-150 focus-within:border-line-3 focus-within:shadow-[0_0_0_3px_var(--accent-soft)]",
        inset ? "rounded-lg" : "rounded-xl",
      )}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
            onCancel?.();
          }
        }}
        className="block max-h-80 min-h-10 w-full resize-none bg-transparent px-3 py-2.5 leading-[1.55] text-fg outline-none placeholder:text-fg-3"
      />
      {showFooter && (
        <div className="flex h-10 items-center gap-2 pl-3 pr-2 text-[11.5px] leading-none text-fg-3">
          {footerStart ?? <span>Markdown supported</span>}
          <span className="flex-1" />
          {onCancel && (
            <Button variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button variant="primary" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={submit} disabled={!text.trim() || busy}>
            {busy && <Spinner size={12} />}
            {submitLabel}
            <span className="ml-0.5 inline-flex gap-0.5 opacity-60 [&_kbd]:border-current/30 [&_kbd]:bg-transparent [&_kbd]:text-current">
              <Kbd>{modKey}</Kbd>
              <Kbd>↵</Kbd>
            </span>
          </Button>
        </div>
      )}
    </div>
  );
}

function readDraft(key: string): string {
  try {
    return localStorage.getItem(`pile:draft:${key}`) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(`pile:draft:${key}`, text);
    else localStorage.removeItem(`pile:draft:${key}`);
  } catch {
    // Drafts are a convenience.
  }
}
