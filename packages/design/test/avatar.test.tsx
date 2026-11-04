import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_PRESET_IDS,
  AVATAR_PRESETS,
  AVATAR_SIZES,
  Avatar,
  AvatarPicker,
  DesignProvider,
  TOKEN_NAMES,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const root = (c: HTMLElement) => c.querySelector('[data-part="avatar"]') as HTMLElement;

describe("Avatar (spec §6.30)", () => {
  it("all 10 presets render with their ground", () => {
    expect([...AVATAR_PRESET_IDS]).toEqual([
      "capybara",
      "black-bear",
      "panda",
      "elephant",
      "fox",
      "owl",
      "penguin",
      "rabbit",
      "turtle",
      "whale",
    ]);
    const tokens = new Set<string>(TOKEN_NAMES);
    for (const id of AVATAR_PRESET_IDS) {
      const preset = AVATAR_PRESETS[id];
      // one bitmap size for all ten, so they align
      expect(preset.bitmap).toHaveLength(12);
      for (const row of preset.bitmap) expect(row).toHaveLength(12);
      // palette values are token names, never literals
      expect(tokens.has(preset.ground)).toBe(true);
      for (const t of Object.values(preset.palette)) expect(tokens.has(t)).toBe(true);
      // every drawn cell has a colour
      const cells = new Set(preset.bitmap.join("").replace(/[.O]/g, ""));
      expect([...cells].sort()).toEqual(Object.keys(preset.palette).sort());

      const { container } = wrap(<Avatar value={{ kind: "preset", id }} name="Agent" size={40} />);
      const box = root(container);
      expect(box.getAttribute("data-kind")).toBe("preset");
      expect(box.getAttribute("data-preset")).toBe(id);
      expect(box.style.background).toBe(`var(--cb-${preset.ground})`);
      const svg = box.querySelector("svg") as SVGElement;
      expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
      const fills = [...svg.querySelectorAll("path")].map((p) => p.style.fill);
      expect(fills.sort()).toEqual(
        [...new Set(Object.values(preset.palette))].map((t) => `var(--cb-${t})`).sort(),
      );
      expect(box.textContent).toBe("");
      cleanup();
    }
  });

  it("null draws the initial", () => {
    const { container } = wrap(<Avatar value={null} name="研究助手" size={28} />);
    const box = root(container);
    expect(box.getAttribute("data-kind")).toBe("initial");
    expect(box.textContent).toBe("研");
    expect(box.querySelector("svg")).toBeNull();
    cleanup();
    const en = wrap(<Avatar value={null} name="scout" size={28} />);
    expect(root(en.container).textContent).toBe("S");
  });

  it("an image that fails to load falls back to the initial", () => {
    const { container } = wrap(
      <Avatar value={{ kind: "image", src: "/api/avatar/a1" }} name="Writer" size={40} />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/avatar/a1");
    expect(img.getAttribute("alt")).toBe("");
    expect(root(container).getAttribute("data-kind")).toBe("image");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(root(container).getAttribute("data-kind")).toBe("initial");
    expect(root(container).textContent).toBe("W");
  });

  it("sizes 16/24/28/40/64 set the box", () => {
    expect([...AVATAR_SIZES]).toEqual([16, 24, 28, 40, 64]);
    // the 12×12 bitmap at the nearest whole pixel unit, centred
    const unit = { 16: 1, 24: 2, 28: 2, 40: 3, 64: 5 } as const;
    for (const size of AVATAR_SIZES) {
      const { container } = wrap(
        <Avatar value={{ kind: "preset", id: "fox" }} name="Fox" size={size} />,
      );
      const box = root(container);
      expect(box.getAttribute("data-size")).toBe(String(size));
      const svg = box.querySelector("svg") as SVGElement;
      expect(svg.getAttribute("width")).toBe(String(size));
      expect(svg.getAttribute("height")).toBe(String(size));
      const off = (size - 12 * unit[size]) / 2;
      expect(svg.getAttribute("viewBox")).toBe(`${-off} ${-off} ${size} ${size}`);
      // fox: row 1 has an ear tip at x = 1
      const d = [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")).join("");
      const u = unit[size];
      expect(d).toContain(`M${u} ${u}h${u}v${u}h${-u}z`);
      cleanup();
      const initial = wrap(<Avatar value={null} name="Fox" size={size} />);
      expect(root(initial.container).getAttribute("data-size")).toBe(String(size));
      cleanup();
    }
  });

  it("no art cell of any preset falls outside the box at any size", () => {
    const outside: string[] = [];
    let cells = 0;
    for (const id of AVATAR_PRESET_IDS) {
      for (const size of AVATAR_SIZES) {
        const { container } = wrap(<Avatar value={{ kind: "preset", id }} name="A" size={size} />);
        const svg = root(container).querySelector("svg") as SVGElement;
        const [vx = 0, vy = 0, vw = 0, vh = 0] = (svg.getAttribute("viewBox") ?? "")
          .split(" ")
          .map(Number);
        for (const p of svg.querySelectorAll("path")) {
          for (const m of (p.getAttribute("d") ?? "").matchAll(/M(-?\d+) (-?\d+)h(\d+)/g)) {
            const [x, y, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
            cells++;
            if (x < vx || y < vy || x + s > vx + vw || y + s > vy + vh)
              outside.push(`${id}@${size}: ${x},${y}`);
          }
        }
        cleanup();
      }
    }
    expect(cells).toBeGreaterThan(1000);
    expect(outside).toEqual([]);
  });

  it("is decorative: the name beside it is what is read", () => {
    const { container } = wrap(
      <Avatar value={{ kind: "preset", id: "owl" }} name="Owl" size={24} />,
    );
    expect(root(container).getAttribute("aria-hidden")).toBe("true");
  });
});

describe("AvatarPicker (spec §6.30)", () => {
  it("disabled: every tile is disabled and the value stays shown", () => {
    wrap(
      <AvatarPicker
        value={{ kind: "preset", id: "fox" }}
        onChange={() => {}}
        onUpload={() => {}}
        disabled
      />,
      "en",
    );
    for (const r of screen.getAllByRole("radio")) expect(r).toHaveProperty("disabled", true);
    expect(screen.getByRole("radio", { name: "Fox" })).toHaveProperty("checked", true);
    expect(screen.getByRole("button", { name: "Upload image" })).toHaveProperty("disabled", true);
  });

  it("the picker selects a preset and calls onChange", () => {
    const onChange = vi.fn();
    wrap(
      <AvatarPicker
        value={{ kind: "preset", id: "capybara" }}
        onChange={onChange}
        onUpload={() => {}}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "头像" });
    const radios = [...group.querySelectorAll('input[type="radio"]')];
    expect(radios).toHaveLength(10);
    expect(screen.getByRole("radio", { name: "水豚" })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: "狐狸" })).toHaveProperty("checked", false);
    fireEvent.click(screen.getByRole("radio", { name: "狐狸" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "preset", id: "fox" });
  });

  it("names the presets in English", () => {
    wrap(<AvatarPicker value={null} onChange={() => {}} />, "en");
    const names = screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label"));
    expect(names).toEqual([
      "Capybara",
      "Black bear",
      "Panda",
      "Elephant",
      "Fox",
      "Owl",
      "Penguin",
      "Rabbit",
      "Turtle",
      "Whale",
    ]);
    expect(screen.getByRole("radiogroup", { name: "Avatar" })).toBeTruthy();
  });

  it("the upload tile is disabled with its reason when onUpload is absent", () => {
    wrap(
      <AvatarPicker
        value={{ kind: "preset", id: "panda" }}
        onChange={() => {}}
        uploadOffReason="未配置对象存储，无法上传图片。"
      />,
    );
    const tile = screen.getByRole("button", { name: "上传图片" });
    expect(tile).toHaveProperty("disabled", true);
    const reason = document.getElementById(tile.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe("未配置对象存储，无法上传图片。");
    cleanup();
    // without a reason of its own, a default one
    wrap(<AvatarPicker value={null} onChange={() => {}} />, "en");
    const t = screen.getByRole("button", { name: "Upload image" });
    expect(t).toHaveProperty("disabled", true);
    expect(document.getElementById(t.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Uploading is not available here.",
    );
  });

  it("the upload tile passes the chosen png, jpg or webp to onUpload", () => {
    const onUpload = vi.fn();
    const { container } = wrap(
      <AvatarPicker value={null} onChange={() => {}} onUpload={onUpload} />,
    );
    const tile = screen.getByRole("button", { name: "上传图片" });
    expect(tile).toHaveProperty("disabled", false);
    expect(tile.getAttribute("aria-describedby")).toBeNull();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.getAttribute("accept")).toBe("image/png,image/jpeg,image/webp");
    const file = new File(["x"], "me.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onUpload).toHaveBeenCalledWith(file);
  });

  it("an uploaded image that fails to load shows the upload icon on its tile", () => {
    const { container } = wrap(
      <AvatarPicker
        value={{ kind: "image", src: "/api/avatar/gone" }}
        onChange={() => {}}
        onUpload={() => {}}
      />,
    );
    const tile = container.querySelector('[data-part="avatar-upload"]') as HTMLElement;
    fireEvent.error(tile.querySelector("img") as HTMLImageElement);
    expect(tile.querySelector('[data-part="avatar"]')).toBeNull();
    expect(tile.querySelector('[data-icon="upload"]')).not.toBeNull();
  });

  it("an uploaded image shows on the upload tile and no preset is checked", () => {
    const { container } = wrap(
      <AvatarPicker
        value={{ kind: "image", src: "/api/avatar/a1" }}
        onChange={() => {}}
        onUpload={() => {}}
      />,
    );
    expect(screen.getAllByRole("radio").some((r) => (r as HTMLInputElement).checked)).toBe(false);
    const tile = screen.getByRole("button", { name: "上传图片" });
    expect(tile.getAttribute("data-state")).toBe("checked");
    expect(container.querySelector('[data-part="avatar-upload"] img')?.getAttribute("src")).toBe(
      "/api/avatar/a1",
    );
  });
});
