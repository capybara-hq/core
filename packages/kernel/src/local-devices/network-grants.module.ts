import { Module } from "@nestjs/common";
import { NetworkGrants } from "./network-grants.js";
@Module({ imports: [], providers: [NetworkGrants], exports: [NetworkGrants] })
export class NetworkGrantsModule {}
