import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { currentOrg } from "./support/chat";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

/** UI copy comes from the zh messages, so the spec does not repeat it. */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const CSRF = { "X-Capybara-Csrf": "1" };

/**
 * Connecting a machine (environments spec §13.3): the program's side (`authorize`, then `token`)
 * is driven over the public API like `capybara-device login` does; the person confirms the code on
 * `/devices/link`; the machine then shows on the 设备 page as a local device (offline: nothing
 * holds its connection in this spec), and is deleted again. The dial-in provider is the kernel
 * fixture `fake-dial-in` (the e2e stack loads it), switched on in the org for this case only.
 */
test("connect a machine: authorize → confirm on /devices/link → token → the device page", async ({
  page,
  playwright,
  baseURL,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const dialIn = (enabled: boolean) =>
    page.request.put(`/api/v1/orgs/${orgId}/extensions/fake-dial-in`, {
      headers: CSRF,
      data: { enabled },
    });
  const on = await dialIn(true);
  expect(on.status(), await on.text()).toBe(200);
  const run = Date.now().toString(36);
  const machine = `e2e-${run}`;
  // the program has no session: a context without the browser's cookies
  const program = await playwright.request.newContext({ baseURL: baseURL ?? "" });
  try {
    const authorize = await program.post("/api/v1/device/authorize", {
      headers: CSRF,
      // the protocol the program speaks decides which dial-in providers the confirm page offers
      data: {
        name: machine,
        os: "linux",
        arch: "x64",
        programVersion: "0.1.0",
        protocol: "fake-dial-in/1",
      },
    });
    expect(authorize.status(), await authorize.text()).toBe(200);
    const { deviceCode, userCode } = (await authorize.json()) as {
      deviceCode: string;
      userCode: string;
    };
    expect(userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);

    // before the confirmation the poll waits
    const early = await program.post("/api/v1/device/token", {
      headers: CSRF,
      data: { deviceCode },
    });
    expect(((await early.json()) as { error: { code: string } }).error.code).toBe(
      "device_sign_in.authorization_pending",
    );

    await page.goto(`/devices/link?code=${userCode}`);
    await expect(page.locator('[data-template="AuthPage"]')).toBeVisible();
    await hydrated(page);
    await expect(page.getByText(userCode)).toBeVisible();
    await expect(page.getByText(zh.deviceLink.disclosure)).toBeVisible();
    await expect(page.getByRole("textbox", { name: zh.deviceLink.name })).toHaveValue(machine);
    await page.getByRole("button", { name: zh.deviceLink.confirm }).click();
    await expect(page.getByText(zh.deviceLink.doneTitle)).toBeVisible();

    // the program's next poll, one interval after the last, gets the credential
    let interval = 5;
    let granted: { credential?: string; deviceId?: string } = {};
    for (let attempt = 0; attempt < 5 && granted.credential === undefined; attempt++) {
      await page.waitForTimeout(interval * 1000 + 500);
      const r = await program.post("/api/v1/device/token", { headers: CSRF, data: { deviceCode } });
      const body = (await r.json()) as {
        credential?: string;
        deviceId?: string;
        error?: { code: string; details?: { interval?: number }[] };
      };
      if (r.status() === 200) granted = body;
      else if (body.error?.code === "device_sign_in.slow_down") {
        interval = body.error.details?.[0]?.interval ?? interval + 5;
      } else expect(body.error?.code).toBe("device_sign_in.authorization_pending");
    }
    expect(granted.credential).toMatch(/^cap_dev_/);

    await page.getByRole("button", { name: zh.deviceLink.openDevice }).click();
    await expect(page.locator('[data-template="DetailPage"]')).toBeVisible();
    // Opening the device loads a new document; its server-rendered tabs are not interactive yet.
    await hydrated(page);
    await expect(page.getByText(zh.devices.source.local)).toBeVisible();
    await expect(
      page.locator('[data-part="device-nameplate-status"]').getByText(zh.devices.state.offline),
    ).toBeVisible();
    // inside the page, not the compact top bar's copy of the title (hidden at this width)
    await expect(
      page.locator('[data-template="DetailPage"]').getByText(machine).first(),
    ).toBeVisible();

    // clean up: delete the device (设置 → danger zone, typing its name)
    await page.getByRole("tab", { name: zh.devices.detail.tabSettings }).click();
    await page.getByRole("button", { name: zh.devices.detail.delete }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill(machine);
    await dialog.getByRole("button", { name: zh.devices.detail.delete }).click();
    await expect(page).toHaveURL(/\/devices$/);
  } finally {
    await program.dispose();
    await dialIn(false);
  }
});

/**
 * The bootstrap pin of `device-local` (packages/kernel/bootstrap.json, scope `all`): the e2e kernel
 * imports it through `capybara bootstrap` like a deployment does, so `/api/v1/meta` reports local
 * devices (fake-dial-in speaks another protocol and never counts), and the org, which never switched
 * it on, offers it to a program speaking `capybara-device` and creates a device on it. No real
 * `capybara-device` connects: the program's side is the public API, as in the case above.
 */
test("device-local is pinned, on in the org by default and takes a capybara-device sign-in", async ({
  page,
  playwright,
  baseURL,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const meta = (await (await page.request.get("/api/v1/meta")).json()) as {
    protocols: { device: { min: number; max: number } };
    features: { localDevices: boolean };
  };
  expect(meta.features.localDevices).toBe(true);
  const protocol = `capybara-device/${meta.protocols.device.max}`;
  const name = `e2e-local-${Date.now().toString(36)}`;
  const program = await playwright.request.newContext({ baseURL: baseURL ?? "" });
  let deviceId: string | undefined;
  try {
    const authorize = await program.post("/api/v1/device/authorize", {
      headers: CSRF,
      data: { name, os: "linux", arch: "x64", programVersion: "0.1.0", protocol },
    });
    expect(authorize.status(), await authorize.text()).toBe(200);
    const { deviceCode, userCode } = (await authorize.json()) as {
      deviceCode: string;
      userCode: string;
    };
    const listed = await page.request.get(
      `/api/v1/device/providers?orgId=${orgId}&userCode=${userCode}`,
    );
    expect(listed.status(), await listed.text()).toBe(200);
    const { providers } = (await listed.json()) as { providers: { plugin: string }[] };
    expect(providers.map((p) => p.plugin)).toContain("device-local");

    const confirm = await page.request.post("/api/v1/device/confirm", {
      headers: CSRF,
      data: { userCode, orgId, provider: "device-local", name },
    });
    expect(confirm.status(), await confirm.text()).toBe(200);
    // the program's first poll after the confirmation gets the credential
    const token = await program.post("/api/v1/device/token", {
      headers: CSRF,
      data: { deviceCode },
    });
    expect(token.status(), await token.text()).toBe(200);
    const granted = (await token.json()) as { credential: string; deviceId: string };
    expect(granted.credential).toMatch(/^cap_dev_/);
    deviceId = granted.deviceId;
    const device = await page.request.get(`/api/v1/orgs/${orgId}/devices/${deviceId}`);
    expect(device.status(), await device.text()).toBe(200);
    expect(((await device.json()) as { device: { provider: string } }).device.provider).toBe(
      "device-local",
    );
  } finally {
    if (deviceId !== undefined) {
      await page.request.delete(`/api/v1/orgs/${orgId}/devices/${deviceId}`, { headers: CSRF });
    }
    await program.dispose();
  }
});
