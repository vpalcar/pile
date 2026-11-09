import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Film, Paperclip, X } from "lucide-react";
import type { Attachment } from "../api";
import { api } from "../lib/client";
import { Button, useToast } from "./ui";

/** What GitHub (through gh) accepts; anything else is refused before uploading. */
const ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.mov,.webm";

type Item = Attachment & { preview: string; label: string };

/**
 * Images and videos in a markdown box: paste, drop or pick a file, and its reference
 * (`![name](./file.png)`) goes in at the cursor. Files wait on the local server until
 * the body is saved; then gh uploads them and rewrites the references to GitHub's URLs.
 */
export function useAttachments(input: RefObject<HTMLTextAreaElement | null>, setText: Dispatch<SetStateAction<string>>) {
  const [items, setItems] = useState<Item[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const toast = useToast();
  const seq = useRef(0);

  useEffect(() => () => items.forEach((i) => URL.revokeObjectURL(i.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = useCallback(
    (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        if (!ACCEPT.split(",").includes((file.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase())) {
          toast(<span className="text-bad">{file.name} can't be attached: use PNG, JPEG, GIF, WebP, SVG, MP4, MOV or WebM</span>, { key: "attach" });
          continue;
        }
        // A placeholder at the cursor now, the real reference once the file is in.
        const mark = `![Uploading ${file.name}…](uploading-${++seq.current})`;
        const el = input.current;
        setText((text) => {
          const at = el && document.activeElement === el ? el.selectionStart : text.length;
          const before = text.slice(0, at);
          const lead = before && !before.endsWith("\n") ? "\n" : "";
          return `${before}${lead}${mark}\n${text.slice(at)}`;
        });
        setUploading((n) => n + 1);
        api
          .attach(file)
          .then((attachment) => {
            const label = file.name.replace(/\.[^.]+$/, "");
            setItems((all) => [...all, { ...attachment, label, preview: URL.createObjectURL(file) }]);
            // A video plays only as its own paragraph on GitHub: blank lines around it.
            const ref = `![${label}](./${attachment.name})`;
            setText((text) => text.replace(mark, attachment.kind === "video" ? `\n${ref}\n` : ref));
          })
          .catch((error: Error) => {
            setText((text) => text.replace(`${mark}\n`, "").replace(mark, ""));
            toast(<span className="text-bad">{error.message}</span>, { key: "attach" });
          })
          .finally(() => setUploading((n) => n - 1));
      }
    },
    [input, setText, toast],
  );

  const remove = (item: Item) => {
    const ref = new RegExp(`!\\[[^\\]]*\\]\\(\\./${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\n?`, "g");
    setText((text) => text.replace(ref, ""));
    setItems((all) => all.filter((i) => i.id !== item.id));
    URL.revokeObjectURL(item.preview);
  };

  return {
    items,
    uploading,
    dragging,
    /** The uploads the text still refers to (removed references aren't sent). */
    used: (text: string) => items.filter((i) => text.includes(`(./${i.name})`)).map((i) => i.id),
    reset: () => {
      items.forEach((i) => URL.revokeObjectURL(i.preview));
      setItems([]);
    },
    add,
    remove,
    handlers: {
      onPaste: (e: React.ClipboardEvent) => {
        if (e.clipboardData.files.length === 0) return;
        e.preventDefault();
        add(e.clipboardData.files);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: () => setDragging(false),
      onDrop: (e: React.DragEvent) => {
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        setDragging(false);
        add(e.dataTransfer.files);
      },
    },
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

/** A paperclip that picks files. */
export function AttachButton({ attachments }: { attachments: Attachments }) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="ghost" size="sm" icon onMouseDown={(e) => e.preventDefault()} onClick={() => picker.current?.click()} aria-label="Attach an image or video" data-tip="Attach images or videos (or paste, or drop)">
        <Paperclip size={13} />
      </Button>
      <input
        ref={picker}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) attachments.add(e.target.files);
          e.target.value = "";
        }}
        data-attach-input
      />
    </>
  );
}

/** Thumbnails of what's attached, each removable (which also takes its reference out). */
export function AttachmentStrip({ attachments }: { attachments: Attachments }) {
  if (attachments.items.length === 0 && attachments.uploading === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pb-2.5" data-attachments>
      {attachments.items.map((item) => (
        <span key={item.id} className="group relative block size-16 overflow-hidden rounded-lg border border-line bg-panel-2" title={item.label} data-attachment={item.name}>
          {item.kind === "image" ? (
            <img src={item.preview} alt="" className="size-full object-cover" />
          ) : (
            <>
              <video src={item.preview} muted className="size-full object-cover" />
              <Film size={14} className="absolute bottom-1 left-1 text-white drop-shadow" />
            </>
          )}
          <button
            className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => attachments.remove(item)}
            aria-label={`Remove ${item.label}`}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      {Array.from({ length: attachments.uploading }, (_, i) => (
        <span key={`up-${i}`} className="block size-16 animate-pulse rounded-lg border border-dashed border-line-2 bg-panel-2" aria-label="Uploading" />
      ))}
    </div>
  );
}
