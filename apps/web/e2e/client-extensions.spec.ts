import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { composer, designZh, replies, send, startChat } from "./support/chat";
import {
  type ClientWorld,
  clientWorld,
  pageAs,
  pickSlot,
  type ShellItem,
  setClientExtensions,
  shellRead,
} from "./support/client-fixtures";
import { hydrated, mainNavLink } from "./support/nav";

/**
 * Client extensions end to end (spec `docs/superpowers/specs/2026-11-09-client-extensions-design.md`
 * §14): the fixture `fake-client` (components `hud`, `brand`, `empty`, `frame`, `fx`, a stylesheet
 * on parts and `run=` states, an `events` listener, a suggested appearance) and the broken one
 * `fake-client-broken`, imported through the catalog and switched on in orgs of their own
 * (`support/client-fixtures.ts`), in a real browser: the first document's CSP, import map and
 * stylesheet, first-paint CSS, components with view data, run states, applying the appearance,
 * safe mode, the kill switch, the crash budget, the admin boundary and delivery access.
 */

/** UI copy from the zh messages (the specs read zh). */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/** What `client/styles/fake.css` gives the composer's buttons (the send button among them). */
const FIXTURE_OUTLINE = "rgb(1, 2, 3)";
/** The `fake` theme's dark accent (`themes/fake.json`). */
const FAKE_DARK_ACCENT = "#8fb8ff";

const SEND_BUTTON = '[data-cap-part~="composer"] [data-part="send"]';
const EXTENSION_SHEETS = 'link[rel="stylesheet"][data-precedence="extensions"]';

let w: ClientWorld;

test.beforeEach(async ({ browser }) => {
  w = await clientWorld(browser);
});

/** `fake-client` as the org's shell read lists it for `page`'s account. */
async function fakeClient(page: Page): Promise<ShellItem> {
  const item = (await shellRead(page.request, w.b.orgId)).items.find(
    (i) => i.plugin === "fake-client",
  );
  expect(item?.entry).toBeTruthy();
  return item as ShellItem;
}

/** Records every request for plugin code the page makes: the client file route and the host shims. */
function clientRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/api/v1/client/") || path.startsWith("/_capybara/client-host/"))
      seen.push(r.url());
  });
  return seen;
}

const rootToken = (page: Page, name: string) =>
  page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(),
    name,
  );

/** The shell's state tokens (`data-cap-state` on the `shell` part). */
const capState = (page: Page) =>
  page.locator('[data-cap-part~="shell"]').first().getAttribute("data-cap-state");

/** The brand row of the visible sidebar panel. */
const brandRow = (page: Page) =>
  page.locator('[data-part="sidebar"]:visible [data-part="brand-row"]').first();

/** The org's default theme back to the built-in one. */
async function resetOrgTheme(page: Page): Promise<void> {
  const r = await page.request.patch(`/api/v1/orgs/${w.b.orgId}/settings`, {
    headers: { "X-Capybara-Csrf": "1" },
    data: { theme: { id: null, personal: "allowed" } },
  });
  expect(r.ok(), await r.text()).toBe(true);
}

test("the first document carries the CSP nonce, the import map and the plugin stylesheet", async ({
  browser,
}) => {
  const page = await pageAs(browser, w.b, "");
  const item = await fakeClient(page);
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  const csp = (await res?.allHeaders())?.["content-security-policy"] ?? "";
  const nonce = /'nonce-([A-Za-z0-9+/]+={0,2})'/.exec(csp)?.[1];
  expect(nonce, csp).toBeDefined();
  // the client file route is a script source of the policy
  expect(csp).toContain(`${new URL(page.url()).host}/api/v1/client/ `);
  const html = (await res?.text()) ?? "";
  const head = html.slice(0, html.indexOf("</head>"));

  // the import map: the request's nonce, the host shims, the entry's integrity (the kernel's)
  const map = /<script([^>]*)type="importmap"([^>]*)>([\s\S]*?)<\/script>/.exec(html);
  expect(map, "an import map in the document").not.toBeNull();
  const attrs = `${map?.[1]} ${map?.[2]}`;
  expect(/nonce="([^"]+)"/.exec(attrs)?.[1]).toBe(nonce);
  const parsed = JSON.parse(map?.[3] ?? "{}") as {
    imports: Record<string, string>;
    integrity: Record<string, string>;
  };
  for (const specifier of [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "@capybara-hq/plugin-client",
  ]) {
    expect(parsed.imports[specifier]).toMatch(/^\/_capybara\/client-host\/[^/]+\/[a-z-]+\.mjs$/);
    expect(parsed.integrity[parsed.imports[specifier] as string]).toMatch(/^sha384-/);
  }
  const entry = item.entry as { url: string; integrity: string };
  expect(entry.url).toBe(`/api/v1/client/fake-client/${item.build}/client.mjs`);
  expect(parsed.integrity[entry.url]).toBe(entry.integrity);

  // the plugin stylesheet, in <head> with its integrity
  const style = item.styles[0];
  expect(style?.url).toBe(`/api/v1/client/fake-client/${item.build}/styles/fake.css`);
  const link = new RegExp(`<link[^>]*href="${style?.url}"[^>]*>`).exec(head)?.[0] ?? "";
  expect(link).toContain('rel="stylesheet"');
  expect(link).toContain('data-precedence="extensions"');
  expect(link).toContain(`integrity="${style?.integrity}"`);

  // the browser warms the entry with a classic preload (the layout's hint) and ran it
  await hydrated(page);
  const preload = page.locator(`head link[rel="preload"][href="${entry.url}"]`);
  await expect(preload).toHaveAttribute("as", "script");
  await expect(preload).toHaveAttribute("integrity", entry.integrity);
  await expect(page.getByTestId("fake-client-fx")).toBeAttached();
  await page.context().close();
});

test("part css applies at DOMContentLoaded", async ({ browser }) => {
  const page = await pageAs(browser, w.b, "", async (p) => {
    await p.addInitScript((selector: string) => {
      document.addEventListener("DOMContentLoaded", () => {
        const send = document.querySelector(selector);
        (window as unknown as { __atDcl: unknown }).__atDcl = {
          found: send !== null,
          outline: send === null ? null : getComputedStyle(send).outlineColor,
        };
      });
    }, SEND_BUTTON);
  });
  await page.goto("/");
  const atDcl = await page.evaluate(
    () => (window as unknown as { __atDcl: { found: boolean; outline: string } }).__atDcl,
  );
  expect(atDcl).toEqual({ found: true, outline: FIXTURE_OUTLINE });
  await page.context().close();
});

test("the hud component appears with its view data", async ({ browser }) => {
  const page = await pageAs(browser, w.b, `/?agent=${w.b.agentId}`);
  await send(page, "echo:hud please");
  await expect(replies(page).last()).toContainText("hud please");
  await page.getByRole("button", { name: designZh("titlebar.properties") }).click();
  // the server view answers `data: { n: 1 }`; the component reads it through useView()
  await expect(page.getByTestId("fake-client-hud")).toHaveText("hud 1");
  await page.context().close();
});

test("a run switches data-cap-state to run=running and back", async ({ browser }) => {
  const page = await pageAs(browser, w.b, `/?agent=${w.b.agentId}`);
  await send(page, "echo:warm up");
  await expect(replies(page).last()).toContainText("warm up");
  await expect.poll(() => capState(page)).toMatch(/(^| )run=idle( |$)/);
  // ~4 s of streaming: the shell says running, and the plugin CSS keyed on it applies
  await send(page, `slow:200:${"running state check ".repeat(4)}`);
  await expect.poll(() => capState(page)).toMatch(/(^| )run=running( |$)/);
  const shell = page.locator('[data-cap-part~="shell"]').first();
  expect(
    await shell.evaluate((el) => getComputedStyle(el).getPropertyValue("--cx-fake-client-run")),
  ).toBe("1");
  await expect(replies(page).last()).toContainText("running state check running state check");
  await expect.poll(() => capState(page)).toMatch(/(^| )run=idle( |$)/);
  expect(
    await shell.evaluate((el) => getComputedStyle(el).getPropertyValue("--cx-fake-client-run")),
  ).toBe("");
  await page.context().close();
});

test("apply appearance picks the brand replacement and the theme", async ({ browser }) => {
  const page = await pageAs(browser, w.b, "");
  // the built-in brand and theme first
  await pickSlot(page.request, w.b.orgId, "shell.brand", null);
  await resetOrgTheme(page);
  await page.goto("/extensions");
  await hydrated(page);
  await expect(brandRow(page).getByTestId("fake-client-brand")).toHaveCount(0);
  const before = await rootToken(page, "--cb-accent");
  expect(before).not.toBe(FAKE_DARK_ACCENT);

  // the extension's row by its name (`fake-client v<version> …`), never fake-client-broken's
  await page.getByRole("row", { name: /^fake-client v/ }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: /^应用 .+ 的外观$/ }).click();
  const confirm = page.getByRole("dialog", { name: /^应用 .+ 的外观？$/ });
  await expect(confirm).toBeVisible();
  // the plugin has client code: the dialog says the page reloads after the apply
  await expect(confirm.getByText(zh.applyAppearance.reloadHint)).toBeVisible();
  await page.evaluate(() => {
    (window as { __beforeApply?: boolean }).__beforeApply = true;
  });
  const reloaded = page.waitForEvent("framenavigated", (f) => f === page.mainFrame());
  await confirm.getByRole("button", { name: zh.applyAppearance.apply, exact: true }).click();

  // a new document: the replacement wraps the official brand, the theme's tokens apply
  await reloaded;
  await page.waitForLoadState("load");
  expect(
    await page.evaluate(() => (window as { __beforeApply?: boolean }).__beforeApply),
  ).toBeUndefined();
  await hydrated(page);
  await expect(brandRow(page).getByTestId("fake-client-brand")).toBeVisible();
  await expect(brandRow(page).locator(".cb-logo")).toBeVisible();
  await expect.poll(() => rootToken(page, "--cb-accent")).toBe(FAKE_DARK_ACCENT);
  // a new document paints the same
  await page.goto("/");
  await hydrated(page);
  await expect(brandRow(page).getByTestId("fake-client-brand")).toBeVisible();
  expect(await rootToken(page, "--cb-accent")).toBe(FAKE_DARK_ACCENT);
  await page.context().close();
});

test("safe mode loads zero plugin code", async ({ browser }) => {
  const page = await pageAs(browser, w.b, "");
  await pickSlot(page.request, w.b.orgId, "shell.brand", "fake-client/brand");
  const requests = clientRequests(page);
  await page.goto("/?safe-ui=1");
  await hydrated(page);
  const banner = page.getByText(designZh("safeMode.message"));
  await expect(banner).toBeVisible();
  // two client navigations: the URL loses the parameter, safe mode stays
  await (await mainNavLink(page, zh.nav.agents)).click();
  await expect(page).toHaveURL(/\/agents$/);
  await startChat(page, "CX agent b");
  await expect(composer(page)).toBeEditable();
  await expect(banner).toBeVisible();
  // the official brand; nothing of the plugin in the document
  await expect(brandRow(page).locator(".cb-logo")).toBeVisible();
  await expect(page.getByTestId("fake-client-brand")).toHaveCount(0);
  await expect(page.getByTestId("fake-client-fx")).toHaveCount(0);
  await expect(page.locator('script[type="importmap"]')).toHaveCount(0);
  expect(
    await page
      .locator(EXTENSION_SHEETS)
      .evaluateAll((ls) =>
        ls.filter((l) => !(l as HTMLLinkElement).disabled).map((l) => l.getAttribute("href")),
      ),
  ).toEqual([]);
  expect(requests).toEqual([]);
  // the exit loads the page with safe-ui=0: the proxy clears the session cookie, the plugin is back
  await page.getByRole("button", { name: designZh("safeMode.exit") }).click();
  await expect(page).toHaveURL(/safe-ui=0/);
  await hydrated(page);
  await expect(banner).toHaveCount(0);
  await expect(brandRow(page).getByTestId("fake-client-brand")).toBeVisible();
  expect((await page.context().cookies()).some((c) => c.name === "cap_safe_ui")).toBe(false);
  await page.context().close();
});

test("the kill switch removes everything after the shell read", async ({ browser }) => {
  const page = await pageAs(browser, w.b, "", async (p) => {
    await p.clock.install();
  });
  await pickSlot(page.request, w.b.orgId, "shell.brand", "fake-client/brand");
  const item = await fakeClient(page);
  await page.goto("/");
  await hydrated(page);
  const send = page.locator(SEND_BUTTON);
  await expect(brandRow(page).getByTestId("fake-client-brand")).toBeVisible();
  await expect(page.getByTestId("fake-client-fx")).toBeAttached();
  await expect(send).toHaveCSS("outline-color", FIXTURE_OUTLINE);
  try {
    await setClientExtensions(page.request, { enabled: false, disabled: [] });
    // the open page's next shell read: the set is stale after its freshness (30 s), and a
    // reconnect refetches it
    await page.clock.fastForward(31_000);
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await expect(brandRow(page).getByTestId("fake-client-brand")).toHaveCount(0);
    await expect(brandRow(page).locator(".cb-logo")).toBeVisible();
    await expect(page.getByTestId("fake-client-fx")).toHaveCount(0);
    await expect(send).not.toHaveCSS("outline-color", FIXTURE_OUTLINE);
    // a new document: no import map, no preload, no stylesheet, no request for plugin code
    const requests = clientRequests(page);
    const res = await page.goto("/");
    const html = (await res?.text()) ?? "";
    expect(html).not.toContain('type="importmap"');
    expect(html).not.toContain("/api/v1/client/");
    await hydrated(page);
    await expect(brandRow(page).locator(".cb-logo")).toBeVisible();
    await expect(page.getByTestId("fake-client-brand")).toHaveCount(0);
    expect(requests).toEqual([]);
    // and the bundle is not served
    const entry = await page.request.get(item.entry?.url as string);
    expect(entry.status()).toBe(404);
  } finally {
    await setClientExtensions(page.request, { enabled: true, disabled: [] });
    await page.context().close();
  }
});

test("a broken plugin is disabled after three errors and the conversation still works", async ({
  browser,
}) => {
  const page = await pageAs(browser, w.c, `/?agent=${w.c.agentId}`);
  const build = (await shellRead(page.request, w.c.orgId)).items.find(
    (i) => i.plugin === "fake-client-broken",
  )?.build;
  expect(build).toBeTruthy();
  // 1: the greeting replacement throws; the built-in greeting stands in
  await expect(page.locator('[data-part="greeting"]')).toBeVisible();
  await expect(composer(page)).toBeEditable();
  // 2: the run.started listener throws
  await send(page, "echo:still works");
  await expect(replies(page).last()).toContainText("still works");
  // 3: the properties section component throws
  await page.getByRole("button", { name: designZh("titlebar.properties") }).click();
  await expect(
    page.getByText(zh.clientExtensions.budget.replace("{plugin}", "fake-client-broken")),
  ).toBeVisible();
  expect(
    await page.evaluate(() => JSON.parse(sessionStorage.getItem("cap-client-disabled") ?? "[]")),
  ).toEqual([`fake-client-broken/${build}`]);
  // the conversation goes on: a run starts (no listener throws now) and answers
  await send(page, "echo:after the budget");
  await expect(replies(page).last()).toContainText("after the budget");
  await page.context().close();
  // the reports the super admin reads: the render and event errors, then the spent budget
  const admin = await pageAs(browser, w.b, "");
  await expect
    .poll(async () => {
      const r = await admin.request.get("/api/v1/admin/extensions/fake-client-broken");
      const rows = r.ok()
        ? ((await r.json()) as { clientReports?: { orgId: string | null; kind: string }[] })
            .clientReports
        : undefined;
      return [...new Set((rows ?? []).filter((x) => x.orgId === w.c.orgId).map((x) => x.kind))]
        .sort()
        .join(",");
    })
    .toBe("budget,event,render");
  await admin.context().close();
});

test("navigating into /admin is a document load and no plugin css is present", async ({
  browser,
}) => {
  const page = await pageAs(browser, w.b, "/");
  await expect(page.locator(EXTENSION_SHEETS).first()).toBeAttached();
  await expect(page.getByTestId("fake-client-fx")).toBeAttached();
  await page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });
  await page.locator('[data-part="sidebar"]:visible a[href="/admin"]').first().click();
  await expect(page).toHaveURL(/\/admin$/);
  await hydrated(page);
  expect(
    await page.evaluate(
      () => (window as unknown as { __sameDocument?: boolean }).__sameDocument ?? false,
    ),
  ).toBe(false);
  await expect(page.locator(EXTENSION_SHEETS)).toHaveCount(0);
  await expect(page.locator('script[type="importmap"]')).toHaveCount(0);
  await expect(page.getByTestId("fake-client-fx")).toHaveCount(0);
  // no plugin stylesheet among the document's sheets, so no rule of the extensions layer
  expect(
    await page.evaluate(() =>
      [...document.styleSheets].flatMap((s) =>
        s.href?.includes("/api/v1/client/") === true ? [s.href] : [],
      ),
    ),
  ).toEqual([]);
  await page.context().close();
});

test("a member of an org where the plugin is off gets 404 for its bundle url", async ({
  browser,
}) => {
  const member = await pageAs(browser, w.b, "");
  const item = await fakeClient(member);
  const url = item.entry?.url as string;
  // where it is on: served
  expect((await member.request.get(url)).status()).toBe(200);
  await member.context().close();
  // org C has it off
  const other = await pageAs(browser, w.c, "");
  const res = await other.request.get(url);
  expect(res.status()).toBe(404);
  expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe(
    "client.not_found",
  );
  expect((await other.request.get(item.styles[0]?.url as string)).status()).toBe(404);
  await other.context().close();
});
