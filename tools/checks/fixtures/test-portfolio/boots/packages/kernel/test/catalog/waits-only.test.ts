import { it } from "vitest";
import { waitFor } from "../helpers/runs.js";

it("imports helpers/runs only for waitFor", async () => {
  await waitFor(() => true);
});
