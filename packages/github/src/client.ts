import { Octokit } from "@octokit/rest";
import { execSync } from "node:child_process";
import simpleGit from "simple-git";
import { GitHubConfig } from "./types.js";

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(config: GitHubConfig) {
    this.octokit = new Octokit({ auth: config.token });
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
    const token = execSync("gh auth token", { encoding: "utf-8" }).trim();
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
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

/**
 * Get GitHub config from the current git repository
 */
export async function getGitHubConfig(repoPath?: string): Promise<GitHubConfig | null> {
  const token = getGitHubToken();
  if (!token) {
    return null;
  }

  try {
    const git = simpleGit(repoPath);
    const remotes = await git.remote(["-v"]);
    if (!remotes) {
      return null;
    }

    // Find origin remote
    const match = remotes.match(/origin\s+(\S+)/);
    if (!match) {
      return null;
    }

    const parsed = parseGitRemote(match[1]);
    if (!parsed) {
      return null;
    }

    return {
      token,
      owner: parsed.owner,
      repo: parsed.repo,
    };
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
}

export interface CreateRepoResult {
  owner: string;
  repo: string;
  url: string;
  sshUrl: string;
  httpsUrl: string;
}

/**
 * Create a new GitHub repository
 */
export async function createGitHubRepo(
  token: string,
  options: CreateRepoOptions
): Promise<CreateRepoResult> {
  const octokit = new Octokit({ auth: token });

  const { data } = await octokit.repos.createForAuthenticatedUser({
    name: options.name,
    description: options.description,
    private: options.private ?? false,
    auto_init: false,
  });

  return {
    owner: data.owner.login,
    repo: data.name,
    url: data.html_url,
    sshUrl: data.ssh_url,
    httpsUrl: data.clone_url,
  };
}
