import type { Octokit } from "@octokit/rest";
import type { ChecksSummary, InlineComment } from "@pile/review-web/api";
import { recordGraphQL, mapChecks, type Repo } from "./github-data.js";

/**
 * The review app's reads over GraphQL: one query for the whole inbox and one per PR
 * page, instead of several REST requests per PR. GraphQL has its own hourly budget
 * (5,000 points) and these queries cost a point or two each. The results are turned
 * into the REST shapes the rest of the review code already maps, so both paths share
 * one set of logic (and REST remains the fallback where GraphQL is unavailable).
 */

const USER = "login avatarUrl";
const REQUESTED = `reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { ${USER} } ... on Team { slug name } } } }`;
const RATE = "rateLimit { cost remaining limit resetAt }";

/**
 * The inbox is two searches, not a list of every open PR: yours and those asking for
 * your review. In two passes: the fast one (titles, branches, review requests and
 * reviews: about a second even on very large repos), then the same PRs with sizes and
 * check counts, which GitHub computes on the fly and are several times slower.
 */
const PR_FAST = `number title url isDraft createdAt updatedAt totalCommentsCount reviewDecision
  headRefName headRefOid baseRefName baseRefOid
  author { ${USER} }
  ${REQUESTED}
  latestReviews(first: 30) { nodes { author { ${USER} } state submittedAt } }
  latestOpinionatedReviews(first: 30) { nodes { author { ${USER} } state submittedAt } }`;
const CHECK_COUNTS = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 1) {
    checkRunCountsByState { state count }
    statusContextCountsByState { state count }
  } } } } }`;
const PR_SLOW = `number additions deletions ${CHECK_COUNTS}`;

const inboxQuery = (fields: string) => `query PileInbox($owner: String!, $name: String!, $mine: String!, $review: String!) {
  viewer { ${USER} }
  ${RATE}
  repository(owner: $owner, name: $name) { defaultBranchRef { name } pullRequests(states: OPEN) { totalCount } }
  mine: search(query: $mine, type: ISSUE, first: 100) { nodes { ... on PullRequest { ${fields} } } }
  review: search(query: $review, type: ISSUE, first: 100) { nodes { ... on PullRequest { ${fields} } } }
}`;

const SEARCH = `query PileSearch($q: String!) {
  ${RATE}
  search(query: $q, type: ISSUE, first: 25) { nodes { ... on PullRequest { ${PR_FAST} } } }
}`;

const PR = `query PilePR($owner: String!, $name: String!, $number: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      number title url state isDraft merged mergedAt createdAt updatedAt body bodyHTML additions deletions viewerCanUpdate
      headRefName headRefOid baseRefName baseRefOid mergeable mergeStateStatus reviewDecision
      author { ${USER} }
      labels(first: 30) { nodes { name color description } }
      assignees(first: 20) { nodes { ${USER} } }
      ${REQUESTED}
      reviews(first: 100) { nodes { databaseId author { ${USER} } state submittedAt bodyHTML url } }
      comments(first: 100) { nodes { databaseId author { ${USER} } createdAt bodyHTML url } }
      commits(first: 100) { nodes { commit { oid message url committedDate authoredDate author { name user { ${USER} } } } } }
      reviewThreads(first: 100) { nodes { path diffSide line originalLine isResolved
        comments(first: 50) { nodes { databaseId author { ${USER} } createdAt bodyHTML url replyTo { databaseId } pullRequestReview { databaseId } } }
      } }
      lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion startedAt completedAt detailsUrl url title checkSuite { app { slug } } }
        ... on StatusContext { context state description targetUrl }
      } } } } } }
    }
  }
}`;

type User = { login: string; avatarUrl: string | null } | null;
type Requested = { nodes: Array<{ requestedReviewer: ({ __typename: "User" } & NonNullable<User>) | { __typename: "Team"; slug: string; name: string } | null }> };
type Review = { author: User; state: string; submittedAt: string | null };
type Counts = Array<{ state: string; count: number }>;

export interface InboxNode {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  additions?: number;
  deletions?: number;
  totalCommentsCount: number | null;
  /** GitHub's verdict under the base branch's rules; null where no review is required. */
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  author: User;
  reviewRequests: Requested;
  latestReviews: { nodes: Review[] };
  latestOpinionatedReviews: { nodes: Review[] };
  /** Only in the second, slower pass. */
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: Counts | null; statusContextCountsByState: Counts | null } } | null } }> };
}

const restUser = (u: User) => (u ? { login: u.login, avatar_url: u.avatarUrl ?? undefined } : null);

/** GraphQL errors come back as data with `errors`; Octokit throws them as one error. */
async function query<T>(octokit: Octokit, text: string, variables: Record<string, unknown>): Promise<T> {
  const data = await octokit.graphql<T & { rateLimit?: { cost: number; remaining: number; limit: number; resetAt: string } }>(text, variables);
  recordGraphQL(octokit, data.rateLimit);
  return data;
}

/**
 * Your open PRs and those requesting your review, from GitHub's search (`@me` is
 * the token's user). `full` adds sizes and check counts: the slow fields.
 */
export async function fetchInboxGraphQL(octokit: Octokit, repo: Repo, { full = false } = {}) {
  const scope = `repo:${repo.owner}/${repo.repo} is:pr is:open`;
  const data: {
    viewer: User;
    repository: { defaultBranchRef: { name: string } | null; pullRequests: { totalCount: number } };
    mine: { nodes: InboxNode[] };
    review: { nodes: InboxNode[] };
  } = await query(octokit, inboxQuery(full ? `${PR_FAST} ${PR_SLOW}` : PR_FAST), {
    owner: repo.owner,
    name: repo.repo,
    mine: `${scope} author:@me`,
    review: `${scope} review-requested:@me`,
  });
  const nodes = new Map<number, InboxNode>();
  for (const node of [...data.mine.nodes, ...data.review.nodes]) if (node?.number) nodes.set(node.number, node);
  return {
    viewer: restUser(data.viewer),
    defaultBranch: data.repository.defaultBranchRef?.name ?? "main",
    nodes: [...nodes.values()],
    // Requested from you or a team you're on (search's review-requested covers both).
    requested: new Set(data.review.nodes.filter((n) => n?.number).map((n) => n.number)),
    // Search can come back empty without an error when the token can't search this
    // repo (SSO not authorized, fine-grained tokens): the caller checks this.
    openInRepo: data.repository.pullRequests.totalCount,
  };
}

/** Open PRs matching `text` (title, body, number, branch or author), across the repo. */
export async function searchPRsGraphQL(octokit: Octokit, repo: Repo, text: string) {
  const scope = `repo:${repo.owner}/${repo.repo} is:pr is:open`;
  const term = text.trim();
  // An author or number search, or words matched in titles and descriptions.
  const q = /^#?\d+$/.test(term) ? `${scope} ${term.replace("#", "")}` : /^@\S+$/.test(term) ? `${scope} author:${term.slice(1)}` : `${scope} ${term}`;
  const data: { search: { nodes: InboxNode[] } } = await query(octokit, SEARCH, { q });
  return data.search.nodes.filter((n) => n?.number);
}

/**
 * Open PRs next to some branches: those based on `heads` (built on them) and those
 * whose head is one of `bases` (what they're built on). The inbox only knows your PRs
 * and your review requests, so a PR page asks for the rest of its stack this way.
 */
export async function stackNeighboursGraphQL(octokit: Octokit, repo: Repo, { heads, bases }: { heads: string[]; bases: string[] }) {
  const vars: Record<string, unknown> = { owner: repo.owner, name: repo.repo };
  const fields: string[] = [];
  heads.forEach((head, i) => {
    vars[`c${i}`] = head;
    fields.push(`c${i}: pullRequests(states: OPEN, baseRefName: $c${i}, first: 20) { nodes { ${PR_FAST} ${CHECK_COUNTS} } }`);
  });
  bases.forEach((base, i) => {
    vars[`p${i}`] = base;
    fields.push(`p${i}: pullRequests(states: OPEN, headRefName: $p${i}, first: 5) { nodes { ${PR_FAST} ${CHECK_COUNTS} } }`);
  });
  const params = Object.keys(vars).filter((k) => k !== "owner" && k !== "name").map((k) => `$${k}: String!`).join(", ");
  const text = `query PileStack($owner: String!, $name: String!, ${params}) {
  ${RATE}
  repository(owner: $owner, name: $name) { defaultBranchRef { name } ${fields.join("\n    ")} }
}`;
  const data: { repository: Record<string, { nodes: InboxNode[] }> & { defaultBranchRef: { name: string } | null } } = await query(octokit, text, vars);
  const pick = (key: string) => (data.repository[key]?.nodes ?? []).filter((n) => n?.number);
  return {
    defaultBranch: data.repository.defaultBranchRef?.name ?? null,
    /** PRs based on each of `heads`. */
    children: new Map(heads.map((head, i) => [head, pick(`c${i}`)])),
    /** The PR whose head is each of `bases`. */
    parents: new Map(bases.map((base, i) => [base, pick(`p${i}`)])),
  };
}

/** Open PRs by number, with reviews and check counts: a native stack's members outside the inbox. */
export async function prsByNumberGraphQL(octokit: Octokit, repo: Repo, numbers: number[]) {
  const fields = numbers.map((n, i) => `p${i}: pullRequest(number: ${Math.trunc(n)}) { ${PR_FAST} ${CHECK_COUNTS} }`);
  const text = `query PileStackPRs($owner: String!, $name: String!) {
  ${RATE}
  repository(owner: $owner, name: $name) { defaultBranchRef { name } ${fields.join("\n    ")} }
}`;
  const data: { repository: Record<string, InboxNode | null> & { defaultBranchRef: { name: string } | null } } = await query(octokit, text, { owner: repo.owner, name: repo.repo });
  return {
    defaultBranch: data.repository.defaultBranchRef?.name ?? null,
    nodes: numbers.map((_, i) => data.repository[`p${i}`] as InboxNode | null).filter((n): n is InboxNode => !!n?.number),
  };
}

const requestedUsers = (r: Requested) =>
  r.nodes.flatMap((n) => (n.requestedReviewer?.__typename === "User" ? [restUser(n.requestedReviewer)!] : []));
const requestedTeams = (r: Requested) =>
  r.nodes.flatMap((n) => (n.requestedReviewer?.__typename === "Team" ? [{ slug: n.requestedReviewer.slug, name: n.requestedReviewer.name }] : []));

/** A PR from the inbox query in the shape of a REST `pulls.list` item. */
export function listedFromNode(node: InboxNode, defaultBranch: string) {
  return {
    number: node.number,
    title: node.title,
    state: "open",
    draft: node.isDraft,
    merged_at: null,
    user: restUser(node.author),
    head: { ref: node.headRefName, sha: node.headRefOid },
    base: { ref: node.baseRefName, sha: node.baseRefOid, repo: { default_branch: defaultBranch } },
    requested_reviewers: requestedUsers(node.reviewRequests),
    requested_teams: requestedTeams(node.reviewRequests),
    updated_at: node.updatedAt,
    created_at: node.createdAt,
    html_url: node.url,
    labels: [],
    assignees: [],
    review_decision: node.reviewDecision ?? null,
  };
}

/** Each reviewer's latest reviews, in the REST shape `latestReviews` reads (oldest first). */
export function reviewsFromNode(node: Pick<InboxNode, "latestReviews" | "latestOpinionatedReviews">) {
  const all = [...node.latestOpinionatedReviews.nodes, ...node.latestReviews.nodes];
  return all
    .map((r) => ({ user: restUser(r.author), state: r.state, submitted_at: r.submittedAt }))
    .sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""));
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE", "ERROR"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"]);

/** The check summary from the rollup's counts, without listing the checks. */
export function checksFromNode(node: InboxNode): ChecksSummary | null {
  if (!node.commits) return null; // the fast pass doesn't have them yet
  const contexts = node.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
  const counts = [...(contexts?.checkRunCountsByState ?? []), ...(contexts?.statusContextCountsByState ?? [])];
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const { state, count } of counts) {
    if (FAILED.has(state)) failed += count;
    else if (PASSED.has(state)) passed += count;
    else pending += count;
  }
  const total = passed + failed + pending;
  return { state: total === 0 ? "none" : failed ? "failure" : pending ? "pending" : "success", total, passed, failed, pending };
}

type PRData = {
  repository: {
    defaultBranchRef: { name: string } | null;
    pullRequest: null | {
      number: number;
      title: string;
      url: string;
      state: "OPEN" | "CLOSED" | "MERGED";
      isDraft: boolean;
      merged: boolean;
      mergedAt: string | null;
      createdAt: string;
      updatedAt: string;
      body: string;
      bodyHTML: string;
      viewerCanUpdate: boolean;
      additions: number;
      deletions: number;
      headRefName: string;
      headRefOid: string;
      baseRefName: string;
      baseRefOid: string;
      mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
      mergeStateStatus: string;
      reviewDecision: string | null;
      author: User;
      labels: { nodes: Array<{ name: string; color: string; description: string | null }> };
      assignees: { nodes: NonNullable<User>[] };
      reviewRequests: Requested;
      reviews: { nodes: Array<{ databaseId: number; author: User; state: string; submittedAt: string | null; bodyHTML: string; url: string }> };
      comments: { nodes: Array<{ databaseId: number; author: User; createdAt: string; bodyHTML: string; url: string }> };
      commits: { nodes: Array<{ commit: { oid: string; message: string; url: string; committedDate: string; authoredDate: string; author: { name: string | null; user: User } | null } }> };
      reviewThreads: {
        nodes: Array<{
          path: string;
          isResolved: boolean;
          diffSide: "LEFT" | "RIGHT";
          line: number | null;
          originalLine: number | null;
          comments: { nodes: Array<{ databaseId: number; author: User; createdAt: string; bodyHTML: string; url: string; replyTo: { databaseId: number } | null; pullRequestReview: { databaseId: number } | null }> };
        }>;
      };
      lastCommit: {
        nodes: Array<{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: Array<
                  | { __typename: "CheckRun"; databaseId: number; name: string; status: string; conclusion: string | null; startedAt: string | null; completedAt: string | null; detailsUrl: string | null; url: string | null; title: string | null; checkSuite: { app: { slug: string } | null } | null }
                  | { __typename: "StatusContext"; context: string; state: string; description: string | null; targetUrl: string | null }
                >;
              };
            } | null;
          };
        }>;
      };
    };
  };
};

/**
 * Everything on a PR page except its files, in one query, as the REST shapes the
 * PR page is built from: the PR, its reviews, discussion comments, commits, inline
 * comments and checks.
 */
export async function fetchPRGraphQL(octokit: Octokit, repo: Repo, number: number) {
  const data = await query<PRData>(octokit, PR, { owner: repo.owner, name: repo.repo, number });
  const p = data.repository.pullRequest;
  if (!p) return null;
  const defaultBranch = data.repository.defaultBranchRef?.name ?? "main";
  const pr = {
    number: p.number,
    title: p.title,
    html_url: p.url,
    state: p.state === "OPEN" ? "open" : "closed",
    draft: p.isDraft,
    merged_at: p.merged ? (p.mergedAt ?? p.updatedAt) : null,
    user: restUser(p.author),
    head: { ref: p.headRefName, sha: p.headRefOid },
    base: { ref: p.baseRefName, sha: p.baseRefOid, repo: { default_branch: defaultBranch } },
    body: p.body,
    body_html: p.bodyHTML,
    viewer_can_update: p.viewerCanUpdate,
    additions: p.additions,
    deletions: p.deletions,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    mergeable: p.mergeable === "UNKNOWN" ? null : p.mergeable === "MERGEABLE",
    mergeable_state: p.mergeStateStatus.toLowerCase(),
    review_decision: p.reviewDecision,
    labels: p.labels.nodes.map((l) => ({ name: l.name, color: l.color, description: l.description })),
    assignees: p.assignees.nodes.map((a) => restUser(a)!),
    requested_reviewers: requestedUsers(p.reviewRequests),
    requested_teams: requestedTeams(p.reviewRequests),
    comments: 0,
    review_comments: 0,
    stack: null,
  };
  const reviews = p.reviews.nodes.map((r) => ({
    id: r.databaseId,
    user: restUser(r.author),
    state: r.state,
    submitted_at: r.submittedAt,
    body_html: r.bodyHTML,
    html_url: r.url,
  }));
  const comments = p.comments.nodes.map((c) => ({ id: c.databaseId, user: restUser(c.author), created_at: c.createdAt, body_html: c.bodyHTML, html_url: c.url }));
  const commits = p.commits.nodes.map(({ commit: c }) => ({
    sha: c.oid,
    html_url: c.url,
    author: restUser(c.author?.user ?? null),
    commit: { message: c.message, author: { name: c.author?.name ?? null, date: c.authoredDate }, committer: { date: c.committedDate } },
  }));
  const inline: InlineComment[] = p.reviewThreads.nodes.flatMap((t) =>
    t.comments.nodes.map(
      (c) =>
        ({
          id: c.databaseId,
          path: t.path,
          line: t.line ?? t.originalLine ?? null,
          side: t.diffSide ?? "RIGHT",
          author: restUser(c.author) ? { login: c.author!.login, avatarUrl: c.author!.avatarUrl } : null,
          createdAt: c.createdAt,
          bodyHtml: c.bodyHTML,
          inReplyTo: c.replyTo?.databaseId ?? null,
          resolved: t.isResolved,
          url: c.url,
          reviewId: c.pullRequestReview?.databaseId,
        }) as InlineComment,
    ),
  );
  const contexts = p.lastCommit.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const checks = mapChecks(
    contexts.flatMap((c) =>
      c.__typename === "CheckRun"
        ? [
            {
              id: c.databaseId,
              name: c.name,
              status: c.status.toLowerCase(),
              conclusion: c.conclusion?.toLowerCase() ?? null,
              started_at: c.startedAt,
              completed_at: c.completedAt,
              output: { title: c.title },
              html_url: c.url,
              details_url: c.detailsUrl,
              app: c.checkSuite?.app ?? null,
            },
          ]
        : [],
    ),
    contexts.flatMap((c) =>
      c.__typename === "StatusContext" ? [{ context: c.context, state: c.state.toLowerCase(), description: c.description, target_url: c.targetUrl }] : [],
    ),
  );
  return { pr, reviews, comments, commits, inline, checks };
}
