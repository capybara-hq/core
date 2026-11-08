import { Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  Public,
  requireUser,
  SessionOnly,
} from "../identity/principal.js";
import { CredentialThrottler } from "../infra/throttler/credential-throttler.js";
import { Throttled } from "../infra/throttler/throttler.guard.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import {
  type DeviceAuthorization,
  DeviceAuthService,
  type DeviceGrant,
  type DeviceMachineInfo,
} from "./device-auth.js";
import {
  type DeviceAuthorizeBody,
  DeviceAuthorizeBodyDto,
  type DeviceConfirmBody,
  DeviceConfirmBodyDto,
  type DeviceTokenBody,
  DeviceTokenBodyDto,
  type DeviceUserCodeBody,
  DeviceUserCodeBodyDto,
  type DeviceUserCodeParams,
  DeviceUserCodeParamsDto,
} from "./dto.js";

/** The throttler of every route that takes a user code (guessing another machine's code). */
const CODE_THROTTLER = ["device-code-account"] as const;

/**
 * Device sign-in (`/api/v1/device`, environments spec §13.3; the shape of RFC 8628).
 *
 * The program's routes are public (it has no credential yet); like every public unsafe route
 * they need `X-Capybara-Csrf: 1`, which `capybara-device` sends:
 * - `POST /authorize { name, os, arch, programVersion }` → `{ deviceCode, userCode,
 *   verificationUri, verificationUriComplete, interval, expiresIn }` (`device-authorize-ip`);
 * - `POST /token { deviceCode }` → `{ credential, orgId, deviceId, connectUrl,
 *   reconnectGraceSeconds, maxFrameBytes }` once, else `device_sign_in.authorization_pending` / `device_sign_in.slow_down` /
 *   `device_sign_in.denied` / `device_sign_in.expired` (`device-token-ip`).
 *
 * The person's routes need a web session (the confirmation page `/device`); each try of a user
 * code counts on `device-code-account` (refunded on success):
 * - `GET /pending/:userCode` → `{ machine, expiresAt }`;
 * - `POST /confirm { userCode, orgId, deviceId | name }` → `{ deviceId }`
 *   (`device_sign_in.expired` / `device_sign_in.unavailable` when the credential could not be handed over: the
 *   machine is revoked again and the person runs login again);
 * - `POST /deny { userCode }` → 204.
 */
@Controller("api/v1/device")
export class DeviceAuthController {
  constructor(
    @Inject(DeviceAuthService) private readonly auth: DeviceAuthService,
    @Inject(CredentialThrottler) private readonly throttler: CredentialThrottler,
  ) {}

  @Post("authorize")
  @Public()
  @HttpCode(200)
  @Throttled("device-authorize-ip")
  async authorize(
    @ZBody(DeviceAuthorizeBodyDto) body: z.infer<typeof DeviceAuthorizeBody>,
  ): Promise<DeviceAuthorization> {
    return this.auth.authorize(body);
  }

  @Post("token")
  @Public()
  @HttpCode(200)
  @Throttled("device-token-ip")
  async token(
    @ZBody(DeviceTokenBodyDto) body: z.infer<typeof DeviceTokenBody>,
  ): Promise<DeviceGrant> {
    return this.auth.token(body.deviceCode);
  }

  @Get("pending/:userCode")
  @SessionOnly()
  async pending(
    @CurrentPrincipal() principal: Principal,
    @ZParam(DeviceUserCodeParamsDto) params: z.infer<typeof DeviceUserCodeParams>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ machine: DeviceMachineInfo; expiresAt: string }> {
    requireUser(principal);
    return this.counted(req, reply, () => this.auth.pending(params.userCode));
  }

  @Post("confirm")
  @SessionOnly()
  @HttpCode(200)
  async confirm(
    @CurrentPrincipal() principal: Principal,
    @ZBody(DeviceConfirmBodyDto) body: z.infer<typeof DeviceConfirmBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ deviceId: string }> {
    const p = requireUser(principal);
    return this.counted(req, reply, () => this.auth.confirm(p, body));
  }

  @Post("deny")
  @SessionOnly()
  @HttpCode(204)
  async deny(
    @CurrentPrincipal() principal: Principal,
    @ZBody(DeviceUserCodeBodyDto) body: z.infer<typeof DeviceUserCodeBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    requireUser(principal);
    await this.counted(req, reply, () => this.auth.deny(body.userCode));
  }

  /** Runs `fn` as one counted try of a user code; a success gives the try back. */
  private async counted<T>(
    req: FastifyRequest,
    reply: FastifyReply,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.throttler.reserve(CODE_THROTTLER, req, reply);
    const out = await fn();
    await this.throttler.succeeded(CODE_THROTTLER, req);
    return out;
  }
}
