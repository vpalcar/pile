import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createPile } from "@pile/core";
import { parseGitDiff } from "../src/review/local-data.js";
import { ReviewError, ReviewService } from "../src/review/service.js";
import { startReviewServer } from "../src/review/server.js";
import { createCliRepo } from "./helpers.js";

function webRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pile-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>pile review</title>");
  writeFileSync(join(dir, "app.js"), "console.log('app')");
  return dir;
}

/** Raw HTTP so the Host header can be set freely. */
function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET", body?: string) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("parseGitDiff", () => {
  it("splits files and reads status, renames, binaries and counts", () => {
    const files = parseGitDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        "-old",
        "+new",
        " same",
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1 @@",
        "+hello",
        "diff --git a/old name.md b/new name.md",
        "similarity index 90%",
        "rename from old name.md",
        "rename to new name.md",
        "diff --git a/logo.png b/logo.png",
        "Binary files a/logo.png and b/logo.png differ",
        "",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.previousPath, f.binary])).toEqual([
      ["src/a.ts", "modified", 1, 1, null, false],
      ["new.txt", "added", 1, 0, null, false],
      ["new name.md", "renamed", 0, 0, "old name.md", false],
      ["logo.png", "modified", 0, 0, null, true],
    ]);
    expect(files[0].patch).toBe("@@ -1,2 +1,2 @@\n-old\n+new\n same");
  });
});

describe("review server", () => {
  const stub = (overrides: Partial<ReviewService> = {}) =>
    ({
      session: async () => ({ repo: null, viewer: null, trunk: "main", currentBranch: "main", github: false, initial: null }),
      inbox: async () => ({ groups: [], fetchedAt: "now" }),
      detail: async () => {
        throw new ReviewError(404, "PR_NOT_FOUND", "Pull request #9 doesn't exist");
      },
      comment: async () => {},
      invalidate: () => {},
      ...overrides,
    }) as unknown as ReviewService;

  it("requires the token for the API and serves the app without it", async () => {
    const server = await startReviewServer({ service: stub(), initial: null, token: "secret", webRoot: webRoot() });
    try {
      expect((await get(server.port, "/api/session")).status).toBe(401);
      expect((await get(server.port, "/api/session", { "x-pile-token": "wrong!" })).status).toBe(401);
      const ok = await get(server.port, "/api/session", { "x-pile-token": "secret" });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toMatchObject({ trunk: "main" });

      const page = await get(server.port, "/");
      expect(page.status).toBe(200);
      expect(page.body).toContain("<title>pile review</title>");
      expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=secret$/);
    } finally {
      await server.close();
    }
  });

  it("rejects other host names (DNS rebinding)", async () => {
    const server = await startReviewServer({ service: stub(), initial: null, token: "secret", webRoot: webRoot() });
    try {
      expect((await get(server.port, "/", { host: "evil.example:80" })).status).toBe(403);
      expect((await get(server.port, "/api/session", { host: "evil.example", "x-pile-token": "secret" })).status).toBe(403);
      expect((await get(server.port, "/", { host: `localhost:${server.port}` })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("never serves files outside the app directory", async () => {
    const server = await startReviewServer({ service: stub(), initial: null, token: "secret", webRoot: webRoot() });
    try {
      for (const path of ["/../../../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/app.js/../../secret"]) {
        const res = await get(server.port, path);
        expect(res.body).not.toContain("root:");
      }
      expect((await get(server.port, "/app.js")).body).toBe("console.log('app')");
    } finally {
      await server.close();
    }
  });

  it("returns API errors with their status and code", async () => {
    let posted = "";
    const service = stub({ comment: async (_n: number, body: string) => void (posted = body) } as Partial<ReviewService>);
    const server = await startReviewServer({ service, initial: null, token: "secret", webRoot: webRoot() });
    try {
      const missing = await get(server.port, "/api/pr/9", { "x-pile-token": "secret" });
      expect(missing.status).toBe(404);
      expect(JSON.parse(missing.body)).toMatchObject({ code: "PR_NOT_FOUND" });

      const created = await get(server.port, "/api/pr/9/comments", { "x-pile-token": "secret", "content-type": "application/json" }, "POST", JSON.stringify({ body: "LGTM" }));
      expect(created.status).toBe(201);
      expect(posted).toBe("LGTM");
    } finally {
      await server.close();
    }
  });
});

describe("local branches without GitHub", () => {
  it("lists tracked branches and shows their diff and commits", async () => {
    const repo = createCliRepo();
    repo.chain(["feature/a", "feature/b"]);
    repo.commitFile("feature_b.txt", "feature/b\nmore\n", "more b");
    const pile = await createPile(repo.dir);
    const service = new ReviewService(pile, null);

    const inbox = await service.inbox();
    const local = inbox.groups.find((g) => g.id === "local")!;
    expect(local.items.map((i) => [i.branch, i.state, i.stack?.index, i.stack?.size])).toEqual([
      ["feature/a", "local", 1, 2],
      ["feature/b", "local", 2, 2],
    ]);

    const detail = await service.detail({ kind: "branch", name: "feature/b" });
    expect(detail).toMatchObject({ state: "local", base: "feature/a", number: null, additions: 2, deletions: 0 });
    expect(detail.files.map((f) => f.path)).toEqual(["feature_b.txt"]);
    expect(detail.timeline.map((t) => t.message)).toEqual(["add feature/b", "more b"]);
    expect(detail.stack.map((s) => [s.branch, s.isCurrent])).toEqual([
      ["feature/a", false],
      ["feature/b", true],
    ]);

    const file = await service.file(detail.headSha, "feature_b.txt");
    expect(file.lines).toEqual(["feature/b", "more"]);

    await expect(service.detail({ kind: "pr", number: 1 })).rejects.toMatchObject({ code: "NO_GITHUB" });
    await expect(service.detail({ kind: "branch", name: "nope" })).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND" });
  });
});

describe("inbox freshness", () => {
  it("keeps serving the full inbox after a change, never falling back to the quick list", async () => {
    const pile = await createPile(createCliRepo().dir);
    const service = new ReviewService(pile, null);
    // Pretend GitHub is configured and count full builds instead of calling it.
    let builds = 0;
    Object.assign(service, {
      octokit: {},
      loadInbox: async (enrich: boolean) => ({ groups: [], fetchedAt: enrich ? `full ${++builds}` : "quick", partial: !enrich }),
    });

    expect(await service.inbox()).toMatchObject({ partial: true }); // nothing built yet
    await (service as unknown as { refreshInbox(): Promise<unknown> }).refreshInbox();
    expect(await service.inbox()).toMatchObject({ partial: false });
    const before = builds;

    service.invalidate({ kind: "pr", number: 1 });
    // Stale, but still the full one while its replacement is built.
    expect(await service.inbox()).toMatchObject({ partial: false });
    // An explicit refresh waits for the new full inbox.
    expect((await service.inbox({ fresh: true })).fetchedAt).toBe(`full ${builds}`);
    expect(builds).toBeGreaterThan(before);
  });
});
