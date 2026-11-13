import { beforeAll, it } from "vitest";
import { startOrgEnv } from "./org-env.js";

beforeAll(async () => {
  await startOrgEnv();
});

it("first", () => {});

it("second", () => {});
