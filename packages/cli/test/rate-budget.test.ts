import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPile } from "@pile/core";
import { ReviewService } from "../src/review/service.js";
import { fakeGitHub } from "./fake-github.js";
import { createCliRepo } from "./helpers.js";

/** Waits until the service stops making requests (background refreshes included). */
async function settle(count: () => number) {
  let last = -1;
  let still = 0;
  while (still < 4) {
    await new Promise((r) => setTimeout(r, 25));
    still = count() === last ? still + 1 : 0;
    last = count();
  }
}

afterEach(() => vi.useRealTimers());

async function setup(graphql: boolean, prs = 60) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
  const fake = fakeGitHub({ prs, graphql });
  const { github, tick } = fake;
  const pile = await createPile(createCliRepo().dir);
  const cacheFile = join(mkdtempSync(join(tmpdir(), "pile-etags-")), "review-cache.json");
  const service = new ReviewService(pile, github, { cacheFile });
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  /** A new `pile review` process on the same repo, with the cache from disk. */
  const restart = () => new ReviewService(pile, fake.client(), { cacheFile });
  return { service, advance, tick, restart };
}

/**
 * Startup, an inbox left open for 10 minutes (polled every 30s while the repo
 * changes), a PR page with running checks for 2 minutes (polled every 8s), and a
 * restart. Returns REST requests that count, and GraphQL points, for each.
 */
async function measure(graphql: boolean) {
  const { service, advance, tick, restart } = await setup(graphql);
  const rest = () => service.usage()!.counted;
  const points = () => service.usage()!.graphql.points;
  const both = () => rest() + points();
  const out: Record<string, { rest: number; points: number }> = {};
  const phase = async (name: string, run: () => Promise<void>) => {
    const [r, p] = [rest(), points()];
    await run();
    await settle(both);
    out[name] = { rest: rest() - r, points: points() - p };
  };
  await phase("startup", async () => {
    await service.warm(null);
    await settle(both);
  });
  await phase("idle10min", async () => {
    for (let t = 0; t < 20; t++) {
      advance(30_000);
      tick();
      await service.inbox();
      await settle(both);
    }
  });
  await phase("prPage2min", async () => {
    for (let t = 0; t < 15; t++) {
      advance(8_000);
      tick();
      service.invalidate({ kind: "pr", number: 1 });
      await service.detail({ kind: "pr", number: 1 });
      await settle(both);
    }
  });
  process.emit("exit", 0);
  const again = restart();
  await again.warm(null);
  await settle(() => again.usage()!.counted + again.usage()!.graphql.points);
  out.restart = { rest: again.usage()!.counted, points: again.usage()!.graphql.points };
  return out;
}

describe("GitHub request budget (60 open PRs)", () => {
  it("GraphQL: a few points per refresh, REST only for diffs", async () => {
    const m = await measure(true);
    console.log("graphql", JSON.stringify(m));
    expect(m.startup.rest).toBeLessThanOrEqual(30);
    expect(m.idle10min.rest).toBeLessThanOrEqual(5);
    expect(m.idle10min.points).toBeLessThanOrEqual(30);
    expect(m.prPage2min.rest + m.prPage2min.points).toBeLessThanOrEqual(40);
    expect(m.restart.rest).toBeLessThanOrEqual(5);
  }, 120_000);

  it("REST fallback (GraphQL blocked) stays within its budget too", async () => {
    const m = await measure(false);
    console.log("rest", JSON.stringify(m));
    // Before this budget existed: startup 487, idle 273, PR page 30, restart 487.
    expect(m.startup.rest).toBeLessThanOrEqual(200);
    expect(m.idle10min.rest).toBeLessThanOrEqual(120);
    expect(m.prPage2min.rest).toBeLessThanOrEqual(40);
    expect(m.restart.rest).toBeLessThanOrEqual(50);
  }, 120_000);
});
