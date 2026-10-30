import { type DynamicModule, Module, type Provider } from "@nestjs/common";
import { makeOptions, makeProviders } from "./make.js";
import { Probe } from "./probe.service.js";

declare const flag: boolean;
declare const holder: { probe: typeof Probe };

// lists whose classes are not visible statically
@Module({
  providers: [
    makeProviders(), // expect: kc-wiring
    flag ? Probe : undefined, // expect: kc-wiring
    holder.probe, // expect: kc-wiring
    { provide: "P", useClass: holder.probe }, // expect: kc-wiring
    { provide: "E", useExisting: Probe },
  ],
})
export class UnknownModule {}

// a parameter of an exported function: its callers are not visible here
export function custom(extra: Provider[]): DynamicModule {
  return { module: UnknownModule, providers: [...extra] }; // expect: kc-wiring
}

// module metadata that is not an object literal
@Module(makeOptions()) // expect: kc-wiring
export class OpaqueModule {}
