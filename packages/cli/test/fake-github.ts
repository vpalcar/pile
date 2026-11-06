import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { GitHubInstance } from "@pile/github";

/**
 * An in-memory GitHub with the read endpoints the review server uses. It answers
 * with ETags and honours If-None-Match with 304s, like GitHub, so tests can count
 * how many requests a scenario costs against the rate limit.
 */
export interface FakePR {
  number: number;
  head: string;
  base: string;
  sha: string;
  updatedAt: string;
  author: string;
  requested: string[];
  checks: Array<{ name: string; status: "completed" | "in_progress"; conclusion: string | null }>;
}

export function fakeGitHub(options: { prs: number; viewer?: string; trunk?: string; graphql?: boolean }) {
  const graphqlEnabled = options.graphql ?? true;
  const viewer = options.viewer ?? "me";
  const trunk = options.trunk ?? "main";
  const prs: FakePR[] = Array.from({ length: options.prs }, (_, i) => {
    const number = i + 1;
    // Every fifth PR starts a stack of three.
    const stacked = i % 5 === 1 || i % 5 === 2;
    return {
      number,
      head: `feature/${number}`,
      base: stacked ? `feature/${number - 1}` : trunk,
      sha: `sha${number}`.padEnd(40, "0"),
      updatedAt: new Date(Date.UTC(2026, 10, 1, 0, number)).toISOString(),
      author: i % 3 === 0 ? viewer : `dev${i % 4}`,
      requested: i % 4 === 0 ? [viewer] : [],
      checks: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "test", status: i % 7 === 0 ? "in_progress" : "completed", conclusion: i % 7 === 0 ? null : "success" },
      ],
    };
  });

  const user = (login: string) => ({ login, avatar_url: `https://avatars/${login}` });
  const pr = (p: FakePR, full = false) => ({
    number: p.number,
    title: `PR ${p.number}`,
    state: "open",
    draft: false,
    merged_at: null,
    user: user(p.author),
    head: { ref: p.head, sha: p.sha },
    base: { ref: p.base, sha: "base".padEnd(40, "0"), repo: { default_branch: trunk } },
    requested_reviewers: p.requested.map(user),
    requested_teams: [],
    labels: [],
    assignees: [],
    updated_at: p.updatedAt,
    created_at: p.updatedAt,
    html_url: `https://github.com/o/r/pull/${p.number}`,
    ...(full ? { additions: 10, deletions: 2, comments: 0, review_comments: 0, body_html: "", mergeable: true, mergeable_state: "clean", stack: null } : {}),
  });

  const routes: Array<[RegExp, (m: RegExpMatchArray, url: URL) => unknown]> = [
    [/^\/user$/, () => user(viewer)],
    [/^\/repos\/o\/r\/pulls$/, (_m, url) => {
      const page = Number(url.searchParams.get("page") ?? 1);
      const size = Number(url.searchParams.get("per_page") ?? 30);
      return prs.slice((page - 1) * size, page * size).map((p) => pr(p));
    }],
    [/^\/repos\/o\/r\/pulls\/(\d+)$/, (m) => pr(prs[Number(m[1]) - 1], true)],
    [/^\/repos\/o\/r\/pulls\/(\d+)\/(reviews|files|comments|commits)$/, () => []],
    [/^\/repos\/o\/r\/issues\/(\d+)\/comments$/, () => []],
    [/^\/repos\/o\/r\/commits\/([^/]+)\/check-runs$/, (m) => {
      const p = prs.find((x) => x.sha === m[1]);
      return { total_count: p?.checks.length ?? 0, check_runs: (p?.checks ?? []).map((c, i) => ({ id: i + 1, name: c.name, status: c.status, conclusion: c.conclusion, started_at: null, completed_at: null, output: { title: null }, html_url: null, details_url: null, app: { slug: "github-actions" } })) };
    }],
    [/^\/repos\/o\/r\/commits\/([^/]+)\/status$/, () => ({ state: "success", statuses: [] })],
  ];

  // GraphQL: the two queries the review server sends, answered from the same repo.
  let points = 5000;
  const gqlUser = (login: string) => ({ login, avatarUrl: `https://avatars/${login}` });
  const counts = (p: FakePR) => {
    const by = new Map<string, number>();
    for (const c of p.checks) {
      const state = c.status === "completed" ? (c.conclusion ?? "success").toUpperCase() : "IN_PROGRESS";
      by.set(state, (by.get(state) ?? 0) + 1);
    }
    return [...by].map(([state, count]) => ({ state, count }));
  };
  const node = (p: FakePR) => ({
    number: p.number,
    title: `PR ${p.number}`,
    url: `https://github.com/o/r/pull/${p.number}`,
    isDraft: false,
    createdAt: p.updatedAt,
    updatedAt: p.updatedAt,
    additions: 10,
    deletions: 2,
    totalCommentsCount: 0,
    headRefName: p.head,
    headRefOid: p.sha,
    baseRefName: p.base,
    baseRefOid: "base".padEnd(40, "0"),
    author: gqlUser(p.author),
    reviewRequests: { nodes: p.requested.map((l) => ({ requestedReviewer: { __typename: "User", ...gqlUser(l) } })) },
    latestReviews: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: counts(p), statusContextCountsByState: [] } } } }] },
  });
  const graphql = (query: string, variables: Record<string, unknown>) => {
    points--;
    const rateLimit = { cost: 1, remaining: points, limit: 5000, resetAt: "2033-05-18T03:33:20Z" };
    if (query.includes("query PileInbox")) {
      return { data: { viewer: gqlUser(viewer), rateLimit, repository: { defaultBranchRef: { name: trunk }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: prs.map(node) } } } };
    }
    const p = prs[Number(variables.number) - 1];
    if (!p) return { data: { rateLimit, repository: { defaultBranchRef: { name: trunk }, pullRequest: null } } };
    return {
      data: {
        rateLimit,
        repository: {
          defaultBranchRef: { name: trunk },
          pullRequest: {
            ...node(p),
            state: "OPEN",
            merged: false,
            mergedAt: null,
            bodyHTML: "",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            labels: { nodes: [] },
            assignees: { nodes: [] },
            reviews: { nodes: [] },
            comments: { nodes: [] },
            commits: { nodes: [] },
            reviewThreads: { nodes: [] },
            lastCommit: {
              nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: p.checks.map((c, i) => ({ __typename: "CheckRun", databaseId: i + 1, name: c.name, status: c.status.toUpperCase(), conclusion: c.conclusion?.toUpperCase() ?? null, startedAt: null, completedAt: null, detailsUrl: null, url: null, title: null, checkSuite: { app: { slug: "github-actions" } } })) } } } }],
            },
          },
        },
      },
    };
  };

  let remaining = 5000;
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      if (!graphqlEnabled) return new Response(JSON.stringify({ message: "GraphQL is blocked here" }), { status: 403, headers: { "content-type": "application/json" } });
      const { query, variables } = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(graphql(query, variables)), { status: 200, headers: { "content-type": "application/json" } });
    }
    const route = routes.find(([re]) => re.test(url.pathname));
    if (!route) return new Response(JSON.stringify({ message: `Not faked: ${url.pathname}` }), { status: 404 });
    const body = JSON.stringify(route[1](url.pathname.match(route[0])!, url));
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    const headers = new Headers(init?.headers);
    const notModified = headers.get("if-none-match") === etag;
    if (!notModified) remaining--;
    const rate = { "x-ratelimit-remaining": String(remaining), "x-ratelimit-limit": "5000", "x-ratelimit-reset": "2000000000", "x-ratelimit-resource": "core" };
    if (notModified) return new Response(null, { status: 304, headers: { etag, ...rate } });
    return new Response(body, { status: 200, headers: { "content-type": "application/json", etag, ...rate } });
  };

  /**
   * Time passing in a busy repo: running checks report progress (their responses
   * change) and one PR gets a new push.
   */
  let ticks = 0;
  const tick = () => {
    ticks++;
    for (const p of prs) for (const c of p.checks) if (c.status === "in_progress") c.name = c.name.replace(/ \(\d+\)$/, "") + ` (${ticks})`;
    const pushed = prs[ticks % prs.length];
    pushed.sha = `sha${pushed.number}t${ticks}`.padEnd(40, "0");
    pushed.updatedAt = new Date(Date.parse(pushed.updatedAt) + 60_000).toISOString();
  };

  /** A fresh client on the same repo, like a new `pile review` process. */
  const client = () => {
    const octokit = new Octokit({ request: { fetch } });
    return { client: { api: octokit, repoOwner: "o", repoName: "r" }, prs: {} } as unknown as GitHubInstance;
  };
  const github = client();
  return { github, client, prs, tick };
}
