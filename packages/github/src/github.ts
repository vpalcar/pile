import { GitHubClient, createGitHubClient, getGitHubConfig } from "./client.js";
import { PROperations, createPROperations } from "./pr.js";
import { PRCacheManager, createPRCacheManager } from "./cache.js";

export interface GitHubInstance {
  client: GitHubClient;
  prs: PROperations;
  cache: PRCacheManager;
}

export async function createGitHub(pileDir: string): Promise<GitHubInstance | null> {
  const config = await getGitHubConfig();
  if (!config) {
    return null;
  }

  const client = createGitHubClient(config);
  const prs = createPROperations(client);
  const cache = createPRCacheManager(pileDir);

  return { client, prs, cache };
}
