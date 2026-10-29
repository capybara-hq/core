import { CliJobsModule, openKernelCli } from "@capybara-hq/kernel";

export const open = (config: unknown) => openKernelCli(config, { modules: [CliJobsModule] });
