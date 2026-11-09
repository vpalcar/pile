// Serves the built app (dist/) with fixture data instead of GitHub, for tests.
// Writes are recorded and exposed at /__calls; /__state changes behavior.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { branchDetail, detailFor, fileContents, inbox, options, partialInbox, session } from "./fixtures.mjs";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
export const TOKEN = "test-token";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

export function startMockServer(port = 0) {
  const state = { calls: [], inboxRequests: 0, down: false, delayMs: 120, edits: {} };
  // Edits made through the app, layered over the fixtures.
  const withEdits = (detail) => (detail ? { ...detail, ...state.edits[detail.number] } : detail);
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data ? JSON.parse(data) : {}));
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (path === "/__calls") return json(res, 200, state.calls);
    if (path === "/__state") {
      Object.assign(state, Object.fromEntries([...url.searchParams].map(([k, v]) => [k, v === "true" ? true : v === "false" ? false : Number.isNaN(Number(v)) ? v : Number(v)])));
      if (url.searchParams.has("reset")) Object.assign(state, { calls: [], inboxRequests: 0, down: false, edits: {}, fileDown: false });
      return json(res, 200, { ok: true });
    }

    if (path.startsWith("/api/")) {
      if (state.down) return json(res, 503, { error: "Down", code: "DOWN" });
      if (req.headers["x-pile-token"] !== TOKEN) return json(res, 401, { error: "Missing or wrong token", code: "UNAUTHORIZED" });
      await new Promise((r) => setTimeout(r, state.delayMs));
      const api = path.slice(4);
      let m;
      if (api === "/session") return json(res, 200, session);
      if (api === "/inbox") {
        state.inboxRequests++;
        return json(res, 200, state.inboxRequests === 1 && !url.searchParams.has("fresh") ? partialInbox() : inbox);
      }
      if ((m = api.match(/^\/pr\/(\d+)$/))) {
        const detail = withEdits(detailFor(Number(m[1])));
        if (detail && req.method === "PATCH") {
          const change = await readBody(req);
          state.calls.push({ type: "update", pr: detail.number, ...change });
          if (JSON.stringify(change).includes("fail")) return json(res, 422, { error: "Reviews may only be requested from collaborators", code: "GITHUB_422" });
          const person = (login) => options.people.find((p) => p.login === login) ?? { login, avatarUrl: null };
          const edit = (state.edits[detail.number] ??= {});
          if (change.reviewers) {
            const { add = [], remove = [] } = change.reviewers;
            edit.reviewers = [...detail.reviewers.filter((r) => !remove.includes(r.person.login) && !add.includes(r.person.login)), ...add.map((l) => ({ person: person(l), state: "requested" }))];
          }
          if (change.assignees) {
            const { add = [], remove = [] } = change.assignees;
            edit.assignees = [...detail.assignees.filter((a) => !remove.includes(a.login)), ...add.map(person)];
          }
          if (change.labels) edit.labels = change.labels.map((name) => options.labels.find((l) => l.name === name) ?? { name, color: "ededed", description: null });
          if (change.draft !== undefined) edit.state = change.draft ? "draft" : "open";
          return json(res, 200, withEdits(detailFor(detail.number)));
        }
        return detail ? json(res, 200, detail) : json(res, 404, { error: `Pull request #${m[1]} doesn't exist`, code: "PR_NOT_FOUND" });
      }
      if (api === "/options") return json(res, 200, options);
      if (req.method === "POST" && (m = api.match(/^\/pr\/(\d+)\/checks\/rerun$/))) {
        const body = await readBody(req);
        state.calls.push({ type: "rerun", pr: Number(m[1]), ...body });
        const detail = withEdits(detailFor(Number(m[1])));
        const hit = (c) => (body.jobId ? c.jobId === body.jobId : c.state === "failure" && c.jobId);
        (state.edits[detail.number] ??= {}).checks = detail.checks.map((c) => (hit(c) ? { ...c, state: "pending", durationSeconds: null } : c));
        return json(res, 200, withEdits(detailFor(detail.number)));
      }
      if (api === "/branch") {
        const detail = branchDetail(url.searchParams.get("name"));
        return detail ? json(res, 200, detail) : json(res, 404, { error: "Branch not found", code: "BRANCH_NOT_FOUND" });
      }
      if (api === "/file" && state.fileDown) return json(res, 500, { error: "git show failed", code: "ERROR" });
      if (api === "/file") {
        const lines = fileContents[url.searchParams.get("path")];
        return lines ? json(res, 200, { path: url.searchParams.get("path"), ref: url.searchParams.get("ref"), lines }) : json(res, 404, { error: "Not found", code: "FILE_NOT_FOUND" });
      }
      if (req.method === "POST" && (m = api.match(/^\/pr\/(\d+)\/comments$/))) {
        const body = await readBody(req);
        state.calls.push({ type: "comment", pr: Number(m[1]), ...body });
        if (/fail/i.test(body.body)) return json(res, 422, { error: "GitHub rejected the comment", code: "GITHUB_422" });
        return json(res, 201, { ok: true });
      }
      if (req.method === "POST" && (m = api.match(/^\/pr\/(\d+)\/reviews$/))) {
        const body = await readBody(req);
        state.calls.push({ type: "review", pr: Number(m[1]), ...body });
        if (/fail/i.test(body.body ?? "")) return json(res, 422, { error: "Review cannot be submitted right now", code: "REVIEW_REJECTED" });
        return json(res, 201, { ok: true });
      }
      return json(res, 404, { error: "Not found", code: "NOT_FOUND" });
    }

    let file = join(dist, normalize(path).replace(/^\/+/, ""));
    if (!existsSync(file) || !extname(file)) file = join(dist, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: actual } = server.address();
      resolve({ url: `http://127.0.0.1:${actual}`, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startMockServer(Number(process.argv[2] ?? 4600));
  console.log(`${server.url}/#token=${TOKEN}`);
}
