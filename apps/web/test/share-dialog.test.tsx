import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareDialog } from "../src/components/file-preview/ShareDialog";
import type { FileOutput } from "../src/lib/files";
import type { SharePolicy, ShareView } from "../src/lib/shares";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { renderPage } from "./support/render";
import { optionValues, pickOption } from "./support/select";

const FILES = "/api/v1/orgs/o1/conversations/c1/files/f1/shares";

const FILE: FileOutput = {
  id: "f1",
  name: "report.html",
  contentType: "text/html",
  size: 1234,
  sourcePath: "/w/report.html",
  version: 1,
  versions: [{ id: "f1", size: 1234, createdAt: "2026-11-18T06:00:00.000Z" }],
  callId: "call_1",
  createdAt: "2026-11-18T06:00:00.000Z",
  status: "available",
  previewable: "text",
  origin: "delivered",
  shared: false,
};

const share = (id: string, extra: Partial<ShareView> = {}): ShareView => ({
  id,
  code: `Code${id}000000`.slice(0, 10),
  audience: "internal",
  conversationId: "c1",
  fileId: "f1",
  sourcePath: "/w/report.html",
  name: "report.html",
  contentType: "text/html",
  size: 1234,
  generation: 1,
  createdBy: { id: "a1", displayName: "Grant" },
  createdAt: "2026-11-18T06:00:00.000Z",
  expiresAt: null,
  lastOpenedAt: null,
  state: "live",
  revokedAt: null,
  revokeReason: null,
  newerVersion: false,
  ...extra,
});

const ALLOWED: SharePolicy = { external: "allowed", maxExpiryDays: 30 };

function open(policy: SharePolicy, shares: ShareView[] = [], extra = {}) {
  const calls = stubApi({
    [`GET ${FILES}`]: () => json(200, { shares, policy }),
    ...extra,
  });
  renderPage(
    <ShareDialog orgId="o1" conversationId="c1" file={FILE} open onOpenChange={() => {}} />,
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const externalRadio = async () =>
  (await screen.findByRole("radio", { name: /Anyone with the link/ })) as HTMLInputElement;

describe("the share dialog", () => {
  it("External is disabled with the platform's reason when the platform denies it", async () => {
    open({ external: "platform_denied", maxExpiryDays: 30 });
    expect((await externalRadio()).disabled).toBe(true);
    expect(screen.getByText("The platform does not allow external sharing.")).toBeTruthy();
  });

  it("External is disabled with the org's reason when the org has it off", async () => {
    open({ external: "org_off", maxExpiryDays: 30 });
    expect((await externalRadio()).disabled).toBe(true);
    expect(screen.getByText(/External sharing is off for this organization/)).toBeTruthy();
  });

  it("expiry choices stay within the maximum; Never only for internal", async () => {
    open({ external: "allowed", maxExpiryDays: 7 });
    const user = userEvent.setup();
    await externalRadio();
    const expiry = screen.getByRole("combobox", { name: "Expires" });
    expect(await optionValues(expiry, user)).toEqual(["1", "7", "never"]);
    await user.click(await externalRadio());
    expect(await optionValues(expiry, user)).toEqual(["1", "7"]);
  });

  it("create posts the audience and expiry and shows the link to copy", async () => {
    const calls = open(ALLOWED, [], {
      [`POST ${FILES}`]: () => json(201, { share: share("s1", { code: "AbCdEfGh12" }) }),
    });
    const user = userEvent.setup();
    await user.click(await externalRadio());
    await pickOption(screen.getByRole("combobox", { name: "Expires" }), "30", user);
    await user.click(screen.getByRole("button", { name: "Create link" }));
    const field = (await screen.findByRole("textbox", { name: "Link" })) as HTMLInputElement;
    expect(field.value).toBe(`${window.location.origin}/s/AbCdEfGh12`);
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      audience: "external",
      expiresInDays: 30,
    });
  });

  it("internal defaults to never expiring; external to 7 days", async () => {
    const calls = open(ALLOWED, [], {
      [`POST ${FILES}`]: () => json(201, { share: share("s1") }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create link" }));
    await screen.findByRole("textbox", { name: "Link" });
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      audience: "internal",
      expiresInDays: null,
    });
    await user.click(await externalRadio());
    expect(screen.getByRole("combobox", { name: "Expires" }).textContent).toContain("In 7 days");
  });

  it("active links offer Copy, Update to latest only when newer, and Revoke", async () => {
    const calls = open(
      ALLOWED,
      [
        share("s1", { code: "AAAAAAAAAA", newerVersion: true }),
        share("s2", {
          code: "BBBBBBBBBB",
          audience: "external",
          expiresAt: "2026-11-25T06:00:00Z",
        }),
        share("s3", { code: "CCCCCCCCCC", state: "revoked" }),
      ],
      {
        "POST /api/v1/orgs/o1/shares/s1/refresh": () => json(200, { share: share("s1") }),
        "DELETE /api/v1/orgs/o1/shares/s2": () => noContent(),
      },
    );
    const live = await screen.findByRole("list", { name: "Active links" });
    const rows = within(live).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(within(first).getByRole("button", { name: "Update to latest" })).toBeTruthy();
    expect(within(second).queryByRole("button", { name: "Update to latest" })).toBeNull();
    // user-event stands in for the clipboard
    const user = userEvent.setup();
    await user.click(within(first).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/s/AAAAAAAAAA`);
    await user.click(within(first).getByRole("button", { name: "Update to latest" }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/s1/refresh"))).toBe(true),
    );
    await user.click(within(second).getByRole("button", { name: "Revoke" }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/shares/s2"))).toBe(true),
    );
    const recent = screen.getByRole("list", { name: "Recent links" });
    expect(within(recent).getByText("Revoked")).toBeTruthy();
    expect(within(recent).queryByRole("button")).toBeNull();
    // one box: the lists inside the dialog draw no box of their own
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});
