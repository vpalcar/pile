import type { Octokit } from "@octokit/rest";
import { mapLimit, type PileInstance } from "@pile/core";
import { blockingReasons, PileGitHubError, type GitHubInstance } from "@pile/github";
import type {
  Detail,
  FileContent,
  Inbox,
  InboxGroup,
  InboxItem,
  ItemRef,
  MergeInfo,
  MergeRequest,
  MergeResult,
  NewNoteRequest,
  AgentNote,
  PRState,
  PRUpdate,
  RepoOptions,
  RerunRequest,
  ReviewRequest,
  Session,
  StackEntry,
  StackPosition,
} from "@pile/review-web/api";
import {
  apiUsage,
  enableEtagCache,
  fetchChecks,
  fetchFiles,
  fetchInlineComments,
  fetchReviews,
  fetchTimeline,
  fetchTimelineParts,
  latestReviews,
  mapPRs,
  person,
  reviewDecision,
  reviewerStates,
  summarizeChecks,
  type Repo,
} from "./github-data.js";
import { diffStats, localCommits, localFiles, localState } from "./local-data.js";
import { cleanupMergedBranch } from "../utils/merge-cleanup.js";
import { checksFromNode, fetchInboxGraphQL, fetchPRGraphQL, listedFromNode, reviewsFromNode, type InboxNode } from "./github-graphql.js";

type ListedPR = Awaited<ReturnType<Octokit["pulls"]["list"]>>["data"][number];
type FullPR = Awaited<ReturnType<Octokit["pulls"]["get"]>>["data"] & {
  body_html?: string;
  stack?: { number: number; position: number; size: number } | null;
};

export class ReviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Requests budget knobs: see test/rate-budget.test.ts for what they cost. */
const SHARED_READ_MS = 10_000;
const WARM_LIMIT = 8;
const LOW_QUOTA = 300;
const GRAPHQL_RETRY_MS = 10 * 60_000;
/** How long the list of open PRs (one GraphQL query) is shared by the inbox and PR pages. */
const OPEN_PRS_MS = 15_000;
const PENDING_CHECKS_MS = 60_000;
/** How often the inbox is rebuilt from GitHub; much less often when the quota runs low. */
const INBOX_FRESH_MS = 20_000;
const INBOX_FRESH_LOW_QUOTA_MS = 5 * 60_000;

const prState = (pr: { state: string; draft?: boolean; merged_at?: string | null }): PRState =>
  pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";

/**
 * Everything the review app shows, from GitHub (REST) and from local git. Works
 * without GitHub too: then only local branches are listed.
 */
export class ReviewService {
  private readonly octokit: Octokit | null;
  private readonly repo: Repo | null;
  private viewerPromise: Promise<{ login: string; avatar_url: string } | null> | null = null;
  /** GitHub reads shared by the inbox, PR pages and stacks for a few seconds (see `recent`). */
  private recentReads = new Map<string, { at: number; value: Promise<unknown> }>();
  /** Each PR as last enriched for the inbox, so unchanged PRs cost no requests. */
  private enriched = new Map<number, { version: string; item: InboxItem; pending: boolean; at: number }>();
  /** PR pages already warmed, by version, so each is prepared once per change. */
  private warmed = new Map<string, string>();
  private warmedOnce = false;
  /** GraphQL reads (fewer, richer queries); off when unavailable, until `graphqlOffUntil`. */
  private graphqlOffUntil = 0;
  private graphqlOffReason: string | null = null;
  /** The inbox query's PRs, by number: inbox rows and stack entries come from these. */
  private inboxNodes = new Map<number, InboxNode>();
  private graphqlViewer: { login: string; avatar_url: string } | null = null;
  private openPRs: { at: number; prs: Promise<ListedPR[]> } | null = null;
  private memo = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private readonly pile: PileInstance,
    private readonly github: GitHubInstance | null,
    /** Where GitHub responses are cached between runs (.git/pile/review-cache.json). */
    options: { cacheFile?: string; graphql?: boolean } = {},
  ) {
    if (options.graphql === false || process.env.PILE_REVIEW_REST === "1") this.graphqlOffUntil = Infinity;
    this.octokit = github?.client.api ?? null;
    this.repo = github ? { owner: github.client.repoOwner, repo: github.client.repoName } : null;
    if (this.octokit) enableEtagCache(this.octokit, options.cacheFile);
  }

  /** Who you are: from the inbox query when GraphQL is in use, otherwise REST. */
  private viewer(): Promise<{ login: string; avatar_url: string } | null> {
    if (!this.octokit) return Promise.resolve(null);
    if (this.graphql()) return this.listOpenPRs().then(() => this.graphqlViewer ?? this.restViewer());
    return this.restViewer();
  }

  private restViewer() {
    this.viewerPromise ??= this.octokit!.users
      .getAuthenticated()
      .then(({ data }) => ({ login: data.login, avatar_url: data.avatar_url }))
      .catch(() => null);
    return this.viewerPromise;
  }

  /** Open PRs, shared by the inbox and stack lookups for a few seconds. */
  private listOpenPRs(): Promise<ListedPR[]> {
    if (!this.octokit || !this.repo) return Promise.resolve([]);
    if (!this.openPRs || Date.now() - this.openPRs.at > OPEN_PRS_MS) {
      const rest = () => this.octokit!.paginate(this.octokit!.pulls.list, { ...this.repo!, state: "open", per_page: 100 });
      // One GraphQL query brings every open PR with its reviews, checks and size, so
      // inbox rows and stack entries need no further requests.
      const prs = this.graphql()
        ? fetchInboxGraphQL(this.octokit, this.repo).then(
            ({ viewer, defaultBranch, nodes }) => {
              this.inboxNodes = new Map(nodes.map((n) => [n.number, n]));
              if (viewer) this.graphqlViewer = viewer as { login: string; avatar_url: string };
              return nodes.map((n) => listedFromNode(n, defaultBranch) as unknown as ListedPR);
            },
            (error) => {
              this.graphqlFailed(error);
              return rest();
            },
          )
        : rest();
      this.openPRs = { at: Date.now(), prs };
    }
    return this.openPRs.prs;
  }

  /** Whether reads go over GraphQL right now. */
  private graphql(): boolean {
    return Date.now() >= this.graphqlOffUntil;
  }

  /** GraphQL failed (blocked in a sandbox, its own rate limit, an outage): REST for a while. */
  private graphqlFailed(error: unknown): void {
    this.graphqlOffReason = error instanceof Error ? error.message : String(error);
    this.graphqlOffUntil = Date.now() + GRAPHQL_RETRY_MS;
    this.inboxNodes.clear();
  }

  async session(initial: ItemRef | null): Promise<Session> {
    const [viewer, currentBranch] = await Promise.all([this.viewer(), this.pile.git.getCurrentBranch()]);
    return {
      repo: this.repo
        ? {
            owner: this.repo.owner,
            name: this.repo.repo,
            url: `https://github.com/${this.repo.owner}/${this.repo.repo}`,
          }
        : null,
      viewer: person(viewer),
      trunk: this.pile.stack.getTrunk(),
      currentBranch,
      github: !!this.octokit,
      initial,
    };
  }

  // ---------------------------------------------------------------------------
  // Inbox

  /**
   * Serves a recent result immediately (under a minute old) and refreshes it in the
   * background once it is older than `freshMs`; failures are never cached.
   */
  private cached<T>(key: string, freshMs: number, load: () => Promise<T>, staleMs = 60_000): Promise<T> {
    const hit = this.memo.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < freshMs) return hit.value as Promise<T>;
    const next = load();
    const entry = { at: Date.now(), value: next };
    next.catch(() => {
      if (this.memo.get(key) === entry) this.memo.delete(key);
    });
    if (hit && age < staleMs) {
      // Stale but recent: answer now, swap in the new value when it lands, unless the
      // entry was invalidated meanwhile (a review was just posted, say): then this
      // result predates the change and must not replace the fresh one.
      next.then(() => this.memo.get(key) === hit && this.memo.set(key, entry)).catch(() => {});
      return hit.value as Promise<T>;
    }
    this.memo.set(key, entry);
    return next;
  }

  /** Forget cached reads, e.g. after a comment or review changes them. */
  invalidate(ref?: ItemRef): void {
    if (ref) this.memo.delete(ref.kind === "pr" ? `pr/${ref.number}` : `branch/${ref.name}`);
    if (ref?.kind === "pr") {
      this.recentReads.delete(`pr/${ref.number}`);
      this.recentReads.delete(`reviews/${ref.number}`);
      this.enriched.delete(ref.number);
    }
    // The full inbox is kept and served until its replacement is ready: dropping it
    // would fall back to the quick list, whose missing checks read as "Open".
    this.inboxVersion++;
    this.memo.delete("inbox-fast");
    // Who's requested to review lives on the PR list, so that has to be read again too.
    this.openPRs = null;
  }

  private warming = false;
  /** Prepares every open PR's details in the background, a few at a time, so opening one is instant. */
  private warmDetails(inbox: Inbox): void {
    // Each warmed page costs a dozen requests: only the likeliest few, once per change,
    // and not at all when the hourly quota runs low.
    // Once, after the first full inbox: later pages are fetched when opened.
    if (this.warming || this.warmedOnce || this.lowOnQuota()) return;
    this.warmedOnce = true;
    const order = ["needs_review", "mine", "local"];
    const items = order
      .flatMap((id) => inbox.groups.find((g) => g.id === id)?.items ?? [])
      .filter((i) => !this.warmed.has(i.id))
      .slice(0, WARM_LIMIT);
    if (items.length === 0) return;
    this.warming = true;
    mapLimit(items, 3, (item) =>
      this.detail(item.ref)
        .then(() => this.warmed.set(item.id, `${item.updatedAt}`))
        .catch(() => undefined),
    ).finally(() => (this.warming = false));
  }

  /** Under 300 requests left this hour: stop extras and refresh rarely. */
  private lowOnQuota(): boolean {
    const quota = this.quota();
    return !!quota && quota.remaining < LOW_QUOTA;
  }

  /** The tighter of the two budgets: GraphQL points (when in use) and REST requests. */
  private quota(): { remaining: number; limit: number; resetAt: string | null } | null {
    const usage = this.usage();
    if (!usage) return null;
    const budgets = [
      usage.remaining != null ? { remaining: usage.remaining, limit: usage.limit ?? 5000, resetAt: usage.resetAt } : null,
      this.graphql() && usage.graphql.remaining != null ? { remaining: usage.graphql.remaining, limit: usage.graphql.limit ?? 5000, resetAt: usage.graphql.resetAt } : null,
    ].filter((b): b is NonNullable<typeof b> => !!b);
    return budgets.sort((a, b) => a.remaining / a.limit - b.remaining / b.limit)[0] ?? null;
  }

  /**
   * One GitHub read shared for a few seconds by everything that needs it (the inbox,
   * a PR page, the stacks it appears in), and by concurrent callers.
   */
  private recent<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.recentReads.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.recentReads.set(key, { at: Date.now(), value });
    value.catch(() => this.recentReads.get(key)?.value === value && this.recentReads.delete(key));
    return value;
  }
  private getPR(number: number) {
    return this.recent(`pr/${number}`, SHARED_READ_MS, () => this.octokit!.pulls.get({ ...this.repo!, pull_number: number }).then(({ data }) => data as FullPR));
  }
  private getReviews(number: number) {
    return this.recent(`reviews/${number}`, SHARED_READ_MS, () => fetchReviews(this.octokit!, this.repo!, number));
  }
  private getChecks(sha: string) {
    return this.recent(`checks/${sha}`, SHARED_READ_MS, () => fetchChecks(this.octokit!, this.repo!, sha));
  }

  /** Fetches the inbox and the first item's details ahead of the first page load. */
  async warm(initial: ItemRef | null): Promise<void> {
    const inbox = await this.inbox();
    const first = initial ?? inbox.groups.flatMap((g) => g.items)[0]?.ref;
    if (first) await this.detail(first);
  }

  /**
   * The inbox comes in two passes: the plain PR list answers fast (one request), and
   * the full version with checks, reviews and sizes is built in the background. Until
   * it is ready, responses carry `partial: true` so the client polls again shortly.
   * Once a full inbox exists it is always what's served; stale ones are rebuilt in
   * the background, and `fresh` waits for the rebuild.
   */
  async inbox({ fresh = false } = {}): Promise<Inbox> {
    const full = this.memo.get("inbox");
    if (!full) {
      this.refreshInbox();
      return this.cached("inbox-fast", 5_000, () => this.loadInbox(false));
    }
    const stale = this.inboxBuiltFrom !== this.inboxVersion || Date.now() - full.at > (this.lowOnQuota() ? INBOX_FRESH_LOW_QUOTA_MS : INBOX_FRESH_MS);
    if (fresh) return (await this.refreshInbox()) ?? (full.value as Promise<Inbox>);
    if (stale) this.refreshInbox();
    return full.value as Promise<Inbox>;
  }

  /** Bumped by every change; a full inbox built from an older version is stale. */
  private inboxVersion = 0;
  private inboxBuiltFrom = -1;
  private inboxRefresh: Promise<Inbox | undefined> | null = null;
  private refreshInbox(): Promise<Inbox | undefined> {
    if (this.inboxRefresh) return this.inboxRefresh;
    const version = this.inboxVersion;
    const next = this.loadInbox(true);
    this.inboxRefresh = next
      .then((inbox) => {
        this.memo.set("inbox", { at: Date.now(), value: next });
        this.inboxBuiltFrom = version;
        this.warmDetails(inbox);
        return inbox;
      })
      .catch(() => undefined)
      .finally(() => {
        this.inboxRefresh = null;
        // Something changed while this was being built: build again.
        if (version !== this.inboxVersion) this.refreshInbox();
      });
    return this.inboxRefresh;
  }

  private async loadInbox(enrich: boolean): Promise<Inbox> {
    const [viewer, prs, refs, currentBranch] = await Promise.all([
      this.viewer(),
      this.listOpenPRs(),
      this.pile.git.getRefs(),
      this.pile.git.getCurrentBranch(),
    ]);

    // Only PRs that are yours or wait on your review are enriched (checks, reviews,
    // size); everyone else's come from the list alone and only show up in search.
    const yours = (pr: ListedPR) =>
      !!viewer && (pr.user?.login === viewer.login || (pr.requested_reviewers ?? []).some((u) => u?.login === viewer.login));
    const prItems = enrich
      ? await mapPRs(prs, (pr) => (yours(pr) ? this.inboxItem(pr, viewer?.login ?? null, refs, currentBranch) : Promise.resolve(this.basicPRItem(pr))))
      : prs.map((pr) => this.basicPRItem(pr));
    const positions = chainPositions(prs.map((pr) => ({ head: pr.head.ref, base: pr.base.ref })));
    for (const item of prItems) {
      item.stack ??= positions.get(item.branch) ?? null;
    }

    // Tracked branches without an open PR are local work.
    const prBranches = new Set(prs.map((pr) => pr.head.ref));
    const localBranches = this.pile.stack
      .getAllTrackedBranches()
      .filter((branch) => refs.local.has(branch) && !prBranches.has(branch));
    const localItems = await Promise.all(localBranches.map((b) => this.localItem(b, refs, currentBranch)));

    const login = viewer?.login;
    const needsReview: InboxItem[] = [];
    const mine: InboxItem[] = [];
    const others: InboxItem[] = [];
    prs.forEach((pr, i) => {
      const item = prItems[i];
      const requested = (pr.requested_reviewers ?? []).some((u) => u?.login === login);
      if (pr.user?.login === login) mine.push(item);
      else if (requested) needsReview.push(item);
      else others.push(item);
    });

    const groups: InboxGroup[] = [
      { id: "needs_review", title: "Needs your review", items: sortByStack(needsReview) },
      { id: "mine", title: "Your pull requests", items: sortByStack(mine) },
      { id: "local", title: "Local branches", items: sortByStack(localItems) },
      // Not shown in the inbox; searched when you look for something specific.
      { id: "others", title: "Other open pull requests", items: sortByStack(others), searchOnly: true },
    ];
    return { groups, fetchedAt: new Date().toISOString(), partial: !enrich && !!this.octokit, quota: this.quota() };
  }

  /** What the PR list alone tells us; checks, reviews and sizes come later. */
  private basicPRItem(pr: ListedPR): InboxItem {
    return {
      ref: { kind: "pr", number: pr.number },
      id: `pr-${pr.number}`,
      title: pr.title,
      branch: pr.head.ref,
      base: pr.base.ref,
      author: person(pr.user),
      state: prState(pr),
      updatedAt: pr.updated_at,
      additions: null,
      deletions: null,
      reviewDecision: (pr.requested_reviewers?.length ?? 0) > 0 ? "review_required" : null,
      checks: null,
      stack: null,
      local: null,
      url: pr.html_url,
      comments: 0,
    };
  }

  /**
   * A PR's inbox row. Unchanged PRs (same update time and head commit) are reused
   * without a request; while checks run, only the checks are read again.
   */
  private async inboxItem(
    pr: ListedPR,
    viewer: string | null,
    refs: Awaited<ReturnType<PileInstance["git"]["getRefs"]>>,
    currentBranch: string,
  ): Promise<InboxItem> {
    const version = `${pr.updated_at}/${pr.head.sha}/${(pr.requested_reviewers ?? []).map((u) => u?.login).join(",")}`;
    const node = this.inboxNodes.get(pr.number);
    if (node) {
      // Everything came with the inbox query.
      return {
        ...this.basicPRItem(pr),
        additions: node.additions,
        deletions: node.deletions,
        comments: node.totalCommentsCount ?? 0,
        reviewDecision: decisionFor(reviewsFromNode(node), pr, viewer),
        checks: checksFromNode(node),
        local: await localState(this.pile, pr.head.ref, refs, currentBranch),
      };
    }
    const known = this.enriched.get(pr.number);
    let item: InboxItem;
    let at = Date.now();
    if (known?.version === version && (!known.pending || Date.now() - known.at < PENDING_CHECKS_MS)) {
      // Unchanged; running checks are re-read at most once a minute here (the PR page
      // follows them live).
      item = { ...known.item, local: await localState(this.pile, pr.head.ref, refs, currentBranch) };
      at = known.at;
    } else if (known?.version === version) {
      const checks = summarizeChecks(await this.getChecks(pr.head.sha));
      item = { ...known.item, checks, local: await localState(this.pile, pr.head.ref, refs, currentBranch) };
    } else {
      item = await this.prItem(pr, viewer, refs, currentBranch);
    }
    this.enriched.set(pr.number, { version, item, pending: item.checks?.state === "pending", at });
    return item;
  }

  private async prItem(
    pr: ListedPR,
    viewer: string | null,
    refs: Awaited<ReturnType<PileInstance["git"]["getRefs"]>>,
    currentBranch: string,
  ): Promise<InboxItem> {
    const [full, reviews, checks, local] = await Promise.all([
      this.getPR(pr.number),
      this.getReviews(pr.number),
      this.getChecks(pr.head.sha),
      localState(this.pile, pr.head.ref, refs, currentBranch),
    ]);
    return {
      ref: { kind: "pr", number: pr.number },
      id: `pr-${pr.number}`,
      title: pr.title,
      branch: pr.head.ref,
      base: pr.base.ref,
      author: person(pr.user),
      state: prState(pr),
      updatedAt: pr.updated_at,
      additions: full.additions,
      deletions: full.deletions,
      reviewDecision: decisionFor(reviews, pr, viewer),
      checks: summarizeChecks(checks),
      stack: full.stack ? { index: full.stack.position, size: full.stack.size, nativeStack: full.stack.number } : null,
      local,
      url: pr.html_url,
      comments: full.comments + full.review_comments,
    };
  }

  private async localItem(
    branch: string,
    refs: Awaited<ReturnType<PileInstance["git"]["getRefs"]>>,
    currentBranch: string,
  ): Promise<InboxItem> {
    const parent = this.pile.state.getParent(branch) ?? this.pile.stack.getTrunk();
    const ancestry = this.pile.stack.getAncestry(branch);
    const [stat, commits, local] = await Promise.all([
      this.pile.git.run(["diff", "--shortstat", `${parent}...${branch}`]).catch(() => ""),
      this.pile.git.getCommitsBetween(parent, branch),
      localState(this.pile, branch, refs, currentBranch),
    ]);
    const additions = Number(stat.match(/(\d+) insertion/)?.[1] ?? 0);
    const deletions = Number(stat.match(/(\d+) deletion/)?.[1] ?? 0);
    const tree = this.localTree(branch);
    return {
      ref: { kind: "branch", name: branch },
      id: `branch-${branch}`,
      title: this.pile.state.getTitle(branch) ?? commits[0]?.message ?? branch,
      branch,
      base: parent,
      author: commits[0] ? { login: commits[0].author, avatarUrl: null } : null,
      state: "local",
      updatedAt: commits[0]?.date ?? null,
      additions,
      deletions,
      reviewDecision: null,
      checks: null,
      stack:
        tree.length > 1
          ? { index: ancestry.length, size: tree.length, nativeStack: null }
          : null,
      local,
      url: null,
      comments: 0,
    };
  }

  /** The tracked stack a local branch belongs to: from its bottom, every branch built on it. */
  private localTree(branch: string): string[] {
    const root = this.pile.stack.getAncestry(branch)[0] ?? branch;
    const tree: string[] = [];
    const queue = [root];
    while (queue.length) {
      const next = queue.shift()!;
      if (tree.includes(next)) continue;
      tree.push(next);
      queue.push(...this.pile.state.getChildren(next));
    }
    return tree;
  }

  // ---------------------------------------------------------------------------
  // Detail

  detail(ref: ItemRef): Promise<Detail> {
    return ref.kind === "pr"
      ? this.cached(`pr/${ref.number}`, 15_000, () => this.prDetail(ref.number), 5 * 60_000)
      : this.cached(`branch/${ref.name}`, 3_000, () => this.branchDetail(ref.name));
  }

  private async prDetail(number: number): Promise<Detail> {
    if (!this.octokit || !this.repo) {
      throw new ReviewError(400, "NO_GITHUB", "GitHub isn't configured", "Run `gh auth login` or set GITHUB_TOKEN.");
    }
    const octokit = this.octokit;
    const repo = this.repo;
    if (this.graphql()) {
      try {
        return await this.prDetailGraphQL(number);
      } catch (error) {
        if (error instanceof ReviewError) throw error;
        this.graphqlFailed(error);
      }
    }
    // Everything that doesn't need the head commit starts right away, in parallel.
    const prPromise = octokit.pulls
      .get({ ...repo, pull_number: number, mediaType: { format: "full" } })
      .then(({ data }) => data as FullPR)
      .catch((error) => {
        if ((error as { status?: number }).status === 404) {
          throw new ReviewError(404, "PR_NOT_FOUND", `Pull request #${number} doesn't exist`);
        }
        throw error;
      });
    const filesP = fetchFiles(octokit, repo, number);
    const reviewsP = this.getReviews(number);
    const inlineP = fetchInlineComments(octokit, repo, number);
    const partsP = fetchTimelineParts(octokit, repo, number);
    const contextP = Promise.all([this.viewer(), this.pile.git.getRefs(), this.pile.git.getCurrentBranch()]);
    for (const p of [filesP, reviewsP, inlineP, partsP, contextP]) p.catch(() => {});

    const pr = await prPromise;
    const [files, reviews, inline, checks] = await Promise.all([filesP, reviewsP, inlineP, this.getChecks(pr.head.sha)]);
    return this.buildDetail(number, pr, { files, reviews, inline, checks, parts: partsP, context: contextP });
  }

  /** A PR page from one GraphQL query plus the files (REST: GraphQL has no patches). */
  private async prDetailGraphQL(number: number): Promise<Detail> {
    const octokit = this.octokit!;
    const repo = this.repo!;
    // Files are the one REST read here. If REST's quota is used up, the page still
    // shows everything else, and says why the files are missing.
    let filesUnavailable: string | null = null;
    const filesP = fetchFiles(octokit, repo, number).catch((error) => {
      const { body } = ReviewService.errorBody(error);
      if (body.code !== "RATE_LIMITED") throw error;
      filesUnavailable = body.error;
      return [];
    });
    const contextP = Promise.all([this.viewer(), this.pile.git.getRefs(), this.pile.git.getCurrentBranch()]);
    filesP.catch(() => {});
    contextP.catch(() => {});
    const data = await fetchPRGraphQL(octokit, repo, number);
    if (!data) throw new ReviewError(404, "PR_NOT_FOUND", `Pull request #${number} doesn't exist`);
    const files = await filesP;
    const detail = await this.buildDetail(number, data.pr as unknown as FullPR, {
      files,
      reviews: data.reviews as unknown as Awaited<ReturnType<typeof fetchReviews>>,
      inline: data.inline,
      checks: data.checks,
      parts: Promise.resolve([data.comments, data.commits]) as unknown as ReturnType<typeof fetchTimelineParts>,
      context: contextP,
    });
    return filesUnavailable ? { ...detail, filesUnavailable } : detail;
  }

  private async buildDetail(
    number: number,
    pr: FullPR,
    got: {
      files: Awaited<ReturnType<typeof fetchFiles>>;
      reviews: Awaited<ReturnType<typeof fetchReviews>>;
      inline: Awaited<ReturnType<typeof fetchInlineComments>>;
      checks: Awaited<ReturnType<typeof fetchChecks>>;
      parts: ReturnType<typeof fetchTimelineParts>;
      context: Promise<[Awaited<ReturnType<ReviewService["viewer"]>>, Awaited<ReturnType<PileInstance["git"]["getRefs"]>>, string]>;
    },
  ): Promise<Detail> {
    const { files, reviews, inline, checks } = got;
    const [stack, [viewer, refs, currentBranch]] = await Promise.all([this.prStack(pr), got.context]);
    const [timeline, local] = await Promise.all([
      fetchTimeline(got.parts, reviews, inline),
      localState(this.pile, pr.head.ref, refs, currentBranch),
    ]);
    const state = prState(pr);

    return {
      ref: { kind: "pr", number },
      title: pr.title,
      number,
      url: pr.html_url,
      state,
      author: person(pr.user),
      branch: pr.head.ref,
      base: pr.base.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      bodyHtml: pr.body_html || null,
      additions: pr.additions,
      deletions: pr.deletions,
      stack,
      timeline,
      inlineComments: inline,
      checks,
      checksSummary: summarizeChecks(checks),
      reviewers: reviewerStates(reviews, (pr.requested_reviewers ?? []) as Array<{ login: string; avatar_url?: string }>, (pr.requested_teams ?? []) as Array<{ slug: string; name: string }>, pr.user?.login),
      labels: (pr.labels ?? []).map((l) => ({ name: l.name ?? "", color: l.color ?? "888888" })),
      assignees: (pr.assignees ?? []).map((a) => person(a)!),
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
      reviewDecision: decisionFor(reviews, pr, viewer?.login ?? null),
      files,
      local,
      can: {
        review: !!viewer && viewer.login !== pr.user?.login && (state === "open" || state === "draft"),
        comment: !!viewer,
        merge: state === "open",
        // Only the author moves their own PR between draft and ready.
        draft: !!viewer && viewer.login === pr.user?.login && (state === "open" || state === "draft"),
      },
      merge: state === "open" || state === "draft" ? this.mergeInfo(pr, reviews, checks, stack) : null,
    };
  }

  /**
   * The PR's stack, each open entry with its own checks and review state (requests
   * are ETag-cached, so refreshing a whole stack is cheap).
   */
  private async prStack(pr: FullPR): Promise<StackEntry[]> {
    const entries = await this.stackEntries(pr);
    if (entries.length === 0) return entries;
    const octokit = this.octokit!;
    const repo = this.repo!;
    const [open, viewer] = await Promise.all([this.listOpenPRs(), this.viewer()]);
    const byNumber = new Map(open.map((p) => [p.number, p as ListedPR | FullPR]));
    byNumber.set(pr.number, pr);
    return mapLimit(entries, 4, async (entry) => {
      const listed = entry.ref.kind === "pr" ? byNumber.get(entry.ref.number) : undefined;
      if (!listed || entry.state === "merged" || entry.state === "closed") return entry;
      const node = this.inboxNodes.get(listed.number);
      if (node) {
        // From the inbox query: no requests.
        const reviews = reviewsFromNode(node);
        const summary = checksFromNode(node);
        return {
          ...entry,
          checks: summary,
          reviewDecision: decisionFor(reviews, listed, viewer?.login ?? null),
          blockers: blockingReasons({ draft: !!listed.draft, checks: summary, changesRequested: changesRequested(reviews), mergeable: null, mergeableState: null }).map((r) => r.message),
        };
      }
      const [checks, reviews] = await Promise.all([
        this.getChecks(listed.head.sha).catch(() => null),
        this.getReviews(listed.number).catch(() => null),
      ]);
      const summary = checks ? summarizeChecks(checks) : null;
      return {
        ...entry,
        checks: summary,
        reviewDecision: reviews ? decisionFor(reviews, listed, viewer?.login ?? null) : entry.reviewDecision,
        blockers: blockingReasons({
          draft: !!listed.draft,
          checks: summary ?? { state: "pending", total: 0, failed: 0, pending: 0 },
          changesRequested: !!reviews && changesRequested(reviews),
          mergeable: null, // only known per PR; GitHub refuses at merge time if it can't
          mergeableState: null,
        }).map((r) => r.message),
      };
    });
  }

  private async stackEntries(pr: FullPR): Promise<StackEntry[]> {
    const octokit = this.octokit!;
    const repo = this.repo!;
    // Native GitHub stack: the stack itself is the source of truth.
    if (pr.stack) {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/stacks/{stack_number}", {
        ...repo,
        stack_number: pr.stack.number,
      });
      const entries = (data as { pull_requests: Array<{ number: number; title?: string; state: string; draft?: boolean; merged_at: string | null; head: { ref: string } }> }).pull_requests;
      const titles = new Map((await this.listOpenPRs()).map((p) => [p.number, p.title]));
      // A native stack is a straight line: each PR is based on the one before it.
      return entries.map((e, i) => ({
        ref: { kind: "pr" as const, number: e.number },
        title: e.title ?? titles.get(e.number) ?? `#${e.number}`,
        branch: e.head.ref,
        base: i === 0 ? pr.base.repo.default_branch : entries[i - 1].head.ref,
        state: prState(e),
        reviewDecision: null,
        isCurrent: e.number === pr.number,
      }));
    }

    // Otherwise follow base -> head links between open PRs: down to the bottom of the
    // stack, then every PR built on it. Stacks can diverge, so this is a tree.
    const open = (await this.listOpenPRs()).filter((p) => p.number !== pr.number);
    const all: Array<ListedPR | FullPR> = [pr, ...open];
    const byHead = new Map(all.map((p) => [p.head.ref, p]));
    let root: ListedPR | FullPR = pr;
    const seen = new Set<string>([pr.head.ref]);
    while (byHead.has(root.base.ref) && !seen.has(root.base.ref)) {
      seen.add(root.base.ref);
      root = byHead.get(root.base.ref)!;
    }
    const tree: Array<ListedPR | FullPR> = [];
    const queue = [root];
    const visited = new Set<string>();
    while (queue.length) {
      const next = queue.shift()!;
      if (visited.has(next.head.ref)) continue;
      visited.add(next.head.ref);
      tree.push(next);
      queue.push(...all.filter((p) => p.base.ref === next.head.ref).sort((a, b) => a.number - b.number));
    }
    if (tree.length < 2) return [];
    return tree.map((p) => ({
      ref: { kind: "pr" as const, number: p.number },
      title: p.title,
      branch: p.head.ref,
      base: p.base.ref,
      state: prState(p),
      reviewDecision: null,
      isCurrent: p.number === pr.number,
    }));
  }

  private async branchDetail(branch: string): Promise<Detail> {
    if (!(await this.pile.git.branchExists(branch))) {
      throw new ReviewError(404, "BRANCH_NOT_FOUND", `Branch ${branch} doesn't exist locally`);
    }
    const trunk = this.pile.stack.getTrunk();
    const parent = this.pile.state.getParent(branch) ?? trunk;
    const [mergeBase, headSha, refs, currentBranch] = await Promise.all([
      this.pile.git.getMergeBase(parent, branch),
      this.pile.git.getCommitHash(branch),
      this.pile.git.getRefs(),
      this.pile.git.getCurrentBranch(),
    ]);
    const base = mergeBase ?? parent;
    const [files, timeline, local] = await Promise.all([
      localFiles(this.pile, base, branch),
      localCommits(this.pile, base, branch),
      localState(this.pile, branch, refs, currentBranch),
    ]);
    const chain = this.localTree(branch);
    const stack: StackEntry[] =
      chain.length > 1
        ? chain.map((name) => ({
            ref: { kind: "branch" as const, name },
            title: this.pile.state.getTitle(name) ?? name,
            branch: name,
            base: this.pile.state.getParent(name) ?? trunk,
            state: "local" as const,
            reviewDecision: null,
            isCurrent: name === branch,
          }))
        : [];
    const stats = diffStats(files);
    const last = timeline[timeline.length - 1];

    return {
      ref: { kind: "branch", name: branch },
      title: this.pile.state.getTitle(branch) ?? timeline[0]?.message?.split("\n")[0] ?? branch,
      number: null,
      url: null,
      state: "local",
      author: timeline[0]?.author ?? null,
      branch,
      base: parent,
      headSha,
      baseSha: base,
      createdAt: timeline[0]?.createdAt ?? null,
      updatedAt: last?.createdAt ?? null,
      bodyHtml: null,
      additions: stats.additions,
      deletions: stats.deletions,
      stack,
      timeline,
      inlineComments: [],
      checks: [],
      checksSummary: null,
      reviewers: [],
      labels: [],
      assignees: [],
      mergeable: null,
      mergeableState: null,
      reviewDecision: null,
      files,
      local,
      can: { review: false, comment: false, merge: false, draft: false },
      merge: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Files and actions

  /** File contents at a commit, for expanding diff context. Local git first, then GitHub. */
  async file(ref: string, path: string): Promise<FileContent> {
    const text = await this.pile.git.run(["show", `${ref}:${path}`]).catch(async () => {
      if (!this.octokit || !this.repo) throw new ReviewError(404, "FILE_NOT_FOUND", `${path} isn't available at ${ref}`);
      const { data } = await this.octokit.repos.getContent({ ...this.repo, path, ref, mediaType: { format: "raw" } });
      return String(data);
    });
    // A final newline ends the last line rather than starting another.
    return { path, ref, lines: text.replace(/\r?\n$/, "").split("\n") };
  }

  async comment(number: number, body: string): Promise<void> {
    this.requireGitHub();
    if (!body.trim()) throw new ReviewError(400, "EMPTY_COMMENT", "Write something before commenting");
    await this.octokit!.issues.createComment({ ...this.repo!, issue_number: number, body });
    this.invalidate({ kind: "pr", number });
  }

  async review(number: number, request: ReviewRequest): Promise<void> {
    this.requireGitHub();
    if (request.event !== "APPROVE" && !request.body?.trim() && !request.comments?.length) {
      throw new ReviewError(400, "EMPTY_REVIEW", "Add a comment to request changes or comment");
    }
    try {
      await this.octokit!.pulls.createReview({
        ...this.repo!,
        pull_number: number,
        event: request.event,
        body: request.body,
        comments: request.comments,
      });
      this.invalidate({ kind: "pr", number });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 422) {
        throw new ReviewError(422, "REVIEW_REJECTED", (error as Error).message.replace(/ - https:.*$/, ""));
      }
      throw error;
    }
  }

  /** What merging this PR alone, or its stack up to it, would take. */
  private mergeInfo(pr: FullPR, reviews: Awaited<ReturnType<typeof fetchReviews>>, checks: Awaited<ReturnType<typeof fetchChecks>>, stack: StackEntry[]): MergeInfo {
    const own = blockingReasons({
      draft: !!pr.draft,
      checks: summarizeChecks(checks),
      changesRequested: changesRequested(reviews),
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
    }).map((r) => r.message);
    const trunk = pr.base.repo.default_branch;
    // Open PRs this one is built on, bottom first (never a sibling branch).
    const below = ancestors(stack).filter((e) => e.state === "open" || e.state === "draft");
    return {
      method: this.pile.state.getConfig()?.mergeMethod ?? "squash",
      single: { possible: pr.base.ref === trunk, blockers: own },
      stack:
        below.length > 0
          ? {
              count: below.length + 1,
              blockers: [
                ...below.flatMap((e) => (e.blockers ?? []).map((b) => `#${e.ref.kind === "pr" ? e.ref.number : e.branch}: ${b}`)),
                ...own.map((b) => `#${pr.number}: ${b}`),
              ],
            }
          : null,
    };
  }

  /**
   * Merges this PR, or every open PR from the bottom of its stack up to it, with the
   * same rules as `pile merge`: nothing blocked is merged, PRs above are moved onto
   * the merged PR's base, and branches pile tracks locally are cleaned up.
   */
  async merge(number: number, request: MergeRequest): Promise<MergeResult> {
    this.requireGitHub();
    this.invalidate({ kind: "pr", number });
    this.openPRs = null;
    const detail = await this.detail({ kind: "pr", number });
    const info = detail.merge;
    if (!info) throw new ReviewError(400, "NOT_OPEN", `#${number} isn't open`);
    const plan = request.stack ? info.stack : info.single.possible ? { count: 1, blockers: info.single.blockers } : null;
    if (!plan) {
      throw new ReviewError(400, "NOT_ON_TRUNK", `#${number} is based on ${detail.base}`, "Merge the stack up to it instead, or merge the PRs below first.");
    }
    if (plan.blockers.length > 0) throw new ReviewError(409, "MERGE_BLOCKED", plan.blockers.join("; "));

    const github = this.github!;
    const current = detail.stack.find((e) => e.isCurrent);
    const chain = request.stack && current
      ? [...ancestors(detail.stack), current].filter((e) => e.ref.kind === "pr" && (e.state === "open" || e.state === "draft"))
      : [{ ref: detail.ref, branch: detail.branch }];
    const numbers = chain.map((e) => (e.ref as { number: number }).number);
    const trunk = this.pile.stack.getTrunk();
    const tracked = (branch: string) => !!this.pile.state.getBranchRelationship(branch);

    try {
      const { data: full } = await this.octokit!.pulls.get({ ...this.repo!, pull_number: number });
      const native = (full as FullPR).stack;
      if (native) {
        // One atomic merge of everything below and including this PR.
        const result = await github.prs.mergeAsyncAndWait(number, info.method, { sha: detail.headSha });
        if (result.status === "enqueued") return { merged: [], queued: true };
        const merged = new Set((await github.prs.getMergedInStack(native.number)).map((m) => m.number));
        for (const entry of chain) if (tracked(entry.branch)) await cleanupMergedBranch(this.pile, github, entry.branch, trunk, false);
        return { merged: numbers.filter((n) => merged.has(n)), queued: false };
      }

      const merged: number[] = [];
      for (const [i, entry] of chain.entries()) {
        const n = numbers[i];
        const { data: pr } = await this.octokit!.pulls.get({ ...this.repo!, pull_number: n });
        await github.prs.merge(n, info.method);
        merged.push(n);
        // PRs that were based on the merged branch move onto its base.
        const children = (await this.octokit!.paginate(this.octokit!.pulls.list, { ...this.repo!, state: "open", base: entry.branch, per_page: 100 })) as ListedPR[];
        await Promise.all(children.map((child) => github.prs.update({ number: child.number, base: pr.base.ref })));
        if (tracked(entry.branch)) await cleanupMergedBranch(this.pile, github, entry.branch, trunk, false);
      }
      return { merged, queued: false };
    } catch (error) {
      throw cleanGitHubError(error);
    } finally {
      this.openPRs = null;
      this.memo.clear();
      this.inboxVersion++;
    }
  }

  // ---------------------------------------------------------------------------
  // Notes for the agent (.pile/notes.json, read with `pile notes`)

  notes(branch: string | null): AgentNote[] {
    return this.pile.notes.list(branch ? { branch } : {});
  }

  /** Saves a note with the code around its line, as the reviewer saw it. */
  async addNote(request: NewNoteRequest): Promise<AgentNote> {
    const detail = await this.detail(request.ref);
    let code: string[] = [];
    let codeStart: number | null = null;
    if (request.path && request.line) {
      // The old side reads the file as it was before the change.
      const ref = request.side === "LEFT" ? detail.baseSha : detail.headSha;
      const lines = await this.file(ref, request.path).then((f) => f.lines).catch(() => [] as string[]);
      if (lines.length) {
        codeStart = Math.max(1, request.line - 2);
        code = lines.slice(codeStart - 1, Math.min(lines.length, request.line + 2));
      }
    }
    try {
      return this.pile.notes.add({
        branch: detail.branch,
        pr: detail.number,
        path: request.path ?? null,
        line: request.line ?? null,
        side: request.path ? (request.side ?? "RIGHT") : null,
        commit: detail.headSha,
        code,
        codeStart,
        body: request.body,
      });
    } catch (error) {
      throw new ReviewError(400, "EMPTY_NOTE", (error as Error).message);
    }
  }

  updateNote(id: string, change: { done?: boolean; body?: string }): AgentNote {
    try {
      return this.pile.notes.update(id, { ...(change.done !== undefined && { done: !!change.done }), ...(change.body && { body: change.body }) });
    } catch (error) {
      throw new ReviewError(404, "NOTE_NOT_FOUND", (error as Error).message);
    }
  }

  /** The reviewer answers the agent; replying to a finished note reopens it. */
  replyToNote(id: string, body: string): AgentNote {
    try {
      return this.pile.notes.reply(id, "reviewer", body);
    } catch (error) {
      const message = (error as Error).message;
      throw /No note/.test(message) ? new ReviewError(404, "NOTE_NOT_FOUND", message) : new ReviewError(400, "EMPTY_REPLY", message);
    }
  }

  removeNote(id: string): void {
    try {
      this.pile.notes.remove(id);
    } catch (error) {
      throw new ReviewError(404, "NOTE_NOT_FOUND", (error as Error).message);
    }
  }

  /** GitHub requests made so far and what's left of the hourly rate limit. */
  usage() {
    return this.octokit ? (apiUsage(this.octokit) ?? null) : null;
  }

  /** People and labels a PR can be given; cached for a few minutes. */
  options(): Promise<RepoOptions> {
    this.requireGitHub();
    return this.cached("options", 5 * 60_000, async () => {
      const [people, labels] = await Promise.all([
        this.octokit!.paginate(this.octokit!.issues.listAssignees, { ...this.repo!, per_page: 100 }).catch(() => []),
        this.octokit!.paginate(this.octokit!.issues.listLabelsForRepo, { ...this.repo!, per_page: 100 }).catch(() => []),
      ]);
      return {
        people: people.map((p) => person(p)!).sort((a, b) => a.login.localeCompare(b.login)),
        labels: labels.map((l) => ({ name: l.name, color: l.color ?? "888888", description: l.description ?? null })),
      };
    });
  }

  /** Changes reviewers, assignees, labels or draft state, then returns the fresh PR. */
  async update(number: number, change: PRUpdate): Promise<Detail> {
    this.requireGitHub();
    const repo = this.repo!;
    const api = this.octokit!;
    const tasks: Array<Promise<unknown>> = [];
    const { reviewers, assignees, labels, draft } = change;
    if (reviewers?.add?.length) tasks.push(api.pulls.requestReviewers({ ...repo, pull_number: number, reviewers: reviewers.add }));
    if (reviewers?.remove?.length) tasks.push(api.pulls.removeRequestedReviewers({ ...repo, pull_number: number, reviewers: reviewers.remove }));
    if (assignees?.add?.length) tasks.push(api.issues.addAssignees({ ...repo, issue_number: number, assignees: assignees.add }));
    if (assignees?.remove?.length) tasks.push(api.issues.removeAssignees({ ...repo, issue_number: number, assignees: assignees.remove }));
    // Setting labels creates any that don't exist yet.
    if (labels) tasks.push(api.issues.setLabels({ ...repo, issue_number: number, labels }));
    if (draft !== undefined) tasks.push(draft ? this.github!.prs.convertToDraft(number) : this.github!.prs.markReadyForReview(number));
    try {
      await Promise.all(tasks);
    } catch (error) {
      this.invalidate({ kind: "pr", number });
      throw cleanGitHubError(error);
    }
    if (labels) this.memo.delete("options");
    this.invalidate({ kind: "pr", number });
    return this.detail({ kind: "pr", number });
  }

  /** Re-runs one GitHub Actions job, or every failed job on the PR's head commit. */
  async rerun(number: number, request: RerunRequest): Promise<Detail> {
    this.requireGitHub();
    const repo = this.repo!;
    const api = this.octokit!;
    try {
      if (request.jobId) {
        await api.actions.reRunJobForWorkflowRun({ ...repo, job_id: request.jobId });
      } else {
        const { data: pr } = await api.pulls.get({ ...repo, pull_number: number });
        const failed = (await fetchChecks(api, repo, pr.head.sha)).filter((c) => c.state === "failure" && c.url);
        const runs = new Set(failed.map((c) => c.url!.match(/\/actions\/runs\/(\d+)/)?.[1]).filter((id): id is string => !!id));
        if (runs.size === 0) throw new ReviewError(400, "NOTHING_TO_RERUN", "There are no failed GitHub Actions checks to re-run");
        await Promise.all([...runs].map((id) => api.actions.reRunWorkflowFailedJobs({ ...repo, run_id: Number(id) })));
      }
    } catch (error) {
      throw cleanGitHubError(error);
    }
    this.invalidate({ kind: "pr", number });
    return this.detail({ kind: "pr", number });
  }

  private requireGitHub(): void {
    if (!this.octokit || !this.repo) {
      throw new ReviewError(400, "NO_GITHUB", "GitHub isn't configured", "Run `gh auth login` or set GITHUB_TOKEN.");
    }
  }

  static errorBody(error: unknown): { status: number; body: { error: string; code: string; hint?: string } } {
    if (error instanceof ReviewError) {
      return { status: error.status, body: { error: error.message, code: error.code, hint: error.hint } };
    }
    if (error instanceof PileGitHubError) {
      return { status: 400, body: { error: error.message, code: error.code, hint: error.hint } };
    }
    const status = (error as { status?: number }).status;
    const headers = (error as { response?: { headers?: Record<string, string> } }).response?.headers;
    if ((status === 403 || status === 429) && (headers?.["x-ratelimit-remaining"] === "0" || /rate limit/i.test(String((error as Error).message)))) {
      const reset = Number(headers?.["x-ratelimit-reset"]);
      const at = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
      return {
        status: 429,
        body: {
          error: at ? `GitHub's API limit for your account is used up until ${at}` : "GitHub's API limit for your account is used up for now",
          code: "RATE_LIMITED",
          hint: "Everything signed in as you shares 5,000 requests an hour. pile shows what it already has until then.",
        },
      };
    }
    return {
      status: status && status >= 400 && status < 600 ? status : 500,
      body: { error: error instanceof Error ? error.message : String(error), code: status ? `GITHUB_${status}` : "ERROR" },
    };
  }
}

/**
 * What the PR needs from review, the same for the inbox and the PR page: for
 * someone else's PR the viewer's own latest verdict, otherwise the overall state.
 */
function decisionFor(
  reviews: Array<{ user: { login: string } | null; state: string; submitted_at?: string | null }>,
  pr: { user: { login: string } | null; requested_reviewers?: unknown[] | null; requested_teams?: unknown[] | null },
  viewer: string | null,
): InboxItem["reviewDecision"] {
  const requested = (pr.requested_reviewers?.length ?? 0) + (pr.requested_teams?.length ?? 0);
  const mine = viewer ? latestReviews(reviews).get(viewer) : undefined;
  return mine && pr.user?.login !== viewer ? reviewStateOf(mine.state) : reviewDecision(reviews, requested);
}

function reviewStateOf(state: string): InboxItem["reviewDecision"] {
  return state === "APPROVED" ? "approved" : state === "CHANGES_REQUESTED" ? "changes_requested" : "commented";
}

/** Position of each branch in chains of PRs based on each other (bottom = 1). */
function chainPositions(prs: Array<{ head: string; base: string }>): Map<string, StackPosition> {
  const heads = new Set(prs.map((p) => p.head));
  const children = new Map<string, string[]>();
  for (const p of prs) children.set(p.base, [...(children.get(p.base) ?? []), p.head]);
  const positions = new Map<string, StackPosition>();
  // Each PR whose base isn't another PR starts a stack; everything built on it,
  // across every branch, belongs to that stack.
  for (const root of prs.filter((p) => !heads.has(p.base))) {
    const depth = new Map<string, number>([[root.head, 1]]);
    const queue = [root.head];
    while (queue.length) {
      const head = queue.shift()!;
      for (const child of children.get(head) ?? []) {
        if (depth.has(child)) continue;
        depth.set(child, depth.get(head)! + 1);
        queue.push(child);
      }
    }
    if (depth.size < 2) continue;
    for (const [head, index] of depth) positions.set(head, { index, size: depth.size, nativeStack: null });
  }
  return positions;
}

/** Keeps stacks together (bottom first), most recently updated stack first. */
function sortByStack(items: InboxItem[]): InboxItem[] {
  const byBranch = new Map(items.map((i) => [i.branch, i]));
  const rootOf = (item: InboxItem): string => {
    let current = item;
    const seen = new Set<string>();
    while (byBranch.has(current.base) && !seen.has(current.base)) {
      seen.add(current.base);
      current = byBranch.get(current.base)!;
    }
    return current.branch;
  };
  const groups = new Map<string, InboxItem[]>();
  for (const item of items) groups.set(rootOf(item), [...(groups.get(rootOf(item)) ?? []), item]);
  const latest = (group: InboxItem[]) => Math.max(...group.map((i) => (i.updatedAt ? Date.parse(i.updatedAt) : 0)));
  return [...groups.values()]
    .map((group) => group.sort((a, b) => (a.stack?.index ?? 0) - (b.stack?.index ?? 0)))
    .sort((a, b) => latest(b) - latest(a))
    .flat();
}

/** GitHub's messages end with a docs link and may hide the reason in `errors`. */
function cleanGitHubError(error: unknown): unknown {
  if (error instanceof ReviewError || error instanceof PileGitHubError) return error;
  const status = (error as { status?: number }).status;
  if (!status) return error;
  const data = (error as { response?: { data?: { message?: string; errors?: Array<{ message?: string } | string> } } }).response?.data;
  const detail = data?.errors?.map((e) => (typeof e === "string" ? e : e.message)).filter(Boolean).join("; ");
  const message = (detail || data?.message || (error as Error).message).replace(/ - https:.*$/, "");
  return new ReviewError(status >= 400 && status < 500 ? status : 502, `GITHUB_${status}`, message);
}

/** The entries the current one is built on, bottom first. */
function ancestors(stack: StackEntry[]): StackEntry[] {
  const byBranch = new Map(stack.map((e) => [e.branch, e]));
  const chain: StackEntry[] = [];
  let entry = stack.find((e) => e.isCurrent);
  while (entry && byBranch.has(entry.base) && !chain.includes(byBranch.get(entry.base)!)) {
    entry = byBranch.get(entry.base)!;
    chain.unshift(entry);
  }
  return chain;
}

/** Someone's latest review asks for changes. */
function changesRequested(reviews: Array<{ user: { login: string } | null; state: string; submitted_at?: string | null }>): boolean {
  return [...latestReviews(reviews as Parameters<typeof latestReviews>[0]).values()].some((r) => r.state === "CHANGES_REQUESTED");
}
