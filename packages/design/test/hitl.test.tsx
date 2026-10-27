import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalBlock,
  type ApprovalBlockProps,
  approvalArgs,
  ConnectBlock,
  DesignProvider,
  QuestionBlock,
  type QuestionField,
  QueuedMessage,
  QueuePaused,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const pending = (over: Partial<ApprovalBlockProps> = {}): ApprovalBlockProps => ({
  tool: "Acme 工单: 发送消息",
  toolKey: "acme_tickets__send_message",
  input: { text: "你好", channel: "#示例-支持", notify_all: true },
  keyArgs: ["channel"],
  scopes: ["once", "session", "always"],
  policy: "策略：发消息需审批",
  state: { kind: "pending" },
  onApprove: () => {},
  onDeny: () => {},
  ...over,
});

describe("ApprovalBlock (§6.16.11)", () => {
  it("offers only the scopes the request allows", () => {
    wrap(<ApprovalBlock {...pending({ scopes: ["once"] })} />);
    expect(screen.getByRole("button", { name: "批准" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "本会话内都批准" })).toBeNull();
    expect(screen.queryByRole("button", { name: "总是批准" })).toBeNull();
  });

  it("renders one approve button per scope and passes the scope", async () => {
    const onApprove = vi.fn();
    wrap(<ApprovalBlock {...pending({ onApprove })} />);
    expect(screen.getByRole("button", { name: "批准" }).getAttribute("data-variant")).toBe(
      "primary",
    );
    await userEvent.click(screen.getByRole("button", { name: "本会话内都批准" }));
    await userEvent.click(screen.getByRole("button", { name: "总是批准" }));
    expect(onApprove.mock.calls).toEqual([["session"], ["always"]]);
  });

  it("is the accent-outlined group and always shows the model-visible key", () => {
    const { container } = wrap(<ApprovalBlock {...pending()} />);
    const card = container.querySelector('[data-part="approval-block"]');
    expect(card?.getAttribute("role")).toBe("group");
    expect(card?.getAttribute("data-pending")).toBe("true");
    expect(container.querySelector('[data-part="tool-key"]')?.textContent).toBe(
      "acme_tickets__send_message",
    );
    expect(screen.getByText("策略：发消息需审批").getAttribute("data-part")).toBe("card-note");
  });

  it("lists every argument, the key arguments first, non-strings as compact JSON", () => {
    expect(
      approvalArgs({ text: "hi", channel: "#c", n: { a: [1, 2] }, b: true, z: null }, [
        "channel",
        "missing",
      ]),
    ).toEqual([
      ["channel", "#c"],
      ["text", "hi"],
      ["n", '{"a":[1,2]}'],
      ["b", "true"],
      ["z", "null"],
    ]);
    const { container } = wrap(<ApprovalBlock {...pending()} />);
    const keys = [...container.querySelectorAll('[data-part="kv-key"]')].map((e) => e.textContent);
    expect(keys).toEqual(["channel", "text", "notify_all"]);
  });

  it("opens the whole input as JSON in place, and says when there are no arguments", async () => {
    wrap(<ApprovalBlock {...pending()} />);
    await userEvent.click(screen.getByRole("button", { name: "查看完整输入" }));
    const json = screen.getByText(/"notify_all": true/);
    expect(json.tagName).toBe("PRE");
    cleanup();
    wrap(<ApprovalBlock {...pending({ input: {} })} />);
    expect(screen.getByText("无参数")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "查看完整输入" })).toBeNull();
  });

  it("Deny… asks for an optional reason the model sees", async () => {
    const onDeny = vi.fn();
    wrap(<ApprovalBlock {...pending({ onDeny })} />);
    await userEvent.click(screen.getByRole("button", { name: "拒绝…" }));
    expect(screen.queryByRole("button", { name: "批准" })).toBeNull();
    expect(screen.getByText("原因会写入会话，模型能看到")).toBeTruthy();
    await userEvent.type(screen.getByRole("textbox", { name: "拒绝原因" }), "太危险");
    const deny = screen.getByRole("button", { name: "拒绝" });
    expect(deny.getAttribute("data-variant")).toBe("danger");
    await userEvent.click(deny);
    expect(onDeny).toHaveBeenCalledWith("太危险");
  });

  it("Deny with an empty reason passes none; Cancel goes back", async () => {
    const onDeny = vi.fn();
    wrap(<ApprovalBlock {...pending({ onDeny })} />);
    await userEvent.click(screen.getByRole("button", { name: "拒绝…" }));
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "批准" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "拒绝…" }));
    await userEvent.type(screen.getByRole("textbox", { name: "拒绝原因" }), "   ");
    await userEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(onDeny).toHaveBeenCalledWith(undefined);
  });

  it("disables the actions while busy", () => {
    wrap(<ApprovalBlock {...pending({ state: { kind: "pending", busy: true } })} />);
    expect((screen.getByRole("button", { name: "批准" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "拒绝…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("collapses to one line naming who, the tool, its key, the scope and when", () => {
    const { container } = wrap(
      <ApprovalBlock
        {...pending({
          state: {
            kind: "decided",
            decision: "approved",
            who: "grant",
            when: "10:32",
            scope: "once",
          },
        })}
      />,
    );
    const line = container.querySelector('[data-part="tool-line"]');
    expect(line?.textContent).toBe(
      "grant 批准了 Acme 工单: 发送消息 acme_tickets__send_message · 仅这一次 · 10:32",
    );
    expect(container.querySelector('[data-part="approval-block"]')).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a denial names the reason", () => {
    const { container } = wrap(
      <ApprovalBlock
        {...pending({
          state: {
            kind: "decided",
            decision: "denied",
            who: "grant",
            when: "10:35",
            reason: "先别写",
          },
        })}
      />,
    );
    expect(container.querySelector('[data-part="tool-line"]')?.textContent).toBe(
      "grant 拒绝了 Acme 工单: 发送消息 acme_tickets__send_message · 「先别写」 · 10:35",
    );
  });

  it("speaks English", () => {
    wrap(<ApprovalBlock {...pending()} />, "en");
    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve for this conversation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny…" })).toBeTruthy();
  });
});

const choice: QuestionField = {
  key: "category",
  label: "类别",
  kind: "enum",
  options: ["服务费", "办公租金"],
  allowOther: true,
  required: true,
};

describe("QuestionBlock (§6.16.12)", () => {
  it("answers with the picked option", async () => {
    const onAnswer = vi.fn();
    const { container } = wrap(
      <QuestionBlock
        title="保留哪一个类别？"
        fields={[choice]}
        state={{ kind: "pending" }}
        onAnswer={onAnswer}
        onSkip={() => {}}
      />,
    );
    expect(screen.getByRole("group", { name: "保留哪一个类别？" })).toBeTruthy();
    expect(container.querySelector('[data-part="question-title"]')?.textContent).toBe(
      "保留哪一个类别？",
    );
    await userEvent.click(screen.getByRole("radio", { name: "办公租金" }));
    expect(
      container.querySelector('[data-part="option"][aria-checked="true"]')?.textContent,
    ).toContain("办公租金");
    await userEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(onAnswer).toHaveBeenCalledWith({ category: "办公租金" });
  });

  it("offers Other with free text when allowOther", async () => {
    const onAnswer = vi.fn();
    wrap(
      <QuestionBlock
        title="保留哪一个类别？"
        fields={[choice]}
        state={{ kind: "pending" }}
        onAnswer={onAnswer}
      />,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "其他" }), "差旅费");
    expect(
      (screen.getByRole("radio", { name: /其他/ }) as HTMLElement).getAttribute("aria-checked"),
    ).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(onAnswer).toHaveBeenCalledWith({ category: "差旅费" });
  });

  it("m12: the Other text box is not inside the radio (whose children are presentational)", async () => {
    wrap(
      <QuestionBlock
        title="保留哪一个类别？"
        fields={[choice]}
        state={{ kind: "pending" }}
        onAnswer={() => {}}
      />,
    );
    const box = screen.getByRole("textbox", { name: "其他" });
    expect(box.closest('[role="radio"]')).toBeNull();
    const other = screen.getByRole("radio", { name: /其他/ });
    await userEvent.click(other);
    expect(other.getAttribute("aria-checked")).toBe("true");
  });

  it("no Other row without allowOther; a required field must be filled", async () => {
    const onAnswer = vi.fn();
    wrap(
      <QuestionBlock
        title="保留哪一个类别？"
        fields={[{ ...choice, allowOther: false }]}
        state={{ kind: "pending" }}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.queryByRole("textbox", { name: "其他" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText("必填")).toBeTruthy();
  });

  it("multi-select fields use checkboxes and answer a list", async () => {
    const onAnswer = vi.fn();
    wrap(
      <QuestionBlock
        title="选几个"
        fields={[{ key: "k", label: "k", kind: "multi", options: ["a", "b", "c"] }]}
        state={{ kind: "pending" }}
        onAnswer={onAnswer}
      />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "a" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "c" }));
    await userEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(onAnswer).toHaveBeenCalledWith({ k: ["a", "c"] });
  });

  it("text, number and boolean fields", async () => {
    const onAnswer = vi.fn();
    wrap(
      <QuestionBlock
        title="填表"
        fields={[
          { key: "name", label: "名称", kind: "string" },
          { key: "n", label: "数量", kind: "number" },
          { key: "ok", label: "确认", kind: "boolean" },
        ]}
        state={{ kind: "pending" }}
        onAnswer={onAnswer}
      />,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "名称" }), "Acme");
    await userEvent.type(screen.getByRole("spinbutton", { name: "数量" }), "3");
    await userEvent.click(screen.getByRole("switch", { name: "确认" }));
    await userEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(onAnswer).toHaveBeenCalledWith({ name: "Acme", n: 3, ok: true });
  });

  it("shows the full URL as a link that opens in a new tab", () => {
    const url = "https://portal.acme.example/oauth/consent?session=7f3a2c&very=long";
    wrap(
      <QuestionBlock
        title="需要你在浏览器里确认授权"
        url={url}
        fields={[]}
        state={{ kind: "pending" }}
        onSkip={() => {}}
      />,
    );
    const link = screen.getByRole("link", { name: url });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("data-part")).toBe("question-url");
    expect(screen.getByRole("link", { name: "打开链接" }).getAttribute("href")).toBe(url);
    expect(screen.getByText("完成后回到这里继续")).toBeTruthy();
  });

  it("never links a non-http(s) URL", () => {
    wrap(
      <QuestionBlock title="t" url="javascript:alert(1)" fields={[]} state={{ kind: "pending" }} />,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("collapses to the question and the answer pairs", () => {
    const { container } = wrap(
      <QuestionBlock
        title="保留哪一个类别？"
        fields={[choice]}
        state={{ kind: "answered", pairs: [["类别", "服务费"]], who: "grant" }}
      />,
    );
    const lines = [...container.querySelectorAll('[data-part="tool-line"]')].map(
      (l) => l.textContent,
    );
    expect(lines).toEqual(["保留哪一个类别？", "服务费 · grant"]);
    cleanup();
    const two = wrap(
      <QuestionBlock
        title="填表"
        fields={[]}
        state={{
          kind: "answered",
          pairs: [
            ["名称", "Acme"],
            ["数量", "3"],
          ],
        }}
      />,
    );
    expect(two.container.textContent).toContain("名称：Acme");
    expect(two.container.textContent).toContain("数量：3");
  });

  it("skipped and expired", () => {
    const { container } = wrap(
      <QuestionBlock title="q" fields={[]} state={{ kind: "skipped", who: "grant" }} />,
    );
    expect(container.textContent).toContain("已跳过 · grant");
    cleanup();
    const e = wrap(<QuestionBlock title="q" fields={[]} state={{ kind: "expired" }} />);
    expect(e.container.textContent).toContain("已过期");
  });
});

describe("ConnectBlock (§6.16.13)", () => {
  it("names the service and why, says it only affects you, and connects", async () => {
    const onConnect = vi.fn();
    const { container } = wrap(
      <ConnectBlock service="Acme 文档" reason="连接 Acme 文档 后才能读取" onConnect={onConnect} />,
    );
    expect(container.querySelector('[data-part="connect-initial"]')?.textContent).toBe("A");
    expect(screen.getByText("只影响你")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "连接" }));
    expect(onConnect).toHaveBeenCalled();
  });

  it("closed is one line", () => {
    const { container } = wrap(
      <ConnectBlock service="Acme 文档" reason="r" closed={{ who: "grant", when: "10:36" }} />,
    );
    expect(container.querySelector('[data-part="tool-line"]')?.textContent).toBe(
      "grant 已连接 Acme 文档 · 10:36",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("QueuedMessage (§6.16.14)", () => {
  const handlers = () => ({
    onCopy: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onSendNow: vi.fn(),
  });

  it("is a dashed bubble with named actions", async () => {
    const h = handlers();
    const { container } = wrap(<QueuedMessage text="再按收款人汇总" {...h} />);
    expect(container.querySelector('[data-part="bubble"]')?.getAttribute("data-queued")).toBe(
      "true",
    );
    expect(screen.getByText("排队中").getAttribute("data-part")).toBe("queued-label");
    for (const name of ["复制", "编辑", "删除"]) {
      expect(screen.getByRole("button", { name }).getAttribute("data-part")).toBe("icon-button");
    }
    await userEvent.click(screen.getByRole("button", { name: "立即发送" }));
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(h.onSendNow).toHaveBeenCalled();
    expect(h.onDelete).toHaveBeenCalled();
  });

  it("edits in place", async () => {
    const h = handlers();
    const onSave = vi.fn();
    const onCancelEdit = vi.fn();
    wrap(
      <QueuedMessage
        text="顺便把 PDF 也重新生成"
        editing
        onSave={onSave}
        onCancelEdit={onCancelEdit}
        {...h}
      />,
    );
    const box = screen.getByRole("textbox", { name: "编辑排队消息" });
    expect((box as HTMLTextAreaElement).value).toBe("顺便把 PDF 也重新生成");
    await userEvent.type(box, "一下");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSave).toHaveBeenCalledWith("顺便把 PDF 也重新生成一下");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancelEdit).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "立即发送" })).toBeNull();
  });

  it("paused: bubbles without actions, then one line to continue", async () => {
    const onContinue = vi.fn();
    wrap(
      <>
        <QueuedMessage text="a" paused {...handlers()} />
        <QueuePaused count={2} onContinue={onContinue} />
      </>,
    );
    expect(screen.queryByRole("button", { name: "立即发送" })).toBeNull();
    const line = screen.getByText("运行已停止，队列已暂停（2 条）");
    expect(line.getAttribute("data-part")).toBe("queued-paused");
    await userEvent.click(screen.getByRole("button", { name: "继续发送" }));
    expect(onContinue).toHaveBeenCalled();
  });

  it("a queued skill invocation shows its chip before the arguments", () => {
    const { container } = wrap(<QueuedMessage text="9" skill="/fix-issue" {...handlers()} />);
    const b = container.querySelector('[data-part="bubble"]') as Element;
    expect(b.querySelector('[data-part="bubble-skill"]')?.textContent).toBe("/fix-issue");
    expect(b.textContent).toBe("/fix-issue9");
  });

  it("paused for a reason: the reason replaces the default line", () => {
    wrap(<QueuePaused count={1} text="技能已不可用，队列已暂停" onContinue={vi.fn()} />);
    expect(screen.getByText("技能已不可用，队列已暂停").getAttribute("data-part")).toBe(
      "queued-paused",
    );
    expect(screen.queryByText(/运行已停止/)).toBeNull();
  });

  it("speaks English", () => {
    wrap(<QueuedMessage text="a" {...handlers()} />, "en");
    const actions = screen.getByText("Queued").parentElement as HTMLElement;
    for (const name of ["Copy", "Edit", "Delete", "Send now"]) {
      expect(within(actions).getByRole("button", { name })).toBeTruthy();
    }
  });
});
