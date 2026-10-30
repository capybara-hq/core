import { forwardRef, Inject, Injectable, Module } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";

@Module({ imports: [forwardRef(() => ToolsModule)] }) // expect: kc-late-binding
export class RuntimeModule {}

@Injectable()
export class RunWorker {
  constructor(
    @Inject(ModuleRef) private readonly refs: ModuleRef,
    @Inject(forwardRef(() => Tools)) private readonly tools: Tools, // expect: kc-late-binding
  ) {}

  run(app: { get(t: unknown): unknown }, map: Map<string, string>) {
    void this.refs.get(Tools); // expect: kc-late-binding
    void this.refs.resolve(Tools); // expect: kc-late-binding
    void app.get(Tools);
    void map.get("k");
  }
}

export async function lookup(moduleRef: { get(t: unknown): unknown }) {
  return moduleRef.get(Tools); // expect: kc-late-binding
}
