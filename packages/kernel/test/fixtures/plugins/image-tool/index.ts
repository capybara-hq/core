import { defineExtension } from "@capybara-hq/plugin-sdk";

/**
 * Tool result images (tool result images design §2): `shot` returns a text line and the image
 * blocks its input names (`images`: base64 strings, `mimeType` for all), as a screenshot tool does.
 */
export default defineExtension({
  name: "image-tool",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { tools: ["shot"] },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "shot",
        description: "Return the given images as a screenshot result.",
        inputSchema: {
          type: "object",
          properties: {
            images: { type: "array", items: { type: "string" } },
            mimeType: { type: "string" },
          },
        },
        defaultPolicy: "allow",
      },
      async (input) => {
        const { images = [], mimeType = "image/png" } = input as {
          images?: string[];
          mimeType?: string;
        };
        return {
          content: [
            { type: "text", text: `Screenshot of ${images.length} image(s).` },
            ...images.map((data) => ({ type: "image" as const, data, mimeType })),
          ],
        };
      },
    );
  },
});
