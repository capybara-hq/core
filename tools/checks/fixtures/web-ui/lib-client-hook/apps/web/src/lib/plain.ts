import type { useState } from "react";
import { useQueryClient as qc } from "@tanstack/react-query";

export type S = typeof useState;
export const x = qc;
