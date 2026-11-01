import "server-only";
import { setApiTransport } from "../api";
import { serverTransport } from "./kernel";

// Imported by the root layout: server components' `apiFetch` calls go through the server transport.
setApiTransport(serverTransport);
