import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { createGitHub, PullRequest, Review, getPRStatus, PRStatus } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import { ErrorMessage } from "../components/Message.js";
import { Link } from "../components/Link.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";
import { formatStatusWithFlair, getStatusEmoji } from "../utils/fun.js";

export interface StatusCommandProps {
  options: OutputOptions;
}

type State =
  | "loading"
  | "success"
  | "no_pr"
  | "no_github"
  | "not_initialized"
  | "on_trunk"
  | "error";

interface StatusData {
  branch: string;
  pr: PullRequest;
  status: PRStatus;
}

function getStatusIcon(status: PRStatus): { icon: string; color: string } {
  switch (status) {
    case "merged":
      return { icon: "✓", color: "magenta" };
    case "approved":
      return { icon: "✓", color: "green" };
    case "changes_requested":
      return { icon: "!", color: "red" };
    case "draft":
      return { icon: "◐", color: "gray" };
    case "closed":
      return { icon: "✗", color: "gray" };
    case "open":
    default:
      return { icon: "○", color: "blue" };
  }
}

function getCheckIcon(state: string | null): { icon: string; color: string } {
  switch (state) {
    case "success":
      return { icon: "✓", color: "green" };
    case "failure":
      return { icon: "✗", color: "red" };
    case "pending":
      return { icon: "◐", color: "yellow" };
    case "error":
      return { icon: "!", color: "red" };
    default:
      return { icon: "○", color: "gray" };
  }
}

function getReviewIcon(state: Review["state"]): { icon: string; color: string } {
  switch (state) {
    case "APPROVED":
      return { icon: "✓", color: "green" };
    case "CHANGES_REQUESTED":
      return { icon: "!", color: "red" };
    case "COMMENTED":
      return { icon: "💬", color: "blue" };
    case "PENDING":
      return { icon: "◐", color: "yellow" };
    case "DISMISSED":
      return { icon: "○", color: "gray" };
    default:
      return { icon: "○", color: "gray" };
  }
}

function formatStatusLabel(status: PRStatus): string {
  switch (status) {
    case "merged":
      return "Merged";
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes Requested";
    case "draft":
      return "Draft";
    case "closed":
      return "Closed";
    case "open":
      return "Open";
    default:
      return status;
  }
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function StatusCommand({
  options,
}: StatusCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("loading");
  const [statusData, setStatusData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadStatus() {
      try {
        const pile = await createPile();

        if (!pile.state.isInitialized()) {
          if (options.json) {
            console.log(
              formatJson(createResult(false, null, "Pile not initialized"))
            );
            process.exit(1);
          }
          setState("not_initialized");
          return;
        }

        const config = pile.state.getConfig();
        const trunk = config?.trunk ?? "main";
        const currentBranch = await pile.git.getCurrentBranch();

        if (currentBranch === trunk) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, "On trunk branch - no PR to show")
              )
            );
            process.exit(1);
          }
          setState("on_trunk");
          return;
        }

        const repoRoot = await pile.git.getRepoRoot();
        const github = await createGitHub(`${repoRoot}/.pile`);

        if (!github) {
          if (options.json) {
            console.log(
              formatJson(createResult(false, null, "GitHub not configured"))
            );
            process.exit(1);
          }
          setState("no_github");
          return;
        }

        // Check stored PR number first (survives renames), then API lookup
        const rel = pile.state.getBranchRelationship(currentBranch);
        let prFromList = null;
        if (rel?.prNumber) {
          try {
            prFromList = await github.prs.get(rel.prNumber);
          } catch {
            // Stored PR might be invalid
          }
        }
        if (!prFromList) {
          prFromList = await github.prs.findByBranchAnyState(currentBranch);
        }

        if (!prFromList) {
          if (options.json) {
            console.log(
              formatJson(
                createResult(false, null, "No PR found for this branch")
              )
            );
            process.exit(1);
          }
          setState("no_pr");
          return;
        }

        // Fetch full PR data to get mergeable status (list doesn't include it)
        const pr = await github.prs.get(prFromList.number);
        const status = getPRStatus(pr);

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                branch: currentBranch,
                pr: {
                  number: pr.number,
                  title: pr.title,
                  url: pr.html_url,
                  status,
                  draft: pr.draft,
                  mergeable: pr.mergeable,
                  author: pr.user.login,
                  createdAt: pr.created_at,
                  updatedAt: pr.updated_at,
                },
                reviews: pr.reviews.map((r) => ({
                  user: r.user.login,
                  state: r.state,
                  submittedAt: r.submitted_at,
                })),
                checks: pr.checks,
              })
            )
          );
          process.exit(0);
        }

        setStatusData({ branch: currentBranch, pr, status });
        setState("success");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(formatJson(createResult(false, null, message)));
          process.exit(1);
        }
        setError(message);
        setState("error");
      }
    }

    loadStatus();
  }, [options.json]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "loading":
      return <Spinner label="Loading PR status..." />;

    case "success":
      if (!statusData) return <></>;
      const { branch, pr, status } = statusData;
      const statusIcon = getStatusIcon(status);
      const checkIcon = getCheckIcon(pr.checks.state);

      // Get unique latest reviews per user
      const latestReviews = new Map<string, Review>();
      for (const review of pr.reviews) {
        const existing = latestReviews.get(review.user.login);
        if (!existing || new Date(review.submitted_at) > new Date(existing.submitted_at)) {
          latestReviews.set(review.user.login, review);
        }
      }
      const reviews = Array.from(latestReviews.values());

      return (
        <Box flexDirection="column">
          {/* Header */}
          <Box marginBottom={1}>
            <Text color={statusIcon.color} bold>
              {statusIcon.icon}
            </Text>
            <Text> </Text>
            <Text bold>PR #{pr.number}</Text>
            <Text> </Text>
            <Text color={statusIcon.color}>{formatStatusLabel(status)}</Text>
          </Box>

          {/* Title */}
          <Box marginBottom={1}>
            <Text>  {pr.title}</Text>
          </Box>

          {/* Branch info */}
          <Box marginBottom={1}>
            <Text color="gray">  </Text>
            <Text color="cyan">{branch}</Text>
            <Text color="gray"> → </Text>
            <Text color="green">{pr.base.ref}</Text>
          </Box>

          {/* Link */}
          <Box marginBottom={1}>
            <Text>  </Text>
            <Link url={pr.html_url}>{pr.html_url}</Link>
          </Box>

          {/* Divider */}
          <Box marginBottom={1}>
            <Text color="gray">  ─────────────────────────────────────────</Text>
          </Box>

          {/* CI Checks */}
          <Box flexDirection="column" marginBottom={1}>
            <Box>
              <Text color="gray">  </Text>
              <Text bold>CI Checks</Text>
            </Box>
            {pr.checks.total === 0 ? (
              <Box>
                <Text color="gray">    No checks configured</Text>
              </Box>
            ) : (
              <Box>
                <Text color="gray">    </Text>
                <Text color={checkIcon.color}>{checkIcon.icon}</Text>
                <Text> </Text>
                <Text color={checkIcon.color}>
                  {pr.checks.state === "success"
                    ? "All checks passed"
                    : pr.checks.state === "failure"
                    ? "Some checks failed"
                    : pr.checks.state === "pending"
                    ? "Checks in progress"
                    : "Unknown"}
                </Text>
                <Text color="gray">
                  {" "}({pr.checks.passed}/{pr.checks.total} passed
                  {pr.checks.pending > 0 && `, ${pr.checks.pending} pending`}
                  {pr.checks.failed > 0 && `, ${pr.checks.failed} failed`})
                </Text>
              </Box>
            )}
          </Box>

          {/* Reviews */}
          <Box flexDirection="column" marginBottom={1}>
            <Box>
              <Text color="gray">  </Text>
              <Text bold>Reviews</Text>
            </Box>
            {reviews.length === 0 ? (
              <Box>
                <Text color="gray">    No reviews yet</Text>
              </Box>
            ) : (
              reviews.map((review) => {
                const reviewIcon = getReviewIcon(review.state);
                return (
                  <Box key={review.id}>
                    <Text color="gray">    </Text>
                    <Text color={reviewIcon.color}>{reviewIcon.icon}</Text>
                    <Text> </Text>
                    <Text bold>{review.user.login}</Text>
                    <Text color="gray"> • </Text>
                    <Text color={reviewIcon.color}>
                      {review.state === "APPROVED"
                        ? "Approved"
                        : review.state === "CHANGES_REQUESTED"
                        ? "Changes requested"
                        : review.state === "COMMENTED"
                        ? "Commented"
                        : review.state}
                    </Text>
                    <Text color="gray"> • {formatTimeAgo(review.submitted_at)}</Text>
                  </Box>
                );
              })
            )}
          </Box>

          {/* Mergeable status */}
          <Box flexDirection="column">
            <Box>
              <Text color="gray">  </Text>
              <Text bold>Merge Status</Text>
            </Box>
            <Box>
              <Text color="gray">    </Text>
              {pr.mergeable === true ? (
                <>
                  <Text color="green">✓</Text>
                  <Text> Ready to merge</Text>
                </>
              ) : pr.mergeable === false ? (
                <>
                  <Text color="red">✗</Text>
                  <Text> </Text>
                  <Text color="red">
                    {pr.mergeable_state === "dirty"
                      ? "Has conflicts"
                      : pr.mergeable_state === "blocked"
                      ? "Blocked by requirements"
                      : "Cannot merge"}
                  </Text>
                </>
              ) : (
                <>
                  <Text color="yellow">◐</Text>
                  <Text color="gray"> Checking...</Text>
                </>
              )}
            </Box>
          </Box>

          {/* Footer with timestamps */}
          <Box marginTop={1}>
            <Text color="gray">
              {"  "}Created {formatTimeAgo(pr.created_at)} • Updated{" "}
              {formatTimeAgo(pr.updated_at)}
            </Text>
          </Box>

          {/* Fun status flair */}
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              {"  "}{getStatusEmoji(status)} {formatStatusWithFlair(status).subtext}
            </Text>
          </Box>
        </Box>
      );

    case "no_pr":
      return (
        <Box flexDirection="column">
          <Text color="yellow">○ No PR</Text>
          <Text color="gray">  No pull request found for this branch.</Text>
          <Text color="gray">  Run `pile submit` to create one.</Text>
        </Box>
      );

    case "on_trunk":
      return (
        <Box flexDirection="column">
          <Text color="gray">On trunk branch - no PR to show.</Text>
          <Text color="gray">Checkout a feature branch to see its status.</Text>
        </Box>
      );

    case "no_github":
      return (
        <Box flexDirection="column">
          <ErrorMessage>GitHub not configured</ErrorMessage>
          <Text color="gray">
            Set GITHUB_TOKEN environment variable or run `gh auth login`
          </Text>
        </Box>
      );

    case "not_initialized":
      return (
        <ErrorMessage>Pile not initialized. Run `pile init` first.</ErrorMessage>
      );

    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;

    default:
      return <></>;
  }
}
