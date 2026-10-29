import { Module } from "@nestjs/common";
import { Nested } from "../barrel/index.js";

// imported by KernelModule: NestedModule (as Nested) reaches every role through it
@Module({ imports: [Nested] })
export class OtherModule {}
