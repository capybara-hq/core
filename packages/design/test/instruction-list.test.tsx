import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, InstructionList } from "../src/index";

afterEach(cleanup);

describe("InstructionList", () => {
  it("numbers the steps; a backtick pair is inline code and nothing else is markup", () => {
    const { container } = render(
      <DesignProvider locale="zh">
        <InstructionList
          label="接入步骤"
          items={["Open `https://api.slack.com/apps`.", "<b>bold</b> [link](https://x.example)"]}
        />
      </DesignProvider>,
    );
    const list = screen.getByRole("list", { name: "接入步骤" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe("1Open https://api.slack.com/apps.");
    expect(container.querySelector('[data-part="inline-code"]')?.textContent).toBe(
      "https://api.slack.com/apps",
    );
    // HTML and Markdown stay text
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(items[1]?.textContent).toContain("<b>bold</b> [link](https://x.example)");
  });
});
