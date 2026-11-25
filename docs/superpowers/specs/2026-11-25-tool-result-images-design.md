# Images in tool results: shown to the agent, visible to the person, deliverable

Status: implemented on branch `fix/tool-result-images` (2026-11-25). Amends the vision-read design
(`2026-11-19-vision-read-design.md`, non-goal "No image bytes inside tool results at the SDK level"
and open question 2) and completes the browser use design's screenshot line (§ Vision:
"screenshot … through the kernel's media limits and downscaling").

## 1. Intent

Acceptance on prod (rc.114, browser rc.4, conversation f1f1c5f5…, model deepseek-flash): the
person asked "截图发给我吧"; the agent called `browser_screenshot` and answered as if the person
had received the image. The person saw only the tool row text `[image image/jpeg, 50308 bytes]`.

What the log shows:

- `tool_result.content` was `Page: … Screenshot 1280x800 (viewport 1280x800).\n[image image/jpeg, 50308 bytes]`
  and the result had no `media`. `renderResult` flattens every `ToolContent` image of an extension
  or connector tool to that line; the bytes are dropped. **No model ever saw a screenshot**, with or
  without vision (deepseek-flash does receive pasted images as bytes on prod: `model_call.request.media`
  outcome `bytes`).
- The line names a type and a byte count and nothing else. It reads like an attached image, so the
  model took it for one it had sent and seen.
- Nothing let the person see the image (the web draws the text) or let the agent hand it over
  (`Deliver` takes only a device path; the screenshot never lands on the device).

The browser design assumed the screenshot reaches vision models; the vision-read design had ruled
plugin images out to keep a plugin from naming attachments for request building. Both hold if the
kernel stores the bytes itself.

## 2. The pipeline stores tool-result images

For every tool call that returns a result (builtin, extension or connector), the pipeline walks the
result's image blocks (`{ type: "image", data, mimeType }`) in order (`tools/result-images.ts`):

1. at most `RESULT_IMAGES_MAX` (10) per result;
2. the bytes must sniff as PNG, JPEG, GIF or WebP (the sniffed type wins over the declared one);
3. at most `MEDIA_LIMITS.imageBytes` (5 MiB);
4. stored with `AttachmentsService.storeRead` as a `read` copy bound to the calling conversation
   (intent row, put, bind; the per-conversation cap `attachments.readMaxBytesPerConversation`
   applies; the purge of deleted conversations covers it), named `<tool name>[-n].<ext>`.

Each stored image is appended to `tool_result.media` (after any builtin `Read` copy). The tool never
names an id: the kernel records only rows it created from bytes it was given. A failed store
(storage error other than "no object store") logs a warning and the block counts as not stored; the
call's result is still written.

The block's line in the result text (model-visible, written once in the log):

- stored: `[Image (<type>, <size>, <W>×<H>), file_id <id>]`;
- not stored: `[Image (<declared type>, <size>) not stored, so not shown: <reason>]`, the reason one
  of: only PNG, JPEG, GIF and WebP images are stored / it is over the 5 MB image limit / a tool
  result stores at most 10 images / this conversation reached its limit for stored images / file
  storage is not configured in this deployment / storing it failed. A pipeline with no image store
  wired in (hand-built test pipelines) writes `… not stored, so not shown.`

A network ask that keeps a result keeps its `media` too (`KeptToolResult.media`).

## 3. Request building

Unchanged mechanism (vision-read §1.4: after the step's tool results, in call order, inside the
Read-image window and the request's media limits, `media_excluded` applies); the texts now name the
tool and say plainly when the image was not shown:

- label: `Image from <toolKey> (file_id <id>):` (for `Read` exactly as before);
- a model without vision: `[Not shown to you: this model cannot view images.]` after `Read` (its
  result already carries the vision model's answer); after any other tool
  `[Not shown to you: this model cannot view images. Read with file_id <id> sends it to the
  organization's vision model, if one is set.]` (the same mechanism the pasted-image placeholder
  states; `Read` resolves `read` copies by id);
- left out by the window: `[Image from <toolKey> (file_id <id>) not included in this request.]`.

All of it is derived from the log (`tool_result.media`, `toolKey`), so no `DriftReason` is needed;
reconstruct and full-run replay read `media` as before (`RecordedToolPipeline` copies it).

## 4. The person sees them

- `GET /attachments/:id/download` also serves `read` copies to whoever can open the copy's
  conversation (same check, presigned inline for images). Copies stay out of every list and out of
  the device's attachments directory.
- The web timeline carries `tool_result.media` on the call's row; the thread renders the images as
  thumbnails under the row's output (design §6.16.9, `ToolRowData.detail.images`, part
  `tool-images`), and a click opens the existing `ImageViewer` (navigation across the group's
  images, download, open in a new tab, one retry after a failed load).

The tool row is a record of what the agent did, not a delivery: channels (Lark, Slack …) show no tool
rows, and the person may not expand them.

## 5. The agent can hand an image over

`Deliver` gains `file_id` (exactly one of `file_path` and `file_id`): an attachment, `read` copy or
artifact of the conversation or its root, read from the object store with no device, stored as an
artifact with source path `file_id/<id>`, name and type from the stored file unless `name` is given.
`Deliver` is listed without a usable device when the object store and the conversation file lookup
exist. Its description states the mechanism: files on the device and images in tool results are not
delivered to the user by themselves; `file_id` names such a file.

No browser plugin change is needed: its screenshot result is an ordinary image block.

## 6. Other image-returning tools (audit)

| Tool | Before | Now |
|---|---|---|
| `Read` of an image | stored, shown / vision answer (vision-read) | unchanged; label text unchanged; no-vision text says "Not shown to you" |
| `GenerateImage` | artifacts, "not shown to you; Read with file_id" | unchanged (already delivered to the person) |
| Extension tools (`browser_screenshot`, any plugin) | flattened to `[image <mime>, <n> bytes]`, never seen | stored, shown to vision models, thumbnails, Deliver by `file_id` |
| Connector tools (MCP image content) | flattened, never seen | same as extension tools |
| Resource reads / prompts (`connector-content.ts`) | flattened text | flattened to the honest "not stored, so not shown." line (no call context to store under) |

## 7. Rulings

- Reuse the `read` attachment purpose for tool-result images (no migration): same owner, cap, purge,
  request path and replay; the purpose means "an image a tool showed the agent".
- At most 10 stored images per result: bounds the work one result can cause; the rest are named.
- A store failure does not fail the call: the tool already ran (it may have had effects); the text
  says the image was not stored.
- No vision-purpose call for extension images on a model without vision: that is a billed call per
  screenshot the agent did not ask for; the placeholder names the `Read file_id` way.
- Thumbnails live in the row's expanded OUT section, not always visible: the row is a record; the
  explicit hand-over is `Deliver`.

## AGENTS.md rules touched

- **Runtime and replay:** new model-visible text (the image lines in `tool_result.content`, the
  labels and placeholders after tool results) is fully derived from the log (`tool_result.media`,
  `toolKey`); no new `DriftReason`; the zero-drift tests cover an extension tool's image on a vision
  and a non-vision model.
- **Tools:** `Deliver` gains `file_id`, description and errors in English and actionable; tool
  results with images now carry `file_id`s.
- **Object storage / multi-replica:** storage follows `storeRead` (intent row in its own
  transaction, put, bind); no process memory.
- **Web UI:** the tool row's detail gains thumbnails (design package component, no page styles).
- No AGENTS.md text changes.
