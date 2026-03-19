import * as fs from "node:fs";
import * as path from "node:path";
import { PullRequest, PRStatus, getPRStatus } from "./types.js";

export interface CachedPR {
  number: number;
  branch: string;
  title: string;
  status: PRStatus;
  url: string;
  reviews: number;
  checksState: string | null;
  updatedAt: string;
  cachedAt: string;
}

interface PRCache {
  prs: Record<string, CachedPR>;
  lastSync: string | null;
}

const CACHE_STALE_MINUTES = 5;

export class PRCacheManager {
  private cacheDir: string;
  private cachePath: string;

  constructor(pileDir: string) {
    this.cacheDir = path.join(pileDir, "cache");
    this.cachePath = path.join(this.cacheDir, "prs.json");
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private readCache(): PRCache {
    try {
      if (!fs.existsSync(this.cachePath)) {
        return { prs: {}, lastSync: null };
      }
      const content = fs.readFileSync(this.cachePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return { prs: {}, lastSync: null };
    }
  }

  private writeCache(cache: PRCache): void {
    this.ensureCacheDir();
    fs.writeFileSync(this.cachePath, JSON.stringify(cache, null, 2));
  }

  /**
   * Cache a PR's status
   */
  cachePR(pr: PullRequest): void {
    const cache = this.readCache();

    const cached: CachedPR = {
      number: pr.number,
      branch: pr.head.ref,
      title: pr.title,
      status: getPRStatus(pr),
      url: pr.html_url,
      reviews: pr.reviews.length,
      checksState: pr.checks.state,
      updatedAt: pr.updated_at,
      cachedAt: new Date().toISOString(),
    };

    cache.prs[pr.head.ref] = cached;
    cache.lastSync = new Date().toISOString();

    this.writeCache(cache);
  }

  /**
   * Cache multiple PRs
   */
  cachePRs(prs: PullRequest[]): void {
    const cache = this.readCache();

    for (const pr of prs) {
      cache.prs[pr.head.ref] = {
        number: pr.number,
        branch: pr.head.ref,
        title: pr.title,
        status: getPRStatus(pr),
        url: pr.html_url,
        reviews: pr.reviews.length,
        checksState: pr.checks.state,
        updatedAt: pr.updated_at,
        cachedAt: new Date().toISOString(),
      };
    }

    cache.lastSync = new Date().toISOString();
    this.writeCache(cache);
  }

  /**
   * Get cached PR for a branch
   */
  getCachedPR(branchName: string): CachedPR | null {
    const cache = this.readCache();
    return cache.prs[branchName] ?? null;
  }

  /**
   * Get all cached PRs
   */
  getAllCachedPRs(): CachedPR[] {
    const cache = this.readCache();
    return Object.values(cache.prs);
  }

  /**
   * Check if cache is stale
   */
  isCacheStale(): boolean {
    const cache = this.readCache();
    if (!cache.lastSync) {
      return true;
    }

    const lastSync = new Date(cache.lastSync);
    const now = new Date();
    const diffMinutes = (now.getTime() - lastSync.getTime()) / (1000 * 60);

    return diffMinutes > CACHE_STALE_MINUTES;
  }

  /**
   * Get last sync time
   */
  getLastSync(): Date | null {
    const cache = this.readCache();
    return cache.lastSync ? new Date(cache.lastSync) : null;
  }

  /**
   * Remove a PR from cache
   */
  removePR(branchName: string): void {
    const cache = this.readCache();
    delete cache.prs[branchName];
    this.writeCache(cache);
  }

  /**
   * Clear all cache
   */
  clearCache(): void {
    this.writeCache({ prs: {}, lastSync: null });
  }
}

export function createPRCacheManager(pileDir: string): PRCacheManager {
  return new PRCacheManager(pileDir);
}
