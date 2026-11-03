import { expect, type Page, type Request, type Route, test } from "@playwright/test";
import {
  CSRF,
  conversationIdOf,
  createAgent,
  currentOrg,
  designZh,
  openConversation,
  replies,
  send,
  zh,
} from "./support/chat";
import { hydrated } from "./support/nav";
import { ORG_NAME, signIn } from "./support/sign-in";

/**
 * The web query cache (spec `docs/superpowers/specs/2026-11-03-web-query-cache-design.md` §9): a
 * first load paints complete from the layout's prefetch, a client navigation reads from the query
 * cache (nothing within the freshness window, a background refresh after it, the template's
 * loading state for what is not cached), and a mutation or an org switch keeps every view current.
 * The cases count the browser's `/api` GETs with `page.on("request")`.
 */

/** Every `/api` GET the browser makes from now on (EventSource streams included), as paths. */
function recordGets(page: Page): { paths: string[]; stop(): void } {
  const paths: string[] = [];
  const onRequest = (r: Request) => {
    const url = new URL(r.url());
    if (r.method() === "GET" && url.pathname.startsWith("/api/")) {
      paths.push(url.pathname + url.search);
    }
  };
  page.on("request", onRequest);
  return { paths, stop: () => page.off("request", onRequest) };
}

/** Document requests of the main frame from now on (a reload or a full navigation). */
function recordDocuments(page: Page): string[] {
  const docs: string[] = [];
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) docs.push(r.url());
  });
  return docs;
}

/** Lets held requests through; one the browser cancelled meanwhile is already handled. */
async function release(held: Route[]): Promise<void> {
  await Promise.all(held.map((r) => r.continue().catch(() => undefined)));
}

const sidebarConversations = (page: Page) => page.getByRole("region", { name: "会话" });
const titleOf = (page: Page) => page.locator('[data-part="title-bar"] [data-part="title"]');

/** Waits until the conversation's generated title is shown (title generation is a background job). */
async function titled(page: Page, id: string): Promise<void> {
  await expect(titleOf(page)).not.toHaveAttribute("data-untitled", "true", { timeout: 60_000 });
  await expect(sidebarConversations(page).locator(`a[href$="/chat/${id}"]`)).not.toContainText(
    designZh("sidebar.untitled"),
  );
}

/** The highest seq of the conversation's log. */
async function lastSeq(page: Page, orgId: string, id: string): Promise<number> {
  const res = await page.request.get(`/api/v1/orgs/${orgId}/conversations/${id}/events?limit=500`);
  expect(res.ok()).toBe(true);
  const { events } = (await res.json()) as { events: { seq: number }[] };
  return Math.max(...events.map((e) => e.seq));
}

/**
 * Conversation A (opened as a document, one exchange, titled), then B created from the sidebar's
 * 新会话 link by a client navigation; the page ends on B. Waiting for both titles keeps any
 * background change to A from landing while the case is away.
 */
async function twoConversations(page: Page, agentName: string) {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, agentName);
  const a = await openConversation(page, orgId, agentId);
  await send(page, "echo:alpha");
  await expect(replies(page).last()).toHaveText(/alpha/);
  await titled(page, a);
  // A fresh document of A: everything A shows is read now, so the 30 s window starts here.
  await page.reload();
  await expect(replies(page).last()).toHaveText(/alpha/);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: designZh("sidebar.new") })
    .click();
  await expect(page).toHaveURL(/\/chat$/);
  await send(page, "echo:beta");
  await expect(replies(page).last()).toHaveText(/beta/);
  const b = conversationIdOf(page);
  await titled(page, b);
  return { orgId, agentId, a, b };
}

/** Back to A through its sidebar row (a client navigation). */
async function backTo(page: Page, id: string): Promise<void> {
  await sidebarConversations(page).locator(`a[href$="/chat/${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${id}$`));
}

test("back to a conversation within 30 s reads only its stream", async ({ page }) => {
  const { orgId, agentId, a } = await twoConversations(page, "QC within");
  const after = await lastSeq(page, orgId, a);
  const docs = recordDocuments(page);
  const gets = recordGets(page);

  await backTo(page, a);
  // A paints from the cache, its stream reopens from the cached last seq
  await expect(replies(page).last()).toHaveText(/alpha/);
  await expect
    .poll(() => gets.paths.filter((p) => p.includes(`/conversations/${a}/stream`)))
    .toHaveLength(1);
  // give a late read the time to show up
  await page.waitForTimeout(1500);
  gets.stop();

  const forA = gets.paths.filter(
    (p) => p.includes(`/conversations/${a}`) || p.includes(`/agents/${agentId}`),
  );
  expect(forA).toEqual([`/api/v1/orgs/${orgId}/conversations/${a}/stream?after=${after}`]);
  expect(docs).toEqual([]);
});

test("after 30 s it paints at once and refreshes in the background", async ({ page }) => {
  // the fake clock follows real time until the case moves it on
  await page.clock.install();
  const { orgId, a } = await twoConversations(page, "QC stale");
  await page.clock.setSystemTime(Date.now() + 31_000);

  // A's reads (all but its stream) are held until A has painted
  const held: Route[] = [];
  const heldPaths: string[] = [];
  const isAsRead = (url: URL) =>
    url.pathname.includes(`/conversations/${a}`) && !url.pathname.endsWith("/stream");
  await page.route(isAsRead, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    heldPaths.push(url.pathname);
    held.push(route);
  });

  await backTo(page, a);
  await expect(replies(page).last()).toHaveText(/alpha/);
  // A painted while its background reads were still unanswered
  await expect.poll(() => heldPaths.length).toBeGreaterThan(0);
  expect(held.length).toBe(heldPaths.length);
  await expect(replies(page).last()).toHaveText(/alpha/);

  const base = `/api/v1/orgs/${orgId}/conversations/${a}`;
  // the live pieces refresh; the log is never read again (the stream catches up)
  await expect
    .poll(() => [...new Set(heldPaths)].sort())
    .toEqual(expect.arrayContaining([base, `${base}/files`, `${base}/queue`]));
  expect(heldPaths).not.toContain(`${base}/events`);

  await release(held);
  await page.unroute(isAsRead);
  await expect(replies(page).last()).toHaveText(/alpha/);
});

test("renaming a conversation updates the sidebar without a reload or an extra groups read beyond the invalidation's one", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "QC rename");
  const id = await openConversation(page, orgId, agentId);
  await send(page, "echo:rename me");
  await expect(replies(page).last()).toHaveText(/rename me/);
  await titled(page, id);

  const docs = recordDocuments(page);
  const gets = recordGets(page);
  await titleOf(page).click();
  await page.getByRole("menuitem", { name: zh.chat.rename }).click();
  const dialog = page.getByRole("dialog", { name: designZh("rename.title") });
  await dialog.getByRole("textbox").fill("Renamed by the cache case");
  await dialog.getByRole("button", { name: designZh("rename.save") }).click();

  await expect(titleOf(page)).toHaveText("Renamed by the cache case");
  await expect(sidebarConversations(page).locator(`a[href$="/chat/${id}"]`)).toContainText(
    "Renamed by the cache case",
  );
  const groups = () => gets.paths.filter((p) => p.includes("/conversations/groups"));
  await expect.poll(groups).toHaveLength(1);
  await page.waitForTimeout(1500);
  gets.stop();
  expect(groups()).toHaveLength(1);
  // the session is not read again (`mine` data, untouched by a rename)
  expect(gets.paths.filter((p) => p.startsWith("/api/v1/me"))).toEqual([]);
  expect(docs).toEqual([]);
});

/** One frame state: the org the switcher names and which of the two orgs' agents the page shows. */
type Frame = { org: string | null; acme: boolean; other: boolean };

const PROBE_KEY = "e2e-query-cache-probe";

/**
 * Records every distinct frame state (the org switcher's org, whether the page shows Acme's or the
 * other org's agent) from before the first paint of every document, in `sessionStorage`.
 */
async function installProbe(page: Page, names: { acme: string; other: string }): Promise<void> {
  await page.addInitScript(
    ({ key, acme, other }) => {
      let last = "";
      const record = () => {
        const text = document.body?.innerText ?? "";
        const frame = {
          org: document.querySelector('[data-part="org-switcher"]')?.getAttribute("title") ?? null,
          acme: text.includes(acme),
          other: text.includes(other),
        };
        const json = JSON.stringify(frame);
        if (json === last) return;
        last = json;
        try {
          const seen = JSON.parse(sessionStorage.getItem(key) ?? "[]") as unknown[];
          seen.push(frame);
          sessionStorage.setItem(key, JSON.stringify(seen));
        } catch {
          // storage unavailable: the assertions then see no frames and fail loudly
        }
      };
      new MutationObserver(record).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["title"],
      });
    },
    { key: PROBE_KEY, ...names },
  );
}

const framesSeen = (page: Page): Promise<Frame[]> =>
  page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "[]") as Frame[], PROBE_KEY);

type Me = { memberships: { orgId: string; name: string }[] };

test("switching org never shows the old org", async ({ page }) => {
  const stamp = Date.now();
  const names = { acme: `QC Acme only ${stamp}`, other: `QC Other only ${stamp}` };
  await installProbe(page, names);
  await signIn(page);
  const acmeId = await currentOrg(page);
  await createAgent(page, acmeId, names.acme);
  // a second org that is ready (an agent of its own), so the switch lands on its workspace
  const otherName = `QC switch ${stamp}`;
  const r = await page.request.post("/api/v1/orgs", { headers: CSRF, data: { name: otherName } });
  expect(r.ok(), await r.text()).toBe(true);
  const otherId = ((await r.json()) as { org: { id: string } }).org.id;
  await createAgent(page, otherId, names.other);

  try {
    // Acme's agent list is in the cache
    await page.goto("/agents");
    await expect(page.getByText(names.acme)).toBeVisible();
    await hydrated(page);
    await page.evaluate((key) => sessionStorage.removeItem(key), PROBE_KEY);

    const sidebar = page.locator('[data-part="sidebar"][data-context="work"]');
    await sidebar.locator('button[data-part="account"]').click();
    await page.getByRole("menuitem", { name: zh.shell.orgMenu }).click();
    await page.getByRole("menuitemradio", { name: otherName }).click();
    await expect(page).toHaveURL(/\/$/);
    await hydrated(page);
    await expect(sidebar.locator('[data-part="org-switcher"]')).toHaveAttribute("title", otherName);
    // the agent list of the other org, by a client navigation
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: zh.nav.agents })
      .click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByText(names.other)).toBeVisible();

    const frames = await framesSeen(page);
    expect(frames.length).toBeGreaterThan(0);
    // never the old org's agent under the other org, nor the other org's under the old one
    expect(frames.filter((f) => f.org === otherName && f.acme)).toEqual([]);
    expect(frames.filter((f) => f.org === ORG_NAME && f.other)).toEqual([]);
  } finally {
    // back to Acme, so the specs that run after this one sign in to the org they expect
    const me = await page.request.get("/api/v1/me");
    const acme = ((await me.json()) as Me).memberships.find((m) => m.name === ORG_NAME);
    if (acme !== undefined) {
      await page.request.put("/api/v1/me/current-org", {
        headers: CSRF,
        data: { orgId: acme.orgId },
      });
    }
  }
});

test("a reload paints complete with no skeleton and no browser read", async ({ page }) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "QC reload");
  const conversation = await openConversation(page, orgId, agentId);
  await send(page, "echo:painted whole");
  await expect(replies(page).last()).toHaveText(/painted whole/);
  await titled(page, conversation);
  // what the parsed document holds when DOMContentLoaded fires (before any client fetch answers)
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      (window as unknown as { __firstPaint: unknown }).__firstPaint = {
        busy: document.querySelectorAll('[aria-busy="true"]').length,
        templates: [...document.querySelectorAll("[data-template]")].map((e) =>
          e.getAttribute("data-template"),
        ),
      };
    });
  });
  const firstPaint = () =>
    page.evaluate(
      () =>
        (window as unknown as { __firstPaint: { busy: number; templates: string[] } }).__firstPaint,
    );

  for (const [path, template] of [
    [`/agents/${agentId}`, "FormPage"],
    [`/chat/${conversation}`, "ConversationPage"],
    ["/agents", "ListPage"],
  ] as const) {
    const gets = recordGets(page);
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.locator(`[data-template="${template}"]`)).toBeVisible();
    expect(await firstPaint()).toEqual({ busy: 0, templates: [template] });
    // the dehydrated cache feeds the view and the frame: the browser reads nothing but a stream
    await page.waitForTimeout(1500);
    gets.stop();
    expect(
      gets.paths.filter((p) => !/\/conversations\/[^/]+\/stream\?after=\d+$/.test(p)),
      path,
    ).toEqual([]);
  }
});

test("a client navigation to an uncached page shows the template's loading state", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "QC loading");
  await page.goto("/agents");
  // a click before hydration would be a document navigation (no client cache to miss)
  await hydrated(page);

  // the agent's own read is held until the loading state was seen
  const agentPath = `/api/v1/orgs/${orgId}/agents/${agentId}`;
  const held: Route[] = [];
  const isAgentRead = (url: URL) => url.pathname === agentPath;
  await page.route(isAgentRead, async (route) => {
    held.push(route);
  });

  await page.locator(`a[href="/agents/${agentId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${agentId}$`));
  const form = page.locator('[data-template="FormPage"]');
  await expect(form).toBeVisible();
  await expect(form.locator('[aria-busy="true"]').first()).toBeAttached();
  await expect.poll(() => held.length).toBeGreaterThan(0);

  await release(held);
  await page.unroute(isAgentRead);
  await expect(
    page.getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true }),
  ).toHaveValue("QC loading");
  await expect(form.locator('[aria-busy="true"]')).toHaveCount(0);
});
