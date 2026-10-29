import { KernelModule } from "./kernel.module.js";

export const root = (roles: string[]) => KernelModule.forRoot(roles);
