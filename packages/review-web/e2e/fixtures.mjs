// Fixture data for the review app's end-to-end tests: one of every state the UI
// has to handle. Shapes follow src/api.ts.

const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
const person = (login) => ({ login, avatarUrl: null });
const checks = (state, passed, failed, pending) => ({ state, total: passed + failed + pending, passed, failed, pending });

export const VIEWER = person("you");

export const session = {
  repo: { owner: "acme", name: "web", url: "https://github.com/acme/web" },
  viewer: VIEWER,
  trunk: "main",
  currentBranch: "settings/schema",
  github: true,
  initial: null,
};

const pr = (number, title, branch, extra = {}) => ({
  ref: { kind: "pr", number },
  id: `pr-${number}`,
  title,
  branch,
  base: "main",
  author: person("alice"),
  state: "open",
  updatedAt: ago(30),
  additions: 120,
  deletions: 14,
  reviewDecision: null,
  checks: checks("success", 4, 0, 0),
  stack: null,
  local: null,
  url: `https://github.com/acme/web/pull/${number}`,
  comments: 0,
  ...extra,
});

const longStack = Array.from({ length: 8 }, (_, i) =>
  pr(120 + i, `Migrate billing step ${i + 1} of 8`, `billing/step-${i + 1}`, {
    author: VIEWER,
    base: i === 0 ? "main" : `billing/step-${i}`,
    stack: { index: i + 1, size: 8, nativeStack: 140 },
    reviewDecision: i < 3 ? "approved" : i === 3 ? "changes_requested" : "review_required",
    updatedAt: ago(200 + i),
    additions: 30 + i * 11,
    deletions: 4 + i,
  }),
);

// A diverging stack: #140 on main, then two branches built on it, each with more on top.
//   main <- 140 <- 141 <- 143
//               <- 142 <- 144
//                      <- 145
const searchTree = [
  [140, "Index documents for search", "search/index", "main", 1, "approved"],
  [141, "Search API endpoint", "search/api", "search/index", 2, "changes_requested"],
  [142, "Search page", "search/ui", "search/index", 2, "approved"],
  [143, "Tests for the search API", "search/api-tests", "search/api", 3, "review_required"],
  [144, "Filters on the search page", "search/ui-filters", "search/ui", 3, "approved"],
  [145, "Empty and error states for search", "search/ui-empty", "search/ui", 3, "review_required"],
].map(([number, title, branch, base, index, reviewDecision]) =>
  pr(number, title, branch, { author: VIEWER, base, reviewDecision, stack: { index, size: 6, nativeStack: null }, updatedAt: ago(90 + number) }),
);

const local = (name, title, base, extra = {}) => ({
  ref: { kind: "branch", name },
  id: `branch-${name}`,
  title,
  branch: name,
  base,
  author: VIEWER,
  state: "local",
  updatedAt: ago(5),
  additions: 42,
  deletions: 3,
  reviewDecision: null,
  checks: null,
  stack: null,
  local: { ahead: 0, behind: 0, unpushed: true, isCurrent: false },
  url: null,
  comments: 0,
  ...extra,
});

export const inbox = {
  fetchedAt: ago(0),
  groups: [
    {
      id: "needs_review",
      title: "Needs your review",
      items: [
        pr(101, "Rate limit the public API", "api/rate-limit", {
          reviewDecision: "review_required",
          checks: checks("failure", 3, 1, 1),
          stack: { index: 1, size: 2, nativeStack: null },
          comments: 6,
          additions: 412,
          deletions: 87,
        }),
        pr(102, "Expose rate-limit headers to clients", "api/rate-limit-headers", {
          author: person("bob"),
          base: "api/rate-limit",
          reviewDecision: "review_required",
          stack: { index: 2, size: 2, nativeStack: null },
          checks: checks("pending", 2, 0, 2),
        }),
        pr(103, "Fix typo in the onboarding email that some customers reported last week", "fix/onboarding-typo", {
          author: person("carol"),
          reviewDecision: "review_required",
          checks: checks("failure", 3, 1, 0),
          additions: 1,
          deletions: 1,
        }),
      ],
    },
    {
      id: "mine",
      title: "Your pull requests",
      items: [
        pr(110, "Add settings schema", "settings/schema", { author: VIEWER, reviewDecision: "approved", checks: checks("none", 0, 0, 0), comments: 2 }),
        pr(111, "Settings API", "settings/api", { author: VIEWER, reviewDecision: "changes_requested", comments: 9 }),
        pr(112, "Settings page", "settings/ui", { author: VIEWER, state: "draft", checks: checks("none", 0, 0, 0) }),
        pr(113, "Upgrade React to 19", "deps/react-19", {
          author: VIEWER,
          reviewDecision: "approved",
          checks: checks("pending", 5, 0, 1),
          local: { ahead: 2, behind: 0, unpushed: true, isCurrent: true },
          additions: 12840,
          deletions: 9311,
        }),
        ...longStack,
        ...searchTree,
      ],
    },
    {
      id: "local",
      title: "Local branches",
      items: [
        local("spike/parser", "Try a hand-written parser", "main", { stack: { index: 1, size: 2, nativeStack: null } }),
        local("spike/parser-errors", "Better parser errors", "spike/parser", { stack: { index: 2, size: 2, nativeStack: null } }),
        local("wip", "wip", "main", { additions: 0, deletions: 0 }),
      ],
    },
    {
      id: "others",
      title: "Other open pull requests",
      searchOnly: true,
      items: [
        pr(130, "Dark mode for the dashboard", "ui/dark-mode", { author: person("dave"), reviewDecision: null, checks: checks("none", 0, 0, 0) }),
        pr(131, "Speed up CI with remote caching", "ci/cache", { author: person("erin"), reviewDecision: "commented", comments: 3 }),
      ],
    },
  ],
};

/** The quick first answer: no checks, sizes or review state yet. */
export function partialInbox() {
  return {
    ...inbox,
    partial: true,
    groups: inbox.groups.map((g) => ({
      ...g,
      items: g.items.map((i) => (i.state === "local" ? i : { ...i, checks: null, additions: null, deletions: null, reviewDecision: null, comments: 0 })),
    })),
  };
}

// -----------------------------------------------------------------------------
// Files

export const SOURCE = Array.from({ length: 120 }, (_, i) => {
  const n = i + 1;
  if (n === 1) return 'import { limit } from "./limit";';
  if (n % 10 === 0) return "";
  if (n % 7 === 0) return `  // Step ${n}: keep requests under the limit`;
  return `export const rule${n} = limit({ window: ${n}, max: ${n * 3} });`;
});

function patchFor() {
  // Hunk 1 around lines 20–26 (replace two lines, add one); hunk 2 around 80–85 (delete one).
  const lines = (from, to) => SOURCE.slice(from - 1, to).map((l) => ` ${l}`);
  return [
    "@@ -20,6 +20,7 @@ export function setup() {",
    ...lines(20, 21),
    `-export const rule22 = limit({ window: 22, max: 66 });`,
    `-export const rule23 = limit({ window: 23, max: 69 });`,
    `+${SOURCE[21]}`,
    `+${SOURCE[22]}`,
    `+${SOURCE[23]}`,
    ...lines(25, 26),
    "@@ -79,5 +80,4 @@ export function teardown() {",
    ...lines(80, 81),
    `-export const removed = true;`,
    ...lines(82, 83),
  ].join("\n");
}

const big = Array.from({ length: 1500 }, (_, i) => `+generated line ${i + 1}`).join("\n");

export const files = [
  { path: "src/api/limit.ts", previousPath: null, status: "modified", additions: 3, deletions: 3, patch: patchFor(), sha: "limit-v1", binary: false },
  {
    path: "src/api/headers.ts",
    previousPath: null,
    status: "added",
    additions: 6,
    deletions: 0,
    patch: '@@ -0,0 +1,6 @@\n+/** Headers sent with every limited response. */\n+export const HEADERS = {\n+  limit: "x-ratelimit-limit",\n+  remaining: "x-ratelimit-remaining",\n+  reset: "x-ratelimit-reset",\n+};',
    sha: "headers-v1",
    binary: false,
  },
  { path: "src/legacy/throttle.js", previousPath: null, status: "removed", additions: 0, deletions: 3, patch: "@@ -1,3 +0,0 @@\n-export function throttle() {\n-  return true;\n-}", sha: "throttle-v1", binary: false },
  { path: "docs/rate-limits.md", previousPath: "docs/limits.md", status: "renamed", additions: 0, deletions: 0, patch: null, sha: "docs-v1", binary: false },
  { path: "assets/diagram.png", previousPath: null, status: "added", additions: 0, deletions: 0, patch: null, sha: "png-v1", binary: true },
  { path: "src/generated/schema.ts", previousPath: null, status: "added", additions: 1500, deletions: 0, patch: `@@ -0,0 +1,1500 @@\n${big}`, sha: "gen-v1", binary: false },
  {
    path: "README.md",
    previousPath: null,
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "@@ -1,3 +1,4 @@\n # acme web\n-Rate limits are not enforced.\n+Rate limits are enforced per API key.\n+See docs/rate-limits.md.\n \n",
    sha: "readme-v1",
    binary: false,
  },
];

export const fileContents = { "src/api/limit.ts": SOURCE };

// -----------------------------------------------------------------------------
// Details

const BODY = `<p>Adds a token-bucket rate limiter in front of the public API.</p>
<h2>What changes</h2>
<ul><li><code>limit()</code> builds a rule from a window and a maximum</li><li>Limited responses get <strong>429</strong> and <a href="https://example.com/docs">documented headers</a></li></ul>
<table><thead><tr><th>Plan</th><th>Requests / min</th></tr></thead><tbody><tr><td>Free</td><td>60</td></tr><tr><td>Pro</td><td>600</td></tr></tbody></table>
<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked disabled> Unit tests</li><li class="task-list-item"><input type="checkbox" disabled> Load test in staging</li></ul>
<blockquote><p>Rolling out behind a flag first.</p></blockquote>
<details><summary>Benchmark</summary><pre><code>p50 1.2ms  p99 4.8ms</code></pre></details>`;

const commit = (sha, message, minutes) => ({ id: `commit-${sha}`, kind: "commit", author: person("alice"), createdAt: ago(minutes), bodyHtml: null, sha: sha.padEnd(40, "0"), message, url: `https://github.com/acme/web/commit/${sha}` });

/** Check runs that add up to a summary, so list and counts agree. */
function checkRunsFor(summary) {
  if (!summary) return [];
  const runs = [];
  for (let i = 0; i < summary.failed; i++) runs.push({ name: `test shard ${i + 1}`, state: "failure", summary: "1 failed", url: null, durationSeconds: 61 });
  for (let i = 0; i < summary.pending; i++) runs.push({ name: `e2e ${i + 1}`, state: "pending", summary: null, url: null, durationSeconds: null });
  for (let i = 0; i < summary.passed; i++) runs.push({ name: ["build", "lint", "typecheck", "unit tests", "docs"][i % 5], state: "success", summary: null, url: null, durationSeconds: 20 + i * 7 });
  return runs.map((run, i) => ({ ...run, jobId: 5000 + i }));
}

/** The same reasons pile's merge rules give (see @pile/github merge-rules). */
function blockersFor(item) {
  const reasons = [];
  if (item.state === "draft") reasons.push("PR is still a draft");
  if (item.checks?.state === "failure") reasons.push(`CI checks failing (${item.checks.failed}/${item.checks.total} failed)`);
  else if (item.checks?.state === "pending") reasons.push(`CI checks in progress (${item.checks.pending}/${item.checks.total} pending)`);
  if (item.reviewDecision === "changes_requested") reasons.push("Changes requested by reviewer");
  return reasons;
}

function mergeInfo(item, stack) {
  if (item.state !== "open" && item.state !== "draft") return null;
  const own = blockersFor(item);
  // What this PR is built on, bottom first: never a sibling branch.
  const byBranch = new Map(stack.map((e) => [e.branch, e]));
  const below = [];
  for (let e = stack.find((x) => x.isCurrent); e && byBranch.has(e.base); ) {
    e = byBranch.get(e.base);
    below.unshift(e);
  }
  return {
    method: "squash",
    single: { possible: item.base === "main", blockers: own },
    stack: below.length
      ? { count: below.length + 1, blockers: [...below.flatMap((e) => e.blockers.map((b) => `#${e.ref.number}: ${b}`)), ...own.map((b) => `#${item.ref.number}: ${b}`)] }
      : null,
  };
}

/** Header totals always match the files the detail actually carries. */
export function detailFor(number) {
  const detail = buildDetail(number);
  if (!detail) return null;
  const sum = (key) => detail.files.reduce((n, f) => n + f[key], 0);
  // Like the server: anyone's latest review asking for changes blocks a merge.
  const changes = detail.reviewDecision === "changes_requested" || detail.reviewers.some((r) => r.state === "changes_requested");
  const merge = mergeInfo({ ...detail, checks: detail.checksSummary, reviewDecision: changes ? "changes_requested" : detail.reviewDecision, ref: detail.ref }, detail.stack);
  return { ...detail, additions: sum("additions"), deletions: sum("deletions"), merge };
}

function buildDetail(number) {
  const item = inbox.groups.flatMap((g) => g.items).find((i) => i.ref.kind === "pr" && i.ref.number === number);
  if (!item) return null;
  const base = {
    ref: item.ref,
    title: item.title,
    number,
    url: item.url,
    state: item.state,
    author: item.author,
    branch: item.branch,
    base: item.base,
    headSha: `head${number}`,
    baseSha: `base${number}`,
    createdAt: ago(600),
    updatedAt: item.updatedAt,
    bodyHtml: null,
    additions: item.additions ?? 0,
    deletions: item.deletions ?? 0,
    stack: [],
    timeline: [commit(`c${number}a`, item.title, 300)],
    inlineComments: [],
    checks: checkRunsFor(item.checks),
    checksSummary: item.checks,
    reviewers: [],
    labels: [],
    assignees: [],
    mergeable: true,
    mergeableState: "clean",
    reviewDecision: item.reviewDecision,
    files: [files[1]],
    local: item.local,
    can: { review: item.author?.login !== VIEWER.login, comment: true, merge: true, draft: item.author?.login === VIEWER.login },
    merge: null,
  };
  const stack = [longStack, searchTree].find((s) => s.some((p) => p.ref.number === number));
  if (stack) {
    base.stack = stack.map((p) => ({
      ref: p.ref,
      title: p.title,
      branch: p.branch,
      base: p.base,
      state: p.state,
      reviewDecision: p.reviewDecision,
      checks: p.checks,
      blockers: blockersFor(p),
      isCurrent: p.ref.number === number,
    }));
  }

  if (number === 101) {
    return {
      ...base,
      bodyHtml: BODY,
      stack: [
        { ref: { kind: "pr", number: 101 }, title: "Rate limit the public API", branch: "api/rate-limit", base: "main", state: "open", reviewDecision: "review_required", isCurrent: true },
        { ref: { kind: "pr", number: 102 }, title: "Expose rate-limit headers to clients", branch: "api/rate-limit-headers", base: "api/rate-limit", state: "open", reviewDecision: "review_required", isCurrent: false },
      ],
      timeline: [
        commit("a1b2c3d", "Add the token bucket", 400),
        commit("b2c3d4e", "Wire the limiter into the router", 390),
        commit("c3d4e5f", "Return 429 with headers", 380),
        commit("d4e5f6a", "Tests for the limiter", 370),
        { id: "comment-1", kind: "comment", author: person("dave"), createdAt: ago(300), bodyHtml: "<p>Should the free plan really be 60/min? Our mobile app polls every 2s.</p>", url: "https://github.com/acme/web/pull/101#c1" },
        { id: "review-1", kind: "review", author: person("erin"), createdAt: ago(240), bodyHtml: "<p>The bucket refills too eagerly; see inline.</p>", reviewState: "changes_requested", url: "https://github.com/acme/web/pull/101#r1", inlineCount: 1 },
        commit("e5f6a7b", "Refill per window, not per request", 200),
        { id: "review-2", kind: "review", author: person("frank"), createdAt: ago(120), bodyHtml: null, reviewState: "approved", url: "https://github.com/acme/web/pull/101#r2", inlineCount: 0 },
        { id: "review-3", kind: "review", author: person("grace"), createdAt: ago(60), bodyHtml: "<p>Looks good, one nit.</p>", reviewState: "commented", url: "https://github.com/acme/web/pull/101#r3", inlineCount: 1 },
      ],
      inlineComments: [
        { id: 9001, path: "src/api/limit.ts", line: 23, side: "RIGHT", author: person("erin"), createdAt: ago(240), bodyHtml: "<p>This refills on every request. Should be per window.</p>", inReplyTo: null, url: "https://github.com/acme/web/pull/101#d1" },
        { id: 9002, path: "src/api/limit.ts", line: 23, side: "RIGHT", author: person("alice"), createdAt: ago(200), bodyHtml: "<p>Fixed in e5f6a7b.</p>", inReplyTo: 9001, url: "https://github.com/acme/web/pull/101#d2" },
        { id: 9003, path: "src/api/limit.ts", line: 22, side: "LEFT", author: person("grace"), createdAt: ago(60), bodyHtml: "<p>Nit: keep the old name in a comment?</p>", inReplyTo: null, url: "https://github.com/acme/web/pull/101#d3" },
      ],
      checks: [
        { name: "typecheck", jobId: 7001, state: "failure", summary: "2 errors in src/api/limit.ts", url: "https://example.com/ci/1", durationSeconds: 42 },
        { name: "e2e (chrome)", jobId: 7002, state: "pending", summary: null, url: "https://example.com/ci/2", durationSeconds: null },
        { name: "unit tests", jobId: 7003, state: "success", summary: "214 passed", url: "https://example.com/ci/3", durationSeconds: 95 },
        { name: "lint", jobId: 7004, state: "success", summary: null, url: "https://example.com/ci/4", durationSeconds: 18 },
        { name: "preview deploy", jobId: null, state: "neutral", summary: "Skipped", url: null, durationSeconds: null },
      ],
      checksSummary: checks("failure", 3, 1, 1),
      reviewers: [
        { person: VIEWER, state: "requested" },
        { person: person("frank"), state: "approved" },
        { person: person("erin"), state: "changes_requested" },
        { person: person("grace"), state: "commented" },
        { person: { login: "platform-team", avatarUrl: null }, state: "requested", isTeam: true },
      ],
      labels: [
        { name: "api", color: "1d76db" },
        { name: "security", color: "b60205" },
        { name: "needs-docs", color: "fbca04" },
        { name: "light", color: "ededed" },
      ],
      assignees: [person("alice"), person("bob")],
      files,
    };
  }
  if (number === 110) return { ...base, bodyHtml: null, files: [files[0]], timeline: [], checks: [], checksSummary: null, reviewers: [{ person: person("frank"), state: "approved" }] };
  // A big repo's CI: dozens of checks, most passing or skipped.
  if (number === 131) {
    const many = [
      { name: "typescript / TypeScript apps check", state: "failure", summary: "3 errors", url: null, durationSeconds: 138, jobId: 8001 },
      ...["e2e / chrome", "e2e / safari"].map((name, i) => ({ name, state: "pending", summary: null, url: null, durationSeconds: null, jobId: 8100 + i })),
      ...Array.from({ length: 18 }, (_, i) => ({ name: `conventions / check ${i + 1}`, state: "success", summary: null, url: null, durationSeconds: 8 + i, jobId: 8200 + i })),
      ...Array.from({ length: 26 }, (_, i) => ({ name: `deploy / preview ${i + 1}`, state: "neutral", summary: "Skipped", url: null, durationSeconds: null, jobId: null })),
    ];
    return { ...base, checks: many, checksSummary: { state: "failure", total: 47, passed: 18, failed: 1, pending: 2 } };
  }
  if (number === 113) return { ...base, bodyHtml: "<p>Mechanical upgrade.</p>", files: [files[5], files[6]] };
  return base;
}

export function branchDetail(name) {
  const item = inbox.groups.flatMap((g) => g.items).find((i) => i.ref.kind === "branch" && i.ref.name === name);
  if (!item) return null;
  return {
    ref: item.ref,
    title: item.title,
    number: null,
    url: null,
    state: "local",
    author: item.author,
    branch: name,
    base: item.base,
    headSha: `local-${name}`,
    baseSha: "main",
    createdAt: ago(60),
    updatedAt: item.updatedAt,
    bodyHtml: null,
    additions: item.additions,
    deletions: item.deletions,
    stack:
      name.startsWith("spike/")
        ? [
            { ref: { kind: "branch", name: "spike/parser" }, title: "Try a hand-written parser", branch: "spike/parser", base: "main", state: "local", reviewDecision: null, isCurrent: name === "spike/parser" },
            { ref: { kind: "branch", name: "spike/parser-errors" }, title: "Better parser errors", branch: "spike/parser-errors", base: "spike/parser", state: "local", reviewDecision: null, isCurrent: name === "spike/parser-errors" },
          ]
        : [],
    timeline: name === "wip" ? [] : [commit("f00ba12", "Parse expressions by hand", 50), commit("f00ba13", "Error recovery", 20)],
    inlineComments: [],
    checks: [],
    checksSummary: null,
    reviewers: [],
    labels: [],
    assignees: [],
    mergeable: null,
    mergeableState: null,
    reviewDecision: null,
    files: name === "wip" ? [] : [files[1], files[6]],
    local: item.local,
    can: { review: false, comment: false, merge: false },
  };
}

/** Who a PR can be assigned to or reviewed by, and the repository's labels. */
export const options = {
  people: ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "you"].map((login) => ({ login, avatarUrl: null })),
  labels: [
    { name: "api", color: "1d76db", description: "Public API" },
    { name: "security", color: "b60205", description: null },
    { name: "needs-docs", color: "fbca04", description: null },
    { name: "light", color: "ededed", description: null },
    { name: "ui", color: "c5def5", description: null },
  ],
};
