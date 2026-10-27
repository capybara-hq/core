"use client";

import { useEffect, useState } from "react";

/**
 * The reference set's placeholder chart (docs/design/reference/src/conversation.js `chart()`) as a
 * real bitmap, so the image blocks load an `<img>` like the product does: drawn on a canvas in the
 * current theme's colors (read from the design tokens on the page) and handed out as a PNG
 * `blob:` URL. `w` × `h` is the frame in CSS px; `scale` sets the bitmap's natural size.
 * Development catalog only.
 */
export function useChartImage(w: number, h: number, scale: number): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const px = (name: string) => Number.parseFloat(v(name)) || 0;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const g = canvas.getContext("2d");
    if (!g) return;
    g.scale(scale, scale);
    g.fillStyle = v("--cb-panel");
    g.fillRect(0, 0, w, h);
    // Inset: top space.7, sides and bottom space.6; bars gap space.2, radius sm on top.
    const top = px("--cb-space-7");
    const side = px("--cb-space-6");
    const gap = px("--cb-space-2");
    const r = px("--cb-radius-sm");
    const heights = [40, 55, 35, 70, 90, 60, 45, 80];
    const areaW = w - side * 2;
    const areaH = h - top - side;
    const barW = (areaW - gap * (heights.length - 1)) / heights.length;
    heights.forEach((pct, i) => {
      const bh = (areaH * pct) / 100;
      const x = side + i * (barW + gap);
      const y = top + areaH - bh;
      g.fillStyle = v(i === 4 ? "--cb-accent" : "--cb-line-strong");
      g.beginPath();
      g.roundRect(x, y, barW, bh, [r, r, 0, 0]);
      g.fill();
    });
    let made: string | undefined;
    let live = true;
    canvas.toBlob((blob) => {
      if (!blob || !live) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }, "image/png");
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [w, h, scale]);
  return url;
}
