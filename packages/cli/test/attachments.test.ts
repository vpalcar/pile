import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AttachmentStore, videosAsPlayers } from "../src/review/attachments.js";

const upload = (bytes: number) => Readable.from([Buffer.alloc(bytes)]) as never;

describe("attachments", () => {
  it("keeps images and videos under a unique, markdown-safe name", async () => {
    const store = new AttachmentStore();
    const image = await store.save("Login error (dark).PNG", upload(1000));
    expect(image).toMatchObject({ kind: "image", size: 1000 });
    expect(image.name).toMatch(/^Login-error-dark-[0-9a-f]{6}\.png$/);
    const video = await store.save("demo.mov", upload(10));
    expect(video.kind).toBe("video");
    expect(store.get([image.id, video.id]).map((f) => f.kind)).toEqual(["image", "video"]);
  });

  it("refuses types gh can't attach, files over GitHub's limits, and unknown ids", async () => {
    const store = new AttachmentStore();
    await expect(store.save("notes.pdf", upload(10))).rejects.toMatchObject({ status: 415 });
    await expect(store.save("huge.png", upload(11 * 1024 * 1024))).rejects.toMatchObject({ status: 413 });
    expect(() => store.get(["nope"])).toThrow(/no longer available/);
  });

  it("turns gh's video links into bare URLs (GitHub plays only those), leaving images alone", () => {
    const body = "![shot](https://github.com/user-attachments/assets/a1)\n\n[demo](https://github.com/user-attachments/assets/b2)\n\n[demo](https://example.com)";
    expect(videosAsPlayers(body, ["demo"])).toBe("![shot](https://github.com/user-attachments/assets/a1)\n\nhttps://github.com/user-attachments/assets/b2\n\n[demo](https://example.com)");
  });
});
