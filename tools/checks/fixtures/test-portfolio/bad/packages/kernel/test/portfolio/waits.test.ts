import { beforeAll, it } from "vitest";
import { startKernel } from "./helpers/runs.js";

it("waits for a fixed time", async () => {
  await sleep(100);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await startKernel({});
});

it("stops", { timeout: 30_000 }, async () => {
  await startKernel({});
});

beforeAll(async () => {
  await Promise.resolve();
}, 60_000);
