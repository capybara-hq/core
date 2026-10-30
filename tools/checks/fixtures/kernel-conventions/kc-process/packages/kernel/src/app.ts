import proc from "node:process";
import { handleShutdownSignals, installProcessGuards } from "./infra/lifecycle/index.js";
import { installProcessGuards as guards } from "./infra/lifecycle/index.js";

export async function createKernelApp(): Promise<void> {
  process.on("SIGTERM", () => {}); // expect: kc-process
  installProcessGuards({}); // expect: kc-process
  const p = process;
  p.on("SIGINT", () => {}); // expect: kc-process
  proc.once("SIGHUP", () => {}); // expect: kc-process
  guards({}); // expect: kc-process
  process["prependListener"]("exit", () => {}); // expect: kc-process
  const { on } = process; // expect: kc-process
  void on;
}

export async function startBuiltKernelApp(): Promise<void> {
  handleShutdownSignals(() => {});
}
