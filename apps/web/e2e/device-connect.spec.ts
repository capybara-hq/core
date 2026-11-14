import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
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
 * holds its connection in this spec), and is deleted again.
 */
test("connect a machine: authorize → confirm on /devices/link → token → the device page", async ({
  page,
  playwright,
  baseURL,
}) => {
  await signIn(page);
  const run = Date.now().toString(36);
  const machine = `e2e-${run}`;
  // the program has no session: a context without the browser's cookies
  const program = await playwright.request.newContext({ baseURL: baseURL ?? "" });
  try {
    const authorize = await program.post("/api/v1/device/authorize", {
      headers: CSRF,
      data: { name: machine, os: "linux", arch: "x64", programVersion: "0.1.0" },
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
    await expect(page.getByText(zh.devices.source.local)).toBeVisible();
    await expect(
      page.locator('[data-part="device-nameplate-status"]').getByText(zh.devices.state.offline),
    ).toBeVisible();
    await expect(page.getByText(machine).first()).toBeVisible();

    // clean up: delete the device (typing its name)
    await page.getByRole("button", { name: zh.common.moreActions }).click();
    await page.getByRole("menuitem", { name: zh.devices.detail.delete }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill(machine);
    await dialog.getByRole("button", { name: zh.devices.detail.delete }).click();
    await expect(page).toHaveURL(/\/devices$/);
  } finally {
    await program.dispose();
  }
});
