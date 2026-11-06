import { describe, expect, it } from "vitest";
import { Octokit } from "@octokit/rest";
import { createGitHubClient, parseGitRemote } from "../src/client.js";
import { PROperations } from "../src/pr.js";
import { PileGitHubError, isGraphQLUnavailable, parsePRNumber } from "../src/errors.js";
import { blockingReasons } from "../src/merge-rules.js";

type Handler = (url: URL, init: RequestInit) => { status?: number; body: unknown } | undefined;

/** PROperations backed by a fake fetch. Records every request as "METHOD /path". */
function fakeGitHub(handler: Handler) {
  const requests: string[] = [];
  const octokit = new Octokit({
    auth: "token",
    request: {
      fetch: async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        requests.push(`${init.method ?? "GET"} ${url.pathname}`);
        const response = handler(url, init) ?? { status: 404, body: { message: "Not Found" } };
        return new Response(JSON.stringify(response.body), {
          status: response.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  const client = createGitHubClient({ token: "token", owner: "o", repo: "r", octokit });
  return { prs: new PROperations(client), requests };
}

const rawPR = (number: number, ref = `branch-${number}`) => ({
  number,
  node_id: `PR_${number}`,
  title: `PR ${number}`,
  body: null,
  state: "open",
  draft: false,
  head: { ref, sha: `sha${number}` },
  base: { ref: "main", sha: "base" },
  html_url: `https://github.com/o/r/pull/${number}`,
  merged_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  user: { login: "me" },
});

describe("parseGitRemote", () => {
  it.each([
    ["git@github.com:owner/repo.git", "owner", "repo"],
    ["git@github.com:owner/repo", "owner", "repo"],
    ["https://github.com/owner/repo.git", "owner", "repo"],
    ["https://github.com/owner/repo", "owner", "repo"],
    ["https://user@github.com/owner/repo.git", "owner", "repo"],
    ["ssh://git@github.com/owner/repo.git", "owner", "repo"],
    ["ssh://git@github.com:22/owner/repo.git", "owner", "repo"],
    ["https://github.com/owner/repo.with.dots.git\n", "owner", "repo.with.dots"],
  ])("parses %s", (url, owner, repo) => {
    expect(parseGitRemote(url)).toEqual({ owner, repo });
  });

  it("rejects non-GitHub remotes", () => {
    expect(parseGitRemote("git@gitlab.com:owner/repo.git")).toBeNull();
    expect(parseGitRemote("/tmp/repo.git")).toBeNull();
  });
});

describe("parsePRNumber", () => {
  it("accepts numbers, #numbers and PR URLs", () => {
    expect(parsePRNumber("42")).toBe(42);
    expect(parsePRNumber("#42")).toBe(42);
    expect(parsePRNumber("https://github.com/o/r/pull/42")).toBe(42);
    expect(parsePRNumber("https://github.com/o/r/pull/42/files")).toBe(42);
  });

  it("treats anything else as a branch name", () => {
    expect(parsePRNumber("feature/42")).toBeNull();
    expect(parsePRNumber("42-fix")).toBeNull();
  });
});

describe("PROperations", () => {
  it("fetches reviews, check runs and commit statuses in parallel and combines them", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { prs } = fakeGitHub((url) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => inFlight--, 0);
      if (url.pathname === "/repos/o/r/pulls/7") return { body: rawPR(7) };
      if (url.pathname === "/repos/o/r/pulls/7/reviews") {
        return { body: [{ id: 1, user: { login: "rev" }, state: "APPROVED", submitted_at: "2026-01-02T00:00:00Z" }] };
      }
      if (url.pathname === "/repos/o/r/commits/sha7/check-runs") {
        return {
          body: {
            total_count: 3,
            check_runs: [
              { status: "completed", conclusion: "success" },
              { status: "completed", conclusion: "skipped" },
              { status: "in_progress", conclusion: null },
            ],
          },
        };
      }
      if (url.pathname === "/repos/o/r/commits/sha7/status") {
        return { body: { state: "failure", statuses: [{ state: "failure" }] } };
      }
      return undefined;
    });

    const pr = await prs.getEnriched(7);
    expect(pr.reviews.map((r) => r.state)).toEqual(["APPROVED"]);
    expect(pr.checks).toEqual({ state: "pending", total: 4, passed: 2, failed: 1, pending: 1 });
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it("resolves numbers, URLs and branches to a PR", async () => {
    const { prs, requests } = fakeGitHub((url) => {
      if (url.pathname === "/repos/o/r/pulls/5") return { body: rawPR(5) };
      if (url.pathname === "/repos/o/r/pulls" && url.searchParams.get("head") === "o:feature") {
        return { body: url.searchParams.get("state") === "open" ? [] : [rawPR(9, "feature")] };
      }
      return undefined;
    });

    expect((await prs.resolve("#5")).number).toBe(5);
    expect((await prs.resolve("https://github.com/o/r/pull/5")).number).toBe(5);
    expect((await prs.resolve("feature")).number).toBe(9);
    expect(requests.filter((r) => r === "GET /repos/o/r/pulls")).toHaveLength(2);
  });

  it("reports a missing PR with a stable code", async () => {
    const { prs } = fakeGitHub((url) => (url.pathname === "/repos/o/r/pulls" ? { body: [] } : undefined));
    await expect(prs.resolve("nope")).rejects.toMatchObject({ code: "PR_NOT_FOUND" });
  });

  it("maps a blocked GraphQL endpoint to GRAPHQL_UNAVAILABLE", async () => {
    const { prs } = fakeGitHub((url) => {
      if (url.pathname === "/repos/o/r/pulls/3") return { body: rawPR(3) };
      if (url.pathname === "/graphql") {
        return {
          status: 403,
          body: { message: "GitHub GraphQL is not available from Claude Code sessions. Use gh api repos/{owner}/{repo}/..." },
        };
      }
      return undefined;
    });

    const error = await prs.convertToDraft(3).catch((e) => e);
    expect(error).toBeInstanceOf(PileGitHubError);
    expect(error).toMatchObject({ code: "GRAPHQL_UNAVAILABLE" });
    expect(isGraphQLUnavailable(error.cause)).toBe(true);
  });

  it("uses REST only for everyday reads", async () => {
    const { prs, requests } = fakeGitHub((url) => {
      if (url.pathname === "/repos/o/r/pulls") return { body: [rawPR(1), rawPR(2)] };
      if (url.pathname.endsWith("/reviews")) return { body: [] };
      if (url.pathname.endsWith("/check-runs")) return { body: { total_count: 0, check_runs: [] } };
      if (url.pathname.endsWith("/status")) return { body: { state: "pending", statuses: [] } };
      return undefined;
    });

    await prs.listOpenEnriched();
    expect(requests.some((r) => r.includes("graphql"))).toBe(false);
  });
});

describe("async merge (native stacks)", () => {
  const asyncBody = (status: string, details: object = {}) => ({ status, details });

  it("polls until GitHub reports the merge", async () => {
    let polls = 0;
    const { prs, requests } = fakeGitHub((url, init) => {
      if (url.pathname === "/repos/o/r/pulls/5/merge-async" && init.method === "PUT") {
        expect(JSON.parse(String(init.body))).toMatchObject({ merge_method: "squash", sha: "abc" });
        return { status: 202, body: asyncBody("pending", { uuid: "u1" }) };
      }
      if (url.pathname === "/repos/o/r/pulls/5/merge-async/u1") {
        polls++;
        return { body: polls < 2 ? asyncBody("pending", { uuid: "u1" }) : asyncBody("merged", { sha: "m1" }) };
      }
      return undefined;
    });

    const seen: string[] = [];
    const result = await prs.mergeAsyncAndWait(5, "squash", { sha: "abc", intervalMs: 1, onPoll: (r) => seen.push(r.status) });
    expect(result).toMatchObject({ status: "merged", sha: "m1" });
    expect(polls).toBe(2);
    expect(seen).toEqual(["pending", "pending"]);
    expect(requests.filter((r) => r.startsWith("PUT"))).toHaveLength(1);
  });

  it("reports a merge queue entry as enqueued", async () => {
    const { prs } = fakeGitHub((url) =>
      url.pathname === "/repos/o/r/pulls/5/merge-async" ? { status: 202, body: asyncBody("enqueued") } : undefined,
    );
    expect((await prs.mergeAsyncAndWait(5)).status).toBe("enqueued");
  });

  it("turns a failed merge into MERGE_FAILED", async () => {
    const { prs } = fakeGitHub((url) =>
      url.pathname === "/repos/o/r/pulls/5/merge-async"
        ? { status: 202, body: asyncBody("failed", { message: "Head branch was modified" }) }
        : undefined,
    );
    await expect(prs.mergeAsyncAndWait(5)).rejects.toMatchObject({ code: "MERGE_FAILED", message: expect.stringContaining("Head branch was modified") });
  });

  it("maps 409 to MERGE_IN_PROGRESS and 400 to MERGE_REJECTED", async () => {
    const busy = fakeGitHub(() => ({ status: 409, body: { message: "A merge request is already pending" } }));
    await expect(busy.prs.mergeAsync(5)).rejects.toMatchObject({ code: "MERGE_IN_PROGRESS" });
    const draft = fakeGitHub(() => ({ status: 400, body: { message: "Pull request is in draft state" } }));
    await expect(draft.prs.mergeAsync(5)).rejects.toMatchObject({ code: "MERGE_REJECTED" });
  });

  it("gives up after the timeout with MERGE_PENDING", async () => {
    const { prs } = fakeGitHub((url) =>
      url.pathname.startsWith("/repos/o/r/pulls/5/merge-async")
        ? { status: 202, body: asyncBody("pending", { uuid: "u1" }) }
        : undefined,
    );
    await expect(prs.mergeAsyncAndWait(5, "squash", { timeoutMs: 5, intervalMs: 2 })).rejects.toMatchObject({ code: "MERGE_PENDING" });
  });

  it("falls back to the async endpoint when GitHub refuses a classic merge for a stacked PR", async () => {
    const { prs, requests } = fakeGitHub((url) => {
      if (url.pathname === "/repos/o/r/pulls/5/merge") {
        return {
          status: 403,
          body: { message: "Merging stacked PRs via this endpoint is not supported. Use the asynchronous merge endpoint instead." },
        };
      }
      if (url.pathname === "/repos/o/r/pulls/5/merge-async") return { status: 202, body: asyncBody("merged") };
      return undefined;
    });
    await prs.merge(5, "squash");
    expect(requests).toEqual(["PUT /repos/o/r/pulls/5/merge", "PUT /repos/o/r/pulls/5/merge-async"]);
  });

  it("does not fall back for other 403s", async () => {
    const { prs } = fakeGitHub(() => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
    await expect(prs.merge(5)).rejects.toMatchObject({ status: 403 });
  });

  it("maps stack membership from the PR payload", async () => {
    const { prs } = fakeGitHub((url) =>
      url.pathname === "/repos/o/r/pulls/7"
        ? { body: { ...rawPR(7), stack: { number: 21, position: 3, size: 5, base: { ref: "main", sha: "x" } } } }
        : undefined,
    );
    expect((await prs.get(7)).stack).toEqual({ number: 21, position: 3, size: 5, base: "main" });
  });

  it("lists the merged PRs of a stack", async () => {
    const { prs } = fakeGitHub((url) =>
      url.pathname === "/repos/o/r/stacks/21"
        ? {
            body: {
              number: 21,
              pull_requests: [
                { number: 1, merged_at: "2026-01-01T00:00:00Z", head: { ref: "a" } },
                { number: 2, merged_at: "2026-01-01T00:00:00Z", head: { ref: "b" } },
                { number: 3, merged_at: null, head: { ref: "c" } },
              ],
            },
          }
        : undefined,
    );
    expect(await prs.getMergedInStack(21)).toEqual([
      { number: 1, branch: "a" },
      { number: 2, branch: "b" },
    ]);
  });
});

describe("createOctokit logging", () => {
  it("drops Octokit's per-request lines (304s from the ETag cache) and keeps other errors", async () => {
    const { createOctokit } = await import("../src/client.js");
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      const octokit = createOctokit("token");
      octokit.log.error("GET /repos/o/r/pulls/1/files?per_page=100 - 304 with id CC14:1618C7 in 361ms");
      octokit.log.error("Something else broke");
    } finally {
      console.error = original;
    }
    expect(errors).toEqual(["Something else broke"]);
  });
});

describe("blockingReasons", () => {
  const clean = { draft: false, checks: { state: "success", total: 1, failed: 0, pending: 0 }, changesRequested: false, mergeable: true, mergeableState: "clean" };

  it("treats GitHub's blocked as blocking even without conflicts", () => {
    expect(blockingReasons({ ...clean, mergeableState: "blocked" }).map((r) => r.message)).toEqual(["Blocked by branch protection rules"]);
    expect(blockingReasons({ ...clean, mergeableState: "blocked", reviewRequired: true }).map((r) => r.message)).toEqual(["Needs an approving review"]);
    expect(blockingReasons(clean)).toEqual([]);
  });
});

