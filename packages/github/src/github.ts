import type { PileInstance } from "@pile/core";
import { GitHubClient, createGitHubClient, getGitHubConfig } from "./client.js";
import { PROperations, createPROperations } from "./pr.js";
import { PRCacheManager, createPRCacheManager } from "./cache.js";

export interface GitHubInstance {
  client: GitHubClient;
  prs: PROperations;
  cache: PRCacheManager;
}

/**
 * Connects to the GitHub repository behind the pile remote. Pass the pile instance
 * so the configured remote and the cache under the git dir are used; a plain path
 * is still accepted as the cache directory for older callers.
 */
export async function createGitHub(source: PileInstance | string): Promise<GitHubInstance | null> {
  const fromPile = typeof source !== "string";
  const config = fromPile
    ? await getGitHubConfig(await source.git.getRepoRoot(), source.git.remoteName)
    : await getGitHubConfig();
  if (!config) {
    return null;
  }

  const client = createGitHubClient(config);
  const prs = createPROperations(client);
  const cache = createPRCacheManager(fromPile ? source.state.getPileDir() : source);

  return { client, prs, cache };
}
