import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Injectable } from "@nestjs/common";

export interface AgentDocTopic {
  id: string;
  title: string;
}

/** The SDK's `agent-docs` directory, found from the installed `@capybara-hq/plugin-sdk` package. */
function agentDocsDir(): string {
  const pkg = createRequire(import.meta.url).resolve("@capybara-hq/plugin-sdk/package.json");
  return join(dirname(pkg), "agent-docs");
}

function listTopics(dir: string, prefix = ""): Map<string, string> {
  const topics = new Map<string, string>();
  if (!existsSync(dir)) return topics;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (e.isDirectory()) {
      for (const [id, text] of listTopics(join(dir, e.name), `${prefix}${e.name}/`)) {
        topics.set(id, text);
      }
    } else if (e.name.endsWith(".md")) {
      topics.set(`${prefix}${e.name.slice(0, -3)}`, readFileSync(join(dir, e.name), "utf8"));
    }
  }
  return topics;
}

/**
 * The documentation topics the `Platform` tool's `read` action serves (Platform tool spec §8):
 * the Markdown files of the SDK's `agent-docs` directory, versioned with the contracts they
 * describe. The files are immutable within a version, so one read per process is a cache of
 * package files, not shared state.
 */
@Injectable()
export class AgentDocs {
  private cache: Map<string, string> | undefined;

  private load(): Map<string, string> {
    this.cache ??= listTopics(agentDocsDir());
    return this.cache;
  }

  /** Topic ids (path without `.md`, e.g. `extension-points/channel`) with their titles. */
  topics(): AgentDocTopic[] {
    return [...this.load()].map(([id, text]) => ({
      id,
      title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? id,
    }));
  }

  /** The Markdown of a topic, or null when there is none. */
  read(id: string): string | null {
    return this.load().get(id) ?? null;
  }
}
