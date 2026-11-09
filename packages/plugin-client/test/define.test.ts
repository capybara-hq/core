import { describe, expect, it } from "vitest";
import { CLIENT_API_VERSION, defineClientExtension, defineComponent } from "../src/index.js";

describe("define", () => {
  it("defineClientExtension stamps the api version", () => {
    const ext = defineClientExtension({ name: "demo" });
    expect(ext.apiVersion).toBe(CLIENT_API_VERSION);
    expect(ext.apiVersion).toBe(1);
    expect(ext.name).toBe("demo");
  });

  it("defineComponent keeps the slot", () => {
    const render = () => null;
    const c = defineComponent("shell.overlay", render);
    expect(c.slot).toBe("shell.overlay");
    expect(c.render).toBe(render);
  });
});
