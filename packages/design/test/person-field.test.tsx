import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalBlock, DesignProvider, PersonFieldRow } from "../src/index";
import { findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement) => render(<DesignProvider locale="en">{ui}</DesignProvider>);

describe("PersonFieldRow", () => {
  it("renders a masked, non-autofilled input with its label", () => {
    wrap(<PersonFieldRow label="API key" multiline={false} value="" onChange={() => {}} />);
    const el = screen.getByLabelText("API key") as HTMLInputElement;
    expect(el.type).toBe("password");
    expect(el.getAttribute("autocomplete")).toBe("off");
  });

  it("renders a multiline field as a textarea", () => {
    wrap(<PersonFieldRow label="Key" multiline value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Key").tagName).toBe("TEXTAREA");
  });

  it("fires onChange", async () => {
    const onChange = vi.fn();
    wrap(<PersonFieldRow label="API key" multiline={false} value="" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("API key"), "a");
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("shows the error with aria-invalid", () => {
    wrap(
      <PersonFieldRow
        label="API key"
        multiline={false}
        value="x"
        error="Too long"
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Too long")).toBeTruthy();
    expect(screen.getByLabelText("API key").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("ApprovalBlock person fields", () => {
  it("renders one row per field inside the card without nested boxes", () => {
    wrap(
      <ApprovalBlock
        tool="Platform: set config"
        toolKey="platform__set"
        input={{ target: "x" }}
        scopes={["once"]}
        state={{ kind: "pending" }}
        personTarget="Acme"
        personFields={[
          { path: "apiKey", label: "API key", multiline: false, value: "", onChange: () => {} },
          {
            path: "cert",
            label: "Certificate",
            multiline: true,
            value: "",
            onChange: () => {},
            error: "Bad",
          },
        ]}
      />,
    );
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.getByLabelText("Certificate")).toBeTruthy();
    expect(document.querySelectorAll('[data-part="person-field"]').length).toBe(2);
    expect(findNestedBoxes(document.body)).toEqual([]);
  });
});
