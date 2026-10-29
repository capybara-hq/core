import { KernelModule } from "./kernel.module.js";
import * as all from "./ns/ns.module.js";

export const root = (roles: string[]) => KernelModule.forRoot(roles);
// a namespace of kernel code used as a value: what it hands on is not visible here
export const everything = Object.values(all); // expect: kc-worker-only
