// Clicks through every component and state of the review app against the mock
// server, asserting behavior and saving a screenshot of each state.
//
//   node e2e/qa.mjs [outDir]          (build first: pnpm build)
//
// Uses the installed Chrome (PILE_CHROME overrides the path).
import { chromium } from "playwright-core";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMockServer, TOKEN } from "./mock-server.mjs";

const OUT = process.argv[2] ?? join(import.meta.dirname, "out");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const server = await startMockServer();
const browser = await chromium.launch({
  executablePath: process.env.PILE_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url });
const page = await context.newPage();

const consoleErrors = [];
// Failed requests the suite provokes on purpose (gate, server down, missing PR, GitHub rejections, git failure).
const EXPECTED = /\b(401|404|422|500|503)\b/;
page.on("console", (m) => m.type() === "error" && !(m.text().startsWith("Failed to load resource") && EXPECTED.test(m.text())) && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const results = [];
let section = "";
let shots = 0;
const log = (s) => console.log(s);

async function check(name, fn) {
  try {
    await fn();
    results.push({ section, name, ok: true });
    log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ section, name, ok: false, error: String(error.message ?? error).split("\n")[0] });
    log(`  ✗ ${name}\n      ${String(error.message ?? error).split("\n")[0]}`);
    await shot(`FAIL ${name}`);
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}
async function shot(name, options = {}) {
  await page.waitForTimeout(250);
  const file = `${String(++shots).padStart(3, "0")} ${section} - ${name}`.replace(/[^\w .-]+/g, "_") + ".png";
  await page.screenshot({ path: join(OUT, file), ...options });
}
let loads = 0;
/** Full page load (a query string forces it even when only the fragment differs). */
const load = (fragment = "") => page.goto(`${server.url}/?load=${++loads}${fragment}`);
const text = (selector) => page.locator(selector).first().innerText();
const count = (selector) => page.locator(selector).count();
const open = async (hash = "") => {
  await page.goto(`${server.url}/#token=${TOKEN}`);
  await page.waitForSelector("[data-page=inbox]");
  if (hash) {
    await page.evaluate((h) => {
      history.pushState(null, "", h);
      dispatchEvent(new HashChangeEvent("hashchange"));
    }, hash);
  }
};
const detailReady = () => page.waitForSelector("[data-page=detail]", { timeout: 10_000 });
const toast = async (pattern) => {
  const el = page.locator("[role=status] > div", { hasText: pattern });
  await el.first().waitFor({ timeout: 5000 });
};
const calls = () => fetch(`${server.url}/__calls`).then((r) => r.json());
const setState = (params) => fetch(`${server.url}/__state?${params}`);
const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll("main")].every((m) => m.scrollWidth <= m.clientWidth + 1));

// =============================================================================
section = "gate";
log("\nGate states");
await check("without a token: explains how to open the app", async () => {
  await load();
  await page.getByText("Open the link from your terminal").waitFor();
  await shot("no token");
});
await check("with a wrong token: says the link expired", async () => {
  await page.evaluate(() => sessionStorage.clear());
  await load("#token=wrong");
  await page.getByText("This link has expired").waitFor();
  await shot("expired");
});
await check("server down: says pile isn't reachable", async () => {
  await setState("down=true");
  await page.evaluate(() => sessionStorage.clear());
  await load(`#token=${TOKEN}`);
  await page.getByText("Can't reach pile").waitFor();
  await shot("server down");
  await setState("reset=1");
});
await check("token is removed from the address bar", async () => {
  await page.evaluate(() => sessionStorage.clear());
  await load(`#token=${TOKEN}`);
  await page.waitForSelector("[data-page=inbox]");
  expect(!page.url().includes("token"), `URL still has the token: ${page.url()}`);
});

// =============================================================================
section = "inbox";
log("\nInbox");
await setState("reset=1");
await page.evaluate(() => localStorage.clear());
await check("a new link in an open tab reloads with the new token", async () => {
  await page.evaluate((t) => {
    location.hash = `#token=${t}`;
  }, TOKEN);
  await page.waitForSelector("[data-page=inbox]");
  expect(!page.url().includes("token"), page.url());
});
await page.waitForLoadState("networkidle");
await setState("reset=1");
await check("loads the quick list first, then fills in details", async () => {
  await load(`#token=${TOKEN}`);
  await page.waitForSelector("[data-page=inbox][data-partial]", { timeout: 5000 });
  await shot("partial");
  await page.waitForSelector("[data-page=inbox]:not([data-partial])", { timeout: 8000 });
  await shot("full");
});
await check("greets the viewer and summarizes", async () => {
  const h1 = await text("h1");
  expect(/(morning|afternoon|evening|late), you/.test(h1), h1);
  const summary = await text("header p");
  expect(summary.includes("3 pull requests are waiting for your review"), summary);
});
await check("tabs show counts per group", async () => {
  const tabs = await page.locator("[role=tab]").allInnerTexts();
  expect(tabs.join("|").replace(/\s+/g, " ") === "All 26|Needs review 3|Yours 12|Local 3|Others 8".replace(/\s+/g, " ").replace(/\|/g, "|"), tabs.join(" | "));
});
await check("every row shows its readiness", async () => {
  const status = async (id) => (await page.locator(`[data-row="${id}"]`).innerText()).replace(/\s+/g, " ");
  const expected = {
    "pr-101": "Checks failing",
    "pr-102": "In review",
    "pr-103": "Checks failing",
    "pr-110": "Ready to merge",
    "pr-111": "Changes requested",
    "pr-112": "Draft",
    "pr-113": "Approved",
    "branch-wip": "Local",
    "pr-130": "Open",
    "pr-131": "In review",
  };
  for (const [id, label] of Object.entries(expected)) {
    const row = await status(id);
    expect(row.includes(label), `${id}: expected "${label}" in "${row}"`);
  }
});
await check("every column lines up across stacked and single rows", async () => {
  // Diverging stacks widen the rail, which moves only their titles; the rest lines up.
  const columns = await page.locator("[data-row]").evaluateAll((rows) =>
    [0, 1, 6].map((i) => [
      ...new Set(rows.filter((r) => i !== 1 || r.closest("[data-stack-lanes]")?.getAttribute("data-stack-lanes") !== "2" && r.closest("[data-stack-lanes]")?.getAttribute("data-stack-lanes") !== "3").map((r) => Math.round(r.children[i].getBoundingClientRect().left))),
    ]),
  );
  expect(columns.every((xs) => xs.length === 1), `x positions per column: ${JSON.stringify(columns)}`);
});
await check("status columns line up across rows", async () => {
  const xs = await page.locator("[data-row]").evaluateAll((rows) => rows.map((r) => Math.round(r.children[2].getBoundingClientRect().left)));
  expect(new Set(xs).size === 1, `status column x positions: ${[...new Set(xs)].join(", ")}`);
});
await check("long stacks fold to their ends and expand", async () => {
  const more = page.getByRole("button", { name: /5 more in this stack/ });
  await more.waitFor();
  await more.scrollIntoViewIfNeeded();
  await shot("long stack folded");
  await more.click();
  expect((await count('[data-row^="pr-12"]')) === 8, "all 8 rows after expanding");
  await shot("long stack expanded");
});
await check("stack rails pass through every dot", async () => {
  const misaligned = await page.evaluate(() =>
    [...document.querySelectorAll(".rail-node")]
      .filter((n) => n.firstElementChild)
      .map((n) => {
        const dot = n.firstElementChild.getBoundingClientRect();
        const rail = n.getBoundingClientRect();
        const line = rail.left + parseFloat(getComputedStyle(n, "::before").left);
        return Math.abs(line - (dot.left + dot.width / 2));
      })
      .filter((d) => d > 0.6),
  );
  expect(misaligned.length === 0, `misaligned by ${misaligned.join(", ")}px`);
});
await check("filters with 1–5 and shows only that group", async () => {
  await page.keyboard.press("2");
  expect((await page.locator("section h2").allInnerTexts()).every((t) => t.startsWith("Waiting for your review")), "only needs-review");
  await shot("filter needs review");
  await page.keyboard.press("4");
  expect((await count("[data-row]")) === 3, "3 local rows");
  await page.keyboard.press("1");
});
await check("search filters by title, branch, author and number", async () => {
  const before = await count("[data-row]");
  await page.keyboard.press("/");
  await page.keyboard.type("rate-limit");
  expect((await count("[data-row]")) === 2, `rows for "rate-limit": ${await count("[data-row]")}`);
  await shot("search");
  await page.keyboard.press("Escape");
  await page.locator("input[placeholder^='Filter by']").fill("#103");
  expect((await count("[data-row]")) === 1, "#103 by number");
  await page.locator("input[placeholder^='Filter by']").fill("carol");
  expect((await count("[data-row]")) === 7, `by author: ${await count("[data-row]")}`); // #103 and her 6-PR search stack
  await page.locator("input[placeholder^='Filter by']").fill("zzzz");
  await page.getByText("No pull requests or branches match").waitFor();
  await shot("search no match");
  await page.locator("input[placeholder^='Filter by']").press("Escape");
  // Clearing brings every row back (a long stack may come back unfolded if the cursor is in it).
  expect((await count("[data-row]")) >= before && (await page.getByText("No pull requests or branches match").count()) === 0, "cleared");
});
await check("j / k move the selection, Enter opens it", async () => {
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  const active = await page.locator("[data-row].border-accent\\/55, [data-row].bg-accent-soft").first().getAttribute("data-row");
  await shot("cursor");
  await page.keyboard.press("Enter");
  await detailReady();
  expect(page.url().includes(active.replace("pr-", "/pr/")), `opened ${page.url()} for ${active}`);
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-page=inbox]");
});
await check("hover reveals the open arrow", async () => {
  await page.hover('[data-row="pr-130"]');
  await page.waitForTimeout(300);
  const opacity = await page.locator('[data-row="pr-130"] svg.lucide-arrow-up-right').evaluate((e) => getComputedStyle(e).opacity);
  expect(Number(opacity) > 0.9, `arrow opacity ${opacity}`);
});

// =============================================================================
section = "nav";
log("\nNavigation bar");
await check("inbox badge counts what waits for you", async () => {
  expect((await page.locator("nav button", { hasText: "Inbox" }).innerText()).includes("3"), "badge 3");
});
await check("navbar: Inbox › branch on the left, repo in the middle, actions and tools on the right", async () => {
  await page.click('[data-row="pr-101"]');
  await detailReady();
  expect((await text("nav [data-breadcrumb]")) === "api/rate-limit", await text("nav [data-breadcrumb]"));
  expect((await text("nav [data-repo]")).replace(/\s+/g, "") === "acme/web", "repo name");
  const nav = await page.locator("nav").boundingBox();
  const repo = await page.locator("nav [data-repo]").boundingBox();
  expect(Math.abs(repo.x + repo.width / 2 - (nav.x + nav.width / 2)) < 2, "repo name centred");
  // Right side, in order: pager, Review, search, refresh, account.
  const xs = await Promise.all(
    ["nav button[aria-label=Next]", "nav button[data-tip='Submit a review']", "nav button[aria-label=Search]", "nav button[aria-label=Refresh]", "nav button[aria-label='Account and settings']"].map(
      async (s) => (await page.locator(s).boundingBox()).x,
    ),
  );
  expect(xs.every((x, i) => i === 0 || x > xs[i - 1]), `order ${xs.map(Math.round)}`);
  // The repo name is the bar's one link to GitHub: the repo's default branch.
  expect((await count("nav a")) === 1 && (await page.locator("nav a[data-repo]").getAttribute("href")) === "https://github.com/acme/web", "repo link");
  expect((await text("nav")).includes("2 of 26"), "position: stacks are listed top first, so #102 comes before #101");
  expect(!(await page.locator("nav button[data-tip=Previous]").isDisabled()), "previous enabled: #102 is listed above #101");
  await shot("breadcrumb");
});
await check("] and [ step through items", async () => {
  // The pager follows the inbox as drawn: #102 sits above #101 in their stack.
  await page.keyboard.press("[");
  await page.waitForFunction(() => location.hash.includes("/pr/102"));
  await page.keyboard.press("]");
  await page.waitForFunction(() => location.hash.includes("/pr/101"));
});
await check("Open on GitHub lives in the status card's menu", async () => {
  await page.locator("[data-status-card]").getByRole("button", { name: "More actions" }).click();
  const link = page.getByRole("menuitem", { name: /Open on GitHub/ });
  expect((await link.getAttribute("href")) === "https://github.com/acme/web/pull/101", "href");
  await shot("status menu");
  await page.keyboard.press("Escape");
});
await check("search opens the palette; the account menu holds the theme", async () => {
  await page.click("nav button[aria-label=Search]");
  await page.locator(".palette input").waitFor();
  await page.keyboard.press("Escape");
  await page.click("nav button[aria-label='Account and settings']");
  const menu = page.getByRole("menu");
  expect((await menu.innerText()).includes("you"), "shows who you are");
  await shot("account menu");
  const themes = [];
  for (const name of ["Dark", "Light", "System"]) {
    await menu.getByRole("radio", { name }).click();
    await page.waitForFunction((n) => (document.documentElement.dataset.theme ?? "system") === n.toLowerCase(), name);
    themes.push(await page.evaluate(() => document.documentElement.dataset.theme ?? "system"));
  }
  expect(themes.join(",") === "dark,light,system", themes.join(","));
  await page.keyboard.press("Escape");
  expect((await count("[role=menu]")) === 0, "closes with Escape");
});
await check("the theme is saved by pile, so it survives a reload and a new port", async () => {
  await page.click("nav button[aria-label='Account and settings']");
  await page.getByRole("menu").getByRole("radio", { name: "Light" }).click();
  await page.waitForTimeout(300);
  const saved = await fetch(`${server.url}/api/preferences`, { headers: { "x-pile-token": TOKEN } }).then((r) => r.json());
  expect(saved.theme === "light", JSON.stringify(saved));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("[data-page]");
  expect((await page.evaluate(() => document.documentElement.dataset.theme)) === "light", "light after reload");
  await page.click("nav button[aria-label='Account and settings']");
  await page.getByRole("menu").getByRole("radio", { name: "System" }).click();
  await page.keyboard.press("Escape");
});
await check("refresh re-requests data", async () => {
  await page.click("nav button[data-tip=Refresh]");
  await page.waitForTimeout(400);
});
await check("Escape and g go back to the inbox", async () => {
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-page=inbox]");
  await page.click('[data-row="pr-101"]');
  await detailReady();
  await page.keyboard.press("g");
  await page.waitForSelector("[data-page=inbox]");
});

// =============================================================================
section = "detail";
log("\nPR page");
await page.click('[data-row="pr-101"]');
await detailReady();
await check("header: status, number, title, branches, size", async () => {
  const header = (await text("[data-page=detail] header")).replace(/\s+/g, " ");
  for (const part of ["Checks failing", "#101", "Rate limit the public API", "alice", "api/rate-limit", "main", "7 files", "+1,511", "−7"]) {
    expect(header.includes(part), `missing "${part}" in "${header}"`);
  }
  await shot("top");
});
await check("branch chip copies the checkout command", async () => {
  await page.click("header button[data-tip='Copy checkout command']");
  await toast("Copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied === "pile checkout api/rate-limit", copied);
});
await check("stack lists both PRs with their status and marks the current one", async () => {
  const stack = (await page.locator("section", { hasText: "Stack" }).first().innerText()).replace(/\s+/g, " ");
  expect(stack.includes("1 of 2") && stack.includes("#102") && stack.includes("#101") && stack.includes("main"), stack);
});
await check("stack entry navigates", async () => {
  await page.getByRole("link", { name: /#102/ }).click();
  await page.waitForFunction(() => location.hash.includes("/pr/102"));
  await page.goBack();
  await page.waitForFunction(() => location.hash.includes("/pr/101"));
  await detailReady();
});
await check("sections collapse and expand", async () => {
  const toggle = page.getByRole("button", { name: "Description" });
  await toggle.click();
  expect(!(await page.locator(".markdown table").first().isVisible()), "description hidden");
  await toggle.click();
  expect(await page.locator(".markdown table").first().isVisible(), "description shown");
});
await check("description renders markdown: headings, lists, table, tasks, quote, details", async () => {
  for (const selector of [".markdown h2", ".markdown ul li code", ".markdown table td", ".markdown input[type=checkbox]:checked", ".markdown blockquote", ".markdown details summary"]) {
    expect((await count(selector)) > 0, `missing ${selector}`);
  }
  await page.locator(".markdown details summary").click();
  expect(await page.locator(".markdown details pre").isVisible(), "details opens");
  expect((await page.locator(".markdown a").first().getAttribute("target")) === "_blank", "links open in a new tab");
  await page.locator("section", { hasText: "Description" }).first().screenshot({ path: join(OUT, `${String(++shots).padStart(3, "0")} detail - description.png`) });
});
await check("discussion: comments, reviews and grouped commits", async () => {
  const discussion = page.locator("section", { hasText: "Discussion" }).first();
  const textContent = (await discussion.innerText()).replace(/\s+/g, " ");
  for (const part of ["dave commented", "erin requested changes", "frank approved", "grace reviewed", "Show 3 earlier commits"]) expect(textContent.includes(part), `missing "${part}"`);
  await discussion.screenshot({ path: join(OUT, `${String(++shots).padStart(3, "0")} detail - discussion.png`) });
  await page.getByRole("button", { name: "Show 3 earlier commits" }).click();
  expect((await discussion.innerText()).includes("Add the token bucket"), "earlier commits shown");
});
await check("composer: footer appears on focus; posting adds a comment", async () => {
  const input = page.locator("textarea[placeholder='Add to the discussion…']");
  expect(!(await page.getByRole("button", { name: /^Comment/ }).filter({ hasText: "⌘" }).isVisible()), "footer hidden before focus");
  await page.keyboard.press("c");
  await input.waitFor();
  expect(await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA"), "c focuses the composer");
  await page.keyboard.type("Thanks, the bucket logic reads well.");
  await shot("composer focused");
  await page.keyboard.press("Meta+Enter");
  await toast("Comment posted");
  const last = (await calls()).at(-1);
  expect(last.type === "comment" && last.pr === 101 && last.body === "Thanks, the bucket logic reads well.", JSON.stringify(last));
  expect((await input.inputValue()) === "", "cleared after posting");
});
await check("composer: a failed post keeps the text and shows the error", async () => {
  const input = page.locator("textarea[placeholder='Add to the discussion…']");
  await input.fill("this will fail");
  await input.press("Meta+Enter");
  await toast("GitHub rejected the comment");
  expect((await input.inputValue()) === "this will fail", "text kept");
  await shot("comment failed");
});
await check("composer: an unsent draft survives leaving the page", async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-page=inbox]");
  await page.click('[data-row="pr-101"]');
  await detailReady();
  expect((await page.locator("textarea[placeholder='Add to the discussion…']").inputValue()) === "this will fail", "draft restored");
  await page.locator("textarea[placeholder='Add to the discussion…']").fill("");
});
await check("rail: status, checks with durations, reviewers, labels, assignees", async () => {
  const rail = (await text("[data-page=detail] > aside")).replace(/\s+/g, " ");
  for (const part of ["Checks failing", "1 failed · 1 running · 2 passed", "typecheck", "42s", "1m 35s", "frank", "Approved", "erin", "Changes requested", "grace", "Commented", "platform-team", "Requested", "api", "security", "alice", "bob"]) {
    expect(rail.includes(part), `missing "${part}"`);
  }
  const order = await page.locator("[data-page=detail] > aside a[href*='example.com/ci'], [data-page=detail] > aside a:not([href])").allInnerTexts();
  expect(order[0].includes("typecheck"), `failing check first: ${order.join(" / ")}`);
  await page.locator("[data-page=detail] > aside").scrollIntoViewIfNeeded();
  await page.locator("[data-page=detail] > aside").screenshot({ path: join(OUT, `${String(++shots).padStart(3, "0")} detail - rail.png`) });
});

// =============================================================================
section = "review";
log("\nReview popover");
await check("opens from the nav button and with r", async () => {
  await page.click("nav button[data-tip='Submit a review']");
  await page.waitForSelector("[role=dialog][aria-label='Submit review']");
  await shot("open");
  await page.keyboard.press("Escape");
  expect((await count("[role=dialog]")) === 0, "Escape closes");
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("r");
  await page.waitForSelector("[role=dialog][aria-label='Submit review']");
  await page.mouse.click(700, 600);
  await page.waitForTimeout(100);
  expect((await count("[role=dialog]")) === 0, "outside click closes");
});
await check("comment and request changes need a summary", async () => {
  await page.keyboard.press("r");
  await page.getByRole("radio", { name: /Comment/ }).click();
  expect(await page.getByRole("button", { name: /Submit review/ }).isDisabled(), "disabled without text");
  await page.getByRole("radio", { name: /Request changes/ }).click();
  expect(await page.getByRole("button", { name: /Submit review/ }).isDisabled(), "disabled without text");
  await page.getByRole("radio", { name: /Approve/ }).click();
  expect(!(await page.getByRole("button", { name: /Submit review/ }).isDisabled()), "approve allowed without text");
  await shot("approve selected");
});
await check("an error from GitHub shows inside the popover", async () => {
  await page.locator("[role=dialog] textarea").fill("please fail");
  await page.getByRole("button", { name: /Submit review/ }).click();
  await page.getByText("Review cannot be submitted right now").waitFor();
  await shot("error");
});
await check("approving sends the review and confirms", async () => {
  await page.locator("[role=dialog] textarea").fill("Ship it.");
  await page.keyboard.press("Meta+Enter");
  await toast("Approved #101");
  // From here the server is slow (like rebuilding a big repo's inbox), so only the
  // app's own update can move the PR in the next check.
  await setState("delayMs=4000");
  const last = (await calls()).at(-1);
  expect(last.type === "review" && last.event === "APPROVE" && last.body === "Ship it.", JSON.stringify(last));
});
await check("a reviewed PR leaves Needs your review right away", async () => {
  // No waiting for the server to rebuild the inbox: the badge drops as the review lands.
  const badge = await text("nav button:has-text('Inbox')");
  expect(badge.includes("2"), `inbox badge: ${badge}`);
  await setState("delayMs=120");
  await page.click("nav button:has-text('Inbox')");
  await page.waitForSelector("[data-page=inbox]");
  await page.getByRole("tab", { name: /Needs review/ }).click();
  const rows = await page.locator("[data-row]").evaluateAll((r) => r.map((x) => x.dataset.row));
  expect(!rows.includes("pr-101") && rows.length === 2, rows.join());
  await page.getByRole("tab", { name: /All/ }).click();
  await page.goto(`${server.url}/#/pr/101`);
  await detailReady();
});
await check("on your own PR only Comment is possible", async () => {
  await page.goto(`${server.url}/#/pr/110`);
  await detailReady();
  expect((await text("nav button[data-tip='Submit a review']")).includes("Comment"), "button says Comment");
  await page.keyboard.press("r");
  expect(await page.getByRole("radio", { name: /Approve/ }).isDisabled(), "approve disabled");
  expect(await page.getByRole("radio", { name: /Comment/ }).getAttribute("aria-checked") === "true", "comment preselected");
  await shot("own PR");
  await page.keyboard.press("Escape");
});

// =============================================================================
section = "files";
log("\nFiles and diffs");
await page.goto(`${server.url}/#/pr/101`);
await detailReady();
const filesSection = page.locator("section[aria-label='Changed files']");
await filesSection.scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await check("tree lists files folders-first, like the diff order", async () => {
  const tree = await page.locator("aside[aria-label='File tree'] button[title]").evaluateAll((b) => b.map((x) => x.title));
  const diffs = await page.locator(".file[data-path]").evaluateAll((f) => f.map((x) => x.dataset.path));
  expect(JSON.stringify(tree) === JSON.stringify(diffs), `tree ${tree.join(", ")} vs diffs ${diffs.join(", ")}`);
  expect(diffs[0] === "assets/diagram.png" && diffs.at(-1) === "README.md", diffs.join(", "));
  await shot("files top");
});
await check("bar: count, size, viewed progress, layout toggles", async () => {
  const bar = (await filesSection.locator("> div").first().innerText()).replace(/\s+/g, " ");
  expect(bar.includes("7 files") && bar.includes("0/7 viewed") && bar.includes("Split") && bar.includes("Unified"), bar);
});
await check("special files: binary, renamed, too large (and loading it anyway)", async () => {
  await page.locator('.file[data-path="assets/diagram.png"]').getByText("Binary file not shown").waitFor();
  await page.locator('.file[data-path="docs/rate-limits.md"]').getByText("File renamed without changes").waitFor();
  const large = page.locator('.file[data-path="src/generated/schema.ts"]');
  await large.scrollIntoViewIfNeeded();
  await large.getByText(/Large diff \(1,500 changed lines\)/).waitFor();
  await large.screenshot({ path: join(OUT, `${String(++shots).padStart(3, "0")} files - large.png`) });
  await large.getByRole("button", { name: "Load diff" }).click();
  await large.locator("tr.add").nth(1000).waitFor();
});
await check("modified file: hunks, word-level changes, syntax colors", async () => {
  const file = page.locator('.file[data-path="src/api/limit.ts"]');
  await file.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  expect((await file.locator("tr.hunk").count()) >= 2, "hunk rows");
  expect((await file.locator("mark.w-add").count()) > 0 || (await file.locator("td.add").count()) > 0, "changes highlighted");
  expect((await file.locator(".code span[style*='--shiki-dark']").count()) > 0, "syntax colors");
  // Red is reserved for deletions; syntax colors never use it.
  const reds = await file.locator(".code span[style*='--shiki-dark']").evaluateAll((spans) =>
    spans.map((s) => s.style.getPropertyValue("--shiki-dark")).filter((c) => /^#e06c75/i.test(c)),
  );
  expect(reds.length === 0, `red syntax tokens: ${reds.length}`);
  await file.screenshot({ path: join(OUT, `${String(++shots).padStart(3, "0")} files - limit split.png`) });
});
await check("existing inline threads show under their lines", async () => {
  const threads = page.locator('.file[data-path="src/api/limit.ts"] tr.thread');
  expect((await threads.count()) === 2, `threads: ${await threads.count()}`);
  const first = (await threads.first().innerText()).replace(/\s+/g, " ");
  expect(first.includes("Nit: keep the old name") || first.includes("refills on every request"), first);
});
await check("added and removed files offer no context to expand", async () => {
  for (const path of ["src/api/headers.ts", "src/legacy/throttle.js"]) {
    const file = page.locator(`.file[data-path="${path}"]`);
    await file.scrollIntoViewIfNeeded();
    expect((await file.getByRole("button", { name: /^Show/ }).count()) === 0, `${path} has expand buttons`);
  }
});
await check("a failed expand says why instead of doing nothing", async () => {
  await setState("fileDown=true");
  const file = page.locator('.file[data-path="src/api/limit.ts"]');
  await file.scrollIntoViewIfNeeded();
  await file.getByRole("button", { name: /Show 19 more lines/ }).click();
  await toast("Couldn't load more of src/api/limit.ts");
  await setState("fileDown=false");
});
await check("expanding context reveals hidden lines", async () => {
  const file = page.locator('.file[data-path="src/api/limit.ts"]');
  const before = await file.locator("tr:not(.hunk):not(.thread)").count();
  await file.getByRole("button", { name: /Show 19 more lines/ }).click();
  await file.getByText("rule3 = limit", { exact: false }).first().waitFor();
  const after = await file.locator("tr:not(.hunk):not(.thread)").count();
  expect(after - before === 19, `added ${after - before} rows`);
  const tail = file.getByRole("button", { name: /Show (20 lines|all|\d+ more line)/ }).last();
  await tail.click();
  await file.screenshot({ path: join(OUT, `${String(++shots).padStart(3, "0")} files - expanded.png`) });
});
await check("+ on a line opens a centred composer; comment becomes pending", async () => {
  const file = page.locator('.file[data-path="src/api/limit.ts"]');
  const row = file.locator("tr", { hasText: "rule25 = limit" }).first();
  await row.locator("td.code").last().hover();
  expect((await row.locator("button.add-comment:visible").count()) === 1, "only the hovered half offers +");
  const button = row.locator("button.add-comment:visible");
  const b = await button.boundingBox();
  const icon = await button.locator("svg").boundingBox();
  expect(Math.abs(icon.x + icon.width / 2 - (b.x + b.width / 2)) < 0.6 && Math.abs(icon.y + icon.height / 2 - (b.y + b.height / 2)) < 0.6, "plus centred");
  await page.screenshot({ path: join(OUT, `${String(++shots).padStart(3, "0")} files - plus.png`), clip: { x: b.x - 20, y: b.y - 20, width: 520, height: 60 } });
  await button.click();
  await page.keyboard.type("Could this read the limit from config?");
  const thread = file.locator("tr.thread", { has: page.locator("textarea") });
  await thread.screenshot({ path: join(OUT, `${String(++shots).padStart(3, "0")} files - inline composer.png`) });
  await page.waitForTimeout(500);
  const submit = await thread.getByRole("button", { name: /Add to review/ }).boundingBox();
  const viewport = page.viewportSize();
  expect(submit && submit.y + submit.height <= viewport.height && submit.y >= 0, `composer buttons in view (y=${submit?.y})`);
  await page.keyboard.press("Meta+Enter");
  await file.getByText("Pending").waitFor();
  await toast("Comment added to your review");
  expect((await text("nav button[data-tip='Submit a review']")).includes("1"), "pending count on the review button");
});
await check("pending comments can be removed, and are sent with the review", async () => {
  const file = page.locator('.file[data-path="src/api/limit.ts"]');
  await file.getByRole("button", { name: "Remove" }).click();
  expect((await file.getByText("Pending").count()) === 0, "removed");
  const row = file.locator("tr", { hasText: "rule26 = limit" }).first();
  await row.hover();
  await row.locator("button.add-comment").last().click();
  await page.keyboard.type("Second thought: fine as is.");
  await page.keyboard.press("Meta+Enter");
  await file.getByText("Pending").waitFor();
  await page.click("nav button[data-tip='Submit a review']");
  await page.getByRole("radio", { name: /Comment/ }).click();
  await page.locator("[role=dialog] textarea").fill("Two small notes.");
  await page.getByText("Includes 1 inline comment").waitFor();
  await page.keyboard.press("Meta+Enter");
  await toast("Reviewed #101");
  const last = (await calls()).at(-1);
  expect(last.comments?.length === 1 && last.comments[0].path === "src/api/limit.ts" && last.comments[0].side === "RIGHT", JSON.stringify(last));
});
await check("old code takes comments too: unchanged and removed lines, in split view", async () => {
  const file = page.locator('.file[data-path="src/api/limit.ts"]');
  for (const [text, body] of [
    ["rule25 = limit", "The old name read better."],
    ["removed = true", "Why drop this?"],
  ]) {
    const row = file.locator("tr", { hasText: text }).first();
    await row.locator("td.code").first().hover();
    const plus = row.locator("button.add-comment:visible");
    expect((await plus.count()) === 1, `one + on the old side of "${text}"`);
    await plus.click();
    await page.keyboard.type(body);
    await page.keyboard.press("Meta+Enter");
    await file.locator("tr.split-thread", { hasText: body }).waitFor();
  }
  // Revealed context is outside the diff: GitHub would reject comments there.
  const revealed = file.locator("tr", { hasText: "rule3 = limit" }).first();
  await revealed.locator("td.code").last().hover();
  expect((await revealed.locator("button.add-comment:visible").count()) === 0, "no + on expanded lines");
  await page.click("nav button[data-tip='Submit a review']");
  await page.getByRole("radio", { name: /Comment/ }).click();
  await page.getByText("Includes 2 inline comments").waitFor();
  await page.keyboard.press("Meta+Enter");
  await toast("Reviewed #101");
  const last = (await calls()).at(-1);
  expect(last.comments?.length === 2 && last.comments.every((c) => c.side === "LEFT"), JSON.stringify(last.comments));
});
await check("j / k move between files; v marks viewed and advances", async () => {
  await page.locator("body").click({ position: { x: 5, y: 500 } });
  const first = await page.locator(".file.border-line-3").getAttribute("data-path");
  await page.keyboard.press("v");
  await page.waitForTimeout(500);
  const bar = await filesSection.locator("> div").first().innerText();
  expect(bar.includes("1/7 viewed"), bar);
  const viewedFile = page.locator(`.file[data-path="${first}"]`);
  expect((await viewedFile.locator("table").count()) === 0, "viewed file collapses");
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await shot("after v");
});
await check("Viewed button toggles, tree shows a check", async () => {
  const file = page.locator('.file[data-path="README.md"]');
  await file.scrollIntoViewIfNeeded();
  await file.getByRole("button", { name: "Viewed" }).click();
  expect((await page.locator("aside[aria-label='File tree'] button[title='README.md'] svg.lucide-check").count()) === 1, "tree check");
  await file.getByRole("button", { name: "Viewed" }).click();
  expect((await page.locator("aside[aria-label='File tree'] button[title='README.md'] svg.lucide-check").count()) === 0, "unchecked");
});
await check("s switches split ↔ unified, w wraps, t hides the tree", async () => {
  await page.keyboard.press("s");
  await page.waitForFunction(() => document.querySelectorAll(".diff-table.split").length === 0, null, { timeout: 2000 }).catch(() => {});
  expect((await count(".diff-table.split")) === 0, "unified");
  await page.locator('.file[data-path="src/api/limit.ts"]').scrollIntoViewIfNeeded();
  await shot("unified");
  await page.keyboard.press("s");
  await page.waitForSelector(".diff-table.split", { timeout: 2000 }).catch(() => {});
  expect((await count(".diff-table.split")) > 0, "split again");
  await page.keyboard.press("w");
  await page.keyboard.press("w");
  await page.keyboard.press("t");
  await page.waitForTimeout(300);
  expect(!(await page.locator("aside[aria-label='File tree']").isVisible()) || (await page.locator("aside[aria-label='File tree']").boundingBox()).width < 2, "tree hidden");
  await page.keyboard.press("t");
});
await check("tree: filter, Enter to jump, Escape to clear, folders collapse", async () => {
  const filter = page.locator("#file-filter");
  await filter.fill("hdrs");
  expect((await page.locator("aside[aria-label='File tree'] button[title]").count()) === 1, "fuzzy match");
  await filter.press("Enter");
  await filter.fill("nothing-matches");
  await page.getByText("No files match").waitFor();
  await filter.press("Escape");
  await page.locator("aside[aria-label='File tree'] button", { hasText: "src" }).first().click();
  expect((await page.locator("aside[aria-label='File tree'] button[title^='src/']").count()) === 0, "folder collapsed");
  await page.locator("aside[aria-label='File tree'] button", { hasText: "src" }).first().click();
});
await check("file header: copy path, collapse", async () => {
  const file = page.locator('.file[data-path="src/api/headers.ts"]');
  await file.scrollIntoViewIfNeeded();
  await file.locator("button[data-tip='Copy path']").click();
  await toast("Copied");
  await file.getByRole("button", { name: "Collapse file" }).click();
  expect((await file.locator("table").count()) === 0, "collapsed");
  await file.getByRole("button", { name: "Expand file" }).click();
});

// =============================================================================
section = "palette";
log("\nCommand palette and shortcuts");
await check("⌘K opens; files of this PR are listed first", async () => {
  await page.keyboard.press("Meta+k");
  await page.waitForSelector(".palette");
  await shot("open");
  await page.keyboard.type("headers");
  expect((await page.locator("[cmdk-item]").first().innerText()).includes("src/api/headers.ts"), "file match first");
  await page.keyboard.press("Enter");
  expect((await count(".palette")) === 0, "closes on select");
});
await check("jumps to another PR by title", async () => {
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("settings page");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash.includes("/pr/112"));
});
await check("shows an empty state", async () => {
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("qqqqqqq");
  await page.getByText("No results").waitFor();
  await shot("no results");
  await page.keyboard.press("Escape");
});
await check("actions: inbox, shortcuts, theme", async () => {
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("light theme");
  await page.keyboard.press("Enter");
  expect((await page.evaluate(() => document.documentElement.dataset.theme)) === "light", "light");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("system theme");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("keyboard shortcuts");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
  await shot("shortcuts");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("go to inbox");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-page=inbox]");
});
await check("? toggles the shortcuts sheet", async () => {
  await page.keyboard.press("?");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
  await page.keyboard.press("Escape");
  expect((await count("[role=dialog]")) === 0, "closed");
});
await check("tooltips appear on hover with their shortcut", async () => {
  await page.hover("nav button[data-tip=Refresh]");
  await page.waitForTimeout(500);
  const tip = await page.locator(".shadow-pop.pointer-events-none").first().innerText();
  expect(tip.includes("Refresh") && tip.includes("R"), tip);
});

// =============================================================================
section = "states";
log("\nOther PR and branch states");
await check("draft PR", async () => {
  await page.click('[data-row="pr-112"]');
  await detailReady();
  expect((await text("[data-page=detail] header")).includes("Draft"), "Draft badge");
  await shot("draft");
});
await check("approved PR with unpushed local commits and a huge diff", async () => {
  await page.goto(`${server.url}/#/pr/113`);
  await detailReady();
  expect((await text("[data-page=detail]")).includes("2 local commits not pushed"), "banner");
  expect((await text("[data-page=detail] header")).includes("Approved"), "badge");
  await shot("approved unpushed");
});
await check("PR with nothing filled in", async () => {
  await page.goto(`${server.url}/#/pr/110`);
  await detailReady();
  const content = await text("[data-page=detail]");
  for (const part of ["No description provided.", "No activity yet.", "No checks reported.", "Ready to merge", "No checks are configured.", "frank", "None"]) expect(content.includes(part), `missing "${part}"`);
  await shot("empty PR");
});
await check("local branch: banner, local stack, commits, no review button", async () => {
  await page.goto(`${server.url}/#/branch/spike%2Fparser-errors`);
  await detailReady();
  const content = (await text("[data-page=detail]")).replace(/\s+/g, " ");
  expect(content.includes("Local branch") && content.includes("Commits") && content.includes("Better parser errors"), content.slice(0, 300));
  expect((await count("nav button[data-tip='Submit a review']")) === 0, "no review button");
  await shot("local branch");
});
await check("local branch without changes", async () => {
  await page.goto(`${server.url}/#/branch/wip`);
  await detailReady();
  await page.getByText("No changes in this branch.").waitFor();
});
await check("missing PR shows an error and a way back", async () => {
  await page.goto(`${server.url}/#/pr/999`);
  await page.getByText("Couldn't load this").waitFor();
  await shot("not found");
  await page.getByRole("button", { name: "Back to inbox" }).click();
  await page.waitForSelector("[data-page=inbox]");
});

// =============================================================================
section = "editing";
log("\nEditing a PR from the rail");
const rail = () => page.locator("[data-page=detail] aside").last();
const railSection = (name) => rail().locator("div.relative", { has: page.locator("h4", { hasText: name }) });
const lastCall = async (type) => (await calls()).filter((c) => c.type === type).at(-1);

await check("reviewers: request from the picker; the author can't be picked", async () => {
  await open("#/pr/101");
  await detailReady();
  await railSection("Reviewers").getByRole("button", { name: "Request reviewers" }).click();
  const picker = page.getByRole("dialog", { name: "Request reviews from" });
  await picker.getByRole("option", { name: /bob/ }).waitFor();
  expect(await picker.getByRole("option", { name: /alice/ }).isDisabled(), "author disabled");
  const box = await picker.boundingBox();
  expect(box.y >= 0 && box.y + box.height <= page.viewportSize().height, `picker on screen (${Math.round(box.y)}–${Math.round(box.y + box.height)})`);
  await shot("reviewer picker");
  await picker.locator("input").fill("bo");
  expect((await picker.getByRole("option").count()) === 1, "filtered to bob");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await toast("Requested review from bob");
  const call = await lastCall("update");
  expect(JSON.stringify(call.reviewers) === JSON.stringify({ add: ["bob"], remove: [] }), JSON.stringify(call));
  expect((await railSection("Reviewers").innerText()).replace(/\s+/g, " ").includes("bob Requested"), "bob requested");
});
await check("reviewers: un-checking a request removes it", async () => {
  await railSection("Reviewers").getByRole("button", { name: "Request reviewers" }).click();
  const picker = page.getByRole("dialog", { name: "Request reviews from" });
  await picker.getByRole("option", { name: /bob/ }).click();
  await page.mouse.click(5, 300); // outside closes and applies
  await toast("Reviewers updated");
  const call = await lastCall("update");
  expect(call.reviewers.remove.includes("bob"), JSON.stringify(call));
  expect(!(await railSection("Reviewers").innerText()).includes("bob"), "bob removed");
});
await check("picker closed without changes sends nothing", async () => {
  const before = (await calls()).length;
  await railSection("Assignees").getByRole("button", { name: "Edit assignees" }).click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect((await calls()).length === before, "no call");
});
await check("labels: toggle, create a new one, chips update", async () => {
  await railSection("Labels").getByRole("button", { name: "Edit labels" }).click();
  const picker = page.getByRole("dialog", { name: "Labels" });
  await picker.getByRole("option", { name: /light/ }).click();
  await picker.locator("input").fill("urgent");
  await picker.getByRole("button", { name: /Create urgent/ }).click();
  await shot("labels picker");
  await page.keyboard.press("Escape");
  await toast("Labels updated");
  const call = await lastCall("update");
  expect(JSON.stringify(call.labels) === JSON.stringify(["api", "security", "needs-docs", "urgent"]), JSON.stringify(call.labels));
  const chips = await railSection("Labels").innerText();
  expect(chips.includes("urgent") && !chips.includes("light"), chips);
});
await check("a rejected change shows GitHub's reason and reverts", async () => {
  await railSection("Labels").getByRole("button", { name: "Edit labels" }).click();
  const picker = page.getByRole("dialog", { name: "Labels" });
  await picker.locator("input").fill("fail");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await toast("Reviews may only be requested");
  await page.waitForTimeout(800);
  expect(!(await railSection("Labels").innerText()).includes("fail"), "reverted");
});
await check("assignees: add and remove", async () => {
  await railSection("Assignees").getByRole("button", { name: "Edit assignees" }).click();
  const picker = page.getByRole("dialog", { name: "Assign to" });
  await picker.getByRole("option", { name: /bob/ }).click();
  await picker.getByRole("option", { name: /carol/ }).click();
  await page.keyboard.press("Escape");
  await toast("Assignees updated");
  const call = await lastCall("update");
  expect(JSON.stringify(call.assignees) === JSON.stringify({ add: ["carol"], remove: ["bob"] }), JSON.stringify(call.assignees));
  const text = await railSection("Assignees").innerText();
  expect(text.includes("carol") && !text.includes("bob"), text);
});
await check("checks: re-run one from its row, or every failed one", async () => {
  await page.mouse.move(5, 5);
  const lint = rail().locator("div.group\\/check", { hasText: "lint" });
  expect(!(await lint.getByRole("button").isVisible()), "re-run hidden until hover");
  const row = rail().locator("div.group\\/check", { hasText: "typecheck" });
  await row.hover();
  await row.getByRole("button", { name: "Re-run typecheck" }).click();
  await toast("Re-running typecheck");
  expect((await lastCall("rerun")).jobId === 7001, "job id sent");
  await page.waitForTimeout(300);
  expect((await row.locator("svg").first().getAttribute("class"))?.includes("animate") || (await rail().innerText()).includes("2 running"), "shown as running");
  await setState("reset=1");
  await open("#/pr/101");
  await detailReady();
  await rail().getByRole("button", { name: /Re-run failed check/ }).click();
  await toast("Re-running failed checks");
  const call = await lastCall("rerun");
  expect(call && call.jobId === undefined, JSON.stringify(call));
});
await check("status checks without a job can't be re-run", async () => {
  const row = rail().locator("div.group\\/check", { hasText: "preview deploy" });
  await row.hover();
  expect((await row.getByRole("button").count()) === 0, "no re-run on a status");
});
await check("many checks: what needs attention shows, passed and skipped fold away", async () => {
  await open("#/pr/131");
  await detailReady();
  const summary = await text("[data-checks-summary]");
  expect(summary === "1 failed · 2 running · 18 passed", summary);
  expect((await count("aside [data-check=failure]")) === 1 && (await count("aside [data-check=pending]")) === 2, "failing and running are listed");
  expect((await count("aside [data-check=success], aside [data-check=neutral]")) === 0, "passed and skipped start folded");
  const folded = await page.locator("aside").last().boundingBox();
  expect(folded.height < 900, `rail is ${Math.round(folded.height)}px tall`);
  await shot("many checks folded");
  await page.locator("aside button", { hasText: "18 passed" }).click();
  expect((await count("aside [data-check=success]")) === 18, "passed expand");
  await page.locator("aside button", { hasText: "18 passed" }).click();
  expect((await count("aside [data-check=success]")) === 0, "and fold again");
  await page.locator("aside button", { hasText: "26 skipped" }).click();
  expect((await count("aside [data-check=neutral]")) === 26, "skipped expand");
  await shot("many checks skipped open");
});
await check("draft → ready for review, and back", async () => {
  await open("#/pr/112");
  await detailReady();
  await shot("draft rail");
  await rail().getByRole("button", { name: "Ready for review" }).click();
  await toast("#112 is ready for review");
  expect((await lastCall("update")).draft === false, "draft false sent");
  await rail().getByRole("button", { name: "Ready for review" }).waitFor({ state: "detached" });
  await rail().getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Convert to draft" }).click();
  await toast("#112 is a draft again");
  expect((await lastCall("update")).draft === true, "draft true sent");
  await rail().getByRole("button", { name: "Ready for review" }).waitFor();
});
await check("someone else's PR can't be turned into a draft", async () => {
  await open("#/pr/101");
  await detailReady();
  await rail().getByRole("button", { name: "More actions" }).click();
  expect((await page.getByRole("menuitem", { name: "Convert to draft" }).count()) === 0, "no draft option on alice's PR");
  await page.keyboard.press("Escape");
});
await check("merge: blocked PRs say why and can't be merged", async () => {
  const card = page.locator("[data-status-card]");
  const button = card.getByRole("button", { name: /^Merge #101/ });
  expect(await button.isDisabled(), "disabled");
  const why = await card.getByRole("list", { name: "What blocks merging" }).innerText();
  expect(why.includes("CI checks failing (1/5 failed)") && why.includes("Changes requested"), why);
  await shot("merge blocked");
});
await check("merge: one PR, after confirming", async () => {
  await open("#/pr/120");
  await detailReady();
  const card = page.locator("[data-status-card]");
  await card.getByRole("button", { name: "Merge #120" }).click();
  expect((await card.innerText()).includes("Squash and merge #120 into main?"), await card.innerText());
  await shot("merge confirm");
  await card.getByRole("button", { name: "Cancel" }).click();
  expect((await calls()).every((c) => c.type !== "merge"), "cancel sends nothing");
  await card.getByRole("button", { name: "Merge #120" }).click();
  await card.getByRole("group", { name: "Confirm merge" }).getByRole("button", { name: "Merge" }).click();
  await toast("Merged #120");
  expect(JSON.stringify(await lastCall("merge")) === JSON.stringify({ type: "merge", pr: 120, stack: false }), JSON.stringify(await lastCall("merge")));
  await setState("reset=1");
});
await check("merge: the stack up to a PR, offered when the PR isn't on main", async () => {
  await open("#/pr/122");
  await detailReady();
  const card = page.locator("[data-status-card]");
  expect((await card.getByRole("button", { name: "Merge options" }).count()) === 0, "only one option: it's based on step 2");
  await card.getByRole("button", { name: "Merge stack (3)" }).click();
  await card.getByRole("group", { name: "Confirm merge" }).getByRole("button", { name: "Merge" }).click();
  await toast("Merged #120, #121, #122");
  expect((await lastCall("merge")).stack === true, "stack sent");
  await page.locator("[data-status-card]", { hasText: "Merged" }).waitFor();
  await setState("reset=1");
});
await check("merge: higher up, the stack is blocked by the PRs below", async () => {
  await open("#/pr/125");
  await detailReady();
  const why = await page.locator("[data-status-card]").getByRole("list", { name: "What blocks merging" }).innerText();
  expect(why.includes("#123: Changes requested by reviewer"), why);
});
await check("diverging stack in the inbox: one card, every branch on its own lane", async () => {
  await open();
  const card = page.locator("div.rounded-\\[14px\\]", { hasText: "Index documents for search" });
  const header = (await card.innerText()).replace(/\s+/g, " ");
  expect(header.includes("Stack of 6 on main · 3 branches"), header.slice(0, 80));
  const order = await card.locator("[data-row]").evaluateAll((rows) => rows.map((r) => r.dataset.row));
  expect(order.join(",") === "pr-145,pr-144,pr-142,pr-143,pr-141,pr-140", order.join(","));
  expect((await card.locator(".rail-corner").count()) === 2, "two branch points");
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: join(OUT, `${String(++shots).padStart(3, "0")} editing - diverging inbox.png`) });
});
await check("diverging stack on a PR page: the whole tree, the current PR marked", async () => {
  await open("#/pr/142");
  await detailReady();
  const section = page.locator("[data-stack-lanes]").first();
  expect((await section.getAttribute("data-stack-lanes")) === "3", "three lanes");
  const text = (await page.locator("[data-page=detail]").innerText()).replace(/\s+/g, " ");
  expect(text.includes("Stack 6 PRs · 3 branches"), text.slice(0, 200));
  const entries = await section.locator("[data-stack-entry]").evaluateAll((rows) => rows.map((r) => r.dataset.stackEntry));
  expect(entries.length === 6, entries.join(","));
  await section.screenshot({ path: join(OUT, `${String(++shots).padStart(3, "0")} editing - diverging stack.png`) });
});
await check("diverging stack: merging up to a PR takes only its own branch, not its siblings", async () => {
  await open("#/pr/144");
  await detailReady();
  const card = page.locator("[data-status-card]");
  await card.getByRole("button", { name: "Merge stack (3)" }).click();
  expect((await card.innerText()).includes("Squash and merge 3 PRs"), await card.innerText());
  await card.getByRole("group", { name: "Confirm merge" }).getByRole("button", { name: "Merge" }).click();
  await toast("Merged #140, #142, #144");
  await setState("reset=1");
});
await check("notes: on your own PR, comments go to your agent by default", async () => {
  await open("#/pr/110");
  await detailReady();
  const file = page.locator(".file").first();
  await file.scrollIntoViewIfNeeded();
  const row = file.locator("tr", { has: page.locator("td.code") }).first();
  await row.locator("td.code").last().hover();
  await row.locator("button.add-comment:visible").click();
  const composer = file.locator("tr.thread");
  expect((await composer.getByRole("radio", { name: /Note for agent/ }).getAttribute("aria-checked")) === "true", "agent is the default on your own PR");
  await page.keyboard.type("Use the shared validator here.");
  await shot("note composer");
  await composer.getByRole("button", { name: /Save note/ }).click();
  await toast("Note saved for your agent");
  const call = (await calls()).filter((c) => c.type === "note").at(-1);
  expect(call.ref.number === 110 && call.side === "RIGHT" && call.body === "Use the shared validator here.", JSON.stringify(call));
  await file.locator("[data-note]").waitFor();
  // The section lists it with where it is and how the agent gets it.
  const section = page.locator("[data-notes-section]");
  const text = (await section.innerText()).replace(/\s+/g, " ");
  expect(text.includes("1 open") && text.includes("Use the shared validator here.") && text.includes("pile notes"), text);
  expect(!text.includes("--branch"), "settings/schema is checked out, so no --branch");
  await section.scrollIntoViewIfNeeded();
  await shot("notes section");
});
await check("notes: the agent's reply shows up live, and a follow-up reopens the note", async () => {
  const section = page.locator("[data-notes-section]");
  await fetch(`${server.url}/__agent-reply?done&body=${encodeURIComponent("Switched to validateSettings() from src/settings/schema.ts.")}`);
  await toast("Your agent resolved 1 note");
  await section.locator("[data-reply=agent]", { hasText: "validateSettings()" }).first().waitFor();
  expect((await section.innerText()).includes("all done"), "resolved by the agent");
  await section.scrollIntoViewIfNeeded();
  await shot("agent replied");
  await section.getByRole("button", { name: "Reply…" }).first().click();
  await page.keyboard.type("Also handle the empty object.");
  await page.keyboard.press("Meta+Enter");
  await section.locator("[data-reply=reviewer]", { hasText: "empty object" }).first().waitFor();
  await section.getByText("1 open").waitFor();
  expect((await calls()).some((c) => c.type === "note-reply" && c.body === "Also handle the empty object."), "reply sent");
});
await check("notes: done, reopen and delete", async () => {
  const section = page.locator("[data-notes-section]");
  await section.getByRole("button", { name: "Mark note done" }).click();
  await section.getByText("all done").waitFor();
  await section.getByRole("button", { name: "Reopen note" }).click();
  await section.getByText("1 open").waitFor();
  await section.getByRole("button", { name: "Delete note" }).first().click();
  await page.waitForFunction(() => document.querySelectorAll("[data-note]").length === 0);
  expect((await count("[data-notes-section]")) === 0, "section goes away on a PR with no notes");
});
await check("notes: on someone else's PR, a review comment by default; switch to a note, on old code too", async () => {
  await open("#/pr/101");
  await detailReady();
  const file = page.locator('.file[data-path="src/api/limit.ts"]');
  await file.scrollIntoViewIfNeeded();
  const row = file.locator("tr", { hasText: "removed = true" }).first();
  await row.locator("td.code").first().hover();
  await row.locator("button.add-comment:visible").click();
  const composer = file.locator("tr.thread", { has: page.locator("textarea") });
  expect((await composer.getByRole("radio", { name: /Review comment/ }).getAttribute("aria-checked")) === "true", "GitHub by default");
  await composer.getByRole("radio", { name: /Note for agent/ }).click();
  await page.keyboard.type("Keep this flag; the mobile app reads it.");
  await composer.getByRole("button", { name: /Save note/ }).click();
  await toast("Note saved for your agent");
  const call = (await calls()).filter((c) => c.type === "note").at(-1);
  expect(call.side === "LEFT" && call.ref.number === 101, JSON.stringify(call));
  const text = (await page.locator("[data-notes-section]").innerText()).replace(/\s+/g, " ");
  expect(text.includes("(old)") && text.includes("pile notes --branch api/rate-limit"), text);
  expect((await calls()).every((c) => c.type !== "review"), "nothing sent to GitHub");
});
await check("notes: on a local branch, every comment is a note, and the branch takes general notes", async () => {
  await open("#/branch/spike%2Fparser-errors");
  await detailReady();
  const section = page.locator("[data-notes-section]");
  expect((await section.innerText()).includes("Comment on lines in the diff"), "explains itself when empty");
  await section.locator("textarea").click();
  await page.keyboard.type("Add a test for the empty input.");
  await page.keyboard.press("Meta+Enter");
  await toast("Note saved for your agent");
  await section.getByText("whole branch").waitFor();
  const file = page.locator(".file").first();
  const row = file.locator("tr", { has: page.locator("td.code") }).first();
  await row.locator("td.code").last().hover();
  await row.locator("button.add-comment:visible").click();
  const composer = file.locator("tr.thread", { has: page.locator("textarea") });
  expect((await composer.getByRole("radio").count()) === 0 && (await composer.innerText()).includes("Note for your agent"), "no GitHub option on a local branch");
  await page.keyboard.type("Split this function.");
  await page.keyboard.press("Meta+Enter");
  await page.waitForFunction(() => document.querySelectorAll("[data-notes-section] [data-note]").length === 2);
  await setState("reset=1");
});
await check("local branches have nothing to edit", async () => {
  await open("#/branch/spike%2Fparser-errors");
  await detailReady();
  expect((await count("aside button[aria-label^='Edit'], aside button[aria-label='Request reviewers'], aside button:has-text('To draft')")) === 0, "no edit controls");
  await setState("reset=1");
});

// =============================================================================
section = "layout";
log("\nThemes and widths");
for (const scheme of ["light", "dark"]) {
  await check(`${scheme}: inbox, PR page and files render`, async () => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${server.url}/#/`);
    await page.waitForSelector("[data-page=inbox]:not([data-partial])");
    await shot(`${scheme} inbox`);
    await page.click('[data-row="pr-101"]');
    await detailReady();
    await shot(`${scheme} detail`);
    await filesSection.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(`${scheme} files`);
  });
}
for (const width of [1100, 900]) {
  await check(`${width}px wide: no horizontal scrolling, nav stays on one line, rail after the content`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.url}/#/`);
    await page.waitForSelector("[data-page=inbox]");
    expect(await noHorizontalScroll(), "inbox scrolls sideways");
    await shot(`${width} inbox`);
    await page.click('[data-row="pr-101"]');
    await detailReady();
    expect(await noHorizontalScroll(), "detail scrolls sideways");
    const navHeight = await page.locator("nav").evaluate((n) => n.getBoundingClientRect().height);
    const pagerLines = await page.locator("nav div.whitespace-nowrap").evaluate((d) => Math.round(d.getBoundingClientRect().height));
    expect(navHeight <= 53 && pagerLines <= 30, `nav ${navHeight}px, pager ${pagerLines}px`);
    if (width < 1080) {
      const titleTop = await page.locator("[data-page=detail] h1").evaluate((h) => h.getBoundingClientRect().top);
      const railTop = await page.locator("[data-page=detail] > aside").evaluate((a) => a.getBoundingClientRect().top);
      expect(titleTop < railTop, "title comes before the rail");
    }
    await shot(`${width} detail`);
  });
}
await page.setViewportSize({ width: 1440, height: 900 });

await check("no console errors during the run", async () => {
  expect(consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
});

const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, "results.json"), JSON.stringify({ results, consoleErrors }, null, 2));
log(`\n${results.length - failed.length}/${results.length} checks passed, ${shots} screenshots in ${OUT}`);
await browser.close();
await server.close();
process.exit(failed.length ? 1 : 0);
