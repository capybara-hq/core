"use client";
import { useEffect } from "react";
import { getThing } from "@/lib/things";

export function Panel() {
  useEffect(() => {
    getThing();
  }, []);
  return null;
}
