import { expect, it } from "vitest";
import { waitFor } from "../helpers/triggers.js";

it("adds", () => {
  expect(1 + 1).toBe(2);
});

it("waits for a condition", async () => {
  await waitFor(() => true);
});
