import { expect, type Page, test } from "@playwright/test";
import { composer, createAgent, currentOrg, replies } from "./support/chat";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

/**
 * The document CSP (client extensions spec §9.5, with the review rulings): every document carries
 * `script-src <host>/_next/ <host>/api/v1/client/ <host>/_capybara/client-host/ 'nonce-<n>';
 * object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'` with a fresh nonce (dev adds `'unsafe-eval'`). Next
 * puts the server's nonce on its own scripts, so every page boots without a single violation; a
 * script without the nonce, or from a same-origin path outside those prefixes, does not run.
 */

const VIOLATIONS = "__cspViolations";

/** Records every `securitypolicyviolation` from before the first script of each document. */
async function recordViolations(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    const seen: string[] = [];
    (window as unknown as Record<string, string[]>)[key] = seen;
    document.addEventListener("securitypolicyviolation", (e) => {
      seen.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
    });
  }, VIOLATIONS);
}

const violations = (page: Page) =>
  page.evaluate(
    (key: string) => (window as unknown as Record<string, string[]>)[key] ?? [],
    VIOLATIONS,
  );

/**
 * Opens `path` and returns the nonce of the document's CSP response header, after checking the
 * policy's shape and that Next's scripts in the document carry that same (server) nonce.
 */
async function visit(page: Page, path: string): Promise<string> {
  const res = await page.goto(path);
  expect(res, path).not.toBeNull();
  const csp = (await res?.allHeaders())?.["content-security-policy"] ?? "";
  const host = new URL(page.url()).host;
  const sources = `script-src ${host}/_next/ ${host}/api/v1/client/ ${host}/_capybara/client-host/ 'nonce-`;
  expect(csp.startsWith(sources), `${path}: ${csp}`).toBe(true);
  const nonce = /'nonce-([A-Za-z0-9+/]+={0,2})'/.exec(csp)?.[1];
  expect(nonce, `${path}: ${csp}`).toBeDefined();
  expect(csp.split("; ")[0]).not.toContain("'self'");
  for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'self'"]) {
    expect(csp).toContain(d);
  }
  expect(csp).toContain("form-action 'self'");
  // the browser hides nonce attributes; the `nonce` property keeps the value Next rendered
  const rendered = await page.evaluate(() =>
    [...document.scripts].map((s) => s.nonce).filter((n) => n !== ""),
  );
  expect(rendered.length, path).toBeGreaterThan(0);
  expect(new Set(rendered), path).toEqual(new Set([nonce]));
  return nonce as string;
}

test("every page boots under the CSP", async ({ page }) => {
  await recordViolations(page);
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Cap csp");
  const nonces = new Set<string>();

  // the new conversation: hydrated when the composer takes a message, which streams back over SSE
  nonces.add(await visit(page, `/?agent=${agentId}`));
  await hydrated(page);
  const input = composer(page);
  await expect(input).not.toHaveAttribute("placeholder", /—/);
  await input.fill("echo:csp ok");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/chat\/[^/?#]+(#.*)?$/);
  await expect(replies(page).last()).toContainText("csp ok");
  const conversation = new URL(page.url()).pathname;
  expect(await violations(page)).toEqual([]);

  // a conversation, loaded as a document
  nonces.add(await visit(page, conversation));
  await hydrated(page);
  await expect(replies(page).last()).toContainText("csp ok");
  await expect(composer(page)).toBeEditable();
  expect(await violations(page)).toEqual([]);

  // org settings and the admin console: the sidebar hydrates and its navigation answers a click
  for (const path of ["/settings/organization", "/admin"]) {
    nonces.add(await visit(page, path));
    await hydrated(page);
    expect(await violations(page), path).toEqual([]);
  }
  await page.getByRole("navigation", { name: "主导航" }).getByRole("link").first().click();
  await hydrated(page);
  expect(await violations(page)).toEqual([]);
  // the same document again: a new nonce (nothing serves a cached copy)
  nonces.add(await visit(page, "/admin"));
  await hydrated(page);
  expect(await violations(page)).toEqual([]);

  // the sign-in page (signed out, so dark): only hydrated React moves <html> to the light scheme
  await page.context().clearCookies();
  nonces.add(await visit(page, "/login"));
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page
    .getByRole("radiogroup", { name: "配色" })
    .getByRole("radio", { name: "浅色", exact: true })
    .click();
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await violations(page)).toEqual([]);

  // a fresh nonce per document
  expect(nonces.size).toBe(6);
});

test("dotted and slash-less app paths render under the CSP with the server's nonce, never the client's", async ({
  page,
}) => {
  await recordViolations(page);
  await signIn(page);
  // a client-chosen nonce and policy, sent on every request of this page
  await page.setExtraHTTPHeaders({
    "x-nonce": "Zm9yZ2VkLW5vbmNlLXZhbHVl",
    "content-security-policy": "script-src 'nonce-Zm9yZ2VkLW5vbmNlLXZhbHVl'",
  });
  // dotted, and the slash-less /api and /plugin-ui (no route handler takes them: (app)/[...rest])
  for (const path of ["/chat/x.y", "/agents/a.b", "/api", "/plugin-ui"]) {
    const nonce = await visit(page, path);
    expect(nonce).not.toBe("Zm9yZ2VkLW5vbmNlLXZhbHVl");
    // the signed-in shell (its not-found page inside the frame) hydrated without a violation
    await hydrated(page);
    expect(await violations(page), path).toEqual([]);
  }
});

test("an inline script without the nonce is blocked", async ({ page }) => {
  await recordViolations(page);
  await visit(page, "/login");
  await expect(page.getByRole("textbox").first()).toBeVisible();
  const ran = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    const s = document.createElement("script");
    s.textContent = "window.__injected = true";
    document.body.append(s);
    // an inline event handler is inline script too
    const img = document.createElement("img");
    img.setAttribute("onerror", "window.__handler = true");
    img.src = "data:,";
    document.body.append(img);
    await new Promise((r) => setTimeout(r, 200));
    return { script: w.__injected === true, handler: w.__handler === true };
  });
  expect(ran).toEqual({ script: false, handler: false });
  const seen = await violations(page);
  expect(seen.some((v) => v.startsWith("script-src"))).toBe(true);
});

test("a same-origin script outside the allowed paths is blocked", async ({ page }) => {
  await recordViolations(page);
  await visit(page, "/login");
  await expect(page.getByRole("textbox").first()).toBeVisible();
  const loads = await page.evaluate(async () => {
    /** How a script element ends: `load`, `error` (fetched, failed) or `blocked` (CSP). */
    const attempt = (src: string) =>
      new Promise<string>((resolve) => {
        const s = document.createElement("script");
        const onViolation = (e: SecurityPolicyViolationEvent) => {
          if (e.blockedURI.endsWith(src)) resolve("blocked");
        };
        document.addEventListener("securitypolicyviolation", onViolation);
        s.onload = () => resolve("load");
        s.onerror = () => setTimeout(() => resolve("error"), 100);
        s.src = src;
        document.body.append(s);
      });
    return {
      // same origin, but user content or API space: never script
      icon: await attempt("/icon.svg"),
      api: await attempt("/api/v1/me"),
      // inside the allowed prefixes the browser fetches (`error` on a 404; the dev server may
      // answer a missing chunk with something loadable): anything but `blocked`
      next: await attempt("/_next/static/csp-probe-missing.js"),
      client: await attempt("/api/v1/client/csp-probe/missing.js"),
      host: await attempt("/_capybara/client-host/csp-probe/missing.mjs"),
    };
  });
  expect(loads.icon).toBe("blocked");
  expect(loads.api).toBe("blocked");
  expect(["load", "error"]).toContain(loads.next);
  expect(["load", "error"]).toContain(loads.client);
  expect(["load", "error"]).toContain(loads.host);
  const seen = await violations(page);
  expect(seen.filter((v) => v.includes("/icon.svg")).length).toBeGreaterThan(0);
  expect(seen.some((v) => v.includes("/_next/static/csp-probe-missing.js"))).toBe(false);
});
