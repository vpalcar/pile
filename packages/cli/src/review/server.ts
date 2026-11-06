import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ItemRef, MergeRequest, PRUpdate, RerunRequest, ReviewRequest } from "@pile/review-web/api";
import { ReviewService } from "./service.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
};

/** The built web app ships next to the CLI bundle in dist/review-web. */
function findWebRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "review-web"), join(here, "..", "review-web"), join(here, "..", "..", "review-web")];
  const root = candidates.find((dir) => existsSync(join(dir, "index.html")));
  if (!root) throw new Error(`Review app assets not found (looked in ${candidates.join(", ")}). Run \`pnpm build\`.`);
  return root;
}

export interface ReviewServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startReviewServer(options: {
  service: ReviewService;
  initial: ItemRef | null;
  port?: number;
  host?: string;
  /** Fixed token (tests); random otherwise. */
  token?: string;
  /** Directory of the built web app (tests); found next to the bundle otherwise. */
  webRoot?: string;
}): Promise<ReviewServer> {
  const { service, initial } = options;
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? randomBytes(24).toString("base64url");
  const webRoot = options.webRoot ?? findWebRoot();
  let port = options.port ?? 0;

  const allowedHost = (value: string | undefined) =>
    !!value && [`127.0.0.1:${port}`, `localhost:${port}`].includes(value);

  const authorized = (req: IncomingMessage) => {
    const given = Buffer.from(String(req.headers["x-pile-token"] ?? ""));
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(json);
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > 2_000_000) reject(new Error("Request too large"));
      });
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
    });

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (!authorized(req)) return send(res, 401, { error: "Missing or wrong token", code: "UNAUTHORIZED" });
    const path = url.pathname.slice("/api".length);
    const method = req.method ?? "GET";
    let match: RegExpMatchArray | null;

    if (method === "GET" && path === "/session") return send(res, 200, await service.session(initial));
    if (method === "GET" && path === "/inbox") {
      return send(res, 200, await service.inbox({ fresh: url.searchParams.has("fresh") }));
    }
    if (method === "GET" && (match = path.match(/^\/pr\/(\d+)$/))) {
      const ref = { kind: "pr" as const, number: Number(match[1]) };
      if (url.searchParams.has("fresh")) service.invalidate(ref);
      return send(res, 200, await service.detail(ref));
    }
    if (method === "GET" && path === "/branch") {
      const name = url.searchParams.get("name");
      if (!name) return send(res, 400, { error: "Missing branch name", code: "BAD_REQUEST" });
      if (url.searchParams.has("fresh")) service.invalidate({ kind: "branch", name });
      return send(res, 200, await service.detail({ kind: "branch", name }));
    }
    if (method === "GET" && path === "/file") {
      const ref = url.searchParams.get("ref");
      const file = url.searchParams.get("path");
      if (!ref || !file) return send(res, 400, { error: "Missing ref or path", code: "BAD_REQUEST" });
      return send(res, 200, await service.file(ref, file));
    }
    if (method === "POST" && (match = path.match(/^\/pr\/(\d+)\/comments$/))) {
      const body = (await readBody(req)) as { body?: string };
      await service.comment(Number(match[1]), String(body.body ?? ""));
      return send(res, 201, { ok: true });
    }
    if (method === "POST" && (match = path.match(/^\/pr\/(\d+)\/reviews$/))) {
      await service.review(Number(match[1]), (await readBody(req)) as ReviewRequest);
      return send(res, 201, { ok: true });
    }
    if (method === "GET" && path === "/options") return send(res, 200, await service.options());
    if (method === "PATCH" && (match = path.match(/^\/pr\/(\d+)$/))) {
      return send(res, 200, await service.update(Number(match[1]), (await readBody(req)) as PRUpdate));
    }
    if (method === "POST" && (match = path.match(/^\/pr\/(\d+)\/merge$/))) {
      return send(res, 200, await service.merge(Number(match[1]), (await readBody(req)) as MergeRequest));
    }
    if (method === "POST" && (match = path.match(/^\/pr\/(\d+)\/checks\/rerun$/))) {
      return send(res, 200, await service.rerun(Number(match[1]), (await readBody(req)) as RerunRequest));
    }
    return send(res, 404, { error: "Not found", code: "NOT_FOUND" });
  };

  const serveStatic = (res: ServerResponse, pathname: string) => {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    let file = join(webRoot, relative);
    if (!file.startsWith(webRoot + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(webRoot, "index.html"); // client-side routes
    }
    const type = MIME[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      // Only content-hashed files (chunks) and fonts may be cached for good; everything
      // else is revalidated so a rebuilt app shows up on reload.
      "cache-control": /[/\\](chunks|fonts)[/\\]/.test(file) ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      ...(file.endsWith("index.html")
        ? {
            "content-security-policy":
              "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          }
        : {}),
    });
    res.end(readFileSync(file));
  };

  const server = createServer(async (req, res) => {
    // Refuse requests addressed to any other host name (DNS rebinding).
    if (!allowedHost(req.headers.host)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else serveStatic(res, url.pathname);
    } catch (error) {
      const { status, body } = ReviewService.errorBody(error);
      if (!res.headersSent) send(res, status, body);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
