import { useEffect, type useRef } from "react";

export type R = typeof useRef;
export const leak = () => useEffect;
