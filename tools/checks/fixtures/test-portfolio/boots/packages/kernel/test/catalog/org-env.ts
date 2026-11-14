import { startKernel, waitFor } from "../helpers/runs.js";

export async function startOrgEnv(): Promise<void> {
  await startKernel();
}

/** A second-level wrapper: it boots only through startOrgEnv. */
export async function resetOrgCatalog(): Promise<void> {
  await startOrgEnv();
  await waitFor(() => true);
}
