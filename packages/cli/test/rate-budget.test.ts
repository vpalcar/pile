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

async function setup(prs = 60) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
  const fake = fakeGitHub({ prs });
  const { github, tick } = fake;
  const pile = await createPile(createCliRepo().dir);
  const cacheFile = join(mkdtempSync(join(tmpdir(), "pile-etags-")), "review-cache.json");
  const service = new ReviewService(pile, github, { cacheFile });
  const counted = () => service.usage()!.counted;
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  /** A new `pile review` process on the same repo, with the cache from disk. */
  const restart = () => new ReviewService(pile, fake.client(), { cacheFile });
  return { service, counted, advance, tick, github, restart };
}

describe("GitHub request budget (60 open PRs)", () => {
  it("stays within its budget: startup, an idle inbox, a PR page with running checks, a restart", async () => {
    const { service, counted, advance, tick, restart } = await setup();
    await service.warm(null);
    await settle(counted);
    const startup = counted();
    const atStart = { ...service.usage()!.byRoute };

    // An inbox left open for 10 minutes: the page polls every 30 seconds.
    for (let t = 0; t < 20; t++) {
      advance(30_000);
      tick();
      await service.inbox();
      await settle(counted);
    }
    const idle = counted() - startup;
    const idleRoutes = Object.fromEntries(
      Object.entries(service.usage()!.byRoute)
        .map(([k, v]) => [k.replace(/\/\d+\//g, "/N/").replace(/\d+/g, "N"), v - (atStart[k] ?? 0)] as const)
        .filter(([, v]) => v > 0)
        .reduce((acc, [k, v]) => acc.set(k, (acc.get(k) ?? 0) + v), new Map<string, number>()),
    );

    // A PR page with running checks for 2 minutes: fresh polls every 8 seconds.
    const before = counted();
    for (let t = 0; t < 15; t++) {
      advance(8_000);
      tick();
      service.invalidate({ kind: "pr", number: 1 });
      await service.detail({ kind: "pr", number: 1 });
      await settle(counted);
    }
    const prPage = counted() - before;
    // Quit and start again: everything unchanged comes back as free 304s.
    process.emit("exit", 0);
    const again = restart();
    await again.warm(null);
    await settle(() => again.usage()!.counted);
    const restartCost = again.usage()!.counted;
    console.log(JSON.stringify({ startup, idle10min: idle, prPage2min: prPage, restart: restartCost, idleRoutes }, null, 1));
    // Before this budget existed: startup 487, idle 273, PR page 30, restart 487.
    expect(startup).toBeLessThanOrEqual(200);
    expect(idle).toBeLessThanOrEqual(120);
    expect(prPage).toBeLessThanOrEqual(40);
    expect(restartCost).toBeLessThanOrEqual(50);
  }, 120_000);
});
