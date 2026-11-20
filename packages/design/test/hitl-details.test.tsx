import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalBlock,
  type ApprovalBlockProps,
  DesignProvider,
  middleClip,
  WORKING_ROOT_MAX,
} from "../src/index";
import { findNestedBoxes } from "../src/reference/index";

// The details a pending approval carries inside its card (design spec §6.16.11, "Details inside
// the card", maintainer decision 2026-11-21): the reason, the facts, the working root and notes.

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const ROOT = "/Users/grant/Projects/acme-ledger/services/reconciliation-worker/packages/importer";

const escalation = (over: Partial<ApprovalBlockProps> = {}): ApprovalBlockProps => ({
  tool: "Bash",
  toolKey: "Bash",
  input: {},
  scopes: ["once"],
  command: {
    kind: "command",
    command: "docker compose up -d postgres",
    reason: "runs outside the sandbox",
    lead: "智能体想让这条命令在沙箱外运行一次。",
  },
  reason: { text: "沙箱里没有 Docker 套接字。\n启动后我再回到沙箱里。" },
  workingRoot: ROOT,
  scopeHints: { once: "仅这一次调用；下次仍在沙箱内运行" },
  notes: ["批准后会启动一个后台进程。"],
  state: { kind: "pending" },
  onApprove: () => {},
  onDeny: () => {},
  ...over,
});

const part = (root: ParentNode, name: string) => root.querySelector(`[data-part="${name}"]`);

/** The props without some keys (exact optional props take no `undefined`). */
const without = (p: ApprovalBlockProps, ...keys: (keyof ApprovalBlockProps)[]) =>
  Object.fromEntries(
    Object.entries(p).filter(([k]) => !keys.includes(k as keyof ApprovalBlockProps)),
  ) as ApprovalBlockProps;

describe("middleClip", () => {
  it("keeps a short path and clips a long one in the middle to the limit", () => {
    expect(middleClip("/work/app")).toBe("/work/app");
    const clipped = middleClip(ROOT);
    expect(Array.from(clipped)).toHaveLength(WORKING_ROOT_MAX);
    expect(clipped.startsWith("/Users/grant/")).toBe(true);
    expect(clipped.endsWith("packages/importer")).toBe(true);
    expect(clipped).toContain("…");
  });
});

describe("ApprovalBlock: details inside the pending card", () => {
  it("leads with the reason, attributed, before the lead and the command", () => {
    const { container } = wrap(<ApprovalBlock {...escalation()} />);
    const card = part(container, "approval-block");
    const reason = part(card as Element, "reason");
    expect(part(reason as Element, "reason-label")?.textContent).toBe("智能体的理由");
    // plain text, every line kept, never clipped
    expect(part(reason as Element, "reason-text")?.textContent).toBe(
      "沙箱里没有 Docker 套接字。\n启动后我再回到沙箱里。",
    );
    const order = [...(card?.querySelectorAll("[data-part]") ?? [])]
      .map((e) => e.getAttribute("data-part"))
      .filter((p) => ["reason", "command-reason", "working-root", "code-block"].includes(p ?? ""));
    expect(order).toEqual(["reason", "command-reason", "working-root", "code-block"]);
  });

  it("a caller's label replaces the default attribution; English has its own", () => {
    const { container, unmount } = wrap(
      <ApprovalBlock {...escalation({ reason: { text: "x", label: "Why" } })} />,
    );
    expect(part(container, "reason-label")?.textContent).toBe("Why");
    unmount();
    const en = wrap(<ApprovalBlock {...escalation()} />, "en");
    expect(part(en.container, "reason-label")?.textContent).toBe("Agent's reason");
  });

  it("names the working root in one line, middle-truncated, the full path as its title", () => {
    const { container } = wrap(<ApprovalBlock {...escalation()} />);
    const line = part(container, "working-root");
    const path = part(line as Element, "working-root-path");
    expect(path?.getAttribute("title")).toBe(ROOT);
    expect(path?.textContent).toBe(middleClip(ROOT));
    expect(line?.textContent).toBe(`在 ${middleClip(ROOT)} 运行`);
    cleanup();
    const en = wrap(<ApprovalBlock {...escalation({ workingRoot: "/work/app" })} />, "en");
    expect(part(en.container, "working-root")?.textContent).toBe("Runs in /work/app");
  });

  it("keeps the buttons adjacent and puts the hint, then the notes, under the action row", () => {
    const { container } = wrap(<ApprovalBlock {...escalation()} />);
    const once = screen.getByRole("button", { name: "允许一次" });
    const deny = screen.getByRole("button", { name: "拒绝" });
    // siblings in one row: no hint column widens the allow button
    expect(once.parentElement).toBe(deny.parentElement);
    expect(once.nextElementSibling).toBe(deny);
    expect(part(container, "scope-choice")).toBeNull();
    const row = once.parentElement as HTMLElement;
    const hint = part(container, "scope-hint");
    expect(row.contains(hint)).toBe(false);
    expect(hint?.textContent).toBe("仅这一次调用；下次仍在沙箱内运行");
    const note = part(container, "card-hint");
    expect(note?.textContent).toBe("批准后会启动一个后台进程。");
    // row, hint, note: in this order, all children of the card
    const card = part(container, "approval-block") as HTMLElement;
    const kids = [...card.children];
    expect(kids.indexOf(row)).toBeLessThan(kids.indexOf(hint as Element));
    expect(kids.indexOf(hint as Element)).toBeLessThan(kids.indexOf(note as Element));
  });

  it("a tool approval with several hinted scopes names each button in its hint line", () => {
    const { container } = wrap(
      <ApprovalBlock
        {...without(
          escalation({
            tool: "Acme: send",
            toolKey: "acme__send",
            input: { text: "hi" },
            scopes: ["once", "session"],
            scopeHints: { once: "只这一次", session: "直到会话结束" },
          }),
          "command",
        )}
      />,
    );
    const once = screen.getByRole("button", { name: "批准" });
    expect(once.nextElementSibling?.textContent).toBe("本会话内都批准");
    expect(
      [...container.querySelectorAll('[data-part="scope-hint"]')].map((e) => e.textContent),
    ).toEqual(["批准 · 只这一次", "本会话内都批准 · 直到会话结束"]);
  });

  it("the deny form hides the hint and the notes; cancelling brings them back", async () => {
    const { container } = wrap(<ApprovalBlock {...escalation()} />);
    await userEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(part(container, "card-hint")).toBeNull();
    expect(part(container, "scope-hint")).toBeNull();
    // the reason stays: the person denies knowing why it was asked
    expect(part(container, "reason")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(part(container, "card-hint")).not.toBeNull();
  });

  it("lists the facts above the command, every value on its own line, empty facts dropped", () => {
    const { container } = wrap(
      <ApprovalBlock
        {...without(
          escalation({
            facts: [
              { label: "读写", values: ["/work/data"] },
              { label: "只读", values: ["/home/a", "/home/a"] },
              { label: "网络主机", values: [] },
            ],
          }),
          "reason",
          "workingRoot",
        )}
      />,
    );
    const facts = part(container, "facts");
    expect(
      [...(facts?.querySelectorAll('[data-part="fact-label"]') ?? [])].map((e) => e.textContent),
    ).toEqual(["读写", "只读"]);
    // an exact list keeps a repeated value
    expect(
      [...(facts?.querySelectorAll('[data-part="fact-value"]') ?? [])].map((e) => e.textContent),
    ).toEqual(["/work/data", "/home/a", "/home/a"]);
    const parts = [...container.querySelectorAll("[data-part]")].map((e) =>
      e.getAttribute("data-part"),
    );
    expect(parts.indexOf("facts")).toBeLessThan(parts.indexOf("code-block"));
    expect(part(container, "reason")).toBeNull();
    expect(part(container, "working-root")).toBeNull();
  });

  it("a tool approval carries them too: the reason first, the facts above the arguments", () => {
    const { container } = wrap(
      <ApprovalBlock
        {...without(
          escalation({
            tool: "Acme: send",
            toolKey: "acme__send",
            input: { text: "hi" },
            scopes: ["once", "session"],
            facts: [{ label: "Target", values: ["#support"] }],
          }),
          "command",
        )}
      />,
    );
    const parts = [...container.querySelectorAll("[data-part]")].map((e) =>
      e.getAttribute("data-part"),
    );
    expect(parts.indexOf("reason")).toBeLessThan(parts.indexOf("facts"));
    expect(parts.indexOf("facts")).toBeLessThan(parts.indexOf("kv"));
  });

  it("draws no box inside the card", () => {
    const { container } = wrap(
      <ApprovalBlock {...escalation({ facts: [{ label: "读写", values: ["/work/data"] }] })} />,
    );
    expect(findNestedBoxes(container)).toEqual([]);
  });
});

describe("ApprovalBlock: decided, the details are gone", () => {
  const decided = (decision: "approved" | "denied") =>
    escalation({
      decidedNote: "在沙箱外运行",
      facts: [{ label: "读写", values: ["/work/data"] }],
      state: { kind: "decided", decision, scope: "once", who: "你", when: "23:56" },
    });

  it("an allowed command ask is one line with the crossing phrase, who and when", () => {
    const { container } = wrap(<ApprovalBlock {...decided("approved")} />);
    const line = part(container, "tool-line");
    expect(line?.textContent).toBe("已允许（一次） Bash · 在沙箱外运行 · 你 · 23:56");
    for (const p of ["reason", "working-root", "facts", "card-hint", "approval-block"])
      expect(part(container, p)).toBeNull();
  });

  it("a denied one keeps the phrase and drops every detail", () => {
    const { container } = wrap(<ApprovalBlock {...decided("denied")} />);
    expect(part(container, "tool-line")?.textContent).toBe(
      "已拒绝 Bash · 在沙箱外运行 · 你 · 23:56",
    );
    expect(part(container, "reason")).toBeNull();
  });

  it("a tool approval's approved line names the phrase after the key", () => {
    const { container } = wrap(
      <ApprovalBlock
        {...without(decided("approved"), "command")}
        tool="Acme: send"
        toolKey="acme__send"
      />,
    );
    expect(part(container, "tool-key")?.textContent).toBe(
      "acme__send · 在沙箱外运行 · 仅这一次 · 23:56",
    );
  });
});
