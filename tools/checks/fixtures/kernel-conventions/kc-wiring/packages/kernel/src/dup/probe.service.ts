import { Injectable } from "@nestjs/common";

@Injectable()
export class Probe {}

@Injectable()
export class Listed {}

@Injectable()
export class Spread {}

@Injectable()
export class Passed {}

@Injectable()
export class Shared {}

export const SHARED_PROVIDERS = [Shared]; // expect: kc-wiring
