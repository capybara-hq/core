import { defineExtension, type InputForm } from "@capybara-hq/plugin-sdk";

/**
 * Test extension for the profile step (profiles govern every approval): three tools whose asks
 * are addressed to the conversation's person.
 * - `ask` (default policy ask): returns `noted: <note>`;
 * - `interactive` (`requiresUserInteraction`, a fixed ask): returns `interacted: <note>`;
 * - `form` (default policy ask): asks the user for a size first, then returns `size: <answer>`.
 */

const SCHEMA = {
  type: "object",
  properties: { note: { type: "string", description: "A short note." } },
  additionalProperties: false,
};

const SIZE_FORM: InputForm = {
  title: "Pick a size",
  fields: [
    { key: "size", label: "Size", schema: { type: "string", enum: ["s", "l"] }, required: true },
  ],
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const noteOf = (input: unknown) => String((input as { note?: unknown } | null)?.note ?? "");

export default defineExtension({
  name: "profile-tools",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { tools: ["ask", "interactive", "form"] },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "ask",
        description: "Record a note. Test fixture only.",
        inputSchema: SCHEMA,
        defaultPolicy: "ask",
      },
      async (input) => text(`noted: ${noteOf(input)}`),
    );
    ctx.tools.register(
      {
        name: "interactive",
        description: "Record a note the user must confirm. Test fixture only.",
        inputSchema: SCHEMA,
        annotations: { requiresUserInteraction: true },
      },
      async (input) => text(`interacted: ${noteOf(input)}`),
    );
    ctx.tools.register(
      {
        name: "form",
        description: "Ask the user for a size, then report it. Test fixture only.",
        inputSchema: SCHEMA,
        defaultPolicy: "ask",
      },
      async (_input, tctx) =>
        tctx.resume === undefined
          ? { kind: "input_required", form: SIZE_FORM, state: { asked: true } }
          : text(`size: ${String(tctx.resume.answer?.size ?? "none")}`),
    );
  },
});
