import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, PreferenceBar } from "../src/index";

afterEach(cleanup);

const language = {
  label: "Language",
  value: "en",
  options: [{ value: "en", label: "English" }],
  onChange: () => {},
};

describe("PreferenceBar", () => {
  it("draws the scheme toggle with a theme", () => {
    render(
      <DesignProvider locale="en">
        <PreferenceBar
          language={language}
          theme={{
            label: "Theme",
            value: "dark",
            lightLabel: "Light",
            darkLabel: "Dark",
            onChange: () => {},
          }}
        />
      </DesignProvider>,
    );
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
  });

  it("without a theme (a single-scheme UI theme) draws only the language", () => {
    render(
      <DesignProvider locale="en">
        <PreferenceBar language={language} />
      </DesignProvider>,
    );
    expect(screen.getByRole("combobox", { name: "Language" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
