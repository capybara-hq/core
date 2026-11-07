import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { CSRF } from "./support/chat";
import { HOME_URL, hydrated } from "./support/nav";
import { ORG_NAME, signIn } from "./support/sign-in";

/** UI text comes from the zh message file, not hard-coded twice. */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/**
 * The server decides the first paint (web-SSR spec `docs/superpowers/specs/2026-11-01-web-ssr-design.md`):
 * an expired access cookie is renewed on the server (§2.1), and org changes are full navigations
 * (§3.2, ruling R4), so no frame ever pairs one org's frame with another org's page.
 */

/** One state of the frame the probe saw: the sidebar's context, the org it names, the templates. */
type Frame = { context: string | null; org: string | null; templates: string };

const PROBE_KEY = "e2e-frame-probe";

/**
 * Records every distinct frame state (sidebar context, the org switcher's org, the `[data-template]`
 * values) from before the first paint of every document of this tab, in `sessionStorage` so the
 * record survives full navigations.
 */
async function installProbe(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    let last = "";
    const record = () => {
      const sidebar = document.querySelector('[data-part="sidebar"]');
      const frame = {
        context: sidebar?.getAttribute("data-context") ?? null,
        org: document.querySelector('[data-part="org-switcher"]')?.getAttribute("title") ?? null,
        templates: [...document.querySelectorAll("[data-template]")]
          .map((e) => e.getAttribute("data-template"))
          .join(","),
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
      attributes: true,
      attributeFilter: ["data-context", "data-template", "title"],
    });
  }, PROBE_KEY);
}

async function framesSeen(page: Page): Promise<Frame[]> {
  return page.evaluate(
    (key: string) => JSON.parse(sessionStorage.getItem(key) ?? "[]") as Frame[],
    PROBE_KEY,
  );
}

async function resetProbe(page: Page): Promise<void> {
  await page.evaluate((key: string) => sessionStorage.removeItem(key), PROBE_KEY);
}

type Me = { memberships: { orgId: string; name: string }[] };

/** Back to Acme, so the specs that run after this one sign in to the org they expect. */
async function backToAcme(page: Page): Promise<void> {
  const r0 = await page.request.get("/api/v1/me");
  // not signed in (the test failed before signing in): nothing to restore
  if (!r0.ok()) return;
  const acme = ((await r0.json()) as Me).memberships.find((m) => m.name === ORG_NAME);
  if (acme === undefined) return;
  const r = await page.request.put("/api/v1/me/current-org", {
    headers: CSRF,
    data: { orgId: acme.orgId },
  });
  expect(r.ok(), await r.text()).toBe(true);
}

const workSidebar = (page: Page) => page.locator('[data-part="sidebar"][data-context="work"]');

const setupSidebar = (page: Page) => page.locator('[data-part="sidebar"][data-context="setup"]');

/** Opens the account menu (the sidebar's account row) of the workspace shell. */
async function openAccountMenu(page: Page): Promise<void> {
  await workSidebar(page).locator('button[data-part="account"]').click();
}

test.afterEach(async ({ page }) => {
  await backToAcme(page);
});

test("an expired access cookie is renewed on the server: the page renders signed in, never via /login", async ({
  page,
}) => {
  await signIn(page);
  // the access token is gone (expired), the refresh token is still there
  await page.context().clearCookies({ name: "cap_at" });
  const names = (await page.context().cookies()).map((c) => c.name);
  expect(names).not.toContain("cap_at");
  expect(names).toContain("cap_rt");

  const navigations: string[] = [];
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigations.push(r.url());
  });
  const res = await page.goto("/agents");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await hydrated(page);
  await expect(workSidebar(page)).toBeVisible();
  // no redirect through the sign-in page, server-side or in the browser
  expect(navigations.filter((u) => new URL(u).pathname.startsWith("/login"))).toEqual([]);
  // the proxy handed the renewed session to the browser
  expect((await page.context().cookies()).map((c) => c.name)).toContain("cap_at");
});

test("creating an org lands on its setup frame with the setup steps; its shell never paints", async ({
  page,
}) => {
  await installProbe(page);
  await signIn(page);
  await resetProbe(page);
  const name = `SSR org ${Date.now()}`;

  await openAccountMenu(page);
  await page.getByRole("menuitem", { name: zh.shell.orgMenu }).click();
  await page.getByRole("menuitem", { name: zh.shell.createOrg }).click();
  const dialog = page.getByRole("dialog", { name: zh.home.createOrg.title });
  await dialog.getByRole("textbox", { name: zh.home.createOrg.nameLabel }).fill(name);
  await dialog.getByRole("button", { name: zh.home.createOrg.submit }).click();

  // a fresh org has no agent: the setup frame, named after the new org, at home (`/`)
  await expect(page.locator('[data-template="SetupPage"]')).toBeVisible();
  await expect(page).toHaveURL(HOME_URL);
  await hydrated(page);
  const sidebar = setupSidebar(page);
  await expect(sidebar.locator('[data-part="org-switcher"]')).toHaveAttribute("title", name);
  await expect(workSidebar(page)).toHaveCount(0);
  // the setup sidebar's steps: the model is done (the e2e stack loads model-fake), the agent is
  // next; an owner also sees the optional steps
  await expect(sidebar.locator('[data-part="step-item"][data-rove="model"]')).toHaveAttribute(
    "data-state",
    "done",
  );
  await expect(sidebar.locator('[data-part="step-item"][data-rove="agent"]')).toHaveAttribute(
    "data-state",
    "todo",
  );
  await expect(sidebar.locator('[data-part="step-item"][data-optional="true"]')).not.toHaveCount(0);

  const frames = await framesSeen(page);
  expect(frames.length).toBeGreaterThan(0);
  // never the workspace shell of the new org, never the setup frame with the old org
  expect(frames.filter((f) => f.org === name && f.context === "work")).toEqual([]);
  expect(frames.filter((f) => f.org === ORG_NAME && f.context === "setup")).toEqual([]);
});

test("switching org from the account menu loads the other org's frame whole, at home (/)", async ({
  page,
}) => {
  await installProbe(page);
  await signIn(page);
  // a second org, fresh, so it shows the setup frame
  const otherName = `SSR switch ${Date.now()}`;
  const r = await page.request.post("/api/v1/orgs", { headers: CSRF, data: { name: otherName } });
  expect(r.ok(), await r.text()).toBe(true);
  // a new document lists the new org in the menus; start on Acme's agent list
  await page.goto("/agents");
  await hydrated(page);
  await expect(workSidebar(page).locator('[data-part="org-switcher"]')).toHaveAttribute(
    "title",
    ORG_NAME,
  );
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await resetProbe(page);

  await openAccountMenu(page);
  await page.getByRole("menuitem", { name: zh.shell.orgMenu }).click();
  await page.getByRole("menuitemradio", { name: otherName }).click();
  await expect(page).toHaveURL(HOME_URL);
  await expect(setupSidebar(page).first()).toBeVisible();
  await hydrated(page);
  await expect(setupSidebar(page).locator('[data-part="org-switcher"]')).toHaveAttribute(
    "title",
    otherName,
  );
  await expect(workSidebar(page)).toHaveCount(0);

  const frames = await framesSeen(page);
  expect(frames.length).toBeGreaterThan(0);
  // never the old org's frame with the other org's page, nor the other org in a shell or with the
  // old org's agent list
  expect(frames.filter((f) => f.org === ORG_NAME && f.templates.includes("SetupPage"))).toEqual([]);
  expect(frames.filter((f) => f.org === otherName && f.context === "work")).toEqual([]);
  expect(frames.filter((f) => f.org === otherName && f.templates.includes("ListPage"))).toEqual([]);
});
