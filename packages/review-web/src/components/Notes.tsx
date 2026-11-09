import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, Check, Copy, RotateCcw, Trash2 } from "lucide-react";
import type { AgentNote, Detail } from "../api";
import { api } from "../lib/client";
import { keys, queryClient } from "../lib/queries";
import { copy, plural, timeAgo } from "../lib/util";
import { Composer } from "./Composer";
import { fileAnchor } from "./FileDiff";
import { Button, cx, Pill, useToast } from "./ui";

/** Where a comment goes: the GitHub review, or a note for the agent (.pile/notes.json). */
export type CommentTarget = "github" | "agent";

interface NotesApi {
  notes: AgentNote[];
  /** Comments can go to GitHub here (a PR you can comment on). */
  github: boolean;
  target: CommentTarget;
  setTarget: (target: CommentTarget) => void;
  /** The command that hands the notes to an agent. */
  command: string;
  add: (note: { path?: string; line?: number; side?: "LEFT" | "RIGHT"; body: string }) => Promise<void>;
  reply: (id: string, body: string) => Promise<void>;
  setDone: (id: string, done: boolean) => void;
  remove: (id: string) => void;
}

const NotesContext = createContext<NotesApi | null>(null);
export const useNotes = () => useContext(NotesContext);

/**
 * Notes for the agent on this PR or branch. On your own PRs and local branches new
 * comments default to notes; on someone else's PR, to your GitHub review.
 */
export function NotesProvider({ detail, currentBranch, children }: { detail: Detail; currentBranch: string | null; children: ReactNode }) {
  const toast = useToast();
  const key = keys.notes(detail.branch);
  // The agent answers through `pile notes`, outside the app: poll so replies show up live.
  const { data: notes = [] } = useQuery({ queryKey: key, queryFn: () => api.notes(detail.branch), staleTime: 2_000, refetchInterval: 4_000 });
  const seen = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const replies = new Map(notes.map((n) => [n.id, n.replies?.filter((r) => r.author === "agent").length ?? 0]));
    if (seen.current) {
      const answered = notes.filter((n) => (replies.get(n.id) ?? 0) > (seen.current!.get(n.id) ?? 0));
      if (answered.length) {
        const resolved = answered.filter((n) => n.done).length;
        toast(
          <>
            <Bot size={14} className="text-merged" />
            {resolved === answered.length ? `Your agent resolved ${plural(resolved, "note")}` : `Your agent replied to ${plural(answered.length, "note")}`}
          </>,
          { key: "agent" },
        );
      }
    }
    seen.current = replies;
  }, [notes, toast]);
  const github = detail.number !== null && detail.can.comment;
  const [target, setTarget] = useState<CommentTarget>(github && detail.can.review ? "github" : "agent");
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const fail = (error: Error) => toast(<span className="text-bad">{error.message}</span>, { key: "note" });

  const add = useMutation({
    mutationFn: (note: Parameters<NotesApi["add"]>[0]) => api.addNote({ ref: detail.ref, ...note }),
    onSuccess: (note) => {
      queryClient.setQueryData<AgentNote[]>(key, (all = []) => [...all, note]);
      toast(
        <>
          <Bot size={14} className="text-merged" /> Note saved for your agent
        </>,
        { key: "note" },
      );
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) => api.updateNote(id, { done }),
    onMutate: ({ id, done }) => queryClient.setQueryData<AgentNote[]>(key, (all = []) => all.map((n) => (n.id === id ? { ...n, done } : n))),
    onError: fail,
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.removeNote(id),
    onMutate: (id) => queryClient.setQueryData<AgentNote[]>(key, (all = []) => all.filter((n) => n.id !== id)),
    onError: fail,
    onSettled: refresh,
  });

  const value = useMemo<NotesApi>(
    () => ({
      notes,
      github,
      target: github ? target : "agent",
      setTarget,
      command: currentBranch === detail.branch ? "pile notes" : `pile notes --branch ${detail.branch}`,
      add: (note) => add.mutateAsync(note).then(() => {}),
      reply: (id, body) =>
        api.replyToNote(id, body).then((note) => {
          queryClient.setQueryData<AgentNote[]>(key, (all = []) => all.map((n) => (n.id === id ? note : n)));
        }, (error) => {
          // The composer keeps the text when this throws.
          fail(error);
          throw error;
        }),
      setDone: (id, done) => update.mutate({ id, done }),
      remove: (id) => remove.mutate(id),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, github, target, currentBranch, detail.branch],
  );
  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

/** Review comment or note for the agent, in a composer's footer. */
export function TargetSwitch() {
  const notes = useNotes();
  if (!notes?.github) return <span className="inline-flex items-center gap-1.5 text-merged"><Bot size={13} /> Note for your agent</span>;
  return (
    <span className="inline-flex rounded-md border border-line bg-bg p-0.5" role="radiogroup" aria-label="Comment goes to">
      {(
        [
          ["github", "Review comment"],
          ["agent", "Note for agent"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={notes.target === value}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => notes.setTarget(value)}
          className={cx(
            "inline-flex h-6 items-center gap-1 rounded px-2 text-[11.5px]",
            notes.target === value ? (value === "agent" ? "bg-merged-soft text-merged" : "bg-panel-3 text-fg") : "text-fg-3 hover:text-fg-2",
          )}
        >
          {value === "agent" && <Bot size={12} />}
          {label}
        </button>
      ))}
    </span>
  );
}

/** One note, inline in the diff or in the notes section. */
export function NoteCard({ note, location }: { note: AgentNote; location?: ReactNode }) {
  const notes = useNotes()!;
  return (
    <div className={cx("border-b border-line bg-merged-soft/40 px-3.5 py-3 last:border-b-0", note.done && "opacity-60")} data-note={note.id}>
      <div className="mb-1.5 flex h-6 items-center gap-2 leading-none text-fg-3">
        <Bot size={14} className="shrink-0 text-merged" />
        <b className="font-medium text-fg">Note for agent</b>
        {location}
        <span>{timeAgo(note.createdAt)}</span>
        {note.done && <Pill tone="green">Done</Pill>}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => notes.setDone(note.id, !note.done)} aria-label={note.done ? "Reopen note" : "Mark note done"}>
          {note.done ? <RotateCcw size={12} /> : <Check size={12} />}
          {note.done ? "Reopen" : "Done"}
        </Button>
        <Button variant="ghost" size="sm" icon onClick={() => notes.remove(note.id)} aria-label="Delete note" data-tip="Delete">
          <Trash2 size={12} />
        </Button>
      </div>
      <div className={cx("whitespace-pre-wrap", note.done && !note.replies?.length && "line-through decoration-fg-4")}>{note.body}</div>
      <NoteThread note={note} />
    </div>
  );
}

/** The agent's answers and your follow-ups under a note, and a box to reply. */
function NoteThread({ note }: { note: AgentNote }) {
  const notes = useNotes()!;
  const [replying, setReplying] = useState(false);
  return (
    <div className="mt-2">
      {note.replies?.map((r, i) => (
        <div key={i} className="mt-2 flex gap-2 border-l-2 border-line-2 pl-3" data-reply={r.author}>
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 flex items-center gap-1.5 text-xs text-fg-3">
              {r.author === "agent" ? <Bot size={12} className="text-merged" /> : null}
              <b className="font-medium text-fg-2">{r.author === "agent" ? "Agent" : "You"}</b>
              {timeAgo(r.createdAt)}
            </div>
            <div className="whitespace-pre-wrap text-fg">{r.body}</div>
          </div>
        </div>
      ))}
      {replying ? (
        <div className="mt-2">
          <Composer
            autoFocus
            inset
            placeholder={note.done ? "Not quite? Reply to reopen it" : "Reply to your agent"}
            submitLabel="Reply"
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              await notes.reply(note.id, body);
              setReplying(false);
            }}
          />
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="-ml-2 mt-1 text-fg-3" onClick={() => setReplying(true)}>
          Reply…
        </Button>
      )}
    </div>
  );
}

/**
 * Every note on this branch, how the agent gets them, and a box for notes about the
 * branch as a whole. Shown on local branches and wherever notes exist.
 */
export function NotesSection({ local }: { local: boolean }) {
  const notes = useNotes();
  const toast = useToast();
  if (!notes || (!local && notes.notes.length === 0)) return null;
  const open = notes.notes.filter((n) => !n.done).length;
  const jump = (note: AgentNote) => {
    const file = note.path ? document.getElementById(fileAnchor(note.path)) : null;
    file?.scrollIntoView({ block: "start", behavior: "smooth" });
    setTimeout(() => document.querySelector(`[data-note="${note.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 450);
  };
  return (
    <section className="mt-9" data-notes-section>
      <div className="mb-3 flex h-7 items-center gap-2 text-[13px] font-medium text-fg-2">
        <Bot size={14} className="text-merged" /> Notes for your agent
        {notes.notes.length > 0 && <span className="font-normal text-fg-3 tabular">{open ? `${open} open` : "all done"}</span>}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            copy(notes.command);
            toast(`Copied “${notes.command}”`, { key: "copy" });
          }}
          data-tip="Your agent reads the notes with this"
        >
          <Copy size={12} /> {notes.command}
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {notes.notes.length === 0 && (
          <p className="px-3.5 py-3 text-fg-3">
            Comment on lines in the diff, or on the branch below. Your agent picks them up with <code>{notes.command}</code>.
          </p>
        )}
        {notes.notes.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            location={
              note.path ? (
                <button className="truncate font-mono text-[11.5px] text-fg-2 hover:text-accent" onClick={() => jump(note)}>
                  {note.path}:{note.line}
                  {note.side === "LEFT" && " (old)"}
                </button>
              ) : (
                <span className="text-[11.5px]">whole branch</span>
              )
            }
          />
        ))}
        <div className="border-t border-line p-1.5">
          <Composer
            compact
            inset
            placeholder="Note for your agent about the whole branch…"
            submitLabel="Save note"
            footerStart={
              <span className="inline-flex items-center gap-1.5 text-merged">
                <Bot size={13} /> {plural(open, "open note")} so far
              </span>
            }
            onSubmit={(body) => notes.add({ body })}
          />
        </div>
      </div>
    </section>
  );
}
