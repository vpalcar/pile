import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Plus, Search } from "lucide-react";
import { cx, Spinner, useDismiss } from "./ui";

/** Header, a full list and the footer. */
const MAX_HEIGHT = 400;

export interface PickerItem {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  /** Can't be toggled (e.g. the PR's author as a reviewer); shown with `hint`. */
  disabled?: boolean;
}

interface Props {
  title: string;
  items: PickerItem[] | undefined;
  /** Ids selected when the picker opens. */
  initial: string[];
  /** Called once on close with the final selection, if it changed. */
  onApply: (selected: string[]) => void;
  onClose: () => void;
  /** Offers to create an entry that doesn't exist (labels). */
  create?: (query: string) => PickerItem;
  empty?: string;
}

/**
 * A filterable multi-select in a popover. Like GitHub's sidebar menus, toggles are
 * collected while it's open and applied together when it closes.
 */
export function Picker({ title, items, initial, onApply, onClose, create, empty = "Nothing to pick from" }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set(initial));
  const [created, setCreated] = useState<PickerItem[]>([]);
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const close = () => {
    const before = new Set(initial);
    const changed = selected.size !== before.size || [...selected].some((id) => !before.has(id));
    if (changed) onApply([...selected]);
    onClose();
  };
  const ref = useDismiss(true, close);
  // Opens upward when its full height (list loaded) wouldn't fit below. Decided once,
  // so it doesn't jump when the options arrive.
  const [above, setAbove] = useState(false);
  useLayoutEffect(() => {
    const anchor = ref.current?.parentElement?.getBoundingClientRect();
    if (!anchor) return;
    const room = { below: window.innerHeight - anchor.top - 30, above: anchor.top - 60 };
    if (room.below < MAX_HEIGHT && room.above > room.below) setAbove(true);
  }, [ref]);

  const all = useMemo(() => [...(items ?? []), ...created.filter((c) => !items?.some((i) => i.id === c.id))], [items, created]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const matches = all.filter((i) => !q || i.label.toLowerCase().includes(q));
    // Selected entries first, so what's on the PR is always in view.
    return [...matches.filter((i) => selected.has(i.id)), ...matches.filter((i) => !selected.has(i.id))];
    // Order is fixed while the picker is open; toggling shouldn't make rows jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, q]);
  const canCreate = !!create && !!q && !all.some((i) => i.label.toLowerCase() === q);
  const rows = canCreate ? shown.length + 1 : shown.length;

  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const choose = (index: number) => {
    if (index < shown.length) {
      if (!shown[index].disabled) toggle(shown[index].id);
    } else if (canCreate && create) {
      const item = create(query.trim());
      setCreated((c) => [...c, item]);
      setSelected((s) => new Set(s).add(item.id));
      setQuery("");
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      className={cx(
        "absolute right-0 z-50 w-[264px] animate-pop-in overflow-hidden rounded-xl bg-panel shadow-pop",
        above ? "bottom-[calc(100%+6px)] origin-bottom-right" : "top-[calc(100%+6px)] origin-top-right",
      )}
      data-placement={above ? "above" : "below"}
    >
      <div className="border-b border-line px-3 pb-2 pt-2.5">
        <div className="mb-2 text-xs font-medium text-fg-2">{title}</div>
        <label className="flex h-8 items-center gap-2 rounded-lg border border-line-2 bg-bg px-2.5 focus-within:border-line-3">
          <Search size={13} className="shrink-0 text-fg-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={create ? "Filter or create…" : "Filter…"}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-3"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(rows - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (rows > 0) choose(cursor);
              }
            }}
          />
        </label>
      </div>
      <div ref={list} className="max-h-[280px] overflow-y-auto p-1" role="listbox" aria-multiselectable>
        {!items && (
          <div className="flex h-16 items-center justify-center gap-2 text-xs text-fg-3">
            <Spinner size={12} /> Loading…
          </div>
        )}
        {items && rows === 0 && <div className="px-2.5 py-4 text-center text-xs text-fg-3">{q ? "No matches" : empty}</div>}
        {shown.map((item, index) => {
          const on = selected.has(item.id);
          return (
            <button
              key={item.id}
              data-index={index}
              role="option"
              aria-selected={on}
              disabled={item.disabled}
              onMouseMove={() => setCursor(index)}
              onClick={() => choose(index)}
              className={cx(
                "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg disabled:cursor-not-allowed disabled:opacity-50",
                cursor === index && "bg-hover",
              )}
            >
              <span className={cx("grid size-4 shrink-0 place-items-center rounded-[5px] border", on ? "border-accent bg-accent text-white" : "border-line-3")}>
                {on && <Check size={11} strokeWidth={3} />}
              </span>
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-[11px] text-fg-3">{item.hint}</span>}
            </button>
          );
        })}
        {canCreate && (
          <button
            data-index={shown.length}
            onMouseMove={() => setCursor(shown.length)}
            onClick={() => choose(shown.length)}
            className={cx("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg-2", cursor === shown.length && "bg-hover")}
          >
            <Plus size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Create <b className="font-medium text-fg">{query.trim()}</b>
            </span>
          </button>
        )}
      </div>
      <div className="border-t border-line px-3 py-2 text-[11px] text-fg-3">Changes apply when you close this.</div>
    </div>
  );
}
