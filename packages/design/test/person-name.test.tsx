import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, PersonName } from "../src/index";
import { findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement) => render(<DesignProvider locale="en">{ui}</DesignProvider>);

describe("PersonName (spec §6.50)", () => {
  it("draws the initial of the name when there is no avatar url", () => {
    const { container } = wrap(<PersonName name="Grant" avatarUrl={null} size={16} />);
    const avatar = container.querySelector('[data-part="avatar"]') as HTMLElement;
    expect(avatar.getAttribute("data-shape")).toBe("circle");
    expect(avatar.getAttribute("data-size")).toBe("16");
    expect(avatar.getAttribute("data-kind")).toBe("initial");
    expect(avatar.textContent).toBe("G");
    expect(container.querySelector("img")).toBeNull();
  });

  it("draws an image, and a load error falls back to the initial without a second img", () => {
    const { container } = wrap(<PersonName name="Grant" avatarUrl="/a.png" size={24} />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/a.png");
    fireEvent.error(img);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector('[data-part="avatar"]')?.getAttribute("data-kind")).toBe(
      "initial",
    );
  });

  it("the name carries a title and is one ellipsized span", () => {
    const { container } = wrap(
      <PersonName name="A very long member display name" avatarUrl={null} size={24} />,
    );
    const text = container.querySelector('[data-part="person-name-text"]') as HTMLElement;
    expect(text.getAttribute("title")).toBe("A very long member display name");
    expect(text.textContent).toBe("A very long member display name");
  });

  it("renders the secondary text after the name", () => {
    const { container } = wrap(
      <PersonName name="Grant" avatarUrl={null} size={24} secondary="grant@example.com" />,
    );
    const text = container.querySelector('[data-part="person-name-text"]') as HTMLElement;
    const secondary = container.querySelector('[data-part="person-name-secondary"]') as HTMLElement;
    expect(secondary.textContent).toBe("grant@example.com");
    expect(text.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws no secondary part without secondary", () => {
    const { container } = wrap(<PersonName name="Grant" avatarUrl={null} size={16} />);
    expect(container.querySelector('[data-part="person-name-secondary"]')).toBeNull();
  });

  it("draws no nested box", () => {
    const { container } = wrap(
      <PersonName name="Grant" avatarUrl="/a.png" size={24} secondary="grant@example.com" />,
    );
    expect(findNestedBoxes(container)).toEqual([]);
  });
});
