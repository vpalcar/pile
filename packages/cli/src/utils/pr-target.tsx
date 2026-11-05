import React from "react";
import { Box, Text } from "ink";
import { createPile, PileInstance } from "@pile/core";
import { createGitHub, GitHubInstance, PullRequest, parsePRNumber } from "@pile/github";
import { CommandError, OutputOptions, exitWithError, toCommandError } from "./output.js";
import { ErrorMessage } from "../components/Message.js";

/**
 * Shared target handling for commands that act on a pull request
 * (status, close, edit, request, merge): a branch name, PR number, #number or
 * PR URL, defaulting to the current branch.
 */

/** A failure with a stable code, raised while resolving what a command acts on. */
export class CommandFailure extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "CommandFailure";
    this.code = code;
    this.hint = hint;
  }
}

export function toFailure(error: unknown): CommandError {
  if (error instanceof CommandFailure) {
    return { code: error.code, message: error.message, hint: error.hint };
  }
  return toCommandError(error);
}

/**
 * Reports a failure: JSON or stderr plus exit code 1 when nobody is watching a
 * rendered UI, otherwise returns the error for the component to render.
 */
export function reportFailure(options: OutputOptions, error: unknown): CommandError {
  const failure = toFailure(error);
  if (options.json || !options.interactive) {
    exitWithError(options, failure);
  }
  process.exitCode = 1;
  return failure;
}

export const notInitialized = () =>
  new CommandFailure("NOT_INITIALIZED", "Pile not initialized", "Run `pile init` first.");

export const onTrunk = (trunk: string) =>
  new CommandFailure(
    "ON_TRUNK",
    `On trunk branch (${trunk}), no PR to act on`,
    "Check out a stacked branch, or pass a branch, PR number or URL.",
  );

export const noGitHub = () =>
  new CommandFailure(
    "NO_GITHUB",
    "GitHub not configured",
    "Pile needs a GitHub remote and a token: set GITHUB_TOKEN or run `gh auth login`.",
  );

export interface PRContext {
  pile: PileInstance;
  github: GitHubInstance;
  trunk: string;
  currentBranch: string;
}

/**
 * Opens pile and GitHub for a PR command. Without a target, being on trunk fails
 * with ON_TRUNK before GitHub is contacted.
 */
export async function openPRContext(target: string | undefined): Promise<PRContext> {
  const pile = await createPile();
  if (!pile.state.isInitialized()) throw notInitialized();

  const trunk = pile.stack.getTrunk();
  const currentBranch = await pile.git.getCurrentBranch();
  if (!target && currentBranch === trunk) throw onTrunk(trunk);

  const github = await createGitHub(pile);
  if (!github) throw noGitHub();

  return { pile, github, trunk, currentBranch };
}

/**
 * A PR with reviews and checks, in as few round trips as possible: the PR, its
 * reviews and (when the head branch is known) its checks are requested together.
 * Checks are looked up by branch name, which GitHub resolves to the PR head.
 */
async function fetchEnriched(
  github: GitHubInstance,
  number: number,
  options: { branch?: string; headSha?: string } = {},
): Promise<PullRequest> {
  const checksRef = options.headSha ?? options.branch;
  const [pr, reviews, earlyChecks] = await Promise.all([
    github.prs.get(number),
    github.prs.getReviews(number),
    checksRef ? github.prs.getCheckStatus(checksRef) : Promise.resolve(null),
  ]);
  const checksMatch =
    earlyChecks && (options.headSha ? pr.head.sha === options.headSha : pr.head.ref === options.branch);
  const checks = checksMatch ? earlyChecks : await github.prs.getCheckStatus(pr.head.sha);
  return { ...pr, reviews, checks };
}

/**
 * Finds the PR for `target` (default: current branch). For branches, the PR number
 * pile stored at submit time wins, since it survives branch renames; otherwise the
 * PR is looked up on GitHub (open first, then closed or merged).
 */
export async function resolveTargetPR(
  context: PRContext,
  target: string | undefined,
  options: { enriched?: boolean } = {},
): Promise<{ pr: PullRequest; branch: string }> {
  const { pile, github } = context;
  const branch = target ?? context.currentBranch;
  const number = parsePRNumber(branch);

  if (number === null) {
    const stored = pile.state.getBranchRelationship(branch)?.prNumber;
    if (stored) {
      try {
        const pr = options.enriched
          ? await fetchEnriched(github, stored, { branch })
          : await github.prs.get(stored);
        return { pr, branch };
      } catch {
        // The stored PR may have been deleted or belong to another repo.
      }
    }
  } else if (options.enriched) {
    const pr = await fetchEnriched(github, number);
    return { pr, branch: pr.head.ref };
  }

  const found = await github.prs.resolve(branch);
  const pr = options.enriched
    ? await fetchEnriched(github, found.number, { headSha: found.head.sha })
    : found;
  return { pr, branch: number === null ? branch : pr.head.ref };
}

/** Renders a failure the same way in every PR command: message, then the hint. */
export function FailureMessage({ failure }: { failure: CommandError }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <ErrorMessage>{failure.message}</ErrorMessage>
      {failure.hint && <Text color="gray">  {failure.hint}</Text>}
    </Box>
  );
}
