import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, createWriteStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { ReviewError } from "./errors.js";

/**
 * Images and videos for PR descriptions and comments. GitHub has no API for its
 * attachments, but the GitHub CLI (2.99+) uploads them with `--attach` and rewrites
 * `![alt](./file.png)` references in the body to the uploaded asset. So files wait
 * here until the body is saved, and then `gh` does the upload.
 */

export type AttachmentKind = "image" | "video";

/** What `gh --attach` takes, and GitHub's limits for each (videos: 10 MB on free plans). */
const TYPES: Record<string, AttachmentKind> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
};
const MAX_BYTES: Record<AttachmentKind, number> = { image: 10 * 1024 * 1024, video: 100 * 1024 * 1024 };

export interface Attachment {
  id: string;
  /** The file name the body refers to, as `./name`; unique within this session. */
  name: string;
  kind: AttachmentKind;
  size: number;
}

export class AttachmentStore {
  private readonly dir = mkdtempSync(join(tmpdir(), "pile-attachments-"));
  private readonly files = new Map<string, Attachment & { path: string }>();

  constructor() {
    process.once("exit", () => rmSync(this.dir, { recursive: true, force: true }));
  }

  /** Streams an upload to disk, refusing types `gh` can't attach and files over GitHub's limits. */
  async save(fileName: string, req: IncomingMessage): Promise<Attachment> {
    const ext = extname(fileName).toLowerCase();
    const kind = TYPES[ext];
    if (!kind) {
      req.resume();
      throw new ReviewError(415, "UNSUPPORTED_ATTACHMENT", `${fileName} can't be attached: use PNG, JPEG, GIF, WebP, SVG, MP4, MOV or WebM`);
    }
    const id = randomBytes(8).toString("hex");
    const stem = fileName.slice(0, fileName.length - ext.length).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || kind;
    const name = `${stem}-${id.slice(0, 6)}${ext}`;
    const path = join(this.dir, name);
    const size = await new Promise<number>((resolve, reject) => {
      const out = createWriteStream(path);
      let bytes = 0;
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES[kind]) {
          req.unpipe(out);
          req.resume();
          out.destroy();
          rmSync(path, { force: true });
          reject(new ReviewError(413, "ATTACHMENT_TOO_LARGE", `${fileName} is too large: images can be up to 10 MB, videos up to 100 MB (10 MB on free plans)`));
        }
      });
      req.pipe(out);
      out.on("finish", () => resolve(bytes));
      out.on("error", reject);
      req.on("error", reject);
    });
    const attachment = { id, name, kind, size };
    this.files.set(id, { ...attachment, path });
    return attachment;
  }

  /** The files for these ids; unknown ids (from another session) are an error. */
  get(ids: string[]): Array<{ name: string; path: string; kind: AttachmentKind }> {
    return ids.map((id) => {
      const file = this.files.get(id);
      if (!file) throw new ReviewError(400, "ATTACHMENT_GONE", "An attachment is no longer available; add it again");
      return { name: file.name, path: file.path, kind: file.kind };
    });
  }
}

/**
 * Runs `gh <command> --body-file … --attach …`: the body and its files sit side by
 * side in a scratch folder, so `./name` references resolve and are rewritten by `gh`.
 */
export async function ghWithAttachments(options: { repo: string; command: string[]; body: string; files: Array<{ name: string; path: string }> }): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "pile-gh-"));
  try {
    writeFileSync(join(work, "body.md"), options.body);
    for (const file of options.files) copyFileSync(file.path, join(work, file.name));
    const args = [...options.command, "--repo", options.repo, "--body-file", "body.md", ...options.files.flatMap((f) => ["--attach", `./${f.name}`])];
    return await new Promise<string>((resolve, reject) => {
      execFile("gh", args, { cwd: work, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim());
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(new ReviewError(501, "GH_MISSING", "Uploading images and videos needs the GitHub CLI", "Install gh 2.99 or later (https://cli.github.com) and run `gh auth login`."));
        }
        if (/unknown flag: --attach/.test(stderr)) {
          return reject(new ReviewError(501, "GH_TOO_OLD", "Uploading images and videos needs gh 2.99 or later", "Update the GitHub CLI (for example `brew upgrade gh`)."));
        }
        const said = stderr.trim().split("\n").filter(Boolean).at(-1) ?? error.message;
        reject(new ReviewError(502, "GH_FAILED", `GitHub didn't take the attachment: ${said}`));
      });
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * GitHub plays a video only from a bare asset URL on its own line, but gh rewrites a
 * `![label](./clip.mp4)` reference to a link (`[label](url)`). Turns those links (not
 * images, which keep their `!`) back into bare URLs.
 */
export function videosAsPlayers(body: string, labels: string[]): string {
  let out = body;
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<!!)\\[${escaped}\\]\\((https://github\\.com/user-attachments/assets/[^)\\s]+)\\)`, "g"), "$1");
  }
  return out;
}

