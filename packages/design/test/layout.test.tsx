import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card, Grid, Stack, Text } from "../src/index.js";

describe("布局原语", () => {
  it("Text truncate 的 title 等于其文本", () => {
    render(<Text truncate>很长很长的名称</Text>);
    expect(screen.getByText("很长很长的名称").getAttribute("title")).toBe("很长很长的名称");
  });

  it("Text 默认 body，可换元素", () => {
    render(
      <Text as="h2" variant="h2" tone="muted">
        标题
      </Text>,
    );
    const el = screen.getByText("标题");
    expect(el.tagName).toBe("H2");
    expect(el.getAttribute("data-variant")).toBe("h2");
    expect(el.getAttribute("data-tone")).toBe("muted");
  });

  it("Stack / Grid / Card 暴露属性", () => {
    render(
      <Stack gap={12} direction="row">
        <Grid columns="form">
          <Card title="卡片" actions={<span>操作</span>} tone="danger">
            内容
          </Card>
        </Grid>
      </Stack>,
    );
    expect(screen.getByText("内容").closest("[data-tone]")?.getAttribute("data-tone")).toBe(
      "danger",
    );
    expect(screen.getByText("卡片")).toBeTruthy();
    expect(screen.getByText("操作")).toBeTruthy();
    expect(document.querySelector("[data-direction='row']")?.getAttribute("data-gap")).toBe("12");
    expect(document.querySelector("[data-columns='form']")).toBeTruthy();
  });
});
afterEach(cleanup);
