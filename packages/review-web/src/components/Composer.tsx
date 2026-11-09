import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Kbd, Spinner } from "./ui";
import { modKey } from "../lib/util";

interface Props {
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void> | void;
  onCancel?: () => void;
  autoFocus?: boolean;
  compact?: boolean;
  /** Persist the unsent text under this key. */
  draftKey?: string;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function Composer({ placeholder, submitLabel, onSubmit, onCancel, autoFocus, compact, draftKey, inputRef }: Props) {
  const [text, setText] = useState(() => (draftKey ? readDraft(draftKey) : ""));
  const [busy, setBusy] = useState(false);
  const local = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? local;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text, ref]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, ref]);

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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`composer ${compact ? "compact" : ""} ${text ? "has-text" : ""}`}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder}
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
      />
      <div className="composer-foot">
        <span>Markdown supported</span>
        <span className="spacer" />
        {onCancel && (
          <button className="btn ghost sm" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary sm" onClick={submit} disabled={!text.trim() || busy}>
          {busy ? <Spinner size={12} /> : null}
          {submitLabel}
          <Kbd>{modKey}</Kbd>
          <Kbd>↵</Kbd>
        </button>
      </div>
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
