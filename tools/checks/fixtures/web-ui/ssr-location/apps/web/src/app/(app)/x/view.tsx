"use client";
import { ListPage } from "@capybara-hq/design";
import { useEffect, useState } from "react";

const helper = () => window.location.search;

export default function View() {
  const body = window.location.search;
  const [init] = useState(() => new URLSearchParams(location.search).get("a"));
  const [path] = useState(window.location.pathname);
  // ssr-exempt: client-only widget
  const exempt = window.location.pathname;
  const go = () => {
    const q = window.location.search;
    const inner = () => window.location.pathname;
    return [q, inner(), helper()];
  };
  useEffect(() => {
    window.location.search;
  }, []);
  return <ListPage header={{ path: [], title: "x" }}>{[body, init, path, exempt, go]}</ListPage>;
}
