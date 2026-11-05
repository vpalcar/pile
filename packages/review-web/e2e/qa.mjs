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
page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && !m.text().includes("503") && !m.text().includes("404") && !m.text().includes("422") && consoleErrors.push(m.text()));
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
  expect(tabs.join("|").replace(/\s+/g, " ") === "All 20|Needs review 3|Yours 12|Local 3|Others 2".replace(/\s+/g, " ").replace(/\|/g, "|"), tabs.join(" | "));
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
  const columns = await page.locator("[data-row]").evaluateAll((rows) =>
    [0, 1, 6].map((i) => [...new Set(rows.map((r) => Math.round(r.children[i].getBoundingClientRect().left)))]),
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
  await page.keyboard.press("/");
  await page.keyboard.type("rate-limit");
  expect((await count("[data-row]")) === 2, `rows for "rate-limit": ${await count("[data-row]")}`);
  await shot("search");
  await page.keyboard.press("Escape");
  await page.locator("input[placeholder^='Filter by']").fill("#103");
  expect((await count("[data-row]")) === 1, "#103 by number");
  await page.locator("input[placeholder^='Filter by']").fill("carol");
  expect((await count("[data-row]")) === 1, "by author");
  await page.locator("input[placeholder^='Filter by']").fill("zzzz");
  await page.getByText("No pull requests or branches match").waitFor();
  await shot("search no match");
  await page.locator("input[placeholder^='Filter by']").press("Escape");
  expect((await count("[data-row]")) === 20, "cleared");
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
await check("opening a PR shows a breadcrumb and position", async () => {
  await page.click('[data-row="pr-101"]');
  await detailReady();
  const nav = (await text("nav")).replace(/\s+/g, " ");
  expect(nav.includes("#101") && nav.includes("Rate limit the public API") && nav.includes("1 of 20"), nav);
  expect(await page.locator("nav button[data-tip=Previous]").isDisabled(), "previous disabled on the first item");
  await shot("breadcrumb");
});
await check("] and [ step through items", async () => {
  await page.keyboard.press("]");
  await page.waitForFunction(() => location.hash.includes("/pr/102"));
  await page.keyboard.press("[");
  await page.waitForFunction(() => location.hash.includes("/pr/101"));
});
await check("GitHub link points at the PR", async () => {
  expect((await page.locator("nav a", { hasText: "GitHub" }).getAttribute("href")) === "https://github.com/acme/web/pull/101", "href");
});
await check("theme toggle cycles system → dark → light → system", async () => {
  const button = page.locator("nav button[data-tip^='Theme']");
  const themes = [];
  for (let i = 0; i < 3; i++) {
    await button.click();
    themes.push(await page.evaluate(() => document.documentElement.dataset.theme ?? "system"));
  }
  expect(themes.join(",") === "dark,light,system", themes.join(","));
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
  for (const part of ["Checks failing", "2 passed · 1 failed · 1 running", "typecheck", "42s", "1m 35s", "frank", "Approved", "erin", "Changes requested", "grace", "Commented", "platform-team", "Requested", "api", "security", "alice", "bob"]) {
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
  const last = (await calls()).at(-1);
  expect(last.type === "review" && last.event === "APPROVE" && last.body === "Ship it.", JSON.stringify(last));
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
  expect((await count(".diff-table.split")) === 0, "unified");
  await page.locator('.file[data-path="src/api/limit.ts"]').scrollIntoViewIfNeeded();
  await shot("unified");
  await page.keyboard.press("s");
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
