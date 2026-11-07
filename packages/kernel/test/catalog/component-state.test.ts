import { describe, expect, it } from "vitest";
import {
  type ComponentScopeFacts,
  componentLocked,
  componentOffered,
  componentOn,
  definitionRefs,
  type PluginFacts,
} from "../../src/catalog/component-state.js";

/** Plugin scope phase 2, Task 6: the component scope predicates (no database). */

const comp = (o: Partial<ComponentScopeFacts> = {}): ComponentScopeFacts => ({
  scopeMode: "follow",
  scope: "optional",
  disabled: false,
  itemId: "item",
  ...o,
});

const plugin = (o: Partial<PluginFacts> = {}): PluginFacts => ({
  live: true,
  disabled: false,
  builtin: false,
  scope: "optional",
  listed: false,
  installed: true,
  ...o,
});

describe("component scope predicates", () => {
  it("follow: on while the plugin is on in the org (installed or builtin) and the switch is not off", () => {
    expect(componentOn(comp(), plugin(), false, null)).toBe(true);
    expect(componentOn(comp(), plugin(), false, false)).toBe(false);
    expect(componentOn(comp(), plugin({ installed: false }), false, true)).toBe(false);
    expect(componentOn(comp(), plugin({ installed: false, builtin: true }), false, null)).toBe(
      true,
    );
  });

  it("own: its own scope decides, whatever the plugin's install; never with the plugin disabled or deleted", () => {
    const own = (scope: "all" | "optional" | "named") => comp({ scopeMode: "own", scope });
    const off = plugin({ installed: false });
    expect(componentOn(own("all"), off, false, null)).toBe(true);
    expect(componentOn(own("optional"), off, false, null)).toBe(false);
    expect(componentOn(own("optional"), off, false, true)).toBe(true);
    expect(componentOn(own("named"), off, true, null)).toBe(true);
    expect(componentOn(own("named"), off, false, null)).toBe(false);
    expect(componentOn(own("all"), plugin({ disabled: true }), false, null)).toBe(false);
    // the plugin deleted (its catalog item gone): off, like the doc comment of the usable sets says
    expect(componentOn(own("all"), plugin({ live: false }), false, null)).toBe(false);
    expect(componentOn(own("all"), null, false, null)).toBe(false);
    // a component without a plugin
    expect(componentOn({ ...own("all"), itemId: null }, null, false, null)).toBe(true);
    expect(componentOn({ ...own("all"), disabled: true }, off, false, null)).toBe(false);
  });

  it("offered: what an org admin could switch on there", () => {
    expect(componentOffered(comp(), plugin({ installed: false }), false)).toBe(true);
    expect(componentOffered(comp(), plugin({ scope: "named", listed: false }), false)).toBe(false);
    expect(componentOffered(comp(), plugin({ scope: "named", listed: true }), false)).toBe(true);
    expect(componentOffered(comp({ scopeMode: "own", scope: "named" }), plugin(), false)).toBe(
      false,
    );
    expect(componentOffered(comp({ disabled: true }), plugin(), false)).toBe(false);
  });

  it("locked: an effective scope of all (the plugin's when following it)", () => {
    expect(componentLocked(comp(), plugin({ scope: "all" }))).toBe(true);
    expect(componentLocked(comp(), plugin({ builtin: true }))).toBe(true);
    expect(componentLocked(comp(), plugin())).toBe(false);
    expect(componentLocked(comp({ scopeMode: "own", scope: "all" }), plugin())).toBe(true);
    expect(componentLocked(comp({ scopeMode: "own" }), plugin({ scope: "all" }))).toBe(false);
  });

  it("definitionRefs reads selected, pinned and inline sub-agent skills, templates and connectors", () => {
    const refs = definitionRefs({
      tools: [{ kind: "connector", connectorId: "c1", tools: "all" }],
      skills: { orgSkills: ["s1"], pinned: ["s2"] },
      subagents: { templates: ["t1"], inline: [{ name: "x", skills: ["s3"] }] },
    });
    expect([...refs.connectors]).toEqual(["c1"]);
    expect([...refs.skills].sort()).toEqual(["s1", "s2", "s3"]);
    expect([...refs.templates]).toEqual(["t1"]);
    expect(definitionRefs(null).skills.size).toBe(0);
  });
});
