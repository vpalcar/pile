import type { Octokit } from "@octokit/rest";
import { mapLimit, type PileInstance } from "@pile/core";
import { PileGitHubError, type GitHubInstance } from "@pile/github";
import type {
  Detail,
  FileContent,
  Inbox,
  InboxGroup,
  InboxItem,
  ItemRef,
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
  private openPRs: { at: number; prs: Promise<ListedPR[]> } | null = null;
  private memo = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private readonly pile: PileInstance,
    private readonly github: GitHubInstance | null,
  ) {
    this.octokit = github?.client.api ?? null;
    this.repo = github ? { owner: github.client.repoOwner, repo: github.client.repoName } : null;
    if (this.octokit) enableEtagCache(this.octokit);
  }

  private viewer() {
    if (!this.octokit) return Promise.resolve(null);
    this.viewerPromise ??= this.octokit.users
      .getAuthenticated()
      .then(({ data }) => ({ login: data.login, avatar_url: data.avatar_url }))
      .catch(() => null);
    return this.viewerPromise;
  }

  /** Open PRs, shared by the inbox and stack lookups for a few seconds. */
  private listOpenPRs(): Promise<ListedPR[]> {
    if (!this.octokit || !this.repo) return Promise.resolve([]);
    if (!this.openPRs || Date.now() - this.openPRs.at > 5_000) {
      this.openPRs = {
        at: Date.now(),
        prs: this.octokit.paginate(this.octokit.pulls.list, { ...this.repo, state: "open", per_page: 100 }),
      };
    }
    return this.openPRs.prs;
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
      // Stale but recent: answer now, swap in the new value when it lands.
      next.then(() => this.memo.set(key, entry)).catch(() => {});
      return hit.value as Promise<T>;
    }
    this.memo.set(key, entry);
    return next;
  }

  /** Forget cached reads, e.g. after a comment or review changes them. */
  invalidate(ref?: ItemRef): void {
    if (ref) this.memo.delete(ref.kind === "pr" ? `pr/${ref.number}` : `branch/${ref.name}`);
    this.memo.delete("inbox");
    this.memo.delete("inbox-fast");
  }

  private warming = false;
  /** Prepares every open PR's details in the background, a few at a time, so opening one is instant. */
  private warmDetails(inbox: Inbox): void {
    if (this.warming) return;
    this.warming = true;
    const refs = inbox.groups.flatMap((g) => g.items.map((i) => i.ref)).slice(0, 40);
    mapLimit(refs, 3, (ref) => this.detail(ref).catch(() => undefined)).finally(() => (this.warming = false));
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
   */
  async inbox(): Promise<Inbox> {
    const full = this.memo.get("inbox");
    if (full && Date.now() - full.at < 60_000) {
      if (Date.now() - full.at > 8_000) this.refreshInbox();
      return full.value as Promise<Inbox>;
    }
    this.refreshInbox();
    return this.cached("inbox-fast", 5_000, () => this.loadInbox(false));
  }

  private inboxRefresh: Promise<unknown> | null = null;
  private refreshInbox(): void {
    if (this.inboxRefresh) return;
    const next = this.loadInbox(true);
    this.inboxRefresh = next
      .then((inbox) => {
        this.memo.set("inbox", { at: Date.now(), value: next });
        this.warmDetails(inbox);
      })
      .catch(() => {})
      .finally(() => (this.inboxRefresh = null));
  }

  private async loadInbox(enrich: boolean): Promise<Inbox> {
    const [viewer, prs, refs, currentBranch] = await Promise.all([
      this.viewer(),
      this.listOpenPRs(),
      this.pile.git.getRefs(),
      this.pile.git.getCurrentBranch(),
    ]);

    const prItems = enrich
      ? await mapPRs(prs, (pr) => this.prItem(pr, viewer?.login ?? null, refs, currentBranch))
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
      { id: "others", title: "Other open pull requests", items: sortByStack(others) },
    ];
    return { groups, fetchedAt: new Date().toISOString(), partial: !enrich && !!this.octokit };
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

  private async prItem(
    pr: ListedPR,
    viewer: string | null,
    refs: Awaited<ReturnType<PileInstance["git"]["getRefs"]>>,
    currentBranch: string,
  ): Promise<InboxItem> {
    const octokit = this.octokit!;
    const repo = this.repo!;
    const [full, reviews, checks, local] = await Promise.all([
      octokit.pulls.get({ ...repo, pull_number: pr.number }).then(({ data }) => data as FullPR),
      octokit.pulls.listReviews({ ...repo, pull_number: pr.number, per_page: 100 }).then(({ data }) => data),
      fetchChecks(octokit, repo, pr.head.sha),
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
    const top = this.stackTop(branch);
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
        ancestry.length + top.length > 1
          ? { index: ancestry.length, size: ancestry.length + top.length, nativeStack: null }
          : null,
      local,
      url: null,
      comments: 0,
    };
  }

  /** Branches above `branch`, following the first child at each fork. */
  private stackTop(branch: string): string[] {
    const above: string[] = [];
    const seen = new Set([branch]);
    let children = this.pile.state.getChildren(branch);
    while (children.length > 0 && !seen.has(children[0])) {
      seen.add(children[0]);
      above.push(children[0]);
      children = this.pile.state.getChildren(children[0]);
    }
    return above;
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
    const reviewsP = fetchReviews(octokit, repo, number);
    const inlineP = fetchInlineComments(octokit, repo, number);
    const partsP = fetchTimelineParts(octokit, repo, number);
    const contextP = Promise.all([this.viewer(), this.pile.git.getRefs(), this.pile.git.getCurrentBranch()]);
    for (const p of [filesP, reviewsP, inlineP, partsP, contextP]) p.catch(() => {});

    const pr = await prPromise;
    const [files, reviews, inline, checks, stack, [viewer, refs, currentBranch]] = await Promise.all([
      filesP,
      reviewsP,
      inlineP,
      fetchChecks(octokit, repo, pr.head.sha),
      this.prStack(pr),
      contextP,
    ]);
    const [timeline, local] = await Promise.all([
      fetchTimeline(partsP, reviews, inline),
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
      },
    };
  }

  private async prStack(pr: FullPR): Promise<StackEntry[]> {
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
      return entries.map((e) => ({
        ref: { kind: "pr" as const, number: e.number },
        title: e.title ?? titles.get(e.number) ?? `#${e.number}`,
        branch: e.head.ref,
        state: prState(e),
        reviewDecision: null,
        isCurrent: e.number === pr.number,
      }));
    }

    // Otherwise follow base -> head chains between open PRs.
    const open = await this.listOpenPRs();
    const byHead = new Map(open.map((p) => [p.head.ref, p]));
    const below: ListedPR[] = [];
    const seen = new Set<string>([pr.head.ref]);
    let base = pr.base.ref;
    while (byHead.has(base) && !seen.has(base)) {
      seen.add(base);
      const parent = byHead.get(base)!;
      below.unshift(parent);
      base = parent.base.ref;
    }
    const above: ListedPR[] = [];
    let head = pr.head.ref;
    for (;;) {
      const child = open.find((p) => p.base.ref === head && !seen.has(p.head.ref));
      if (!child) break;
      seen.add(child.head.ref);
      above.push(child);
      head = child.head.ref;
    }
    if (below.length === 0 && above.length === 0) return [];
    const entry = (p: ListedPR | FullPR, isCurrent: boolean): StackEntry => ({
      ref: { kind: "pr", number: p.number },
      title: p.title,
      branch: p.head.ref,
      state: prState(p),
      reviewDecision: null,
      isCurrent,
    });
    return [...below.map((p) => entry(p, false)), entry(pr, true), ...above.map((p) => entry(p, false))];
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
    const chain = [...this.pile.stack.getAncestry(branch), ...this.stackTop(branch)];
    const stack: StackEntry[] =
      chain.length > 1
        ? chain.map((name) => ({
            ref: { kind: "branch" as const, name },
            title: this.pile.state.getTitle(name) ?? name,
            branch: name,
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
      can: { review: false, comment: false, merge: false },
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
  for (const root of prs.filter((p) => !heads.has(p.base))) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = root.head;
    while (current && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = children.get(current)?.[0];
    }
    if (chain.length < 2) continue;
    chain.forEach((head, i) => positions.set(head, { index: i + 1, size: chain.length, nativeStack: null }));
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
