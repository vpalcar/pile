import { GitHubClient } from "./client.js";
import { PileGitHubError, parsePRNumber, withGraphQL } from "./errors.js";
import {
  AsyncMergeResult,
  PullRequest,
  Review,
  CheckStatus,
  CreatePRParams,
  UpdatePRParams,
} from "./types.js";

/** The subset of GitHub's pull request payload pile reads (shared by get and list). */
interface RawPullRequest {
    number: number;
    title: string;
    body: string | null;
    state: string;
    draft?: boolean;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    html_url: string;
    mergeable?: boolean | null;
    mergeable_state?: string;
    merged?: boolean;
    merged_at?: string | null;
    created_at: string;
    updated_at: string;
    user: { login: string } | null;
    assignees?: { login: string }[] | null;
    labels?: { name: string }[] | null;
    stack?: { number: number; position: number; size: number; base?: { ref: string } } | null;
  }

export interface AsyncMergeOptions {
  /** Merge only if the PR head is still at this commit. */
  sha?: string;
  timeoutMs?: number;
  intervalMs?: number;
  /** Called with each pending poll result. */
  onPoll?: (result: AsyncMergeResult) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PROperations {
  private client: GitHubClient;

  constructor(client: GitHubClient) {
    this.client = client;
  }

  /**
   * Create a new pull request
   */
  async create(params: CreatePRParams): Promise<PullRequest> {
    const { data } = await this.client.api.pulls.create({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      title: params.title,
      body: params.body,
      head: params.head,
      base: params.base,
      draft: params.draft,
    });

    return this.toPullRequest(data);
  }

  /**
   * Update an existing pull request
   */
  async update(params: UpdatePRParams): Promise<PullRequest> {
    const { data } = await this.client.api.pulls.update({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_number: params.number,
      title: params.title,
      body: params.body,
      base: params.base,
      state: params.state,
    });

    return this.toPullRequest(data);
  }

  /**
   * Get a pull request by number
   */
  async get(prNumber: number): Promise<PullRequest> {
    const { data } = await this.client.api.pulls.get({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_number: prNumber,
    });

    return this.toPullRequest(data);
  }

  /**
   * Get a pull request by number with full review/check details
   */
  async getEnriched(prNumber: number): Promise<PullRequest> {
    const { data } = await this.client.api.pulls.get({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_number: prNumber,
    });

    return this.enrichPR(data);
  }

  /**
   * Find PR for a specific branch (open only)
   */
  async findByBranch(branchName: string): Promise<PullRequest | null> {
    const { data } = await this.client.api.pulls.list({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      head: `${this.client.repoOwner}:${branchName}`,
      state: "open",
    });

    if (data.length === 0) {
      return null;
    }

    return this.toPullRequest(data[0]);
  }

  /**
   * Find PR for a specific branch (any state: open, closed, merged)
   */
  async findByBranchAnyState(branchName: string): Promise<PullRequest | null> {
    const { data } = await this.client.api.pulls.list({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      head: `${this.client.repoOwner}:${branchName}`,
      state: "all",
    });

    if (data.length === 0) {
      return null;
    }

    // Return the most recent PR
    return this.toPullRequest(data[0]);
  }

  /**
   * List all open PRs
   */
  async listOpen(): Promise<PullRequest[]> {
    const { data } = await this.client.api.pulls.list({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      state: "open",
      per_page: 100,
    });

    return data.map((pr) => this.toPullRequest(pr));
  }

  /**
   * List all open PRs with full review/check details
   */
  async listOpenEnriched(): Promise<PullRequest[]> {
    const { data } = await this.client.api.pulls.list({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      state: "open",
      per_page: 100,
    });

    return Promise.all(data.map((pr) => this.enrichPR(pr)));
  }

  /**
   * Get reviews for a PR
   */
  async getReviews(prNumber: number): Promise<Review[]> {
    const { data } = await this.client.api.pulls.listReviews({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_number: prNumber,
      per_page: 100,
    });

    return data.map((review) => ({
      id: review.id,
      user: {
        login: review.user?.login ?? "unknown",
      },
      state: review.state as Review["state"],
      submitted_at: review.submitted_at ?? new Date().toISOString(),
    }));
  }

  /**
   * Get check status for a PR
   */
  async getCheckStatus(ref: string): Promise<CheckStatus> {
    const params = { owner: this.client.repoOwner, repo: this.client.repoName, ref };
    // CI reports through check runs (Actions) or commit statuses (many external services).
    const [runs, statuses] = await Promise.all([
      this.client.api.checks
        .listForRef({ ...params, per_page: 100 })
        .then(({ data }) => data.check_runs)
        .catch(() => []),
      this.client.api.repos
        .getCombinedStatusForRef({ ...params, per_page: 100 })
        .then(({ data }) => data.statuses)
        .catch(() => []),
    ]);

    let passed = 0;
    let failed = 0;
    let pending = 0;
    for (const run of runs) {
      if (run.status !== "completed") pending++;
      else if (["success", "neutral", "skipped"].includes(run.conclusion ?? "")) passed++;
      else failed++;
    }
    for (const status of statuses) {
      if (status.state === "pending") pending++;
      else if (status.state === "success") passed++;
      else failed++;
    }

    const total = runs.length + statuses.length;
    let state: CheckStatus["state"] = null;
    if (total > 0) {
      state = pending > 0 ? "pending" : failed > 0 ? "failure" : "success";
    }
    return { state, total, passed, failed, pending };
  }

  /**
   * Resolves what a command should act on: a PR number (`42`, `#42`), a PR URL,
   * or a branch name (open PR first, then the most recent closed or merged one).
   */
  async resolve(target: string): Promise<PullRequest> {
    const number = parsePRNumber(target);
    if (number !== null) {
      return this.get(number);
    }
    const pr = (await this.findByBranch(target)) ?? (await this.findByBranchAnyState(target));
    if (!pr) {
      throw new PileGitHubError(
        "PR_NOT_FOUND",
        `No pull request found for "${target}"`,
        "Pass a PR number, a PR URL, or a branch that has a PR (run `pile submit` to create one).",
      );
    }
    return pr;
  }

  /**
   * Merge a PR. GitHub rejects the classic merge endpoint for PRs in a native stack;
   * those fall back to the asynchronous endpoint (which merges the PRs below too).
   */
  async merge(
    prNumber: number,
    method: "merge" | "squash" | "rebase" = "squash"
  ): Promise<void> {
    try {
      await this.client.api.pulls.merge({
        owner: this.client.repoOwner,
        repo: this.client.repoName,
        pull_number: prNumber,
        merge_method: method,
      });
    } catch (error) {
      if (errorStatus(error) === 403 && /asynchronous merge endpoint/i.test(errorMessage(error))) {
        await this.mergeAsyncAndWait(prNumber, method);
        return;
      }
      throw error;
    }
  }

  /**
   * Requests a merge through GitHub's asynchronous endpoint. For a PR in a native
   * stack, every open PR below it is merged in the same atomic operation.
   */
  async mergeAsync(
    prNumber: number,
    method: "merge" | "squash" | "rebase" = "squash",
    sha?: string,
  ): Promise<AsyncMergeResult> {
    try {
      const { data } = await this.client.api.request(
        "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async",
        {
          owner: this.client.repoOwner,
          repo: this.client.repoName,
          pull_number: prNumber,
          merge_method: method,
          ...(sha ? { sha } : {}),
        },
      );
      return this.toAsyncResult(data);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 409) {
        throw new PileGitHubError(
          "MERGE_IN_PROGRESS",
          `A merge of PR #${prNumber} is already in progress.`,
          "Wait for it to finish, then run `pile sync`.",
          { cause: error },
        );
      }
      if (status === 400 || status === 422) {
        throw new PileGitHubError(
          "MERGE_REJECTED",
          `GitHub refused to merge PR #${prNumber}: ${errorMessage(error)}`,
          "Run `pile status` to see what blocks it.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async getAsyncMergeResult(prNumber: number, uuid: string): Promise<AsyncMergeResult> {
    const { data } = await this.client.api.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}",
      {
        owner: this.client.repoOwner,
        repo: this.client.repoName,
        pull_number: prNumber,
        uuid,
      },
    );
    return this.toAsyncResult(data);
  }

  /**
   * Merges asynchronously and polls until GitHub reports merged, enqueued (merge
   * queue) or failed. Failure and timeout throw with a stable code.
   */
  async mergeAsyncAndWait(
    prNumber: number,
    method: "merge" | "squash" | "rebase" = "squash",
    options: AsyncMergeOptions = {},
  ): Promise<AsyncMergeResult> {
    const { timeoutMs = 180_000, intervalMs = 1_500, onPoll } = options;
    let result = await this.mergeAsync(prNumber, method, options.sha);
    const deadline = Date.now() + timeoutMs;

    while (result.status === "pending") {
      onPoll?.(result);
      if (Date.now() >= deadline) {
        throw new PileGitHubError(
          "MERGE_PENDING",
          `GitHub is still merging PR #${prNumber}.`,
          "Check the PR on GitHub, then run `pile sync` once it has merged.",
        );
      }
      await sleep(intervalMs);
      if (!result.uuid) break;
      result = await this.getAsyncMergeResult(prNumber, result.uuid);
    }

    if (result.status === "failed") {
      throw new PileGitHubError(
        "MERGE_FAILED",
        `GitHub could not merge PR #${prNumber}${result.message ? `: ${result.message}` : ""}`,
        "Run `pile status` for details.",
      );
    }
    return result;
  }

  private toAsyncResult(data: unknown): AsyncMergeResult {
    const body = (data ?? {}) as {
      status?: AsyncMergeResult["status"];
      details?: { uuid?: string; message?: string; sha?: string };
    };
    return {
      // A 200 without a status means the PR was already merged.
      status: body.status ?? "merged",
      uuid: body.details?.uuid,
      message: body.details?.message,
      sha: body.details?.sha,
    };
  }

  /** Numbers of the PRs in a native stack that are merged. */
  async getMergedInStack(stackNumber: number): Promise<Array<{ number: number; branch: string }>> {
    const { data } = await this.client.api.request("GET /repos/{owner}/{repo}/stacks/{stack_number}", {
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      stack_number: stackNumber,
    });
    const stack = data as { pull_requests?: Array<{ number: number; merged_at: string | null; head: { ref: string } }> };
    return (stack.pull_requests ?? [])
      .filter((pr) => pr.merged_at)
      .map((pr) => ({ number: pr.number, branch: pr.head.ref }));
  }

  /** A native GitHub stack's pull requests, bottom first. */
  async getStack(stackNumber: number): Promise<NativeStack> {
    const { data } = await this.client.api.request("GET /repos/{owner}/{repo}/stacks/{stack_number}", {
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      stack_number: stackNumber,
    });
    return toNativeStack(data);
  }

  /** Makes a native GitHub stack of these PRs, bottom first; each must be based on the one before. */
  async createStack(prNumbers: number[]): Promise<NativeStack> {
    const { data } = await this.client.api.request("POST /repos/{owner}/{repo}/stacks", {
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_requests: prNumbers,
    });
    return toNativeStack(data);
  }

  /** Puts these PRs on top of a native stack; the first must be based on its top PR. */
  async addToStack(stackNumber: number, prNumbers: number[]): Promise<NativeStack> {
    const { data } = await this.client.api.request("POST /repos/{owner}/{repo}/stacks/{stack_number}/add", {
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      stack_number: stackNumber,
      pull_requests: prNumbers,
    });
    return toNativeStack(data);
  }

  /** Takes the unmerged PRs out of a native stack (dissolving it when none are merged). */
  async unstack(stackNumber: number): Promise<void> {
    await this.client.api.request("POST /repos/{owner}/{repo}/stacks/{stack_number}/unstack", {
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      stack_number: stackNumber,
    });
  }

  /**
   * Request reviewers for a PR
   */
  async requestReviewers(
    prNumber: number,
    reviewers: string[],
    teamReviewers?: string[]
  ): Promise<void> {
    await this.client.api.pulls.requestReviewers({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_number: prNumber,
      reviewers,
      team_reviewers: teamReviewers,
    });
  }

  /**
   * Set labels on a PR (replaces existing labels)
   */
  async setLabels(prNumber: number, labels: string[]): Promise<void> {
    await this.client.api.issues.setLabels({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      issue_number: prNumber,
      labels,
    });
  }

  /**
   * Add labels to a PR (keeps existing labels)
   */
  async addLabels(prNumber: number, labels: string[]): Promise<void> {
    await this.client.api.issues.addLabels({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      issue_number: prNumber,
      labels,
    });
  }

  /**
   * Set assignees on a PR
   */
  async setAssignees(prNumber: number, assignees: string[]): Promise<void> {
    // First remove existing assignees, then add new ones
    const pr = await this.get(prNumber);
    const currentAssignees = pr.assignees?.map((a) => a.login) ?? [];

    if (currentAssignees.length > 0) {
      await this.client.api.issues.removeAssignees({
        owner: this.client.repoOwner,
        repo: this.client.repoName,
        issue_number: prNumber,
        assignees: currentAssignees,
      });
    }

    if (assignees.length > 0) {
      await this.client.api.issues.addAssignees({
        owner: this.client.repoOwner,
        repo: this.client.repoName,
        issue_number: prNumber,
        assignees,
      });
    }
  }

  /**
   * Create a review on a PR
   */
  async createReview(
    prNumber: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string
  ): Promise<void> {
    await this.client.api.pulls.createReview({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_number: prNumber,
      event,
      body,
    });
  }

  /**
   * Convert PR to draft. GitHub only supports this through GraphQL.
   */
  async convertToDraft(prNumber: number): Promise<void> {
    return withGraphQL("Converting a pull request to draft", () => this.setDraft(prNumber, true));
  }

  /**
   * Mark PR as ready for review. GitHub only supports this through GraphQL.
   */
  async markReadyForReview(prNumber: number): Promise<void> {
    return withGraphQL("Marking a pull request ready for review", () => this.setDraft(prNumber, false));
  }

  private async setDraft(prNumber: number, draft: boolean): Promise<void> {
    // Get the PR node ID first
    const { data: pr } = await this.client.api.pulls.get({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_number: prNumber,
    });

    const mutation = draft
      ? "convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id } }"
      : "markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } }";
    await this.client.api.graphql(`mutation($id: ID!) { ${mutation} }`, { id: pr.node_id });
  }

  /**
   * Convert raw PR data to PullRequest without fetching reviews/checks
   */
  private toPullRequest(pr: RawPullRequest): PullRequest {
    const isMerged = pr.merged === true || pr.merged_at != null;

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state as PullRequest["state"],
      draft: pr.draft ?? false,
      head: pr.head,
      base: pr.base,
      html_url: pr.html_url,
      mergeable: pr.mergeable ?? null,
      mergeable_state: pr.mergeable_state ?? "",
      merged: isMerged,
      merged_at: pr.merged_at ?? null,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      user: {
        login: pr.user?.login ?? "unknown",
      },
      assignees: pr.assignees?.map((a) => ({ login: a.login })) ?? undefined,
      labels: pr.labels?.map((l) => ({ name: l.name })) ?? undefined,
      reviews: [],
      checks: { state: null, total: 0, passed: 0, failed: 0, pending: 0 },
      ...(pr.stack
        ? {
            stack: {
              number: pr.stack.number,
              position: pr.stack.position,
              size: pr.stack.size,
              base: pr.stack.base?.ref ?? "",
            },
          }
        : {}),
    };
  }

  /**
   * Enrich PR data with reviews and checks
   */
  private async enrichPR(pr: RawPullRequest): Promise<PullRequest> {
    const [reviews, checks] = await Promise.all([
      this.getReviews(pr.number),
      this.getCheckStatus(pr.head.sha),
    ]);
    return { ...this.toPullRequest(pr), reviews, checks };
  }
}

export function createPROperations(client: GitHubClient): PROperations {
  return new PROperations(client);
}

/** A native GitHub stack, as pile uses it. */
export interface NativeStack {
  number: number;
  /** Bottom first. */
  pullRequests: Array<{ number: number; branch: string; merged: boolean }>;
}

function toNativeStack(data: unknown): NativeStack {
  const stack = data as { number: number; pull_requests?: Array<{ number: number; merged_at: string | null; head: { ref: string } }> };
  return {
    number: stack.number,
    pullRequests: (stack.pull_requests ?? []).map((pr) => ({ number: pr.number, branch: pr.head.ref, merged: !!pr.merged_at })),
  };
}

