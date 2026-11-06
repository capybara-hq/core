import { Controller, Get, HttpCode, Inject, Post, Put, Req } from "@nestjs/common";
import { z } from "zod";
import { ApiError } from "../errors.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
  SuperAdmin,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { ActorOpts } from "./catalog.service.js";
import {
  type ComponentScopePreview,
  ComponentScopeService,
  type ComponentVersionView,
  type ComponentView,
  type OrgComponentView,
  type OrgOfferedComponentView,
} from "./component-scope.service.js";
import { COMPONENT_KINDS, type ComponentKind } from "./component-state.js";
import { PlatformComponents, type UploadedComponentVersion } from "./platform-components.js";

const Kind = z.enum(COMPONENT_KINDS as [ComponentKind, ...ComponentKind[]]);
const Scope = z.enum(["all", "optional", "named"]);
const Orgs = z.array(z.string().min(1).max(128)).max(1000);
const Hash = z.string().min(1).max(128);

const ComponentParams = z.object({ kind: Kind, id: z.string().min(1).max(128) });
const ListQuery = z.object({ kind: Kind }).strict();
const OrgListQuery = z
  .object({ kind: Kind.optional(), itemId: z.string().uuid().optional() })
  .strict();

/** `{ scope, orgs? }`, `{ disabled: true }` or `{ follow: true }`: exactly one. */
const PreviewBody = z
  .object({
    scope: Scope.optional(),
    orgs: Orgs.optional(),
    disabled: z.literal(true).optional(),
    follow: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (b) =>
      [b.scope !== undefined, b.disabled === true, b.follow === true].filter(Boolean).length === 1,
    { message: "send exactly one of scope (with orgs for named), disabled: true or follow: true" },
  )
  .refine((b) => b.scope !== undefined || b.orgs === undefined, {
    message: "orgs: only allowed with scope named",
    path: ["orgs"],
  });

/** `{ scope, orgs?, scopeHash }` or `{ follow: true, scopeHash }`. */
const ScopeBody = z
  .object({
    scope: Scope.optional(),
    orgs: Orgs.optional(),
    follow: z.literal(true).optional(),
    scopeHash: Hash,
  })
  .strict()
  .refine((b) => (b.scope !== undefined) !== (b.follow === true), {
    message: "send either scope (with orgs for named) or follow: true",
  })
  .refine((b) => b.scope !== undefined || b.orgs === undefined, {
    message: "orgs: only allowed with scope named",
    path: ["orgs"],
  });

const DisabledBody = z.object({ disabled: z.boolean(), scopeHash: Hash.optional() }).strict();
const ShownBody = z.object({ shownToOthers: z.boolean() }).strict();
const SwitchBody = z
  .object({
    enabled: z.boolean(),
    confirm: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

const IdParams = z.object({ id: z.string().min(1).max(128) });
const TemplateVersionBody = z.object({ content: z.string().min(1).max(400_000) }).strict();
class ComponentIdParams extends createZodDto(IdParams, "ComponentIdParams") {}
class TemplateVersionDto extends createZodDto(TemplateVersionBody, "TemplateVersionBody") {}

class ComponentParamsDto extends createZodDto(ComponentParams, "ComponentParams") {}
class ComponentListQuery extends createZodDto(ListQuery, "ComponentListQuery") {}
class OrgComponentListQuery extends createZodDto(OrgListQuery, "OrgComponentListQuery") {}
class ComponentScopePreviewBody extends createZodDto(PreviewBody, "ComponentScopePreviewBody") {}
class ComponentScopeBody extends createZodDto(ScopeBody, "ComponentScopeBody") {}
class ComponentDisabledBody extends createZodDto(DisabledBody, "ComponentDisabledBody") {}
class ComponentShownBody extends createZodDto(ShownBody, "ComponentShownBody") {}
class ComponentSwitchBody extends createZodDto(SwitchBody, "ComponentSwitchBody") {}

const actorOpts = (actor: ReturnType<typeof requireUser>): ActorOpts => {
  const tokenId = patTokenId(actor);
  return tokenId !== undefined ? { actorTokenId: tokenId } : {};
};

/**
 * Platform components (`/api/v1/admin/components/*`, super admins; plugin scope phase 2, Task 6):
 * the global list of skills, agent templates and connector templates, and each one's own scope,
 * disable and visibility (spec §5 rules 2, 4, 8, 10). Changes that take something away are
 * previewed (`POST …/scope/preview`) and confirmed with `scopeHash`.
 */
@Controller("api/v1/admin/components")
@SuperAdmin()
export class AdminComponentsController {
  constructor(
    @Inject(ComponentScopeService) private readonly scope: ComponentScopeService,
    @Inject(PlatformComponents) private readonly components: PlatformComponents,
  ) {}

  /**
   * Updates a platform skill on its own (spec §7.2): the skill package (zip) as the raw body
   * (`application/octet-stream`, at most `packages.maxBytes`). The package keeps the skill's name
   * (400 `validation_failed`), is checked like an org upload (400 `skill.invalid_package`), and
   * becomes the next version, flagged as updated on its own; it keeps its plugin and serves in
   * orgs at once. Unknown component -> 404 `component.not_found`. Audits `component.version_uploaded`.
   */
  @Post("skill/:id/versions")
  @HttpCode(201)
  uploadSkillVersion(
    @CurrentPrincipal() principal: Principal,
    @ZParam(ComponentIdParams) p: z.infer<typeof IdParams>,
    @Req() req: { body?: unknown },
  ): Promise<UploadedComponentVersion> {
    const actor = requireUser(principal);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw new ApiError(
        "unsupported_media_type",
        "Send the skill package (.zip) as the request body with content-type application/octet-stream",
      );
    }
    return this.components.uploadSkillVersion(
      { accountId: actor.account.id, ...actorOpts(actor) },
      p.id,
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  }

  /** Updates a platform agent template on its own: `{ content }` is the template markdown file. */
  @Post("agent_template/:id/versions")
  @HttpCode(201)
  uploadAgentTemplateVersion(
    @CurrentPrincipal() principal: Principal,
    @ZParam(ComponentIdParams) p: z.infer<typeof IdParams>,
    @ZBody(TemplateVersionDto) body: z.infer<typeof TemplateVersionBody>,
  ): Promise<UploadedComponentVersion> {
    const actor = requireUser(principal);
    return this.components.uploadAgentTemplateVersion(
      { accountId: actor.account.id, ...actorOpts(actor) },
      p.id,
      body.content,
    );
  }

  /** `GET ?kind=`: every platform component of the kind (plugin, owner, scope, version, orgs on). */
  @Get()
  async list(
    @ZQuery(ComponentListQuery) q: z.infer<typeof ListQuery>,
  ): Promise<{ components: ComponentView[] }> {
    return { components: await this.scope.list(q.kind) };
  }

  /**
   * A component's versions, newest first: `{ versions: [{ version, catalogVersion, updatedOnOwn,
   * createdAt }] }` (a connector template keeps no history: its current version only). Unknown or
   * removed -> 404 `component.not_found`.
   */
  @Get(":kind/:id/versions")
  async versions(
    @ZParam(ComponentParamsDto) p: z.infer<typeof ComponentParams>,
  ): Promise<{ versions: ComponentVersionView[] }> {
    return { versions: await this.scope.versions(p.kind, p.id) };
  }

  /**
   * What a component scope change (`{ scope, orgs? }`), a disable (`{ disabled: true }`) or a
   * return to its plugin's scope (`{ follow: true }`) would do: `{ affected: [{ orgId, orgName,
   * agents }], conflicts: [{ orgId, orgName, name, skills }], scopeHash }`. Unknown component ->
   * 404 `component.not_found`; of a builtin plugin -> 409 `plugin.builtin`.
   */
  @Post(":kind/:id/scope/preview")
  @HttpCode(200)
  preview(
    @ZParam(ComponentParamsDto) p: z.infer<typeof ComponentParams>,
    @ZBody(ComponentScopePreviewBody) body: z.infer<typeof PreviewBody>,
  ): Promise<ComponentScopePreview> {
    return this.scope.preview(
      p.kind,
      p.id,
      body.scope !== undefined
        ? { scope: body.scope, ...(body.orgs !== undefined && { orgs: body.orgs }) }
        : body.disabled === true
          ? { disabled: true }
          : { follow: true },
    );
  }

  /**
   * Gives the component its own scope, or makes it follow its plugin again, confirmed with the
   * preview's `scopeHash` (a difference -> 409 `plugin.scope_stale`); an org whose own skill has
   * its name would newly be offered it -> 409 `plugin.skill_conflict`. Audits
   * `component.scope_changed`.
   */
  @Put(":kind/:id/scope")
  setScope(
    @CurrentPrincipal() principal: Principal,
    @ZParam(ComponentParamsDto) p: z.infer<typeof ComponentParams>,
    @ZBody(ComponentScopeBody) body: z.infer<typeof ScopeBody>,
  ): Promise<ComponentView> {
    const actor = requireUser(principal);
    return this.scope.setScope(
      actor.account.id,
      p.kind,
      p.id,
      body.scope !== undefined
        ? {
            scope: body.scope,
            scopeHash: body.scopeHash,
            ...(body.orgs !== undefined && { orgs: body.orgs }),
          }
        : { follow: true, scopeHash: body.scopeHash },
      actorOpts(actor),
    );
  }

  /** Disables the component on the deployment (`scopeHash` required) or enables it again. */
  @Put(":kind/:id/disabled")
  setDisabled(
    @CurrentPrincipal() principal: Principal,
    @ZParam(ComponentParamsDto) p: z.infer<typeof ComponentParams>,
    @ZBody(ComponentDisabledBody) body: z.infer<typeof DisabledBody>,
  ): Promise<ComponentView> {
    const actor = requireUser(principal);
    return this.scope.setDisabled(
      actor.account.id,
      p.kind,
      p.id,
      {
        disabled: body.disabled,
        ...(body.scopeHash !== undefined && { scopeHash: body.scopeHash }),
      },
      actorOpts(actor),
    );
  }

  /** Shows or hides the component to orgs outside its `named` list. */
  @Put(":kind/:id/shown")
  setShown(
    @CurrentPrincipal() principal: Principal,
    @ZParam(ComponentParamsDto) p: z.infer<typeof ComponentParams>,
    @ZBody(ComponentShownBody) body: z.infer<typeof ShownBody>,
  ): Promise<ComponentView> {
    const actor = requireUser(principal);
    return this.scope.setShown(
      actor.account.id,
      p.kind,
      p.id,
      body.shownToOthers,
      actorOpts(actor),
    );
  }
}

/**
 * An org admin's switch of one platform component (`PUT orgs/:orgId/components/:kind/:id/switch`,
 * spec §5 rule 5, §13.5): `{ enabled: true }` -> 200 `{ component }`; `{ enabled: false }` on a
 * component in use -> 200 `{ preview: { agents }, confirm }`, then with `confirm` -> `{ component }`.
 * The route needs `catalog.read`; the service re-checks the kind's manage action (org admins).
 */
@Controller("api/v1/orgs/:orgId/components")
export class OrgComponentsController {
  constructor(@Inject(ComponentScopeService) private readonly scope: ComponentScopeService) {}

  /**
   * The platform components offered to the org (`?kind=`, `?itemId=`: only those; Task 10): each
   * with its state in the org (`on`, `locked` for `all`, the org's `switch`) and whether an org
   * admin may switch it. Members read it (the workspace pages are read-only for them).
   */
  @Get()
  @OrgAction("catalog.read")
  async list(
    @CurrentOrg() org: OrgContext,
    @ZQuery(OrgComponentListQuery) q: z.infer<typeof OrgListQuery>,
  ): Promise<{ components: OrgOfferedComponentView[] }> {
    return {
      components: await this.scope.orgList(org.orgId, {
        ...(q.kind !== undefined && { kind: q.kind }),
        ...(q.itemId !== undefined && { itemId: q.itemId }),
      }),
    };
  }

  @Put(":kind/:id/switch")
  @OrgAction("catalog.read")
  async setSwitch(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ComponentParamsDto) p: z.infer<typeof ComponentParams>,
    @ZBody(ComponentSwitchBody) body: z.infer<typeof SwitchBody>,
  ): Promise<
    | { component: OrgComponentView }
    | {
        preview: { agents: { id: string; name: string; refs: string[] }[]; connectorsKept: number };
        confirm: string;
      }
  > {
    const actor = requireUser(principal);
    const r = await this.scope.setSwitch(
      org.orgId,
      actor.account.id,
      p.kind,
      p.id,
      { enabled: body.enabled, ...(body.confirm !== undefined && { confirm: body.confirm }) },
      patTokenId(actor),
    );
    return r.kind === "done"
      ? { component: r.component }
      : { preview: r.preview, confirm: r.confirm };
  }
}
