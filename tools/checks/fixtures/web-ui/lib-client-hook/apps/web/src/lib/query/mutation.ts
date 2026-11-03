"use client";

import { useMutation } from "@tanstack/react-query";

export const useWrite = () => useMutation({ mutationFn: async () => 1 });
