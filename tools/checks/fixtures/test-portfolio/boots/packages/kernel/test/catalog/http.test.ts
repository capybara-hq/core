import { it } from "vitest";
import { testHttpApp } from "../helpers/http-app.js";

it("boots the HTTP app", async () => {
  await testHttpApp();
});
