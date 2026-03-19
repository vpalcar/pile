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

    return this.enrichPR(data);
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

    return this.enrichPR(data);
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

    return this.enrichPR(data);
  }

  /**
   * Find PR for a specific branch
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

    return this.enrichPR(data[0]);
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
  async requestReviewers(prNumber: number, reviewers: string[]): Promise<void> {
    await this.client.api.pulls.requestReviewers({
      owner: this.client.repoOwner,
      repo: this.client.repoName,
      pull_number: prNumber,
      reviewers,
    });
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
  }): Promise<PullRequest> {
    const reviews = await this.getReviews(pr.number);
    const checks = await this.getCheckStatus(pr.head.sha);

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
      merged: pr.merged ?? false,
      merged_at: pr.merged_at ?? null,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      user: {
        login: pr.user?.login ?? "unknown",
      },
      reviews,
      checks,
    };
  }
}

export function createPROperations(client: GitHubClient): PROperations {
  return new PROperations(client);
}
