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
    expect(el.getAttribute("autocomplete")).toBe("new-password");
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

describe("person field safety properties", () => {
  const field = {
    path: "apiKey",
    label: "API key",
    multiline: false,
    value: "",
    onChange: () => {},
  };
  const card = (state: React.ComponentProps<typeof ApprovalBlock>["state"]) => (
    <ApprovalBlock
      tool="t"
      toolKey="k"
      input={{}}
      scopes={["once"]}
      state={state}
      personFields={[field]}
    />
  );

  it("has no button in the row (no reveal toggle)", () => {
    wrap(<PersonFieldRow label="API key" multiline={false} value="" onChange={() => {}} />);
    expect(document.querySelectorAll("button").length).toBe(0);
  });

  it("masks the multiline textarea and disables autofill", () => {
    wrap(<PersonFieldRow label="Key" multiline value="" onChange={() => {}} />);
    const el = screen.getByLabelText("Key");
    expect(el.getAttribute("data-masked")).toBe("true");
    expect(el.getAttribute("autocomplete")).toBe("new-password");
  });

  it("links the description with aria-describedby", () => {
    wrap(
      <PersonFieldRow
        label="API key"
        description="From the console"
        multiline={false}
        value=""
        onChange={() => {}}
      />,
    );
    const el = screen.getByLabelText("API key");
    const id = el.getAttribute("aria-describedby") as string;
    expect(document.getElementById(id)?.textContent).toBe("From the console");
  });

  it("disables the inputs while the approval is busy", () => {
    wrap(card({ kind: "pending", busy: true }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).disabled).toBe(true);
  });

  it.each(["approved", "expired"] as const)("renders no inputs once %s", (decision) => {
    wrap(card({ kind: "decided", decision, who: "me", when: "now" }));
    expect(document.querySelectorAll("input, textarea").length).toBe(0);
  });
});

describe("ApprovalBlock secure input", () => {
  const field = (over: Partial<{ path: string; label: string; value: string }> = {}) => ({
    path: "apiKey",
    label: "API key",
    multiline: false,
    value: "",
    onChange: () => {},
    ...over,
  });
  const card = (
    over: Partial<NonNullable<React.ComponentProps<typeof ApprovalBlock>["secureInput"]>> = {},
    state: React.ComponentProps<typeof ApprovalBlock>["state"] = { kind: "pending" },
  ) => (
    <ApprovalBlock
      tool="Platform: set config"
      toolKey="platform__set"
      input={{ target: "x" }}
      scopes={["once"]}
      state={state}
      secureInput={{
        target: "Anthropic: deployment config",
        fields: [field()],
        onSubmit: () => {},
        onCancel: () => {},
        ...over,
      }}
    />
  );

  it("shows the target, the fields, Submit and Cancel, and no scope buttons or arguments", () => {
    wrap(card());
    expect(screen.getByText("Secure input: Anthropic: deployment config")).toBeTruthy();
    expect(
      screen.getByText("The values are saved directly; the agent never sees them."),
    ).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve|Deny/ })).toBeNull();
    expect(document.querySelector('[data-part="kv"]')).toBeNull();
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it("disables Submit while a field is empty or submitDisabled, not Cancel", () => {
    wrap(card());
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    cleanup();
    wrap(card({ fields: [field({ value: "k" })] }));
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    cleanup();
    wrap(card({ fields: [field({ value: "k" })], submitDisabled: true }));
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("calls onSubmit and onCancel", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    wrap(card({ fields: [field({ value: "k" })], onSubmit, onCancel }));
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("reads Submitted / Cancelled once decided, without inputs", () => {
    wrap(card({}, { kind: "decided", decision: "approved", who: "me", when: "now" }));
    expect(screen.getByText(/Submitted/)).toBeTruthy();
    expect(document.querySelectorAll("input, textarea").length).toBe(0);
    cleanup();
    wrap(card({}, { kind: "decided", decision: "denied", who: "me", when: "now" }));
    expect(screen.getByText(/Cancelled/)).toBeTruthy();
    expect(screen.queryByText(/Denied/)).toBeNull();
  });
});
