import { handleShutdownSignals, installProcessGuards } from "./infra/lifecycle/index.js";

export async function createKernelApp(): Promise<void> {
  process.on("SIGTERM", () => {}); // expect: kc-process
  installProcessGuards({}); // expect: kc-process
}

export async function startBuiltKernelApp(): Promise<void> {
  handleShutdownSignals(() => {});
}
