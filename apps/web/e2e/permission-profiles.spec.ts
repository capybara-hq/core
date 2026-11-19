import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  CSRF,
  composer,
  conversationIdOf,
  createAgent,
  currentOrg,
  designZh,
  eventsOf,
  replies,
  send,
  toolGroup,
  zh,
} from "./support/chat";
import { signIn } from "./support/sign-in";

/**
 * Conversation permission profiles (spec 2026-11-16-conversation-approval-profiles-design, "UI
 * outline"; API in the permission operation contract, "Root state, API, decisions and replay"),
 * through the composer against the real kernel on the `sandbox-fake` cloud provider: the picker's
 * three rows and its default, a change on an existing conversation (persisted, read back through
 * `GET …/permissions`), Full access only through its confirmation for a real device, a Request
 * approval write outside the workspace asking with its directory proposal, and a device whose
 * runtime cannot restrict execution: the restricted rows say so and nothing falls back to Full.
 */

const p = zh.chat.permission;
const PROFILE = p.profile;

type Permissions = {
  profile: "request-approval" | "approve-for-me" | "full-access";
  revision: number;
  deviceId: string | null;
  consentScope: { deviceId: string; scopeRevision: string } | null;
  availability:
    | { state: "supported"; report: { restricted: unknown; outsideSandbox: boolean } }
    | { state: "unsupported" | "unprobed"; reason: string };
  outsideSandboxCeiling: boolean;
};

/** The owner's authoritative read of a conversation's permission state. */
async function permissionsOf(page: Page, orgId: string, convId: string): Promise<Permissions> {
  const r = await page.request.get(`/api/v1/orgs/${orgId}/conversations/${convId}/permissions`);
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as Permissions;
}

/** Creates a personal cloud device (the platform's sandbox provider, `sandbox-fake`). */
async function createDevice(page: Page, orgId: string, name: string): Promise<string> {
  const r = await page.request.post(`/api/v1/orgs/${orgId}/devices`, {
    headers: CSRF,
    data: { name },
  });
  expect(r.status(), await r.text()).toBe(201);
  return ((await r.json()) as { device: { id: string } }).device.id;
}

async function deleteDevice(page: Page, orgId: string, id: string): Promise<void> {
  const r = await page.request.delete(`/api/v1/orgs/${orgId}/devices/${id}`, { headers: CSRF });
  expect([202, 404], await r.text()).toContain(r.status());
}

/**
 * Where the e2e kernel's `sandbox-fake` keeps its root: global-setup configures it as
 * `<temp dir>/sandboxes` and writes the greeter package into the same temp dir, the only path
 * of that dir it exports.
 */
const sandboxRoot = (): string =>
  join(dirname(process.env.CAPYBARA_E2E_GREETER_TGZ as string), "sandboxes");

/**
 * Overrides what the fake answers to `permissionSupport` (null restores its default), exactly as
 * the fixture's `setFakeSandboxPermissionSupport` does: `root/permission-support.json`, read at
 * each call. A cloud device records the report when its instance starts.
 */
async function setPermissionSupport(report: Record<string, unknown> | null): Promise<void> {
  const file = join(sandboxRoot(), "permission-support.json");
  if (report === null) await rm(file, { force: true });
  else await writeFile(file, JSON.stringify(report));
}

/** The new conversation with `agentId` picked, ready to send. */
async function newChat(page: Page, agentId: string): Promise<void> {
  await page.goto(`/?agent=${agentId}`);
  await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
  await expect(composer(page)).not.toHaveAttribute("placeholder", /—/);
}

/** The composer's permission picker button, named "Permission: <profile>" in zh. */
const permissionButton = (page: Page, profile?: string): Locator =>
  page.getByRole("button", {
    name: profile === undefined ? new RegExp(`^${p.label}: `) : `${p.label}: ${profile}`,
    exact: profile !== undefined,
  });

/** A row of the open permission menu (named by its label, then any unavailable tag). */
const row = (page: Page, profile: string): Locator =>
  page.getByRole("menuitemradio", { name: new RegExp(`^${profile}`) });

/** Picks `name` in the new conversation's device picker. */
async function pickDevice(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${zh.chat.pickDevice}: `) }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await expect(
    page.getByRole("button", { name: `${zh.chat.pickDevice}: ${name}`, exact: true }),
  ).toBeVisible();
}

test.describe("permission profiles", () => {
  const devices: { orgId: string; id: string }[] = [];

  test.afterEach(async ({ page }) => {
    for (const d of devices.splice(0)) await deleteDevice(page, d.orgId, d.id);
  });

  test("the picker: three neutral rows, 帮我批准 by default; a change persists; Full access needs its confirmation", async ({
    page,
  }) => {
    await signIn(page);
    const orgId = await currentOrg(page);
    const agentId = await createAgent(page, orgId, "Profiles agent");
    const deviceName = "Profiles device";
    devices.push({ orgId, id: await createDevice(page, orgId, deviceName) });

    // 1. The new conversation: Approve for me is the default, three rows in order with an explanation
    // each, only the selected one checked, all in the same neutral treatment.
    await newChat(page, agentId);
    await pickDevice(page, deviceName);
    await permissionButton(page, PROFILE.approveForMe).click();
    const rows = page.getByRole("menuitemradio");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAccessibleName(PROFILE.requestApproval);
    await expect(rows.nth(1)).toHaveAccessibleName(PROFILE.approveForMe);
    await expect(rows.nth(2)).toHaveAccessibleName(PROFILE.fullAccess);
    await expect(rows.nth(0)).toHaveAccessibleDescription(p.description.requestApproval);
    await expect(rows.nth(1)).toHaveAccessibleDescription(p.description.approveForMe);
    await expect(rows.nth(2)).toHaveAccessibleDescription(p.description.fullAccess);
    for (const [i, checked] of [false, true, false].entries()) {
      await expect(rows.nth(i)).toHaveAttribute("aria-checked", String(checked));
      await expect(rows.nth(i).locator('[data-icon="check"]')).toHaveCount(checked ? 1 : 0);
      await expect(rows.nth(i)).toBeEnabled();
      // no row has a tone of its own (Full access has no accent)
      await expect(rows.nth(i)).not.toHaveAttribute("data-tone", /.+/);
    }
    const colors = await rows.evaluateAll((els) =>
      els.map((el) => {
        const text = el.querySelector(".cb-cmenu-text");
        const icon = el.querySelector('[data-part="icon"]');
        return [
          text ? getComputedStyle(text).color : "",
          icon ? getComputedStyle(icon).color : "",
        ].join("|");
      }),
    );
    expect(new Set(colors).size, colors.join(", ")).toBe(1);

    // 2. Full access only through its confirmation, naming the device and what it is not;
    // canceling keeps Approve for me.
    const fullTitle = new RegExp(`^${p.full.title.replace("{device}", deviceName)}$`);
    await row(page, PROFILE.fullAccess).click();
    let dialog = page.getByRole("dialog", { name: fullTitle });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(p.full.body, { exact: true })).toBeVisible();
    await expect(dialog.getByText(p.full.limits, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: p.full.cancel, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(permissionButton(page, PROFILE.approveForMe)).toBeVisible();

    await permissionButton(page).click();
    await row(page, PROFILE.fullAccess).click();
    dialog = page.getByRole("dialog", { name: fullTitle });
    await dialog.getByRole("button", { name: p.full.confirm, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(permissionButton(page, PROFILE.fullAccess)).toBeVisible();

    // The first message carries the consent for the device and scope on display.
    await send(page, "echo:full access");
    await expect(replies(page).last()).toHaveText("full access");
    const fullConv = conversationIdOf(page);
    const full = await permissionsOf(page, orgId, fullConv);
    expect(full.profile).toBe("full-access");
    expect(full.deviceId).toBe(devices[0]?.id);
    expect(full.consentScope?.deviceId).toBe(devices[0]?.id);

    // 3. An existing conversation started on Approve for me: choosing Request approval is saved (a new
    // revision, an event in the log) and read back after a reload.
    await newChat(page, agentId);
    await pickDevice(page, deviceName);
    await expect(permissionButton(page, PROFILE.approveForMe)).toBeVisible();
    await send(page, "echo:first");
    await expect(replies(page).last()).toHaveText("first");
    const convId = conversationIdOf(page);
    const before = await permissionsOf(page, orgId, convId);
    expect(before.profile).toBe("approve-for-me");

    await permissionButton(page, PROFILE.approveForMe).click();
    await expect(row(page, PROFILE.approveForMe)).toHaveAttribute("aria-checked", "true");
    await row(page, PROFILE.requestApproval).click();
    await expect(page.getByText(p.changed)).toBeVisible();
    await expect(permissionButton(page, PROFILE.requestApproval)).toBeVisible();
    const after = await permissionsOf(page, orgId, convId);
    expect(after.profile).toBe("request-approval");
    expect(after.revision).toBe(before.revision + 1);
    const changed = (await eventsOf(page, orgId, convId)).filter(
      (e) => e.type === "permission_profile_changed",
    );
    expect(changed.at(-1)?.payload).toMatchObject({ newProfile: "request-approval" });

    await page.reload();
    await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
    await expect(permissionButton(page, PROFILE.requestApproval)).toBeVisible();
    await permissionButton(page, PROFILE.requestApproval).click();
    await expect(row(page, PROFILE.requestApproval)).toHaveAttribute("aria-checked", "true");
    await expect(row(page, PROFILE.approveForMe)).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
  });

  test("请求批准: a write outside the workspace asks with its directory proposal; approved once, it runs", async ({
    page,
  }) => {
    await signIn(page);
    const orgId = await currentOrg(page);
    const agentId = await createAgent(page, orgId, "Approval agent");
    const deviceName = "Approval device";
    devices.push({ orgId, id: await createDevice(page, orgId, deviceName) });

    await newChat(page, agentId);
    await pickDevice(page, deviceName);
    await permissionButton(page, PROFILE.approveForMe).click();
    await row(page, PROFILE.requestApproval).click();
    await expect(permissionButton(page, PROFILE.requestApproval)).toBeVisible();

    const target = "/etc/capybara-e2e/note.txt";
    await send(page, `tool:Write:${JSON.stringify({ file_path: target, content: "x" })}`);
    const convId = conversationIdOf(page);
    expect((await permissionsOf(page, orgId, convId)).profile).toBe("request-approval");

    // The command ask: the file, the exact directory it would grant (once), the target apart.
    const approval = page.locator('[data-role="approval"]');
    await expect(approval).toHaveCount(1);
    const card = approval.getByRole("group", { name: designZh("hitl.command.titleWrite") });
    await expect(card).toBeVisible();
    await expect(card.getByText(target).first()).toBeVisible();
    const scope = approval.locator('[data-role="permission-scope"]');
    await expect(scope.getByText(zh.approval.permissionScope.intro)).toBeVisible();
    await expect(scope.locator('[data-scope="write"]')).toContainText("/etc/capybara-e2e");
    await expect(scope.locator('[data-scope="target"]')).toContainText(target);
    const write = toolGroup(page, "Write");
    await expect(write).toHaveAttribute("data-tool-status", "pending");

    await card
      .getByRole("button", { name: designZh("hitl.command.allowOnce"), exact: true })
      .click();
    await expect(approval.getByText(designZh("hitl.command.allowedOnce"))).toBeVisible();
    await expect(write).toHaveAttribute("data-tool-status", "done");
    // (the first use of the device prepends its start notice)
    await expect(replies(page).last()).toHaveText(
      new RegExp(`^Tool result: .*Created ${target} \\(1 bytes\\)\\.$`),
    );
  });

  test("a device that cannot restrict execution: the restricted rows say why, nothing falls back to 完全访问", async ({
    page,
  }) => {
    await signIn(page);
    const orgId = await currentOrg(page);
    const agentId = await createAgent(page, orgId, "Unrestricted agent");
    const deviceName = "Unrestricted device";
    try {
      // The provider reports Full access and background ownership but no restricted runtime; a
      // new device records it when its instance first starts.
      await setPermissionSupport({
        version: 2,
        boundary: "operation",
        restricted: null,
        network: { openPublic: false, allowlist: false, perOperationHosts: false },
        outsideSandbox: true,
        background: true,
        unavailableReason: "This e2e runtime cannot confine execution",
      });
      const deviceId = await createDevice(page, orgId, deviceName);
      devices.push({ orgId, id: deviceId });

      // Not started yet: unprobed, so the restricted rows are offered with the note saying
      // when the device is checked.
      await newChat(page, agentId);
      await pickDevice(page, deviceName);
      await permissionButton(page, PROFILE.approveForMe).click();
      await expect(row(page, PROFILE.requestApproval)).toBeEnabled();
      await expect(page.getByText(p.note.unprobed, { exact: false })).toBeVisible();
      await row(page, PROFILE.requestApproval).click();
      await expect(permissionButton(page, PROFILE.requestApproval)).toBeVisible();

      // The first device operation starts the instance; the runtime cannot enforce the
      // restricted profile, so nothing runs (never under Full access instead).
      await send(
        page,
        `tool:Bash:${JSON.stringify({ command: "echo ran", description: "Try the device" })}`,
      );
      const convId = conversationIdOf(page);
      // The kernel refuses at admission with the typed unsupported refusal: the model gets the
      // actionable text that says nothing ran.
      await expect(toolGroup(page, "Bash")).toHaveAttribute("data-tool-status", "failed");
      await expect(replies(page).last()).toHaveText(/^Tool result: /);
      await expect(replies(page).last()).toContainText(
        "This device cannot enforce this conversation's permission profile, so nothing ran.",
      );
      // `echo ran` printed nothing: the output would end the reply
      await expect(replies(page).last()).not.toHaveText(/\bran\s*$/);

      const view = await permissionsOf(page, orgId, convId);
      expect(view.profile).toBe("request-approval");
      expect(view.availability).toMatchObject({
        state: "supported",
        report: { restricted: null, outsideSandbox: true },
      });

      // The existing conversation's picker: both restricted rows unavailable with the reason,
      // Request approval still the selected profile, Full access offered but not chosen.
      await page.reload();
      await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
      await permissionButton(page, PROFILE.requestApproval).click();
      for (const profile of [PROFILE.requestApproval, PROFILE.approveForMe]) {
        await expect(row(page, profile)).toBeDisabled();
        await expect(row(page, profile)).toHaveAccessibleName(
          `${profile} ${p.reason.restrictedUnsupported}`,
        );
      }
      await expect(row(page, PROFILE.requestApproval)).toHaveAttribute("aria-checked", "true");
      await expect(row(page, PROFILE.fullAccess)).toBeEnabled();
      await expect(row(page, PROFILE.fullAccess)).toHaveAttribute("aria-checked", "false");
      await page.keyboard.press("Escape");
      await expect(permissionButton(page, PROFILE.requestApproval)).toBeVisible();

      // A new conversation on that device shows the same reasons; the default stays Approve for me
      // (shown unavailable), never switched to Full access.
      await newChat(page, agentId);
      await pickDevice(page, deviceName);
      await permissionButton(page, PROFILE.approveForMe).click();
      for (const profile of [PROFILE.requestApproval, PROFILE.approveForMe]) {
        await expect(row(page, profile)).toBeDisabled();
        await expect(row(page, profile)).toHaveAccessibleName(
          `${profile} ${p.reason.restrictedUnsupported}`,
        );
      }
      await expect(row(page, PROFILE.approveForMe)).toHaveAttribute("aria-checked", "true");
      await expect(row(page, PROFILE.fullAccess)).toHaveAttribute("aria-checked", "false");
      await page.keyboard.press("Escape");
      await expect(permissionButton(page, PROFILE.approveForMe)).toBeVisible();
    } finally {
      await setPermissionSupport(null);
    }
  });
});
