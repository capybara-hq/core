import { definePlugin } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export const schema = z.string();
export default definePlugin({ name: "clean", version: "0.0.0", sdk: "^0.1.0", provides: [], setup() {} });
