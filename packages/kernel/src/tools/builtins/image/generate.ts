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
import { sql } from "kysely";
import type { AttachmentsService } from "../../../conversations/attachments.service.js";
import type { AppendEvent, EventLog } from "../../../conversations/event-log.js";
import { type EventPayload, isValidArtifactName } from "../../../conversations/events.js";
import type { KernelSchemaDb } from "../../../db/kernel-schema.js";
import { ApiError } from "../../../errors.js";
import type { KernelConfigService } from "../../../infra/config/kernel-config.service.js";
import {
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
  type StoredArtifact,
  storeArtifacts,
} from "../artifacts.js";
import {
  checkFilePathShape,
  checkToolWritable,
  clip,
  display,
  inSandbox,
  type SandboxToolDeps,
  sandboxConversationOf,
  sandboxUsable,
  withNotices,
  withPathLease,
} from "../sandbox/common.js";
import { generateImagePaths } from "./paths.js";

/** The model purpose the tool calls (image generation spec §5.4; no fallback). */
const PURPOSE = "image";

/** The most reference images one call names (the schema's `maxItems`). */
const MAX_REFERENCES = 4;
/** The most images one call asks for (the schema's maximum; the kernel cap may be lower). */
const MAX_IMAGES = 4;
/** The longest base name (`name`). */
const NAME_MAX_CHARS = 100;

export const GENERATE_IMAGE_SPEC: ToolSpec = {
  name: "GenerateImage",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["prompt"],
  description:
    "Generate images from a text prompt with this organization's image model, and deliver them to " +
    "the user in the conversation. Write a specific prompt: subject, composition, style, lighting, " +
    "any text that must appear. Optionally pass reference images (attachment or earlier generated " +
    "image ids) to guide the result. Each call costs money: generate only what the user asked for.",
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
          "Shape of the images; the closest size the model supports is used. Default: the model's default size.",
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
          "Ids of images that guide the result: attachment ids of this conversation, or artifact ids of images generated earlier in it.",
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
  `reference_images[${k}] is not an attachment or generated image of this conversation; pass an attachment id or the artifact id of an image generated earlier in it.`;
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
  `the device could not write ${clip(path, 200)}; check that the path is not a directory and retry.`;
/** The device line of a call whose conversation has no device to write to. */
export const NO_DEVICE_LINE = "Not written to the device: this conversation has no device.";

/** Lower-case UUIDs: attachment and artifact ids. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  eventLog: Pick<EventLog, "append" | "notify"> & Partial<Pick<EventLog, "publishChanged">>;
  stepLog: Pick<StepLog, "appendCounted" | "appendReported" | "appendAudited">;
  config: Pick<KernelConfigService, "get">;
  log: Pick<Logger, "warn">;
  /** Extension hooks (absent: none fire). */
  hooks?: HookRunner | undefined;
  /** The artifact lookup of `reference_images`. */
  db: () => KernelSchemaDb;
  attachments: Pick<AttachmentsService, "openForConversation">;
  /** The device copy of `file_path` (the sandbox tools' own dependencies). */
  sandbox: SandboxToolDeps;
}

/** Whether the org's `image` purpose resolves to an image model the org can call now. */
async function imageModelUsable(deps: GenerateImageDeps, orgId: string): Promise<boolean> {
  try {
    const target = await deps.purposes.resolve(orgId, PURPOSE);
    await deps.providers.resolve(orgId, target.model, { kind: "image_generation" });
    return true;
  } catch {
    return false;
  }
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
    unavailable: async (scope) => {
      if (!(await imageModelUsable(deps, scope.orgId))) return NO_IMAGE_MODEL_REASON;
      return deps.storage.available ? null : NO_STORAGE_REASON;
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
        const copied = await copyToDevice(deps, ctx, input.file_path, files);
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
 * Reads the reference images as bytes, each an id of the conversation: an attachment of the
 * conversation whose device the call uses (a sub-agent: its root's, as `FetchAttachment`
 * resolves), else an `artifact_created` of the calling conversation or its root. Anything else
 * names its index; a file that is not an image within `MEDIA_LIMITS.imageBytes` is refused before
 * it is read.
 */
async function resolveReferences(
  deps: GenerateImageDeps,
  ctx: BuiltinCallContext,
  ids: readonly string[],
): Promise<{ mediaType: ImageMediaType; data: string }[]> {
  const root = sandboxConversationOf(ctx);
  const out: { mediaType: ImageMediaType; data: string }[] = [];
  for (const [k, id] of ids.entries()) {
    if (!UUID.test(id)) throw new ToolError(unknownReferenceText(k));
    const found = await openReference(deps, ctx, root, id.toLowerCase());
    if (found === null) throw new ToolError(unknownReferenceText(k));
    const mediaType = found.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (
      !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType) ||
      found.size > MEDIA_LIMITS.imageBytes
    ) {
      await found.body.cancel().catch(() => {});
      throw new ToolError(badReferenceText(k));
    }
    const bytes = new Uint8Array(await new Response(found.body).arrayBuffer());
    if (bytes.byteLength > MEDIA_LIMITS.imageBytes) throw new ToolError(badReferenceText(k));
    out.push({
      mediaType: mediaType as ImageMediaType,
      data: Buffer.from(bytes).toString("base64"),
    });
  }
  return out;
}

/** One reference by id: its declared type and size and its bytes, or null when it is not one. */
async function openReference(
  deps: GenerateImageDeps,
  ctx: BuiltinCallContext,
  root: string,
  id: string,
): Promise<{ contentType: string; size: number; body: ReadableStream<Uint8Array> } | null> {
  try {
    const attachment = await deps.attachments.openForConversation(ctx.orgId, root, id);
    if (attachment !== null) return attachment;
    const row = await deps
      .db()
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "in", [...new Set([ctx.conversationId, root])])
      .where("type", "=", "artifact_created")
      .where(sql<string>`payload->>'artifactId'`, "=", id)
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    const a = row.payload as EventPayload<"artifact_created">;
    const got = await deps.storage.kernel(ctx.orgId).get(a.objectKey);
    if (got === null) return null;
    return { contentType: a.contentType, size: got.head.size, body: got.body };
  } catch (e) {
    if (e instanceof ApiError && e.code === "storage.unavailable") throw new ToolError(NO_STORAGE);
    throw e;
  }
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
      outputImages: result.usage.outputImages ?? result.images.length,
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
 * extension, {@link generateImagePaths}), each path checked as `Write` checks it and written under
 * its path lease. The images are already delivered, so a copy that cannot be made is a line of the
 * result, not a tool error: no device, or the reason the device gave, after the paths written
 * before it failed. An abort still ends the call.
 */
async function copyToDevice(
  deps: GenerateImageDeps,
  ctx: BuiltinCallContext,
  filePath: string,
  files: readonly { data: Uint8Array }[],
): Promise<{ line: string; notices: string[] }> {
  const sb = deps.sandbox;
  const conv = sandboxConversationOf(ctx);
  if (!(await hasDevice(sb, ctx.orgId, conv))) return { line: NO_DEVICE_LINE, notices: [] };
  const targets = generateImagePaths({ file_path: filePath, n: files.length });
  // the paths written so far (a rebuilt instance runs the copy again from the start)
  let written: string[] = [];
  let current = targets[0] as string;
  try {
    const { notices } = await inSandbox(sb, ctx, async (s) => {
      written = [];
      for (const [i, f] of files.entries()) {
        current = targets[i] as string;
        const path = checkToolWritable(current, s);
        current = path;
        await withPathLease(sb, { deviceId: s.deviceId }, path, s.signal, (signal) =>
          s.p.writeFile(s.h, path, f.data, signal),
        );
        written.push(path);
      }
    });
    return { line: `Written to the device: ${written.join(", ")}`, notices };
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
      line:
        written.length === 0 ? failed : `Written to the device: ${written.join(", ")}\n${failed}`,
      notices: [],
    };
  }
}

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

/** The model-visible result (spec §5.3): what was generated, where it went, the revised prompt. */
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
    `Generated ${n} ${n === 1 ? "image" : "images"} with ${prepared.ref.provider}/${prepared.ref.model} at ${width}x${height} and delivered ${n === 1 ? "it" : "them"} to the user:`,
    ...stored.map(
      (a, i) =>
        `- ${a.name} (artifact ${a.artifactId}, ${files[i]?.contentType ?? ""}, ${sizeText(a.size)})`,
    ),
  ];
  if (typeof revisedPrompt === "string" && revisedPrompt !== "") {
    lines.push(`Revised prompt: ${revisedPrompt}`);
  }
  if (deviceLine !== null) lines.push(deviceLine);
  return lines.join("\n");
}
