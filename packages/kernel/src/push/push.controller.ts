import { Controller, Delete, Get, HttpCode, Inject, Post, Put } from "@nestjs/common";
import type { z } from "zod";
import { ApiError } from "../errors.js";
import {
  CurrentPrincipal,
  type Principal,
  requireUser,
  SessionOnly,
  type UserPrincipal,
} from "../identity/principal.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { PushPreferencesService } from "./preferences.service.js";
import {
  type PushPreferences,
  PushPreferencesPatchDto,
  type PushPreferencesPatchSchema,
  PushRegistrationDto,
  type PushRegistrationParams,
  PushRegistrationParamsDto,
  type PushRegistrationSchema,
  type PushRegistrationView,
} from "./push.schemas.js";
import { PushRegistrationsService } from "./registrations.service.js";

/** The web session behind a request; a personal token never reaches here (`@SessionOnly`). */
function sessionOf(p: UserPrincipal): string {
  if (p.via !== "session") {
    throw new ApiError("auth.session_required", "This endpoint requires a web session");
  }
  return p.sessionId;
}

/**
 * The person's push registrations and switches (mobile app spec §9.3, §9.4). Registrations are a
 * device action of the person's app: web sessions only, so a registration always has the session
 * it follows. The token is never answered.
 */
@Controller("api/v1/me")
export class PushController {
  constructor(
    @Inject(PushRegistrationsService) private readonly registrations: PushRegistrationsService,
    @Inject(PushPreferencesService) private readonly preferences: PushPreferencesService,
  ) {}

  /** Registers this app install; 422 `push.provider_unavailable` when no provider covers it. */
  @Post("push-registrations")
  @SessionOnly()
  @HttpCode(201)
  async register(
    @CurrentPrincipal() principal: Principal,
    @ZBody(PushRegistrationDto) body: z.infer<typeof PushRegistrationSchema>,
  ): Promise<{ id: string }> {
    const p = requireUser(principal);
    return this.registrations.register(p.account.id, sessionOf(p), body);
  }

  /** The person's installs that receive push, newest seen first. */
  @Get("push-registrations")
  @SessionOnly()
  async list(@CurrentPrincipal() principal: Principal): Promise<{ items: PushRegistrationView[] }> {
    const p = requireUser(principal);
    return { items: await this.registrations.list(p.account.id, sessionOf(p)) };
  }

  /** Removes one of the person's installs; another account's id → 404. */
  @Delete("push-registrations/:id")
  @SessionOnly()
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @ZParam(PushRegistrationParamsDto) { id }: z.infer<typeof PushRegistrationParams>,
  ): Promise<void> {
    // @SessionOnly() already refused personal tokens; removal needs no session id
    await this.registrations.remove(requireUser(principal).account.id, id);
  }

  @Get("push-preferences")
  async getPreferences(@CurrentPrincipal() principal: Principal): Promise<PushPreferences> {
    return this.preferences.get(requireUser(principal).account.id);
  }

  /** Sets the switches given (at least one) and answers all four. */
  @Put("push-preferences")
  async setPreferences(
    @CurrentPrincipal() principal: Principal,
    @ZBody(PushPreferencesPatchDto) body: z.infer<typeof PushPreferencesPatchSchema>,
  ): Promise<PushPreferences> {
    return this.preferences.set(requireUser(principal).account.id, body);
  }
}
