import { GitHubClient } from "./client.js";
import {
  PullRequest,
  Review,
  CheckStatus,
  CreatePRParams,
  UpdatePRParams,
} from "./types.js";

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
    try {
      const { data } = await this.client.api.checks.listForRef({
        owner: this.client.repoOwner,
        repo: this.client.repoName,
        ref,
      });

      const checks = data.check_runs;
      const total = checks.length;
      const passed = checks.filter((c) => c.conclusion === "success").length;
      const failed = checks.filter(
        (c) => c.conclusion === "failure" || c.conclusion === "cancelled"
      ).length;
      const pending = checks.filter(
        (c) => c.status === "in_progress" || c.status === "queued"
      ).length;

      let state: CheckStatus["state"] = null;
      if (total === 0) {
        state = null;
      } else if (pending > 0) {
        state = "pending";
      } else if (failed > 0) {
        state = "failure";
      } else if (passed === total) {
        state = "success";
      } else {
        state = "error";
      }

      return { state, total, passed, failed, pending };
    } catch {
      return { state: null, total: 0, passed: 0, failed: 0, pending: 0 };
    }
  }

  /**
   * Merge a PR
   */
  async merge(
    prNumber: number,
    method: "merge" | "squash" | "rebase" = "squash"
  ): Promise<void> {
    await this.client.api.pulls.merge({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_number: prNumber,
      merge_method: method,
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
   * Convert PR to draft (requires GraphQL)
   */
  async convertToDraft(prNumber: number): Promise<void> {
    // Get the PR node ID first
    const { data: pr } = await this.client.api.pulls.get({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_number: prNumber,
    });

    const nodeId = pr.node_id;

    await this.client.api.graphql(
      `mutation($id: ID!) {
        convertPullRequestToDraft(input: { pullRequestId: $id }) {
          pullRequest { id }
        }
      }`,
      { id: nodeId }
    );
  }

  /**
   * Mark PR as ready for review (requires GraphQL)
   */
  async markReadyForReview(prNumber: number): Promise<void> {
    // Get the PR node ID first
    const { data: pr } = await this.client.api.pulls.get({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_number: prNumber,
    });

    const nodeId = pr.node_id;

    await this.client.api.graphql(
      `mutation($id: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $id }) {
          pullRequest { id }
        }
      }`,
      { id: nodeId }
    );
  }

  /**
   * Convert raw PR data to PullRequest without fetching reviews/checks
   */
  private toPullRequest(pr: {
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
  }): PullRequest {
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
    };
  }

  /**
   * Enrich PR data with reviews and checks
   */
  private async enrichPR(pr: {
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
  }): Promise<PullRequest> {
    const reviews = await this.getReviews(pr.number);
    const checks = await this.getCheckStatus(pr.head.sha);

    // If merged_at exists, the PR was merged (list endpoint may not include merged field)
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
      reviews,
      checks,
    };
  }
}

export function createPROperations(client: GitHubClient): PROperations {
  return new PROperations(client);
}
