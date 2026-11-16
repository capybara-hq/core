import {
  isFileSystemGoneError,
  isSandboxGoneError,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { ApiError } from "../../../errors.js";
import type { BuiltinTool } from "../../registry.js";
import {
  assignAttachmentNames,
  attachmentsDir,
  clip,
  display,
  inSandbox,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  sandboxConversationOf,
  unavailableWhenNoSandbox,
  withNotices,
} from "./common.js";

const SPEC: ToolSpec = {
  name: "FetchAttachment",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["file"],
  description:
    "Copy a file the user attached to this conversation into the device, so you can open it with Bash or the file tools. " +
    "Attachments are not in the device until this call; the user's message names each file and, for a file the model cannot read, " +
    "its unsigned reference. Pass the file name as the message shows it, that reference, or the attachment id. " +
    "The file is written under the workspace's attachments directory, and a given file always lands on the same path.",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        minLength: 1,
        description:
          "The attachment's file name as the user's message shows it, its unsigned object reference, or its id.",
      },
    },
    required: ["file"],
    additionalProperties: false,
  },
};

interface FetchAttachmentInput {
  file: string;
}

/** An attachment of the conversation as resolving and naming read it. */
type ConversationAttachment = { id: string; name: string };

/** Attachment ids are lower-case UUIDs; the reference's last path segment is the id. */
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const noAttachmentsText = (file: string): string =>
  `No attachment named "${clip(file, 200)}"; this conversation has no attachments. Ask the user to send the file, then retry.`;

const unknownFileText = (file: string, list: readonly ConversationAttachment[]): string =>
  `No attachment named "${clip(file, 200)}"; this conversation has: ${list
    .slice(0, 5)
    .map((a) => clip(a.name, 200))
    .join(", ")}. Use the name as the attachment line shows it, its reference or its id.`;

const goneText = (name: string): string =>
  `Attachment "${clip(name, 200)}" is no longer in this conversation: it was deleted, or its upload did not finish. Ask the user to send it again, then retry.`;

const storageText = (name: string): string =>
  `File storage is unavailable, so "${clip(name, 200)}" could not be copied; ask an administrator to check the deployment's object store, then retry.`;

const copyFailedText = (name: string): string =>
  `Copying "${clip(name, 200)}" into the device failed (a temporary error); retry the call, or check that the device has free space.`;

/**
 * The attachment `file` names, among the conversation's ready ones (the caller's list): the exact
 * file name, then the name the copy assigns it (a sanitized or de-duplicated name shown in an
 * earlier result's path), then the bare attachment id or a reference whose last path segment is the
 * id (`s3://<bucket>/<key>/attachments/<id>`, `capybara://attachments/<id>`). Names are exact and
 * case-sensitive; nothing else resolves.
 */
function resolveAttachment(
  file: string,
  list: readonly ConversationAttachment[],
  assigned: ReadonlyMap<string, string>,
): ConversationAttachment | undefined {
  const byName = list.find((a) => a.name === file);
  if (byName !== undefined) return byName;
  const byAssigned = list.find((a) => assigned.get(a.id) === file);
  if (byAssigned !== undefined) return byAssigned;
  const tail = file.slice(file.lastIndexOf("/") + 1);
  if (!ATTACHMENT_ID.test(tail)) return undefined;
  const id = tail.toLowerCase();
  return list.find((a) => a.id.toLowerCase() === id);
}

/**
 * The builtin `FetchAttachment`: copy one attachment of this conversation into the device
 * ({@link attachmentsDir}); it runs nothing. Names come from the conversation's whole attachment
 * list ({@link assignAttachmentNames}), so a given attachment always lands on the same path;
 * copying it twice writes the same bytes and returns the same path. A failure is an ordinary tool
 * error and the run continues.
 */
export function sandboxFetchAttachmentTool(deps: SandboxToolDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    unavailable: unavailableWhenNoSandbox(deps),
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config.get()),
    async run(input, ctx) {
      const file = (input as FetchAttachmentInput).file;
      const conv = sandboxConversationOf(ctx);
      // the list is read before any device is touched: an unknown file starts no device
      const list = await deps.attachments.listForConversation(ctx.orgId, conv);
      const assigned = assignAttachmentNames(list, new Set());
      const attachment = resolveAttachment(file, list, assigned);
      if (attachment === undefined) {
        if (list.length === 0) throw new ToolError(noAttachmentsText(file));
        throw new ToolError(unknownFileText(file, list));
      }
      // the whole list names the file, so its name never changes between calls
      const name = assigned.get(attachment.id) ?? attachment.name;
      const { value, notices } = await inSandbox(deps, ctx, async ({ h, roots, p, signal }) => {
        const path = `${attachmentsDir(roots, conv)}/${name}`;
        let bytes: Uint8Array;
        try {
          const opened = await deps.attachments.openForConversation(ctx.orgId, conv, attachment.id);
          if (opened === null) throw new ToolError(goneText(name));
          bytes = new Uint8Array(await new Response(opened.body).arrayBuffer());
          await p.writeFile(h, path, bytes, signal);
        } catch (e) {
          // an abort (timeout / lost lock / stopped run) and a gone device or instance go to
          // withSandbox and mapSandboxError; never the provider's own words (they may name its
          // internal address)
          if (signal.aborted || isSandboxGoneError(e) || isFileSystemGoneError(e)) throw e;
          if (e instanceof ToolError) throw e;
          if (e instanceof ApiError && e.code === "storage.unavailable") {
            throw new ToolError(storageText(name));
          }
          throw new ToolError(copyFailedText(name));
        }
        return { path, size: bytes.byteLength };
      });
      return {
        content: [{ type: "text", text: withNotices(notices, `Copied ${name} to ${value.path}.`) }],
        // the row names the file and its size; the path is in the result's text
        display: display(
          `复制 ${clip(name, 170)}（${value.size} 字节）`,
          `Copied ${clip(name, 170)} (${value.size} bytes)`,
        ),
      };
    },
  };
}
