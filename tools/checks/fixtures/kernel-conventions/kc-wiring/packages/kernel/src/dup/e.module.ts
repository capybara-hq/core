import { type DynamicModule, Module, type Provider } from "@nestjs/common";
import { Passed } from "./probe.service.js";

// a parameter of a same-file function: followed to its call sites
function withExtra(extra: Provider[]): DynamicModule {
  return { module: EModule, providers: [...extra] };
}

@Module({})
export class EModule {
  static forRoot(): DynamicModule {
    return withExtra([Passed]); // expect: kc-wiring
  }
}
