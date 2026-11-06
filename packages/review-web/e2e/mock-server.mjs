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
  const state = { calls: [], inboxRequests: 0, down: false, delayMs: 120, edits: {}, preferences: {}, notes: [], reviewed: new Set() };
  // Like GitHub: once you've reviewed a PR you're no longer a requested reviewer.
  const withReviews = (data) =>
    state.reviewed.size === 0
      ? data
      : {
          ...data,
          groups: data.groups.map((g) => {
            const moved = data.groups.find((x) => x.id === "needs_review").items.filter((i) => state.reviewed.has(i.ref.number));
            if (g.id === "needs_review") return { ...g, items: g.items.filter((i) => !state.reviewed.has(i.ref.number)) };
            if (g.id === "others") return { ...g, items: [...moved, ...g.items] };
            return g;
          }),
        };
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
    // Plays the agent: what `pile notes done <id> -m "..."` writes.
    if (path === "/__agent-reply") {
      const note = state.notes.find((n) => n.id === url.searchParams.get("id")) ?? state.notes.at(-1);
      (note.replies ??= []).push({ author: "agent", body: url.searchParams.get("body") ?? "Done.", createdAt: new Date().toISOString() });
      if (url.searchParams.has("done")) note.done = true;
      return json(res, 200, note);
    }
    // Puts a PR's description back as the fixtures have it.
    if (path === "/__undo-description") {
      const edit = state.edits[Number(url.searchParams.get("pr"))];
      if (edit) {
        delete edit.body;
        delete edit.bodyHtml;
      }
      return json(res, 200, { ok: true });
    }
    if (path === "/__state") {
      Object.assign(state, Object.fromEntries([...url.searchParams].map(([k, v]) => [k, v === "true" ? true : v === "false" ? false : Number.isNaN(Number(v)) ? v : Number(v)])));
      if (url.searchParams.has("reset")) Object.assign(state, { calls: [], inboxRequests: 0, down: false, edits: {}, fileDown: false, notes: [], reviewed: new Set() });
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
        const body = withReviews(state.inboxRequests === 1 && !url.searchParams.has("fresh") ? partialInbox() : inbox);
        // /__state?emptyGroups=mine,local: those groups come back empty.
        const empty = String(state.emptyGroups ?? "").split(",");
        return json(res, 200, { ...body, groups: body.groups.map((g) => (empty.includes(g.id) ? { ...g, items: [] } : g)) });
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
          if (change.title !== undefined) edit.title = change.title;
          if (change.body !== undefined) {
            edit.body = change.body;
            edit.bodyHtml = change.body.trim() ? change.body.split(/\n{2,}/).map((p) => `<p>${p.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>`).join("") : null;
          }
          return json(res, 200, withEdits(detailFor(detail.number)));
        }
        return detail ? json(res, 200, detail) : json(res, 404, { error: `Pull request #${m[1]} doesn't exist`, code: "PR_NOT_FOUND" });
      }
      if (api === "/options") return json(res, 200, options);
      // GitHub's search across the repo: here, one PR that isn't in the inbox at all.
      if (api === "/search") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        state.calls.push({ type: "search", q });
        const flaky = { ref: { kind: "pr", number: 150 }, id: "pr-150", title: "Flaky e2e on Safari", branch: "ci/safari-flake", base: "main", author: { login: "zoe", avatarUrl: null }, state: "open", updatedAt: new Date().toISOString(), additions: null, deletions: null, reviewDecision: null, checks: null, stack: null, local: null, url: "https://github.com/acme/web/pull/150", comments: 0 };
        return json(res, 200, "safari".includes(q) || q.includes("safari") ? [flaky] : []);
      }
      if (api === "/notes" && req.method === "GET") return json(res, 200, state.notes.filter((n) => n.branch === url.searchParams.get("branch")));
      if (api === "/notes" && req.method === "POST") {
        const body = await readBody(req);
        state.calls.push({ type: "note", ...body });
        if (!body.body?.trim()) return json(res, 400, { error: "A note needs some text", code: "EMPTY_NOTE" });
        const detail = body.ref.kind === "pr" ? detailFor(body.ref.number) : branchDetail(body.ref.name);
        const note = {
          id: Math.random().toString(16).slice(2, 8),
          branch: detail.branch,
          pr: detail.number,
          path: body.path ?? null,
          line: body.line ?? null,
          side: body.path ? (body.side ?? "RIGHT") : null,
          commit: detail.headSha,
          code: [],
          codeStart: null,
          body: body.body.trim(),
          createdAt: new Date().toISOString(),
          done: false,
        };
        state.notes.push(note);
        return json(res, 201, note);
      }
      if (req.method === "POST" && (m = api.match(/^\/notes\/([0-9a-f]+)\/replies$/))) {
        const note = state.notes.find((n) => n.id === m[1]);
        const { body } = await readBody(req);
        state.calls.push({ type: "note-reply", id: m[1], body });
        (note.replies ??= []).push({ author: "reviewer", body, createdAt: new Date().toISOString() });
        note.done = false; // a follow-up reopens the note
        return json(res, 201, note);
      }
      if ((m = api.match(/^\/notes\/([0-9a-f]+)$/))) {
        const note = state.notes.find((n) => n.id === m[1]);
        if (!note) return json(res, 404, { error: `No note with id ${m[1]}`, code: "NOTE_NOT_FOUND" });
        if (req.method === "DELETE") {
          state.notes = state.notes.filter((n) => n !== note);
          return json(res, 200, { ok: true });
        }
        Object.assign(note, await readBody(req));
        return json(res, 200, note);
      }
      if (api === "/preferences" && req.method === "PATCH") {
        Object.assign(state.preferences, await readBody(req));
        return json(res, 200, state.preferences);
      }
      if (api === "/preferences") return json(res, 200, state.preferences);
      if (req.method === "POST" && (m = api.match(/^\/pr\/(\d+)\/merge$/))) {
        const body = await readBody(req);
        state.calls.push({ type: "merge", pr: Number(m[1]), ...body });
        const detail = withEdits(detailFor(Number(m[1])));
        const plan = body.stack ? detail.merge?.stack : detail.merge?.single.possible ? detail.merge.single : null;
        if (!plan) return json(res, 400, { error: `#${detail.number} is based on ${detail.base}`, code: "NOT_ON_TRUNK" });
        if (plan.blockers.length) return json(res, 409, { error: plan.blockers.join("; "), code: "MERGE_BLOCKED" });
        const byBranch = new Map(detail.stack.map((e) => [e.branch, e]));
        const chain = [detail.number];
        for (let e = detail.stack.find((x) => x.isCurrent); e && byBranch.has(e.base); ) {
          e = byBranch.get(e.base);
          chain.unshift(e.ref.number);
        }
        const merged = body.stack ? chain : [detail.number];
        for (const n of merged) (state.edits[n] ??= {}).state = "merged";
        for (const n of merged) state.edits[n].merge = null;
        return json(res, 200, { merged, queued: false });
      }
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
        state.reviewed.add(Number(m[1]));
        return json(res, 201, { ok: true });
      }
      return json(res, 404, { error: "Not found", code: "NOT_FOUND" });
    }

    let file = join(dist, normalize(path).replace(/^\/+/, ""));
    if (!existsSync(file) || !extname(file)) file = join(dist, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    // Like pile's server: the saved theme is written into the page.
    const theme = state.preferences.theme;
    if (file.endsWith("index.html") && (theme === "light" || theme === "dark")) return res.end(readFileSync(file, "utf8").replace("<html", `<html data-theme="${theme}"`));
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
