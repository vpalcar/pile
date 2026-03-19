export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed" | "merged";
  draft: boolean;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
    sha: string;
  };
  html_url: string;
  mergeable: boolean | null;
  mergeable_state: string;
  merged: boolean;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  user: {
    login: string;
  };
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviews: Review[];
  checks: CheckStatus;
}

export interface Review {
  id: number;
  user: {
    login: string;
  };
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | "DISMISSED";
  submitted_at: string;
}

export interface CheckStatus {
  state: "pending" | "success" | "failure" | "error" | null;
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface CreatePRParams {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface UpdatePRParams {
  number: number;
  title?: string;
  body?: string;
  base?: string;
  state?: "open" | "closed";
}

export type PRStatus =
  | "draft"
  | "open"
  | "approved"
  | "changes_requested"
  | "merged"
  | "closed";

export function getPRStatus(pr: PullRequest): PRStatus {
  if (pr.merged) {
    return "merged";
  }
  if (pr.state === "closed") {
    return "closed";
  }
  if (pr.draft) {
    return "draft";
  }

  // Check reviews for approval status
  const latestReviews = new Map<string, Review>();
  for (const review of pr.reviews) {
    const existing = latestReviews.get(review.user.login);
    if (!existing || new Date(review.submitted_at) > new Date(existing.submitted_at)) {
      latestReviews.set(review.user.login, review);
    }
  }

  const hasApproval = Array.from(latestReviews.values()).some(
    (r) => r.state === "APPROVED"
  );
  const hasChangesRequested = Array.from(latestReviews.values()).some(
    (r) => r.state === "CHANGES_REQUESTED"
  );

  if (hasChangesRequested) {
    return "changes_requested";
  }
  if (hasApproval) {
    return "approved";
  }

  return "open";
}
