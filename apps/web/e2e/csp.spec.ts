import { expect, type Page, test } from "@playwright/test";
import { composer, createAgent, currentOrg, replies } from "./support/chat";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

/**
 * The document CSP (client extensions spec §9.5): every document carries
 * `script-src 'self' 'nonce-<n>'; object-src 'none'; base-uri 'none'` with a fresh nonce (dev adds
 * `'unsafe-eval'`). Next puts the nonce on its own scripts, so every page boots without a single
 * violation, and a script injected without the nonce does not run.
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

/** Opens `path` and returns the nonce of the document's CSP response header. */
async function visit(page: Page, path: string): Promise<string> {
  const res = await page.goto(path);
  expect(res, path).not.toBeNull();
  const csp = (await res?.allHeaders())?.["content-security-policy"] ?? "";
  const nonce = /^script-src 'self' 'nonce-([A-Za-z0-9+/]+={0,2})'/.exec(csp)?.[1];
  expect(nonce, `${path}: ${csp}`).toBeDefined();
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
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

  // the sign-in page (signed out): the scheme toggle only answers once React has hydrated
  await page.context().clearCookies();
  nonces.add(await visit(page, "/login"));
  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(html).not.toHaveAttribute("data-theme", before ?? "");
  expect(await violations(page)).toEqual([]);

  // a fresh nonce per document
  expect(nonces.size).toBe(5);
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
