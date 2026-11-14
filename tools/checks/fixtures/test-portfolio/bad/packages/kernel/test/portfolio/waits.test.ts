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

it("runs a command with a tool timeout input", async () => {
  // A tool input named `timeout` is not a Vitest option and must not be reported.
  await callTool("Bash", { timeout: 5_000 });
});

beforeAll(async () => {
  await Promise.resolve();
}, 60_000);
