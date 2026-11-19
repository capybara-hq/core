import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_MEDIA_TYPES,
  type ImageAspectRatio,
  type ImageMediaType,
  isModelError,
  type Logger,
  MEDIA_LIMITS,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import type { AttachmentsService } from "../../../conversations/attachments.service.js";
import type { AppendEvent, EventLog } from "../../../conversations/event-log.js";
import { isValidArtifactName } from "../../../conversations/events.js";
import { ApiError } from "../../../errors.js";
import type { KernelConfigService } from "../../../infra/config/kernel-config.service.js";
import type { KernelDb } from "../../../infra/database/kernel-db.js";
import {
  IMAGE_PURPOSE,
  type ImageInputCaps,
  imagePurposeState,
} from "../../../models/image-usable.js";
import {
  billedImages,
  ImageCallDenied,
  type ImageCallInput,
  type ModelImages,
  type PreparedImageCall,
} from "../../../models/images.js";
import type { ModelPurposesService } from "../../../models/purposes.js";
import {
  type HookDenial,
  type HookRunner,
  hookDeniedAudit,
  hookDeniedEvent,
  hookScope,
} from "../../../runtime/hook-calls.js";
import { appendCounted } from "../../../runtime/model-call.js";
import { ProviderListError, type ProviderRegistry } from "../../../runtime/providers.js";
import type { StepLog } from "../../../runtime/step-log.js";
import type { StorageService } from "../../../storage/storage.service.js";
import type { BuiltinCallContext, BuiltinTool } from "../../registry.js";
import {
  NO_STORAGE,
  NO_STORAGE_REASON,
  REPEAT_CLAUSE,
  type StoredArtifact,
  storeArtifacts,
} from "../artifacts.js";
import { findConversationFile } from "../conversation-files.js";
import {
  checkFilePathShape,
  checkToolWritable,
  clip,
  display,
  inToolSandbox,
  type SandboxToolDeps,
  sandboxConversationOf,
  sandboxUsable,
  withNotices,
  withPathLease,
} from "../sandbox/common.js";
import { assertReadAndUnchanged, FileGuardError, fileStateOf } from "../sandbox/file-state.js";
import { READ_MAX_BYTES } from "../sandbox/read.js";
import { generateImagePaths } from "./paths.js";
import { pickStandardSize } from "./size.js";

/** The model purpose the tool calls (image generation spec §5.4; no fallback). */
const PURPOSE = IMAGE_PURPOSE;

/** The most reference images one call names (the schema's `maxItems`). */
const MAX_REFERENCES = 4;
/** The most images one call asks for (the schema's maximum; the kernel cap may be lower). */
const MAX_IMAGES = 4;
/** The longest base name (`name`). */
const NAME_MAX_CHARS = 100;

/** The listed spec for an org whose image model accepts `caps` (pure; `n` and references drop or cap). */
export function generateImageSpec(
  caps: ImageInputCaps,
  standardPixels: number = DEFAULT_STANDARD_PIXELS,
): ToolSpec {
  const base = GENERATE_IMAGE_SPEC;
  const { n, reference_images, resolution, ...rest } = (
    base.inputSchema as { properties: Record<string, unknown> }
  ).properties;
  const properties: Record<string, unknown> = {
    ...rest,
    resolution: { ...(resolution as object), description: resolutionDescription(standardPixels) },
  };
  if (caps.maxImages > 1) properties.n = { ...(n as object), maximum: caps.maxImages };
  if (caps.maxReferenceImages > 0) {
    properties.reference_images = {
      ...(reference_images as object),
      maxItems: Math.min(MAX_REFERENCES, caps.maxReferenceImages),
    };
  }
  if (!base.description.includes(REFERENCE_SENTENCE)) {
    throw new Error("GenerateImage description lost its reference-images sentence");
  }
  const description =
    caps.maxReferenceImages > 0
      ? base.description
      : base.description.replace(REFERENCE_SENTENCE, "");
  return { ...base, description, inputSchema: { ...base.inputSchema, properties } };
}

/**
 * The description sentence about reference images (spelled out in the description below); dropped
 * with the `reference_images` field. `generateImageSpec` fails loudly if the two drift apart.
 */
const REFERENCE_SENTENCE =
  "Pass reference images (ids of images in this conversation) to keep a subject or style consistent with them, or to edit one. ";

/** `models.imageStandardPixels` default (the schema's), for the listing without the config. */
const DEFAULT_STANDARD_PIXELS = 1_048_576;
/** The `resolution` description with the configured target area in megapixels. */
const resolutionDescription = (standardPixels: number): string =>
  `standard: the size closest to about ${(standardPixels / 1_000_000).toFixed(1)} megapixels for this shape; high: the model's largest size for this shape. Default: standard.`;

export const GENERATE_IMAGE_SPEC: ToolSpec = {
  name: "GenerateImage",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["prompt"],
  description:
    "Generate images from a text prompt with this organization's image model, and deliver them to " +
    "the user in the conversation. Write a specific prompt: subject, composition, style, lighting, " +
    "any text that must appear. " +
    // REFERENCE_SENTENCE, spelled out: the tool-description check reads string literals only
    "Pass reference images (ids of images in this conversation) to keep a subject or style consistent with them, or to edit one. " +
    "Each call costs money: generate only what the user asked for.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        minLength: 1,
        description: "What to draw: subject, composition, style, lighting, any text to include.",
      },
      aspect_ratio: {
        type: "string",
        enum: [...IMAGE_ASPECT_RATIOS],
        description:
          "Shape of the images; the closest size the model supports is used. Default: the shape of the model's default size.",
      },
      resolution: {
        type: "string",
        enum: ["standard", "high"],
        description: resolutionDescription(DEFAULT_STANDARD_PIXELS),
      },
      n: {
        type: "integer",
        minimum: 1,
        maximum: MAX_IMAGES,
        description: "How many images to generate (default 1).",
      },
      reference_images: {
        type: "array",
        maxItems: MAX_REFERENCES,
        items: { type: "string", minLength: 1 },
        description:
          "Ids of images in this conversation that guide the result: attachment ids or artifact ids (generated or delivered images).",
      },
      name: {
        type: "string",
        minLength: 1,
        maxLength: NAME_MAX_CHARS,
        pattern: "^[^/\\\\]+$",
        description:
          'Base file name shown to the user, without extension, e.g. "poster" (gives poster-1.png, poster-2.png). Default: image.',
      },
      file_path: {
        type: "string",
        minLength: 1,
        description:
          "Also write the images into the device at this path, e.g. out/poster.png in the workspace directory; several images get -1, -2 suffixes before the extension.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

interface GenerateImageInput {
  prompt: string;
  aspect_ratio?: ImageAspectRatio;
  resolution?: "standard" | "high";
  n?: number;
  reference_images?: string[];
  name?: string;
  file_path?: string;
}

/** Why the tool is not listed: the org's `image` purpose has no usable model (spec §5.3). */
export const NO_IMAGE_MODEL_REASON = "No image model is configured for this organization";
/** The tool error when the purpose's model went away after the listing. */
export const NO_IMAGE_MODEL_TEXT = `${NO_IMAGE_MODEL_REASON}; ask an org admin to set a model for the image purpose, or continue without the image.`;
/** The tool error when a `model.request` policy hook denies the call. */
export const GENERATE_IMAGE_DENIED_TEXT =
  "An org policy blocked this image request; continue without it or ask the user.";
const refusedText = (message: string): string =>
  `The image model refused this prompt: ${message}. Rephrase it or ask the user.`;
const failedText = (message: string): string =>
  `Image generation failed: ${message}. Retry once, or continue without the image.`;
/** A refused argument (the request building's text names it and the allowed values). */
const invalidText = (message: string): string => `${message}; fix the argument and retry.`;
const unknownReferenceText = (k: number): string =>
  `reference_images[${k}] is not an image attachment or artifact of this conversation; pass the id of one.`;
const badReferenceText = (k: number): string =>
  `reference_images[${k}] is not a PNG, JPEG, GIF or WebP image up to ${
    MEDIA_LIMITS.imageBytes / 1_048_576
  } MB; pass another image, or call without it.`;
const BAD_NAME =
  "name must not contain control characters, / or \\; pass a plain base name such as poster.";
const BLANK_NAME = 'name must not be blank; pass a short file name such as "poster", or omit it.';
/** The request building's refusal of too many references (checked before any is read). */
const tooManyReferencesText = (max: number): string =>
  invalidText(
    max === 0
      ? "this model takes no reference images"
      : `this model takes at most ${max} reference images`,
  );
/** Why a device write failed for a reason the device did not explain (its error stays in the log). */
const copyFailedText = (path: string): string =>
  `the device could not write ${clip(path, 200)}; retry the call, or pass another file_path.`;
/** `Write`'s refusals of a target, worded for `file_path` (the images are already delivered). */
const isDirectoryText = (path: string): string =>
  `${clip(path, 200)} is a directory; pass the path of a file inside it as file_path.`;
const notReadText = (path: string): string =>
  `${clip(path, 200)} already exists and this conversation has not read it; Read it first to replace it, or pass another file_path.`;
const modifiedText = (path: string): string =>
  `${clip(path, 200)} has changed since this conversation read it; Read it again to replace it, or pass another file_path.`;
const vanishedText = (path: string): string =>
  `${clip(path, 200)} disappeared while it was being written; retry the call.`;
/** The device line of a call whose conversation has no device to write to. */
export const NO_DEVICE_LINE = "Not written to the device: this conversation has no device.";

/** The file extension of each image media type. */
const EXTENSIONS: Record<ImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** What the `GenerateImage` builtin needs (everything read per call: no process state). */
export interface GenerateImageDeps {
  images: Pick<ModelImages, "prepare" | "run">;
  /** Availability: the org's `image` purpose target, and its model resolved as an image model. */
  purposes: Pick<ModelPurposesService, "resolve">;
  providers: Pick<ProviderRegistry, "resolve">;
  storage: Pick<StorageService, "kernel" | "available">;
  eventLog: Pick<EventLog, "append" | "notify" | "readDeliveryScope"> &
    Partial<Pick<EventLog, "publishChanged">>;
  stepLog: Pick<StepLog, "appendCounted" | "appendReported" | "appendAudited">;
  config: Pick<KernelConfigService, "get">;
  log: Pick<Logger, "warn">;
  /** Extension hooks (absent: none fire). */
  hooks?: HookRunner | undefined;
  /** The artifact lookup of `reference_images`. */
  db: Pick<KernelDb, "selectFrom">;
  attachments: Pick<AttachmentsService, "openForConversation">;
  /** The device copy of `file_path` (the sandbox tools' own dependencies). */
  sandbox: SandboxToolDeps;
}

/**
 * The builtin `GenerateImage` (image generation spec §5.3): generates images with the org's
 * `image` purpose model ({@link ModelImages}), stores them as artifacts of the conversation as
 * `Deliver` stores a file (all or none, {@link storeArtifacts}), records the call's `usage` event
 * (purpose `image`, the call id, `outputImages`) and, with `file_path`, also writes the images
 * into the device through `Write`'s path checks (the command review covers such a call as a
 * write). Listed only while the purpose resolves to a callable image model and an object store
 * is there. A `model.request` policy denial is logged as any hook denial and sends nothing; a
 * refusal or a failure is an actionable tool error, never retried. The model sees only the result
 * text, so replays never call an image model.
 */
export function generateImageTool(deps: GenerateImageDeps): BuiltinTool {
  return {
    spec: GENERATE_IMAGE_SPEC,
    // the admins mapped a model to the purpose on purpose: that is the opt-in (spec §5.3)
    defaultPolicy: "allow",
    // the predicate the agent form's purpose availability reads too (one rule, no drift)
    unavailable: async (scope) => {
      const state = await imagePurposeState(deps, scope.orgId, scope.memo);
      if (state.usable === "no-model") return NO_IMAGE_MODEL_REASON;
      return state.usable === "no-storage" ? NO_STORAGE_REASON : null;
    },
    // the counts the org's image model accepts (on a race to unusable: the static spec)
    specFor: async (scope) => {
      const state = await imagePurposeState(deps, scope.orgId, scope.memo);
      return state.usable === "usable"
        ? generateImageSpec(state, deps.config.get().models.imageStandardPixels)
        : GENERATE_IMAGE_SPEC;
    },
    timeoutMs: () => deps.config.get().models.imageTimeoutMs + 60_000,
    async run(raw, ctx) {
      const input = raw as GenerateImageInput;
      if (!deps.storage.available) throw new ToolError(NO_STORAGE);
      const base = input.name?.trim();
      if (base === "") throw new ToolError(BLANK_NAME);
      if (base !== undefined && (!isValidArtifactName(base) || /[/\\]/.test(base))) {
        throw new ToolError(BAD_NAME);
      }
      if (input.file_path !== undefined) checkFilePathShape(input.file_path);
      const call: ImageCallInput = {
        prompt: input.prompt,
        ...(input.aspect_ratio !== undefined && { aspectRatio: input.aspect_ratio }),
        ...(input.n !== undefined && { n: input.n }),
      };
      // the cheap checks (prompt, count, size, the model) before any reference is read
      let prepared = await prepare(deps, ctx, call);
      // the size of the tool: the kernel's standard size for the shape, or the largest (spec §3.3)
      const size = pickStandardSize(prepared.info, {
        aspectRatio: input.aspect_ratio,
        resolution: input.resolution ?? "standard",
        standardPixels: deps.config.get().models.imageStandardPixels,
      });
      call.size = size;
      if (
        size.width !== prepared.request.size.width ||
        size.height !== prepared.request.size.height
      ) {
        prepared = await prepare(deps, ctx, call);
      }
      const refs = input.reference_images ?? [];
      if (refs.length > prepared.info.maxReferenceImages) {
        throw new ToolError(tooManyReferencesText(prepared.info.maxReferenceImages));
      }
      if (refs.length > 0) {
        // the bytes are checked (type, size) and sent by the request building
        const referenceImages = await resolveReferences(deps, ctx, refs);
        prepared = await prepare(deps, ctx, { ...call, referenceImages });
      }
      const result = await generate(deps, ctx, prepared);
      // a valid answer is billed whatever happens to its images afterwards (ruling R11)
      await logUsage(deps, ctx, prepared, result);
      // images a late answer carries after an abort are dropped: nothing is stored
      ctx.signal.throwIfAborted();
      const max = deps.config.get().sandbox.deliverMaxBytes;
      const files = result.images.map((img, i) => {
        const data = Buffer.from(img.data, "base64");
        if (data.byteLength > max) {
          // a server failure of the call (spec §6), with no partial delivery: nothing is stored
          throw new ToolError(
            failedText(
              `the model returned an image of ${data.byteLength} bytes, over the artifact limit of ${max} bytes`,
            ),
          );
        }
        const ext = EXTENSIONS[img.mediaType];
        const stem = base ?? "image";
        return {
          name: result.images.length === 1 ? `${stem}.${ext}` : `${stem}-${i + 1}.${ext}`,
          contentType: img.mediaType,
          data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        };
      });
      // each call's images are their own files, never versions of an earlier call's (R13)
      const stored = await storeArtifacts(
        deps,
        ctx,
        files.map((f) => ({ ...f, sourcePath: `generated/${ctx.callId}/${f.name}` })),
      );
      let deviceLine: string | null = null;
      let notices: string[] = [];
      if (input.file_path !== undefined) {
        const copied = await copyToDevice(
          deps,
          ctx,
          input.file_path,
          files.map((f, i) => {
            const a = stored[i] as StoredArtifact;
            return { ...f, artifactId: a.repeatOf?.artifactId ?? a.artifactId };
          }),
        );
        deviceLine = copied.line;
        notices = copied.notices;
      }
      const text = resultText(prepared, stored, files, result.revisedPrompt, deviceLine);
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        display: display(
          `生成图片 ${clip(input.prompt, 160)}`,
          `Generated images: ${clip(input.prompt, 160)}`,
        ),
      };
    },
  };
}

/** {@link ModelImages.prepare} with its refusals as tool errors. */
async function prepare(
  deps: GenerateImageDeps,
  ctx: BuiltinCallContext,
  call: ImageCallInput,
): Promise<PreparedImageCall> {
  try {
    return await deps.images.prepare(ctx.orgId, PURPOSE, call);
  } catch (e) {
    throw toolErrorOf(e) ?? e;
  }
}

/**
 * The tool error of a refusal of the image call, or null for an error the pipeline reports
 * itself (an abort, a kernel fault).
 */
function toolErrorOf(e: unknown): ToolError | null {
  if (e instanceof ToolError) return e;
  if (e instanceof ApiError) {
    if (e.code === "validation_failed") return new ToolError(invalidText(e.message));
    // a transient list error of the provider: the call may succeed on a retry
    if (e instanceof ProviderListError) return new ToolError(failedText(e.message));
    if (e.code === "model.unconfigured" || e.code === "agent.model_unavailable") {
      return new ToolError(NO_IMAGE_MODEL_TEXT);
    }
    return null;
  }
  if (isModelError(e) && e.kind === "refusal") return new ToolError(refusedText(e.message));
  if (isModelError(e)) return new ToolError(failedText(e.message));
  return null;
}

/**
 * Reads the reference images as bytes, each an id of the conversation: an attachment or an
 * `artifact_created` of the calling conversation or its root ({@link findConversationFile}).
 * Anything else names its index; a file that is not an image within `MEDIA_LIMITS.imageBytes` is
 * refused before it is read.
 */
async function resolveReferences(
  deps: GenerateImageDeps,
  ctx: BuiltinCallContext,
  ids: readonly string[],
): Promise<{ mediaType: ImageMediaType; data: string }[]> {
  const root = sandboxConversationOf(ctx);
  const out: { mediaType: ImageMediaType; data: string }[] = [];
  for (const [k, id] of ids.entries()) {
    try {
      const found = await findConversationFile(
        { db: deps.db, attachments: deps.attachments, storage: deps.storage },
        { orgId: ctx.orgId, conversationId: ctx.conversationId, rootConversationId: root, id },
      );
      if (found === null) throw new ToolError(unknownReferenceText(k));
      const mediaType = found.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      if (
        !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType) ||
        found.size > MEDIA_LIMITS.imageBytes
      ) {
        throw new ToolError(badReferenceText(k));
      }
      const bytes = await found.open();
      if (bytes.byteLength > MEDIA_LIMITS.imageBytes) throw new ToolError(badReferenceText(k));
      out.push({
        mediaType: mediaType as ImageMediaType,
        data: Buffer.from(bytes).toString("base64"),
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "storage.unavailable") {
        throw new ToolError(NO_STORAGE);
      }
      throw e;
    }
  }
  return out;
}

/**
 * Runs the prepared call (the hooks fire for a `chat` or `subagent` conversation only). A policy
 * denial is recorded (`hook_denied` with its audit row) and becomes the denial tool error.
 */
async function generate(
  deps: GenerateImageDeps,
  ctx: BuiltinCallContext,
  prepared: PreparedImageCall,
): Promise<Awaited<ReturnType<ModelImages["run"]>>> {
  const runId = ctx.runId ?? "";
  const scope = hookScope(deps.hooks, {
    ...(ctx.conversationKind !== undefined && { conversationKind: ctx.conversationKind }),
    orgId: ctx.orgId,
    accountId: ctx.accountId,
    agentId: ctx.agentId,
    agentVersion: ctx.agentVersion ?? 1,
    conversationId: ctx.conversationId,
    runId,
    parent: ctx.parent,
  });
  try {
    return await deps.images.run(
      ctx.orgId,
      prepared,
      {
        kind: "conversation",
        // without a scope no hook fires (the runner is not passed), so the fields are unused
        scope: scope ?? {
          orgId: ctx.orgId,
          accountId: ctx.accountId,
          agentId: ctx.agentId,
          agentVersion: ctx.agentVersion ?? 1,
          conversationId: ctx.conversationId,
          runId,
        },
        step: ctx.step ?? 0,
        callId: ctx.callId,
      },
      ctx.signal,
      scope ? deps.hooks : undefined,
    );
  } catch (e) {
    if (e instanceof ImageCallDenied) {
      await recordDenial(deps, ctx, runId, e.verdict);
      throw new ToolError(GENERATE_IMAGE_DENIED_TEXT);
    }
    // an abort is the pipeline's (the run stopped or the call timed out)
    if (ctx.signal.aborted) throw e;
    const mapped = toolErrorOf(e);
    if (mapped === null) throw e;
    deps.log.warn("GenerateImage call failed", {
      conversationId: ctx.conversationId,
      callId: ctx.callId,
      err: e,
    });
    throw mapped;
  }
}

/**
 * Appends the call's `usage` event (the tool call's run and step, `callId`, `outputImages`;
 * idempotent per call) and owes its `usage.report` delivery in the same transaction; a
 * sub-agent's call also counts on its budget run ({@link appendCounted}).
 */
async function logUsage(
  deps: GenerateImageDeps,
  ctx: BuiltinCallContext,
  prepared: PreparedImageCall,
  result: Awaited<ReturnType<ModelImages["run"]>>,
): Promise<void> {
  const runId = ctx.runId ?? "";
  const event: AppendEvent = {
    type: "usage",
    ...(runId !== "" && { runId }),
    idemKey: `usage_image:${runId}:${ctx.callId}`,
    payload: {
      step: ctx.step ?? 0,
      provider: prepared.ref.provider,
      model: prepared.ref.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      outputImages: billedImages(result),
      purpose: PURPOSE,
      callId: ctx.callId,
    },
  };
  await appendCounted(
    deps,
    {
      conversationId: ctx.conversationId,
      parentRunId: ctx.parentRunId,
      budgetRunId: ctx.budgetRunId,
    },
    [event],
  );
}

/**
 * Records a `model.request` denial of the call: the `hook_denied` event (the tool call's step and
 * `callId`) with its `hook.denied` audit row (`detail.purpose: "image"`), in one transaction.
 */
async function recordDenial(
  deps: GenerateImageDeps,
  ctx: BuiltinCallContext,
  runId: string,
  verdict: HookDenial,
): Promise<void> {
  const site = {
    orgId: ctx.orgId,
    conversationId: ctx.conversationId,
    runId,
    accountId: ctx.accountId,
    agentId: ctx.agentId,
    idemKey: `hook_denied_image:${runId}:${ctx.callId}`,
  };
  const event = hookDeniedEvent(site, "model.request", verdict, {
    step: ctx.step ?? 0,
    attempt: 1,
    callId: ctx.callId,
  });
  const entry = hookDeniedAudit(site, event.payload, verdict);
  entry.detail = { ...entry.detail, purpose: PURPOSE };
  deps.log.warn("GenerateImage blocked by a policy hook", {
    conversationId: ctx.conversationId,
    callId: ctx.callId,
    plugin: verdict.plugin,
    cause: verdict.cause,
  });
  const written = await deps.stepLog.appendAudited(ctx.conversationId, [event], entry);
  if (written.length > 0) {
    await deps.eventLog.notify(ctx.conversationId, Math.max(...written.map((e) => e.seq)));
  }
}

/**
 * Writes the images into the call's device at `filePath` (several: `-1`, `-2`… before the
 * extension, {@link generateImagePaths}) with `Write`'s checks (spec §5.3): the device entry every
 * builtin takes ({@link inToolSandbox}: the managed route and its marked device paths once
 * activated), each path checked as `Write` checks it, and under its path lease a directory refused
 * and an existing file replaced only when this conversation read it and it is unchanged
 * ({@link assertReadAndUnchanged}). The images are already delivered, so a copy that cannot be made
 * is a line of the result, not a tool error: no device, or the reason the copy stopped, after the
 * paths written before it. A path whose extension does not match the image's media type names the
 * type ({@link deviceEntry}). An abort still ends the call.
 */
async function copyToDevice(
  deps: GenerateImageDeps,
  ctx: BuiltinCallContext,
  filePath: string,
  files: readonly { data: Uint8Array; contentType: ImageMediaType; artifactId: string }[],
): Promise<{ line: string; notices: string[] }> {
  const sb = deps.sandbox;
  const conv = sandboxConversationOf(ctx);
  if (!(await hasDevice(sb, ctx.orgId, conv))) return { line: NO_DEVICE_LINE, notices: [] };
  const targets = generateImagePaths({ file_path: filePath, n: files.length });
  // the paths written so far (a rebuilt instance runs the copy again from the start)
  let written: { entry: string; artifactId: string }[] = [];
  let current = targets[0] as string;
  try {
    const { notices } = await inToolSandbox(sb, ctx, async (s) => {
      written = [];
      for (const [i, f] of files.entries()) {
        current = targets[i] as string;
        const path = checkToolWritable(current, s);
        current = path;
        // stat, read the existing file, write: one holder at a time per file (as `Write`)
        await withPathLease(sb, { deviceId: s.deviceId }, path, s.signal, async (signal) => {
          const st = await s.p.stat(s.h, path, signal);
          if (st?.isDir) throw new ToolError(isDirectoryText(path));
          if (st !== null) {
            const got = await s.p.readFile(s.h, path, { maxBytes: READ_MAX_BYTES, signal });
            if (got === null) throw new ToolError(vanishedText(path));
            try {
              await assertReadAndUnchanged(
                sb,
                ctx.conversationId,
                path,
                fileStateOf(got.data, st.size),
              );
            } catch (e) {
              if (!(e instanceof FileGuardError)) throw e;
              if (e.reason === "not_read") throw new ToolError(notReadText(path));
              throw new ToolError(modifiedText(path));
            }
          }
          await s.p.writeFile(s.h, path, f.data, signal);
        });
        written.push({ entry: deviceEntry(path, f.contentType), artifactId: f.artifactId });
      }
    });
    return { line: writtenLine(written), notices };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    // a device's own error is not shown to the model (it may name provider internals)
    if (!(e instanceof ToolError)) {
      deps.log.warn("GenerateImage device copy failed", {
        conversationId: ctx.conversationId,
        callId: ctx.callId,
        err: e,
      });
    }
    const failed = `Not written to the device: ${
      e instanceof ToolError ? e.message : copyFailedText(current)
    }`;
    // a partial copy says which files are there before the failure
    return {
      line: written.length === 0 ? failed : `${writtenLine(written)}\n${failed}`,
      notices: [],
    };
  }
}

/** The device line for the files written: each names the artifact that holds the same bytes. */
function writtenLine(written: readonly { entry: string; artifactId: string }[]): string {
  const [only] = written;
  if (written.length === 1 && only !== undefined) {
    return `Also written to the device (same bytes as artifact ${only.artifactId}): ${only.entry}`;
  }
  return `Also written to the device: ${written
    .map((w) => `${w.entry} (same bytes as artifact ${w.artifactId})`)
    .join(", ")}`;
}

/**
 * A written path as the device line names it: the path, followed by the image's media type when
 * the path's extension is not one of that type's (`out/a.jpg (image/png)`), so the model knows
 * what the file holds whatever it was called.
 */
export function deviceEntry(path: string, mediaType: ImageMediaType): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MEDIA_EXTENSIONS[mediaType].includes(ext) ? path : `${path} (${mediaType})`;
}

/** The extensions that name each image media type ({@link deviceEntry}). */
const MEDIA_EXTENSIONS: Record<ImageMediaType, readonly string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
};

/**
 * Whether the conversation tree has a device to write to: a provider it can run on, and a device
 * its owner has (an anonymous IM sender or a deployment without a cloud provider has none).
 */
async function hasDevice(sb: SandboxToolDeps, orgId: string, conv: string): Promise<boolean> {
  if (!(await sandboxUsable(sb, orgId, conv))) return false;
  try {
    await sb.devices.forTool(orgId, conv);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.code === "sandbox.unavailable") return false;
    // any other refusal (a gone or forbidden device) is reported by the copy itself
    return true;
  }
}

/** A byte count as the result shows it. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** The model-visible result (spec §5.3): what was generated, delivered or repeated, billing, the device copy. */
function resultText(
  prepared: PreparedImageCall,
  stored: readonly StoredArtifact[],
  files: readonly { contentType: string }[],
  revisedPrompt: string | undefined,
  deviceLine: string | null,
): string {
  const n = stored.length;
  const { width, height } = prepared.request.size;
  const lines = [
    `Generated ${n} ${n === 1 ? "image" : "images"} with ${prepared.ref.provider}/${prepared.ref.model} at ${width}x${height}.`,
  ];
  const fresh = stored.flatMap((a, i) => (a.repeatOf === undefined ? [{ a, i }] : []));
  if (fresh.length > 0) {
    lines.push(
      `Delivered ${fresh.length} to the user:`,
      ...fresh.map(
        ({ a, i }) =>
          `- ${a.name} (artifact ${a.artifactId}, ${files[i]?.contentType ?? ""}, ${sizeText(a.size)})`,
      ),
    );
  }
  const repeats = stored.filter((a) => a.repeatOf !== undefined);
  if (repeats.length > 0) {
    for (const a of repeats) {
      lines.push(`- ${a.name}: ${REPEAT_CLAUSE(a.repeatOf as NonNullable<typeof a.repeatOf>)}`);
    }
    lines.push(`Usage is billed for ${n} generated ${n === 1 ? "image" : "images"}.`);
  }
  if (typeof revisedPrompt === "string" && revisedPrompt !== "") {
    lines.push(`Revised prompt: ${revisedPrompt}`);
  }
  const first = stored[0];
  if (first !== undefined) {
    lines.push(
      `The images are not shown to you; Read with file_id ${first.repeatOf?.artifactId ?? first.artifactId} returns one.`,
    );
  }
  if (deviceLine !== null) lines.push(deviceLine);
  return lines.join("\n");
}
