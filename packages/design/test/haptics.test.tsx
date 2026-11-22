// Haptics (mobile app spec §6.4): sending a message `light`, an approval granted `success`, a
// destructive confirmation `warning`, a selection change `selection`. Without a handler (the
// browser) nothing happens and nothing throws.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalBlock,
  type ApprovalBlockProps,
  ComposerBox,
  type ComposerBoxProps,
  DangerConfirm,
  DesignProvider,
  type NativeHandlers,
  Segmented,
  Select,
} from "../src/index";
import { LONG_PRESS_MS, useLongPress } from "../src/overlays/long-press";

afterEach(cleanup);

const noop = () => {};
const wrap = (ui: React.ReactElement, native?: NativeHandlers) =>
  render(
    <DesignProvider locale="zh" {...(native ? { native } : {})}>
      {ui}
    </DesignProvider>,
  );

function Pressable({ onLongPress }: { onLongPress: () => void }) {
  const handlers = useLongPress(onLongPress);
  return <div data-testid="row" {...handlers} />;
}

const composer = (onClick: () => void): ComposerBoxProps => ({
  value: "你好",
  onChange: noop,
  placeholder: "消息",
  onAttach: noop,
  pickers: {
    agent: { label: "Agent", value: "Research", groups: [], onPick: noop },
    model: { label: "Model", value: "opus", groups: [], onPick: noop },
  },
  send: { mode: "send", onClick },
});

const approval = (onApprove: () => void): ApprovalBlockProps => ({
  tool: "Acme 工单: 发送消息",
  toolKey: "mcp__acme_tickets__send_message",
  input: { text: "你好" },
  scopes: ["once"],
  state: { kind: "pending" },
  onApprove,
  onDeny: noop,
});

const danger = (onConfirm: () => void) => (
  <DangerConfirm
    open
    onOpenChange={noop}
    title="删除组织"
    description="x"
    confirmName="abc"
    confirmLabel="删除"
    onConfirm={onConfirm}
  />
);

const segmented = (onChange: (v: string) => void) => (
  <Segmented
    label="主题"
    value="dark"
    onChange={onChange}
    options={[
      { value: "dark", label: "深色" },
      { value: "light", label: "浅色" },
    ]}
  />
);

describe("haptics", () => {
  it("composer send: light", async () => {
    const haptics = vi.fn();
    const onClick = vi.fn();
    wrap(<ComposerBox {...composer(onClick)} />, { haptics });
    await userEvent.setup().click(screen.getByRole("button", { name: "发送" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(haptics).toHaveBeenCalledWith("light");
  });

  it("approve: success", async () => {
    const haptics = vi.fn();
    const onApprove = vi.fn();
    wrap(<ApprovalBlock {...approval(onApprove)} />, { haptics });
    await userEvent.setup().click(screen.getByRole("button", { name: "批准" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(haptics).toHaveBeenCalledWith("success");
  });

  it("confirming a destructive dialog: warning", async () => {
    const haptics = vi.fn();
    const onConfirm = vi.fn();
    wrap(danger(onConfirm), { haptics });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "abc");
    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(haptics).toHaveBeenCalledWith("warning");
  });

  it("changing a segmented control or a select: selection, not for the current value", async () => {
    const haptics = vi.fn();
    const onChange = vi.fn();
    wrap(segmented(onChange), { haptics });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "深色" }));
    expect(haptics).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: "浅色" }));
    expect(onChange).toHaveBeenCalledWith("light");
    expect(haptics).toHaveBeenCalledWith("selection");
    cleanup();
    haptics.mockClear();
    wrap(
      <Select
        aria-label="语言"
        options={[
          { value: "zh", label: "中文" },
          { value: "en", label: "English" },
        ]}
      />,
      { haptics },
    );
    await user.click(screen.getByRole("combobox", { name: "语言" }));
    await user.click(await screen.findByRole("option", { name: "English" }));
    expect(haptics).toHaveBeenCalledWith("selection");
  });

  it("without a handler nothing throws", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    wrap(<ComposerBox {...composer(onClick)} />);
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    cleanup();
    const onApprove = vi.fn();
    wrap(<ApprovalBlock {...approval(onApprove)} />);
    await user.click(screen.getByRole("button", { name: "批准" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    cleanup();
    const onChange = vi.fn();
    wrap(segmented(onChange));
    await user.click(screen.getByRole("radio", { name: "浅色" }));
    expect(onChange).toHaveBeenCalledWith("light");
  });

  it("a handler that throws never breaks the action", async () => {
    const haptics = vi.fn(() => {
      throw new Error("no engine");
    });
    const onClick = vi.fn();
    wrap(<ComposerBox {...composer(onClick)} />, { haptics });
    await userEvent.setup().click(screen.getByRole("button", { name: "发送" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  describe("long press opens a sheet: light", () => {
    afterEach(() => vi.useRealTimers());
    const touch = { pointerType: "touch", clientX: 5, clientY: 5 };

    it("the touch timer fires light once; the contextmenu that follows does not repeat it", () => {
      vi.useFakeTimers();
      const haptics = vi.fn();
      const onLongPress = vi.fn();
      wrap(<Pressable onLongPress={onLongPress} />, { haptics });
      const row = screen.getByTestId("row");
      fireEvent.pointerDown(row, touch);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      expect(onLongPress).toHaveBeenCalledTimes(1);
      expect(haptics).toHaveBeenCalledTimes(1);
      expect(haptics).toHaveBeenCalledWith("light");
      fireEvent.contextMenu(row);
      expect(onLongPress).toHaveBeenCalledTimes(1);
      expect(haptics).toHaveBeenCalledTimes(1);
    });

    it("a contextmenu before the timer (Android) fires light once", () => {
      vi.useFakeTimers();
      const haptics = vi.fn();
      wrap(<Pressable onLongPress={vi.fn()} />, { haptics });
      const row = screen.getByTestId("row");
      fireEvent.pointerDown(row, touch);
      fireEvent.contextMenu(row);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      expect(haptics).toHaveBeenCalledTimes(1);
      expect(haptics).toHaveBeenCalledWith("light");
    });

    it("a mouse right click and a short touch give no haptic", () => {
      vi.useFakeTimers();
      const haptics = vi.fn();
      const onLongPress = vi.fn();
      wrap(<Pressable onLongPress={onLongPress} />, { haptics });
      const row = screen.getByTestId("row");
      fireEvent.contextMenu(row);
      expect(onLongPress).toHaveBeenCalledTimes(1);
      fireEvent.pointerDown(row, touch);
      fireEvent.pointerUp(row);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      expect(haptics).not.toHaveBeenCalled();
    });
  });
});
