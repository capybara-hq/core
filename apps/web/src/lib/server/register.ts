import "server-only";
import { setApiTransport } from "../api";
import { serverTransport } from "./kernel";

// Imported by the root layout and by `page.ts` / `session.ts`, so whatever loads first registers it:
// server components' `apiFetch` calls go through the server transport. Setting it again is a no-op.
setApiTransport(serverTransport);
