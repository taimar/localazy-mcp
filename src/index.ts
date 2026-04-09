#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { register as registerProjects } from "./tools/projects.js";
import { register as registerFiles } from "./tools/files.js";
import { register as registerLanguages } from "./tools/languages.js";
import { register as registerKeys } from "./tools/keys.js";
import { register as registerImport } from "./tools/import.js";
import { register as registerFind } from "./tools/find.js";
import { register as registerQuality } from "./tools/quality.js";

const server = new McpServer(
  { name: "localazy-mcp-server", version: "1.0.0" },
  {
    instructions: `Localazy translation management server. Use these tools when the user asks about translation keys, localized strings, languages, or localization files. Users may say "Localazy" to explicitly target this server. For QA sweeps like punctuation checks, style cleanup, or placeholder/tag validation, prefer localazy_audit_translations and set scope to 'style', 'syntax', or 'all' based on the user's request. For focused lookup requests like finding invoice-related keys or showing checkout strings in a language, prefer localazy_find_translations. These workflow tools automatically use the first accessible project. Use project/file listing or paginated key browsing only when the user explicitly needs raw IDs, manual browsing, or pagination. When showing Localazy translation results, always display every value in full. Never shorten, truncate, or use ellipsis for translation values.`,
  },
);

registerProjects(server);
registerFiles(server);
registerLanguages(server);
registerKeys(server);
registerFind(server);
registerQuality(server);
registerImport(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Localazy MCP server running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
