/**
 * What the conversation page's right area shows (spec §5.1: one thing at a time), kept in the URL
 * hash so a reload keeps it: `#properties`, `#panel=<plugin>/<contribution>[/<item>]`,
 * `#file=<fileId>`, `#output=<callId>`, `#subagent=<id>` or `#bg-<taskId>` (a background task's
 * output, background Bash spec §5). The agent map's dialog (agent map spec §9) is kept here too:
 * `#agents` (the tree), `#agents=<id>` (one agent), `#agents=<id>/transcript` (its transcript).
 */
export type RightTarget =
  | { kind: "properties" }
  | { kind: "panel"; plugin: string; contribution: string; item?: string }
  | { kind: "file"; id: string }
  | { kind: "output"; callId: string }
  | { kind: "subagent"; id: string }
  | { kind: "background"; taskId: string }
  | { kind: "agents"; id?: string; transcript?: boolean };

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/** The target of a location hash (with or without `#`), or null. */
export function parseRightHash(hash: string): RightTarget | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (h === "properties") return { kind: "properties" };
  if (h === "agents") return { kind: "agents" };
  if (h.startsWith("bg-")) {
    const id = dec(h.slice(3));
    return id ? { kind: "background", taskId: id } : null;
  }
  const eq = h.indexOf("=");
  if (eq < 0) return null;
  const key = h.slice(0, eq);
  const value = h.slice(eq + 1);
  if (value === "") return null;
  if (key === "panel") {
    const parts = value.split("/").map(dec);
    const [plugin, contribution, item] = parts;
    if (parts.length < 2 || parts.length > 3 || !plugin || !contribution || parts.includes(null))
      return null;
    return { kind: "panel", plugin, contribution, ...(item ? { item } : {}) };
  }
  if (key === "agents") {
    const [raw, rest, ...more] = value.split("/");
    const id = dec(raw ?? "");
    if (!id || more.length > 0 || (rest !== undefined && rest !== "transcript")) return null;
    return { kind: "agents", id, ...(rest === "transcript" ? { transcript: true } : {}) };
  }
  const v = dec(value);
  if (v === null || v === "") return null;
  if (key === "file") return { kind: "file", id: v };
  if (key === "output") return { kind: "output", callId: v };
  if (key === "subagent") return { kind: "subagent", id: v };
  return null;
}

/** The hash (with `#`) of a target; "" for none. */
export function formatRightHash(t: RightTarget | null): string {
  if (t === null) return "";
  const e = encodeURIComponent;
  switch (t.kind) {
    case "properties":
      return "#properties";
    case "panel":
      return `#panel=${e(t.plugin)}/${e(t.contribution)}${t.item ? `/${e(t.item)}` : ""}`;
    case "file":
      return `#file=${e(t.id)}`;
    case "output":
      return `#output=${e(t.callId)}`;
    case "subagent":
      return `#subagent=${e(t.id)}`;
    case "background":
      return `#bg-${e(t.taskId)}`;
    case "agents":
      return t.id === undefined
        ? "#agents"
        : `#agents=${e(t.id)}${t.transcript ? "/transcript" : ""}`;
  }
}
