import { Octokit } from "@octokit/rest";
import { execFileSync } from "node:child_process";
import { runGit } from "@pile/core";
import { GitHubConfig } from "./types.js";

/** Per-request timeout, so a stalled connection fails instead of hanging the CLI. */
const REQUEST_TIMEOUT_MS = 20_000;

/** REST API version pinned for every request (stacks and other recent endpoints need it). */
export const GITHUB_API_VERSION = "2026-03-10";

/** Octokit's own line per failed request: "GET /repos/... - 304 with id ... in 361ms". */
const REQUEST_LOG = /^(GET|HEAD|POST|PUT|PATCH|DELETE) \S+ - \d{3} with id /;

export function createOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    userAgent: "pile-cli",
    // Octokit prints every non-2xx response as an error, including the 304s that ETag
    // caching relies on and errors pile already reports in its own words. Those lines
    // are dropped; everything else still goes to the console.
    log: {
      debug: () => {},
      info: () => {},
      warn: console.warn,
      error: (message: string, ...rest: unknown[]) => {
        if (typeof message === "string" && REQUEST_LOG.test(message)) return;
        console.error(message, ...rest);
      },
    },
    request: {
      fetch: (url: string | URL | Request, init?: RequestInit) =>
        fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    },
    headers: { "x-github-api-version": GITHUB_API_VERSION },
  });
}

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(config: GitHubConfig) {
    this.octokit = config.octokit ?? createOctokit(config.token);
    this.owner = config.owner;
    this.repo = config.repo;
  }

  get api(): Octokit {
    return this.octokit;
  }

  get repoOwner(): string {
    return this.owner;
  }

  get repoName(): string {
    return this.repo;
  }
}

/**
 * Get GitHub token from various sources:
 * 1. GITHUB_TOKEN environment variable
 * 2. GH_TOKEN environment variable
 * 3. gh CLI auth token
 */
export function getGitHubToken(): string | null {
  // Check environment variables first
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }
  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }

  // Try to get token from gh CLI
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) {
      return token;
    }
  } catch {
    // gh CLI not available or not authenticated
  }

  return null;
}

/**
 * Parse owner and repo from git remote URL
 */
export function parseGitRemote(remoteUrl: string): { owner: string; repo: string } | null {
  // git@github.com:owner/repo.git, ssh://git@github.com/owner/repo.git,
  // https://github.com/owner/repo(.git), https://user@github.com/owner/repo
  const match = remoteUrl
    .trim()
    .match(/^(?:git@github\.com:|(?:ssh|https?|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/)([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!match) {
    return null;
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Get GitHub config from the current git repository
 */
export async function getGitHubConfig(
  repoPath?: string,
  remote = "origin",
): Promise<GitHubConfig | null> {
  const token = getGitHubToken();
  if (!token) {
    return null;
  }

  try {
    const url = await runGit(["remote", "get-url", remote], { cwd: repoPath });
    const parsed = parseGitRemote(url);
    return parsed ? { token, owner: parsed.owner, repo: parsed.repo } : null;
  } catch {
    return null;
  }
}

export function createGitHubClient(config: GitHubConfig): GitHubClient {
  return new GitHubClient(config);
}

export interface CreateRepoOptions {
  name: string;
  description?: string;
  private?: boolean;
  org?: string; // If provided, create in this org instead of personal account
}

export interface CreateRepoResult {
  owner: string;
  repo: string;
  url: string;
  sshUrl: string;
  httpsUrl: string;
}

export interface GitHubOrg {
  login: string;
  name: string | null;
}

export interface GitHubUser {
  login: string;
  name: string | null;
  orgs: GitHubOrg[];
}

/**
 * Get current user info and their organizations
 */
export async function getGitHubUserInfo(token: string): Promise<GitHubUser> {
  const octokit = createOctokit(token);

  const [userResponse, orgsResponse] = await Promise.all([
    octokit.users.getAuthenticated(),
    octokit.orgs.listForAuthenticatedUser(),
  ]);

  return {
    login: userResponse.data.login,
    name: userResponse.data.name,
    orgs: orgsResponse.data.map((org) => ({
      login: org.login,
      name: org.description ?? null,
    })),
  };
}

/**
 * Create a new GitHub repository
 */
export async function createGitHubRepo(
  token: string,
  options: CreateRepoOptions
): Promise<CreateRepoResult> {
  const octokit = createOctokit(token);

  let data;
  if (options.org) {
    // Create in organization
    const response = await octokit.repos.createInOrg({
      org: options.org,
      name: options.name,
      description: options.description,
      private: options.private ?? false,
      auto_init: false,
    });
    data = response.data;
  } else {
    // Create in personal account
    const response = await octokit.repos.createForAuthenticatedUser({
      name: options.name,
      description: options.description,
      private: options.private ?? false,
      auto_init: false,
    });
    data = response.data;
  }

  return {
    owner: data.owner.login,
    repo: data.name,
    url: data.html_url,
    sshUrl: data.ssh_url,
    httpsUrl: data.clone_url,
  };
}
