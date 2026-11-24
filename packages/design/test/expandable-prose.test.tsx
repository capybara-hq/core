import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, ExpandableProse } from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement) => render(<DesignProvider locale="en">{ui}</DesignProvider>);

describe("ExpandableProse", () => {
  it("shows the summary with a more button, opens to the whole text with a less button", async () => {
    wrap(
      <ExpandableProse
        summary="First sentence."
        text="First sentence. Second sentence."
        moreLabel="Full description"
        lessLabel="Collapse"
      />,
    );
    const more = screen.getByRole("button", { name: "Full description" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("First sentence.")).toBeTruthy();
    expect(screen.queryByText(/Second sentence/)).toBeNull();
    await userEvent.click(more);
    expect(screen.getByText(/Second sentence/)).toBeTruthy();
    const less = screen.getByRole("button", { name: "Collapse" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(less);
    expect(screen.queryByText(/Second sentence/)).toBeNull();
  });

  it("draws no button when the summary is the whole text", () => {
    wrap(<ExpandableProse summary="Same." text="Same." moreLabel="More" lessLabel="Less" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Same.")).toBeTruthy();
  });
});
