import { readFileSync } from "node:fs";
import { type APIRequestContext, type Browser, expect, type Page } from "@playwright/test";
import { CSRF } from "./chat";
import { hydrated } from "./nav";
import { signIn } from "./sign-in";

/**
 * The client extension fixtures of client-extensions.spec.ts (client extensions spec §14), set up
 * apart from the shared org Acme so no other spec ever runs plugin code:
 * - the super admin imports `fake-client` and `fake-client-broken` (packed by global-setup,
 *   `CAPYBARA_E2E_CLIENT_TGZ` / `CAPYBARA_E2E_CLIENT_BROKEN_TGZ`) through the catalog file import
 *   with scope `optional` (off in every org), and approves their sensitive permission sets
 *   (`permissions.client`, `ui.component:*`) when the item still waits for it;
 * - two accounts of their own, each the owner of a new org: `b` is also a super admin (it opens
 *   `/admin` and writes the kill switch) and switches `fake-client` on in its org; `c` switches
 *   `fake-client-broken` on in its org and picks its `conversation.empty` replacement, so the
 *   broken code runs on the new conversation page. Neither switches the shared admin's org.
 * Setup is idempotent per worker: the plugins are imported once per deployment, the accounts and
 * orgs once per worker process (a worker restarted after a failure makes new ones).
 */

/** An account of its own, the owner of one org with one agent. */
export interface ClientUser {
  login: string;
  password: string;
  orgId: string;
  agentId: string;
}

export interface ClientWorld {
  /** Super admin, owner of the org where `fake-client` is on. */
  b: ClientUser;
  /** Owner of the org where `fake-client-broken` is on (`fake-client` is off there). */
  c: ClientUser;
  /** `fake-client`'s catalog item. */
  itemId: string;
}

/** One extension of the org's shell read (`GET /api/v1/orgs/:orgId/ui/client`). */
export interface ShellItem {
  plugin: string;
  build: string;
  entry: { url: string; integrity: string } | null;
  styles: { url: string; integrity: string }[];
  components: { id: string; slot: string }[];
}

const PASSWORD = "client-ext-password-123";

const baseURL = () => process.env.CAPYBARA_E2E_BASE_URL as string;

/** Imports a packed plugin with scope `optional` unless it is in the catalog; returns its item id. */
async function importPlugin(api: APIRequestContext, name: string, tgzEnv: string): Promise<string> {
  const items = async () => {
    const r = await api.get("/api/v1/admin/catalog/items");
    expect(r.ok(), await r.text()).toBe(true);
    return (
      (await r.json()) as {
        items: { id: string; name: string; pending: boolean; permissionsHash: string | null }[];
      }
    ).items;
  };
  if (!(await items()).some((i) => i.name === name)) {
    const tgz = process.env[tgzEnv];
    expect(tgz, `global-setup writes ${tgzEnv}`).toBeTruthy();
    const staged = await api.post("/api/v1/admin/catalog/import/file", {
      headers: { ...CSRF, "content-type": "application/octet-stream" },
      data: readFileSync(tgz as string),
    });
    expect(staged.ok(), await staged.text()).toBe(true);
    const { stagingId, review } = (await staged.json()) as {
      stagingId: string;
      review: { reviewHash: string };
    };
    const confirmed = await api.post(`/api/v1/admin/catalog/imports/${stagingId}/confirm`, {
      headers: CSRF,
      data: { reviewHash: review.reviewHash, scope: "optional" },
    });
    // a concurrent worker may have imported it meanwhile
    if (confirmed.status() !== 201 && !(await items()).some((i) => i.name === name)) {
      expect(confirmed.status(), await confirmed.text()).toBe(201);
    }
  }
  const item = (await items()).find((i) => i.name === name);
  expect(item, `${name} in the catalog`).toBeDefined();
  // the sensitive permission set (client code, components) waits for the super admin
  if (item?.pending === true && item.permissionsHash !== null) {
    const r = await api.post(`/api/v1/admin/catalog/items/${item.id}/confirm`, {
      headers: CSRF,
      data: { permissionsHash: item.permissionsHash },
    });
    expect(r.ok(), await r.text()).toBe(true);
  }
  return item?.id as string;
}

/** An API request context signed in as `login` (cookies only, no page). */
async function apiAs(browser: Browser, login: string, password: string) {
  const context = await browser.newContext({ baseURL: baseURL(), locale: "zh-CN" });
  const r = await context.request.post("/api/v1/auth/login", {
    headers: CSRF,
    data: { login, password },
  });
  expect(r.ok(), await r.text()).toBe(true);
  return context;
}

/**
 * Creates the account (as the shared super admin), signs it in, creates its org and an agent and
 * makes the org its current one; then switches the catalog item on in it.
 */
async function newOwner(
  admin: APIRequestContext,
  browser: Browser,
  tag: string,
  itemId: string,
  superAdmin: boolean,
): Promise<ClientUser> {
  const login = `cx-${tag}-${Date.now().toString(36)}`;
  const created = await admin.post("/api/v1/admin/accounts", {
    headers: CSRF,
    data: { login, password: PASSWORD, displayName: `CX ${tag}`, superAdmin },
  });
  expect(created.status(), await created.text()).toBe(201);
  const context = await apiAs(browser, login, PASSWORD);
  const api = context.request;
  try {
    const org = await api.post("/api/v1/orgs", {
      headers: CSRF,
      data: { name: `Client ext ${tag} ${Date.now().toString(36)}` },
    });
    expect(org.ok(), await org.text()).toBe(true);
    const orgId = ((await org.json()) as { org: { id: string } }).org.id;
    const current = await api.put("/api/v1/me/current-org", { headers: CSRF, data: { orgId } });
    expect(current.status(), await current.text()).toBe(204);
    const agent = await api.post(`/api/v1/orgs/${orgId}/agents`, {
      headers: CSRF,
      data: {
        definition: {
          name: `CX agent ${tag}`,
          instructions: "Help.",
          model: { provider: "model-fake", model: "fake-1" },
        },
        visibility: "org",
      },
    });
    expect(agent.status(), await agent.text()).toBe(201);
    const agentId = ((await agent.json()) as { agent: { id: string } }).agent.id;
    const on = await api.put(`/api/v1/orgs/${orgId}/catalog/${itemId}/switch`, {
      headers: CSRF,
      data: { enabled: true },
    });
    expect(on.ok(), await on.text()).toBe(true);
    return { login, password: PASSWORD, orgId, agentId };
  } finally {
    await context.close();
  }
}

/** The org's shell read as `user` sees it. */
export async function shellRead(
  api: APIRequestContext,
  orgId: string,
): Promise<{ enabled: boolean; items: ShellItem[] }> {
  const r = await api.get(`/api/v1/orgs/${orgId}/ui/client`);
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as { enabled: boolean; items: ShellItem[] };
}

/**
 * Waits until the org's shell read lists `plugin` with its entry: the scope sync installed it in
 * the org and a live replica reports serving its build.
 */
async function servedIn(browser: Browser, user: ClientUser, plugin: string): Promise<void> {
  const context = await apiAs(browser, user.login, user.password);
  try {
    await expect
      .poll(
        async () =>
          (await shellRead(context.request, user.orgId)).items.find((i) => i.plugin === plugin)
            ?.entry?.url ?? null,
        { timeout: 90_000 },
      )
      .not.toBeNull();
  } finally {
    await context.close();
  }
}

let world: Promise<ClientWorld> | null = null;

/** The fixtures of the spec (see the module comment), set up once per worker. */
export function clientWorld(browser: Browser): Promise<ClientWorld> {
  world ??= (async () => {
    const page = await (
      await browser.newContext({ baseURL: baseURL(), locale: "zh-CN" })
    ).newPage();
    try {
      await signIn(page);
      const admin = page.request;
      const itemId = await importPlugin(admin, "fake-client", "CAPYBARA_E2E_CLIENT_TGZ");
      const brokenId = await importPlugin(
        admin,
        "fake-client-broken",
        "CAPYBARA_E2E_CLIENT_BROKEN_TGZ",
      );
      const b = await newOwner(admin, browser, "b", itemId, true);
      const c = await newOwner(admin, browser, "c", brokenId, false);
      await Promise.all([
        servedIn(browser, b, "fake-client"),
        servedIn(browser, c, "fake-client-broken"),
      ]);
      // org C picks the broken greeting, so the new conversation page renders broken code
      const context = await apiAs(browser, c.login, c.password);
      const pick = await context.request.patch(`/api/v1/orgs/${c.orgId}/settings`, {
        headers: CSRF,
        data: { uiArrangement: { "conversation.empty": { use: "fake-client-broken/empty" } } },
      });
      expect(pick.ok(), await pick.text()).toBe(true);
      await context.close();
      return { b, c, itemId };
    } finally {
      await page.context().close();
    }
  })();
  world.catch(() => {
    world = null;
  });
  return world;
}

/**
 * A new browser context signed in as `user` (through the login route, the session cookies set in
 * the context), its page on `path` and hydrated. Pass `init` to add init scripts before the first
 * document.
 */
export async function pageAs(
  browser: Browser,
  user: ClientUser,
  path = "/",
  init?: (page: Page) => Promise<void>,
): Promise<Page> {
  const context = await apiAs(browser, user.login, user.password);
  const page = await context.newPage();
  if (init !== undefined) await init(page);
  if (path !== "") {
    await page.goto(path);
    await hydrated(page);
  }
  return page;
}

/** Sets (or, with `null`, clears) the org's pick for a replaceable slot. */
export async function pickSlot(
  api: APIRequestContext,
  orgId: string,
  slot: string,
  use: string | null,
): Promise<void> {
  const r = await api.patch(`/api/v1/orgs/${orgId}/settings`, {
    headers: CSRF,
    data: { uiArrangement: { [slot]: use === null ? null : { use } } },
  });
  expect(r.ok(), await r.text()).toBe(true);
}

/** Writes the kill switch (`clientExtensions` deployment setting) as a super admin. */
export async function setClientExtensions(
  api: APIRequestContext,
  value: { enabled: boolean; disabled: string[] },
): Promise<void> {
  const r = await api.put("/api/v1/admin/settings", {
    headers: CSRF,
    data: { clientExtensions: value },
  });
  expect(r.ok(), await r.text()).toBe(true);
}
