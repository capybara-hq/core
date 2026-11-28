import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";

// `/automations` reads the remembered view's cookie: none here.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

/**
 * Directed work (collaboration spec §4.4) on the web: my acceptance rules in the Acceptance rules sheet of
 * `/automations` (one choice per source, saved at once; the head's entry shows only while a source
 * directs events to me; `?rules=1` opens it) and a work offer in the inbox (accept or decline).
 */

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const ORG = "/api/v1/orgs/o1";
const RULES = `${ORG}/automations/acceptance`;
const T = "2026-11-25T12:00:00.000Z";

/** A radio's accessible name is its label then its description: match the label's start. */
const starting = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

const rules = (mode: string | null, directedDefault = "auto") => ({
  items: [{ source: "collab", name: { zh: "协作", en: "Collab" }, mode }],
  directedDefault,
});

/** What the automations page reads besides my rules (the list view, no tasks). */
const page = {
  [`GET ${ORG}/automations`]: () => json(200, { items: [] }),
  [`GET ${ORG}/agents`]: () => json(200, { agents: [] }),
  [`GET ${ORG}/settings`]: () =>
    json(200, { settings: { automations: { enabled: true, minIntervalMinutes: 60 } } }),
  "GET /api/v1/me/preferences": () => json(200, { timeZone: null }),
};

const sheet = () => screen.findByRole("dialog");

describe("/automations: the acceptance rules sheet", () => {
  beforeEach(() => resetNavigation("/automations"));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("no source directs events to me: the head has no Acceptance rules action", async () => {
    stubApi({ ...page, [`GET ${RULES}`]: () => json(200, { items: [], directedDefault: "auto" }) });
    await renderRouteWithCache("/automations?view=list", lastStubRoutes(), { locale: "en" });
    expect(screen.getByRole("heading", { level: 1, name: en.automations.title })).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.acceptance.title })).toBeNull();
  });

  it.each(LOCALES)(
    "the head opens the sheet; a choice PUTs that source's rule (%s)",
    async (locale) => {
      const m = msgs[locale].acceptance;
      let current = rules(null, "confirm");
      const calls = stubApi({
        ...page,
        [`GET ${RULES}`]: () => json(200, current),
        [`PUT ${RULES}`]: (call) => {
          const body = bodyOf(call) as { rules: { mode: string | null }[] };
          current = rules(body.rules[0]?.mode ?? null, "confirm");
          return json(200, current);
        },
      });
      await renderRouteWithCache("/automations?view=list", lastStubRoutes(), { locale });
      const user = userEvent.setup();
      expect(screen.queryByRole("dialog")).toBeNull();
      await user.click(screen.getByRole("button", { name: m.title }));
      const dialog = within(await sheet());
      expect(window.location.search).toBe("?view=list&rules=1");
      expect(dialog.getByText(m.description)).toBeTruthy();
      const group = dialog.getByRole("radiogroup", { name: locale === "zh" ? "协作" : "Collab" });
      const byLabel = (label: string) =>
        within(group).getByRole("radio", { name: starting(label) });
      const fallback = m.mode.default.replace("{mode}", m.mode.confirm);
      expect((byLabel(fallback) as HTMLInputElement).checked).toBe(true);
      await user.click(byLabel(m.mode.off));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        rules: [{ source: "collab", mode: "off" }],
      });
      await vi.waitFor(() => expect((byLabel(m.mode.off) as HTMLInputElement).checked).toBe(true));
      expect(await screen.findByText(m.saved)).toBeTruthy();
    },
  );

  it("?rules=1 opens the sheet over the calendar too; closing keeps the view", async () => {
    stubApi({
      ...page,
      [`GET ${RULES}`]: () => json(200, rules(null)),
      [`GET ${ORG}/automations/calendar`]: () =>
        json(200, { tasks: [], items: [], collapsed: [], horizon: "2027-01-06T00:00:00.000Z" }),
    });
    window.history.replaceState(null, "", "/automations?rules=1");
    await renderRouteWithCache("/automations?rules=1", lastStubRoutes(), { locale: "en" });
    const dialog = within(await sheet());
    expect(dialog.getByRole("radiogroup", { name: "Collab" })).toBeTruthy();
    await userEvent.setup().keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.search).toBe("");
    window.history.replaceState(null, "", "/automations");
  });

  it("zh: the hints name the source with no space around it", async () => {
    stubApi({ ...page, [`GET ${RULES}`]: () => json(200, rules(null)) });
    await renderRouteWithCache("/automations?view=list&rules=1", lastStubRoutes(), {
      locale: "zh",
    });
    const dialog = within(await sheet());
    const m = zh.acceptance.mode;
    for (const key of ["autoHint", "confirmHint", "offHint"] as const) {
      const text = m[key].replace("{source}", "协作");
      expect(text).not.toMatch(/ 协作|协作 /);
      expect(dialog.getByText(text)).toBeTruthy();
    }
  });

  it("going back to the default removes my rule", async () => {
    const calls = stubApi({
      ...page,
      [`GET ${RULES}`]: () => json(200, rules("auto")),
      [`PUT ${RULES}`]: () => json(200, rules(null)),
    });
    await renderRouteWithCache("/automations?view=list&rules=1", lastStubRoutes(), {
      locale: "en",
    });
    const m = en.acceptance;
    const group = within(await sheet()).getByRole("radiogroup", { name: "Collab" });
    await userEvent.setup().click(
      within(group).getByRole("radio", {
        name: starting(m.mode.default.replace("{mode}", m.mode.auto)),
      }),
    );
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      rules: [{ source: "collab", mode: null }],
    });
  });

  it("opened by link with no source: the sheet shows the empty state", async () => {
    stubApi({ ...page, [`GET ${RULES}`]: () => json(200, { items: [], directedDefault: "auto" }) });
    await renderRouteWithCache("/automations?view=list&rules=1", lastStubRoutes(), {
      locale: "en",
    });
    expect(within(await sheet()).getByText(en.acceptance.empty)).toBeTruthy();
  });
});

describe("a work offer in the inbox", () => {
  beforeEach(() => resetNavigation("/inbox"));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const offer = {
    id: "f1",
    source: "collab",
    sourceName: { zh: "协作", en: "Collab" },
    agent: { id: "g1", name: "Builder" },
    eventType: "item.assigned",
    subject: { kind: "item", id: "CAP-7", title: "Export reports as PDF" },
    summary: "Mo assigned CAP-7 to you.",
    inboxItemId: "it1",
    createdAt: T,
    expiresAt: "2026-12-02T12:00:00.000Z",
  };
  const listed = (open: boolean) => ({
    items: open ? [{ type: "automation_offer", id: "f1", createdAt: T, offer }] : [],
    truncated: false,
  });

  it.each(LOCALES)("accept POSTs the offer's accept and closes it (%s)", async (locale) => {
    const m = msgs[locale].inbox;
    let open = true;
    const routes = {
      "GET /api/v1/orgs/o1/inbox": () => json(200, listed(open)),
      "POST /api/v1/orgs/o1/automations/offers/f1/accept": () => {
        open = false;
        return json(200, { automationId: "t1" });
      },
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/inbox", routes, { locale });
    const list = await screen.findByRole("list", { name: m.listLabel });
    const row = within(list).getByText("Export reports as PDF", {
      selector: '[data-part="list-title"]',
    });
    expect((row.closest("li") as HTMLElement).textContent).toContain(m.offer.label);
    expect(await screen.findByText("Mo assigned CAP-7 to you.")).toBeTruthy();
    expect(screen.getByRole("button", { name: m.offer.decline })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: m.offer.accept }));
    expect(await screen.findByText(m.offer.accepted)).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain(
      "POST /api/v1/orgs/o1/automations/offers/f1/accept",
    );
    expect(await screen.findByText(m.empty)).toBeTruthy();
  });

  it("the offer's push link (its own item's id) opens the offer", async () => {
    const second = {
      ...offer,
      id: "f2",
      inboxItemId: "it2",
      subject: { kind: "item", id: "CAP-8", title: "Fix the login page" },
      summary: "Mo assigned CAP-8 to you.",
    };
    const routes = {
      "GET /api/v1/orgs/o1/inbox": () =>
        json(200, {
          items: [
            { type: "automation_offer", id: "f1", createdAt: T, offer },
            { type: "automation_offer", id: "f2", createdAt: T, offer: second },
          ],
          truncated: false,
        }),
    };
    stubApi(routes);
    window.history.replaceState(null, "", "/inbox#item=it2");
    await renderRouteWithCache("/inbox", routes, { locale: "en" });
    expect(await screen.findByText("Mo assigned CAP-8 to you.")).toBeTruthy();
    expect(screen.queryByText("Mo assigned CAP-7 to you.")).toBeNull();
    window.history.replaceState(null, "", "/inbox");
  });

  it("decline POSTs the offer's decline", async () => {
    let open = true;
    const routes = {
      "GET /api/v1/orgs/o1/inbox": () => json(200, listed(open)),
      "POST /api/v1/orgs/o1/automations/offers/f1/decline": () => {
        open = false;
        return noContent();
      },
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/inbox", routes, { locale: "en" });
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: en.inbox.offer.decline }));
    expect(await screen.findByText(en.inbox.offer.declined)).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain(
      "POST /api/v1/orgs/o1/automations/offers/f1/decline",
    );
  });
});
