import { Command } from "cmdk";
import { FileCode2, GitBranch, Inbox as InboxIcon, Keyboard, Moon, RefreshCw, Sun, Monitor } from "lucide-react";
import type { Detail, Inbox } from "../api";
import { flatItems } from "./Inbox";
import { Avatar, Kbd, PRStateIcon, useDismiss } from "./ui";
import { navigate } from "../lib/util";
import { fileAnchor } from "./FileDiff";

interface Props {
  inbox: Inbox | undefined;
  detail: Detail | undefined;
  onClose: () => void;
  onRefresh: () => void;
  onInbox: () => void;
  onShortcuts: () => void;
  onTheme: (theme: "dark" | "light" | "system") => void;
}

export function Palette({ inbox, detail, onClose, onRefresh, onInbox, onShortcuts, onTheme }: Props) {
  const ref = useDismiss(true, onClose);
  const items = flatItems(inbox);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <div className="fixed inset-0 z-[80] flex animate-fade-in items-start justify-center bg-scrim px-4 pt-[14vh]">
      <div ref={ref} className="palette w-full max-w-[640px] animate-pop-in overflow-hidden rounded-2xl bg-panel shadow-pop [&_svg]:shrink-0">
        <Command label="Command palette" loop>
          <Command.Input autoFocus placeholder="Jump to a pull request, branch or file…" />
          <Command.List>
            <Command.Empty>No results</Command.Empty>
            {detail && detail.files.length > 0 && (
              <Command.Group heading={`Files in ${detail.number ? `#${detail.number}` : detail.branch}`}>
                {detail.files.map((f) => (
                  <Command.Item
                    key={f.path}
                    value={`file ${f.path}`}
                    onSelect={run(() => document.getElementById(fileAnchor(f.path))?.scrollIntoView({ behavior: "smooth", block: "start" }))}
                  >
                    <FileCode2 size={14} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {f.path}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-fg-3 tabular">
                      <span style={{ color: "var(--green)" }}>+{f.additions}</span> <span style={{ color: "var(--red)" }}>−{f.deletions}</span>
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            <Command.Group heading="Pull requests and branches">
              {items.map((item) => (
                <Command.Item
                  key={item.id}
                  value={`${item.ref.kind === "pr" ? `#${item.ref.number}` : ""} ${item.title} ${item.branch} ${item.author?.login ?? ""}`}
                  onSelect={run(() => navigate(item.ref))}
                >
                  {item.state === "local" ? <GitBranch size={14} /> : <PRStateIcon state={item.state} size={14} />}
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-fg-3">{item.ref.kind === "pr" ? `#${item.ref.number}` : item.branch}</span>
                  {item.author && <Avatar person={item.author} size="sm" />}
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group heading="Actions">
              <Command.Item value="refresh reload" onSelect={run(onRefresh)}>
                <RefreshCw size={14} /> <span className="min-w-0 flex-1 truncate">Refresh</span>
              </Command.Item>
              <Command.Item value="go to inbox home" onSelect={run(onInbox)}>
                <InboxIcon size={14} /> <span className="min-w-0 flex-1 truncate">Go to inbox</span>
                <span className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-fg-3">
                  <Kbd>G</Kbd>
                </span>
              </Command.Item>
              <Command.Item value="keyboard shortcuts help" onSelect={run(onShortcuts)}>
                <Keyboard size={14} /> <span className="min-w-0 flex-1 truncate">Keyboard shortcuts</span>
                <span className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-fg-3">
                  <Kbd>?</Kbd>
                </span>
              </Command.Item>
              <Command.Item value="theme dark" onSelect={run(() => onTheme("dark"))}>
                <Moon size={14} /> <span className="min-w-0 flex-1 truncate">Dark theme</span>
              </Command.Item>
              <Command.Item value="theme light" onSelect={run(() => onTheme("light"))}>
                <Sun size={14} /> <span className="min-w-0 flex-1 truncate">Light theme</span>
              </Command.Item>
              <Command.Item value="theme system" onSelect={run(() => onTheme("system"))}>
                <Monitor size={14} /> <span className="min-w-0 flex-1 truncate">System theme</span>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
        <div className="flex h-9 items-center gap-4 border-t border-line px-3.5 text-[11.5px] text-fg-3 [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> Navigate
          </span>
          <span>
            <Kbd>↵</Kbd> Open
          </span>
          <span>
            <Kbd>Esc</Kbd> Close
          </span>
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: Array<[string, string[]]> = [
  ["Command palette", ["⌘", "K"]],
  ["Next / previous file", ["j", "k"]],
  ["Next / previous pull request", ["]", "["]],
  ["Mark file viewed, go to next", ["v"]],
  ["Split or unified diff", ["s"]],
  ["Wrap long lines", ["w"]],
  ["Toggle file tree", ["t"]],
  ["Back to the inbox", ["Esc"]],
  ["Move through the inbox", ["j", "k"]],
  ["Filter the inbox", ["1", "5"]],
  ["Filter files", ["/"]],
  ["Comment on the pull request", ["c"]],
  ["Submit a review", ["r"]],
  ["Open on GitHub", ["o"]],
  ["Refresh", ["⇧", "R"]],
  ["Shortcuts", ["?"]],
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const ref = useDismiss(true, onClose);
  return (
    <div className="fixed inset-0 z-[80] flex animate-fade-in items-start justify-center bg-scrim px-4 pt-[14vh]">
      <div className="w-full max-w-[580px] animate-pop-in rounded-2xl bg-panel p-5 shadow-pop" ref={ref} role="dialog" aria-label="Keyboard shortcuts">
        <h3 className="mb-3 text-sm font-semibold">Keyboard shortcuts</h3>
        <div className="grid grid-cols-2 gap-x-6">
          {SHORTCUTS.map(([label, keys]) => (
            <div className="flex h-9 items-center justify-between border-b border-line text-fg-2" key={label}>
              <span>{label}</span>
              <span className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
