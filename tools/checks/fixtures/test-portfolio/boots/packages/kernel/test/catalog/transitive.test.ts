import { beforeAll, it } from "vitest";
import { resetOrgCatalog } from "./org-env.js";

beforeAll(async () => {
  await resetOrgCatalog();
});

it("boots through a second-level helper", () => {});
